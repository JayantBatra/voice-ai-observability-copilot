// orchestrator.js — bidirectional HighLevel write-back after scoring.
//
// Automatic write-back is intentionally limited to contact tags + notes. Prompt
// changes require a manual dashboard click because they alter agent behavior.

import { addContactNote, tagContact } from "./ghl.js";
import { getValidAccessToken } from "./tokens.js";

export function buildContactTags(result) {
  const tags = [];
  if (result.health >= 70) tags.push("voice-ai-call-success");
  else if (result.health < 50) tags.push("voice-ai-call-failed");
  else tags.push("voice-ai-call-partial");

  if (result.useActions.some(a => a.reason === "human_review")) {
    tags.push("needs-human-followup");
  }

  const types = new Set(result.deviations.map(d => d.type));
  if (types.has("data_gap")) tags.push("voice-ai-data-gap");
  if (types.has("missed_goal") || types.has("missed_opportunity")) tags.push("voice-ai-missed-goal");
  if (types.has("compliance_breach")) tags.push("voice-ai-compliance-review");

  return [...new Set(tags)];
}

export function buildAnalysisNote({ call, result, recommendations = [] }) {
  const failures = result.deviations.length
    ? result.deviations.map(d => `- [${d.severity}] ${d.type}: ${d.evidence}`).join("\n")
    : "- None";
  const actions = result.useActions.length
    ? result.useActions.map(a => `- ${a.reason}: ${a.note}`).join("\n")
    : "- None";
  const recs = recommendations.length
    ? recommendations.slice(0, 3).map(r => `- ${r.title}: ${r.proposedPromptDiff}`).join("\n")
    : "- None";

  return [
    "Voice AI Copilot Analysis",
    `Call: ${call.id}`,
    `Date: ${new Date(call.startedAt || Date.now()).toLocaleString()}`,
    `Health: ${result.health}/100`,
    `Goal completed: ${result.kpis.goalCompleted ? "yes" : "no"}`,
    "",
    "Deviations:",
    failures,
    "",
    "Use Actions:",
    actions,
    "",
    "Prompt/script recommendations:",
    recs
  ].join("\n");
}

export function canWriteBack(call) {
  return Boolean(call?.locationId && call?.contactId);
}

export async function runOrchestrator({ call, result, recommendations = [] }) {
  if (!canWriteBack(call)) {
    return { skipped: true, reason: "requires live HighLevel locationId and contactId" };
  }

  const token = await getValidAccessToken(call.locationId);
  const tags = buildContactTags(result);
  const note = buildAnalysisNote({ call, result, recommendations });
  const outcomes = [];

  try {
    await tagContact(token, call.contactId, tags);
    outcomes.push({ action: "tag_contact", ok: true, tags });
  } catch (err) {
    outcomes.push({ action: "tag_contact", ok: false, error: err.message });
  }

  try {
    await addContactNote(token, call.contactId, note);
    outcomes.push({ action: "add_contact_note", ok: true });
  } catch (err) {
    outcomes.push({ action: "add_contact_note", ok: false, error: err.message });
  }

  return { skipped: false, outcomes };
}
