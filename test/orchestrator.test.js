// Unit tests for bidirectional write-back decision helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisNote, buildContactTags, canWriteBack } from "../lib/orchestrator.js";

const baseResult = {
  health: 82,
  kpis: { goalCompleted: true },
  deviations: [],
  useActions: []
};

test("buildContactTags: success, partial, failed, and human-review tags", () => {
  assert.deepEqual(buildContactTags(baseResult), ["voice-ai-call-success"]);

  assert.deepEqual(buildContactTags({ ...baseResult, health: 62 }), ["voice-ai-call-partial"]);

  const failed = buildContactTags({
    ...baseResult,
    health: 20,
    deviations: [{ type: "data_gap" }, { type: "missed_goal" }],
    useActions: [{ reason: "human_review" }]
  });

  assert.deepEqual(failed, [
    "voice-ai-call-failed",
    "needs-human-followup",
    "voice-ai-data-gap",
    "voice-ai-missed-goal"
  ]);
});

test("canWriteBack requires live location and contact context", () => {
  assert.equal(canWriteBack({ locationId: "loc1", contactId: "contact1" }), true);
  assert.equal(canWriteBack({ locationId: "loc1" }), false);
  assert.equal(canWriteBack({ contactId: "contact1" }), false);
});

test("buildAnalysisNote includes score, deviations, use actions, and recommendations", () => {
  const note = buildAnalysisNote({
    call: { id: "call1", startedAt: "2026-07-02T00:00:00Z" },
    result: {
      health: 45,
      kpis: { goalCompleted: false },
      deviations: [{ severity: "high", type: "missed_goal", evidence: "No appointment confirmed." }],
      useActions: [{ reason: "training", note: "Review the closing segment." }]
    },
    recommendations: [{ title: "Improve closing", proposedPromptDiff: "+ Offer two concrete slots." }]
  });

  assert.match(note, /Health: 45\/100/);
  assert.match(note, /missed_goal/);
  assert.match(note, /Review the closing segment/);
  assert.match(note, /Improve closing/);
});
