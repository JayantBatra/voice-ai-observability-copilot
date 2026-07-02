// store.js — in-memory data store seeded from fixtures.
//
// Deliberately not a database. For an observability tool at demo/single-account
// scale, an in-memory store rebuilt from fixtures (or, in production, from the
// GHL Call Log backfill) is enough and keeps the whole app runnable with
// `node server.js` and zero infrastructure. Swapping in Postgres later means
// replacing this one module — nothing else imports the raw arrays.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreCall } from "./engine.js";
import { analyzeAgent, enrichAgentLLM } from "./analysis.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "fixtures");

const state = {
  agents: new Map(),   // id -> agent
  calls: new Map(),    // id -> normalized call
  results: new Map(),  // callId -> scoreCall result
  meta: {
    mode: "demo",
    lastAnalyzedAt: null,
    lastSyncAt: null,
    lastSyncLocationId: null
  }
};

function load(file) {
  return JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
}

/** Initialize the store. Optionally seed the offline demo fixtures. */
export function init({ seedFixtures = true, mode = "demo" } = {}) {
  state.agents.clear();
  state.calls.clear();
  state.results.clear();
  state.meta.mode = mode;
  state.meta.lastAnalyzedAt = null;
  if (seedFixtures) {
    load("agents.json").forEach(a => state.agents.set(a.id, a));
    load("calls.json").forEach(c => upsertCall(c));
  }
  return { agents: state.agents.size, calls: state.calls.size };
}

/** Add or replace an agent config (used by live GHL sync). */
export function upsertAgent(agent) {
  state.agents.set(agent.id, agent);
  // rescore any existing calls for this agent against the new config
  for (const call of state.calls.values()) {
    if (call.agentId === agent.id) state.results.set(call.id, scoreCall(call, agent));
  }
  return agent;
}

export function counts() {
  return { agents: state.agents.size, calls: state.calls.size };
}

export function markSync(locationId) {
  state.meta.lastSyncAt = new Date().toISOString();
  state.meta.lastSyncLocationId = locationId;
}

export function status({ locations = [] } = {}) {
  return {
    mode: state.meta.mode,
    locations,
    lastAnalyzedAt: state.meta.lastAnalyzedAt,
    lastSyncAt: state.meta.lastSyncAt,
    lastSyncLocationId: state.meta.lastSyncLocationId,
    ...counts()
  };
}

/** Add or replace a call and (re)score it. Idempotent on call.id. */
export function upsertCall(call) {
  const agent = state.agents.get(call.agentId);
  if (!agent) throw new Error(`Unknown agentId: ${call.agentId}`);
  state.calls.set(call.id, call);
  state.results.set(call.id, scoreCall(call, agent));
  state.meta.lastAnalyzedAt = new Date().toISOString();
  return state.results.get(call.id);
}

export function getAgent(id) { return state.agents.get(id); }
export function listAgents() { return [...state.agents.values()]; }
export function getCall(id) { return state.calls.get(id); }
export function getResult(id) { return state.results.get(id); }

export function resultsForAgent(agentId) {
  return [...state.results.values()].filter(r => r.agentId === agentId);
}

/** Portfolio view: one health row per agent + top-line KPIs. */
export function overview() {
  const agents = listAgents().map(agent => {
    const results = resultsForAgent(agent.id);
    const scored = results.length;
    const goalRate = scored ? results.filter(r => r.kpis.goalCompleted).length / scored : 0;
    const avgHealth = scored ? Math.round(results.reduce((a, r) => a + r.health, 0) / scored) : 0;
    const failures = {};
    results.forEach(r => r.deviations.forEach(d => { failures[d.type] = (failures[d.type] || 0) + 1; }));
    const topFailure = Object.entries(failures).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return {
      id: agent.id, name: agent.name, type: agent.type, goal: agent.goal,
      callsScored: scored,
      goalCompletionRate: Number(goalRate.toFixed(2)),
      avgHealth,
      topFailure,
      needsAttention: avgHealth < (agent.thresholds?.minHealth ?? 70)
    };
  });

  const allResults = [...state.results.values()];
  const scored = allResults.length;
  const portfolio = {
    callsScored: scored,
    goalCompletionRate: scored ? Number((allResults.filter(r => r.kpis.goalCompleted).length / scored).toFixed(2)) : 0,
    avgHealth: scored ? Math.round(allResults.reduce((a, r) => a + r.health, 0) / scored) : 0,
    openUseActions: allResults.reduce((a, r) => a + r.useActions.length, 0)
  };
  return { portfolio, agents };
}

/** Agent deep-dive: summary + failure breakdown + ranked recommendations. */
export async function agentAnalysis(agentId) {
  const agent = getAgent(agentId);
  if (!agent) return null;
  const results = resultsForAgent(agentId);
  let analysis = analyzeAgent(agent, results);
  analysis = await enrichAgentLLM(agent, results, analysis); // no-op without LLM_API_KEY
  return {
    agent: {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      goal: agent.goal,
      promptSnapshot: agent.promptSnapshot,
      requiredSteps: agent.requiredSteps || [],
      thresholds: agent.thresholds || {}
    },
    ...analysis,
    calls: results.map(r => ({
      callId: r.callId,
      contactName: getCall(r.callId)?.contactName,
      startedAt: getCall(r.callId)?.startedAt,
      health: r.health,
      goalCompleted: r.kpis.goalCompleted,
      deviationCount: r.deviations.length
    }))
  };
}

/** Full detail for the call/transcript viewer. */
export function callDetail(callId) {
  const call = getCall(callId);
  const result = getResult(callId);
  if (!call || !result) return null;
  const agent = getAgent(call.agentId);
  return { call, agent: { id: agent.id, name: agent.name, goal: agent.goal }, result };
}

/** Aggregate Use-Actions queue across all calls. */
export function useActionsQueue() {
  const items = [];
  for (const r of state.results.values()) {
    const call = getCall(r.callId);
    r.useActions.forEach(ua => items.push({
      ...ua, agentId: r.agentId, contactName: call?.contactName, startedAt: call?.startedAt
    }));
  }
  // human_review first
  return items.sort((a, b) => (a.reason === "human_review" ? -1 : 1) - (b.reason === "human_review" ? -1 : 1));
}
