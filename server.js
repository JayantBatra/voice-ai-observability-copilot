// server.js — zero-dependency HTTP server (Node 18+, built-in http only).
//
// Serves the Vue dashboard (static, from /public) and a JSON API backed by the
// store. Real integration endpoints:
//   POST /webhooks/ghl   -> signature-verified real-time Voice AI ingestion
//   GET  /oauth/callback -> GHL OAuth install: stores tokens, syncs agents + backfills calls
//
// Run: `node server.js`  (env: PORT, LLM_API_KEY, GHL_* — see .env.example)

import "./lib/env.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import * as store from "./lib/store.js";
import { addContactNote, normalizeCall, exchangeCode, patchAgent, tagContact } from "./lib/ghl.js";
import { saveTokens, hasTokens, listLocations, getValidAccessToken } from "./lib/tokens.js";
import { verifyWebhook } from "./lib/webhook.js";
import { syncLocation } from "./lib/sync.js";
import { buildAnalysisNote, runOrchestrator } from "./lib/orchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const processedWebhooks = new Set(); // idempotency on webhookId
const CALL_EVENTS = new Set(["VoiceAICallCompleted", "OutboundCall", "InboundCall"]);

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain" : "application/json",
    "Content-Security-Policy": "frame-ancestors 'self' https://*.gohighlevel.com https://*.leadconnectorhq.com https://*.msgsndr.com",
    ...headers
  });
  res.end(payload);
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = normalize(join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
  try {
    const data = await readFile(filePath);
    send(res, 200, data.toString(), { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
  } catch {
    send(res, 404, "Not found");
  }
}

// Read the raw request body as a string (needed verbatim for signature checks).
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error("invalid json"); }
}

function liveCallContext(callId) {
  const call = store.getCall(callId);
  const result = store.getResult(callId);
  if (!call || !result) return { error: "call not found", status: 404 };
  if (!call.locationId || !call.contactId) {
    return { error: "This action requires a live HighLevel contact.", status: 400 };
  }
  return { call, result };
}

