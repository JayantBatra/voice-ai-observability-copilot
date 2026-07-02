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
import { normalizeCall, exchangeCode } from "./lib/ghl.js";
import { saveTokens, hasTokens, listLocations } from "./lib/tokens.js";
import { verifyWebhook } from "./lib/webhook.js";
import { syncLocation } from "./lib/sync.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const processedWebhooks = new Set(); // idempotency on webhookId

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    // ---- JSON API -------------------------------------------------------
    if (path === "/api/status") return send(res, 200, store.status({ locations: listLocations() }));
    if (path === "/api/overview") return send(res, 200, { ...store.overview(), status: store.status({ locations: listLocations() }) });
    if (path === "/api/use-actions") return send(res, 200, store.useActionsQueue());
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
    if (path === "/webhooks/ghl" && req.method === "POST") {
      const raw = await readRawBody(req);
      const verdict = verifyWebhook(raw, req.headers);
      if (!verdict.ok) {
        console.warn(`[webhook] rejected: ${verdict.reason}`);
        return send(res, 401, { error: "invalid signature" });
      }
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: "invalid json" }); }

      // Respond fast; process idempotently.
      if (body.webhookId && processedWebhooks.has(body.webhookId)) {
        return send(res, 200, { message: "already processed" });
      }
      if (body.webhookId) processedWebhooks.add(body.webhookId);

      const payload = body.data || body; // events wrap the record under `data`
      const call = normalizeCall(payload);
      if (!call.id || !call.agentId) return send(res, 200, { success: false, reason: "not a scorable call event" });
      if (!store.getAgent(call.agentId)) {
        // Unknown agent (e.g. installed after last sync) — skip gracefully.
        return send(res, 200, { success: false, reason: "unknown agent; run sync" });
      }
      const result = store.upsertCall(call);
      return send(res, 200, { success: true, ingested: call.id, health: result.health, deviations: result.deviations.length });
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
