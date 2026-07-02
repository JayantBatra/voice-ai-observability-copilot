// Unit tests for the deterministic engine, run with `node --test` (no deps).
// Each fixture call has a known-correct expected outcome; these lock the
// scoring logic so future changes can't silently regress it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreCall } from "../lib/engine.js";
import { analyzeAgent } from "../lib/analysis.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = f => JSON.parse(readFileSync(join(dir, "..", "fixtures", f), "utf8"));
const agents = new Map(load("agents.json").map(a => [a.id, a]));
const calls = new Map(load("calls.json").map(c => [c.id, c]));
const score = id => scoreCall(calls.get(id), agents.get(calls.get(id).agentId));
const hasDev = (r, type) => r.deviations.some(d => d.type === type);

test("d1: perfect booking -> health 100, no deviations, goal met", () => {
  const r = score("call_d1");
  assert.equal(r.kpis.goalCompleted, true);
  assert.equal(r.deviations.length, 0);
  assert.equal(r.health, 100);
  assert.equal(r.kpis.sentiment.label, "positive");
});

test("d2: skipped timezone -> script_deviation + missed_goal", () => {
  const r = score("call_d2");
  assert.equal(r.kpis.goalCompleted, false);
  assert.ok(hasDev(r, "missed_goal"));
  assert.ok(r.deviations.some(d => d.type === "script_deviation" && d.stepKey === "confirm_timezone"));
});

test("d3: no callback number captured -> data_gap, goal still met", () => {
  const r = score("call_d3");
  assert.equal(r.kpis.goalCompleted, true);
  assert.equal(r.kpis.phoneCaptured, false);
  assert.ok(hasDev(r, "data_gap"));
});

test("d4: frustrated caller -> recovery_failure + human_review use-action", () => {
  const r = score("call_d4");
  assert.equal(r.kpis.sentiment.label, "negative");
  assert.ok(hasDev(r, "recovery_failure"));
  assert.ok(r.useActions.some(u => u.reason === "human_review"));
  assert.equal(r.health, 0);
});

test("d5: silences + overlong -> dead_air + long_call, goal still met", () => {
  const r = score("call_d5");
  assert.equal(r.kpis.goalCompleted, true);
  assert.ok(hasDev(r, "dead_air"));
  assert.ok(hasDev(r, "long_call"));
});

test("s1: qualified + booked -> clean", () => {
  const r = score("call_s1");
  assert.equal(r.kpis.goalCompleted, true);
  assert.equal(r.kpis.qualification.qualified, true);
  assert.equal(r.deviations.length, 0);
});

test("s2: qualified + interested but not booked -> missed_opportunity", () => {
  const r = score("call_s2");
  assert.equal(r.kpis.goalCompleted, false);
  assert.equal(r.kpis.qualification.qualified, true);
  assert.ok(hasDev(r, "missed_opportunity"));
});

test("s3: renter correctly declined -> no penalty", () => {
  const r = score("call_s3");
  assert.equal(r.kpis.qualification.rents, true);
  assert.equal(r.kpis.expected, false);
  assert.ok(!hasDev(r, "missed_opportunity"));
  assert.equal(r.deviations.length, 0);
});

test("analyzeAgent: recommendations ranked by severity x frequency", () => {
  const dentalResults = [...calls.values()]
    .filter(c => c.agentId === "agent_dental_booking")
    .map(c => scoreCall(c, agents.get("agent_dental_booking")));
  const analysis = analyzeAgent(agents.get("agent_dental_booking"), dentalResults);
  assert.ok(analysis.recommendations.length > 0);
  // top recommendation should be high severity (missed_goal / recovery_failure)
  assert.equal(analysis.recommendations[0].severity, "high");
  // priorities are sorted descending
  const pr = analysis.recommendations.map(r => r.priority);
  assert.deepEqual(pr, [...pr].sort((a, b) => b - a));
});