async function handleCallWebhook(raw) {
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { return { status: 400, body: { error: "invalid json" } }; }

  if (body.webhookId && processedWebhooks.has(body.webhookId)) {
    return { status: 200, body: { message: "already processed" } };
  }
  if (body.webhookId) processedWebhooks.add(body.webhookId);

  if (body.type && !CALL_EVENTS.has(body.type)) {
    return { status: 200, body: { success: false, reason: `ignored event type: ${body.type}` } };
  }

  const payload = body.data || body; // events wrap the record under `data`
  const call = normalizeCall(payload);
  if (!call.id || !call.agentId) return { status: 200, body: { success: false, reason: "not a scorable call event" } };
  if (!store.getAgent(call.agentId)) {
    return { status: 200, body: { success: false, reason: "unknown agent; run sync" } };
  }

  const result = store.upsertCall(call);
  runOrchestrator({
    call,
    result,
    recommendations: store.recommendationsForAgent(call.agentId)
  }).then(r => {
    if (!r.skipped) console.log(`[orchestrator] ${call.id}: ${r.outcomes.filter(o => o.ok).length}/${r.outcomes.length} write-back actions succeeded`);
  }).catch(e => console.warn(`[orchestrator] skipped for ${call.id}: ${e.message}`));

  return { status: 200, body: { success: true, ingested: call.id, health: result.health, deviations: result.deviations.length } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    // ---- JSON API -------------------------------------------------------
    if (path === "/api/status") return send(res, 200, store.status({ locations: listLocations() }));
    if (path === "/api/overview") return send(res, 200, { ...store.overview(), status: store.status({ locations: listLocations() }) });
    if (path === "/api/use-actions") return send(res, 200, store.useActionsQueue());
    if (path.startsWith("/api/calls/") && path.endsWith("/tag-contact") && req.method === "POST") {
      const callId = decodeURIComponent(path.split("/")[3]);
      const ctx = liveCallContext(callId);
      if (ctx.error) return send(res, ctx.status, { error: ctx.error });
      const body = await readJsonBody(req);
      const tags = Array.isArray(body.tags) && body.tags.length ? body.tags : ["needs-human-followup"];
      const token = await getValidAccessToken(ctx.call.locationId);
      await tagContact(token, ctx.call.contactId, tags);
      return send(res, 200, { success: true, tags });
    }
    if (path.startsWith("/api/calls/") && path.endsWith("/add-note") && req.method === "POST") {
      const callId = decodeURIComponent(path.split("/")[3]);
      const ctx = liveCallContext(callId);
      if (ctx.error) return send(res, ctx.status, { error: ctx.error });
      const body = await readJsonBody(req);
      const note = body.note || buildAnalysisNote({
        call: ctx.call,
        result: ctx.result,
        recommendations: store.recommendationsForAgent(ctx.call.agentId)
      });
      const token = await getValidAccessToken(ctx.call.locationId);
      await addContactNote(token, ctx.call.contactId, note);
      return send(res, 200, { success: true });
    }
    if (path.startsWith("/api/agents/") && path.endsWith("/apply-prompt") && req.method === "POST") {
      const agentId = decodeURIComponent(path.split("/")[3]);
      const agent = store.getAgent(agentId);
      if (!agent) return send(res, 404, { error: "agent not found" });
      if (!agent.locationId) return send(res, 400, { error: "This action requires a live HighLevel agent." });
      const body = await readJsonBody(req);
      const proposed = body.proposedPromptDiff || "";
      const agentPrompt = body.agentPrompt || [
        agent.promptSnapshot || "",
        "",
        "Voice AI Copilot recommended adjustment:",
        proposed.replace(/^\+\s*/, "")
      ].join("\n").trim();
      if (!agentPrompt && !body.welcomeMessage) {
        return send(res, 400, { error: "Provide agentPrompt, welcomeMessage, or proposedPromptDiff" });
      }
      const update = {};
      if (agentPrompt) update.agentPrompt = agentPrompt;
      if (body.welcomeMessage) update.welcomeMessage = body.welcomeMessage;
      const token = await getValidAccessToken(agent.locationId);
      const result = await patchAgent(token, agentId, update);
      store.upsertAgent({ ...agent, promptSnapshot: update.agentPrompt || agent.promptSnapshot });
      return send(res, 200, { success: true, result });
    }
    if (path.startsWith("/api/agents/")) {
      const id = decodeURIComponent(path.split("/")[3]);
      const data = await store.agentAnalysis(id);
      return data ? send(res, 200, data) : send(res, 404, { error: "agent not found" });
    }
    if (path.startsWith("/api/calls/")) {
      const id = decodeURIComponent(path.split("/")[3]);
      const data = store.callDetail(id);
      return data ? send(res, 200, data) : send(res, 404, { error: "call not found" });
    }

    // ---- Real-time ingestion (signature-verified) ----------------------
    if ((path === "/webhooks/ghl" || path === "/webhooks/hl") && req.method === "POST") {
      const raw = await readRawBody(req);
      const verdict = verifyWebhook(raw, req.headers);
      if (!verdict.ok) {
        console.warn(`[webhook] rejected: ${verdict.reason}`);
        return send(res, 401, { error: "invalid signature" });
      }
      const result = await handleCallWebhook(raw);
      return send(res, result.status, result.body);
    }

    if (path === "/webhooks/hl-workflow" && req.method === "POST") {
      const raw = await readRawBody(req);
      const verdict = verifyWebhook(raw, req.headers);
      if (!verdict.ok) {
        console.warn(`[workflow] rejected: ${verdict.reason}`);
        return send(res, 401, { error: "invalid signature" });
      }
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: "invalid json" }); }
      console.log(`[workflow] ${body.type || "unknown"} contact=${body.contactId || "n/a"} location=${body.locationId || "n/a"}`);
      return send(res, 200, { success: true, received: body.type || "workflow" });
    }

    // ---- OAuth install callback ----------------------------------------
    if (path === "/oauth/callback") {
      const code = url.searchParams.get("code");
      if (!code) return send(res, 400, "Missing code");
      if (!process.env.GHL_CLIENT_ID) {
        return send(res, 200, "OAuth callback reached. Set GHL_CLIENT_ID/SECRET/REDIRECT_URI to complete installation.");
      }
      const tokens = await exchangeCode(code);
      const saved = saveTokens(tokens);
      store.init({ seedFixtures: false, mode: "live" });
      // Fire-and-forget the initial sync so the redirect returns quickly.
      syncLocation(saved.locationId)
        .then(r => console.log(`[install] location ${saved.locationId}: synced ${r.agents} agents, ${r.calls} calls`))
        .catch(e => console.error(`[install] sync failed: ${e.message}`));
      return send(res, 200, `Installed for location ${saved.locationId}. Syncing your agents and call history now — you can close this tab and open the Copilot.`);
    }

    if (path === "/health") return send(res, 200, { ok: true, ...store.status({ locations: listLocations() }) });

    return serveStatic(res, path);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

// Boot: prefer live data when the app is installed; otherwise seed fixtures for
// the offline demo. Set SEED_FIXTURES=false to force live-only.
async function boot() {
  const installed = hasTokens();
  const seedFixtures = process.env.SEED_FIXTURES !== "false" && !installed;
  const mode = installed ? "live" : seedFixtures ? "demo" : "live-awaiting-install";
  store.init({ seedFixtures, mode });

  if (installed) {
    for (const loc of listLocations()) {
      try {
        const r = await syncLocation(loc);
        console.log(`[boot] location ${loc}: ${r.agents} agents, ${r.calls} calls`);
      } catch (e) {
        console.error(`[boot] sync failed for ${loc}: ${e.message}`);
      }
    }
  }

  const c = store.counts();
  server.listen(PORT, () => {
    console.log(`Voice AI Observability Copilot: http://localhost:${PORT}`);
    console.log(`Mode: ${installed ? "LIVE (GHL synced)" : seedFixtures ? "DEMO (fixtures)" : "LIVE (awaiting install)"} — ${c.agents} agents, ${c.calls} calls`);
    console.log(process.env.LLM_API_KEY ? `LLM enrichment: ON (${process.env.LLM_PROVIDER || "openai"})` : "LLM enrichment: OFF (rule-based)");
    console.log(process.env.VERIFY_WEBHOOKS === "false" ? "Webhook verification: OFF (testing)" : "Webhook verification: ON");
  });
}

boot();
