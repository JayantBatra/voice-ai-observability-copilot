// sync.js — pull real data from HighLevel into the store.
//
//   syncAgents(locationId)  -> fetch GHL Voice AI agents, merge with the
//                              operator's observability config, upsert.
//   backfillCalls(locationId) -> page through Call Logs, normalize, score.
//
// Both are called from the OAuth callback on install and can be re-run any time.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getValidAccessToken } from "./tokens.js";
import { listAgents, getAgent, listCallLogs, getCallLog, normalizeCall } from "./ghl.js";
import * as store from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(__dirname, "..", "config", "observability.json"), "utf8"));

// Infer an agent's observability "type" from its name/goal so we can pick the
// right KPI template. Falls back to defaults if nothing matches.
function inferType(agent) {
  const s = `${agent.name || ""} ${agent.goal || ""} ${agent.promptSnapshot || ""}`.toLowerCase();
  if (/qualif|homeowner|lead|solar|eligib/.test(s)) return "qualification";
  if (/book|appointment|schedul|reservation|calendar/.test(s)) return "booking";
  return null;
}

/** Merge a raw GHL agent with the operator's observability config. */
export function resolveAgentConfig(raw) {
  const id = raw.id || raw.agentId || raw._id;
  const name = raw.name || raw.agentName || "Voice AI Agent";
  const goal = raw.goal || raw.objective || raw.description || "";
  const promptSnapshot = raw.prompt || raw.systemPrompt || raw.instructions || "";
  const type = inferType({ name, goal, promptSnapshot }) || "default";

  const base = CONFIG.byAgentId[id] || CONFIG.byType[type] || CONFIG.defaults;
  return {
    id, name, type: type === "default" ? "booking" : type, goal, promptSnapshot,
    requiredSteps: base.requiredSteps,
    thresholds: base.thresholds,
    ghlAgentId: id
  };
}

/** Fetch all agents for a location and upsert them into the store. */
export async function syncAgents(locationId) {
  const token = await getValidAccessToken(locationId);
  const res = await listAgents(token, locationId);
  const rawAgents = res.agents || res.data || res.items || (Array.isArray(res) ? res : []);
  let count = 0;
  for (const a of rawAgents) {
    // fetch full config when the list view is thin
    let full = a;
    if (!(a.prompt || a.systemPrompt) && (a.id || a.agentId)) {
      try { full = await getAgent(token, a.id || a.agentId); } catch { /* keep list item */ }
    }
    store.upsertAgent(resolveAgentConfig(full));
    count++;
  }
  return count;
}

/** Backfill historical call logs for a location (paginated). */
export async function backfillCalls(locationId, { startDate, endDate, maxPages = 20 } = {}) {
  const token = await getValidAccessToken(locationId);
  let page = 1, ingested = 0;
  while (page <= maxPages) {
    const res = await listCallLogs(token, { locationId, startDate, endDate, page, limit: 50 });
    const logs = res.callLogs || res.data || res.items || (Array.isArray(res) ? res : []);
    if (!logs.length) break;

    for (const log of logs) {
      // If the list item lacks a transcript, fetch full detail.
      let raw = log;
      const hasTranscript = (log.transcript || log.messages || log.turns || []).length > 0;
      if (!hasTranscript && (log.id || log.callId)) {
        try { raw = await getCallLog(token, log.id || log.callId); } catch { /* skip detail */ }
      }
      const call = normalizeCall(raw);
      if (call.id && call.agentId && store.getAgent(call.agentId)) {
        store.upsertCall(call);
        ingested++;
      }
    }
    if (logs.length < 50) break;
    page++;
  }
  return ingested;
}

/** Full sync for a freshly-installed location: agents first, then calls. */
export async function syncLocation(locationId) {
  const agents = await syncAgents(locationId);
  const calls = await backfillCalls(locationId);
  store.markSync(locationId);
  return { agents, calls };
}
