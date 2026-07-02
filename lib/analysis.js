// analysis.js — turns per-call deviations into ranked, actionable recommendations.
//
// Default path is rule-based (deterministic, zero-cost, always available).
// If LLM_API_KEY is set, enrichAgentLLM() replaces the rule-based rationale +
// prompt diff with a model-written one for the top recommendation. Both paths
// emit the *same* shape, so the frontend never has to care which ran.

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

// Rule-based templates keyed by the deviation signature. Each returns the
// human-facing recommendation, including a copy-paste prompt diff.
const TEMPLATES = {
  "script_deviation:confirm_timezone": {
    title: "Confirm the caller's timezone before offering slots",
    rationale: "Calls where the agent proposed a time without first confirming the timezone led to confusion and drop-offs.",
    diff: "+ Before proposing any appointment time, ask for and restate the caller's timezone, then quote every slot in that timezone."
  },
  "script_deviation:identify_caller": {
    title: "Always confirm who you're speaking with",
    rationale: "The agent skipped confirming the caller's name, which weakens booking accuracy and personalization.",
    diff: "+ Early in the call, ask 'Who am I speaking with?' and use the caller's name in follow-ups."
  },
  "data_gap:capture_callback": {
    title: "Always capture a callback number",
    rationale: "Bookings were made or attempted without a callback number, creating no-show and follow-up risk.",
    diff: "+ Before confirming any appointment, ask 'What's the best number to reach you?' and read it back to confirm."
  },
  "data_gap:phone": {
    title: "Always capture a callback number",
    rationale: "The caller's phone number was never captured on some calls, creating follow-up risk.",
    diff: "+ Ask for and confirm the best callback number before ending the call."
  },
  "missed_goal": {
    title: "Reduce dropped bookings at the closing step",
    rationale: "Calls reached the point of booking but ended without a confirmed appointment.",
    diff: "+ When the caller hesitates, offer two concrete slots and explicitly confirm: 'Shall I lock in [slot]?' before closing."
  },
  "missed_opportunity": {
    title: "Book the consult whenever the caller is qualified and interested",
    rationale: "Qualified, interested callers were thanked and released instead of being booked into a consultation.",
    diff: "+ If the caller owns their home and their bill is over $120, do NOT end the call — immediately offer a consultation time and confirm it."
  },
  "recovery_failure": {
    title: "Add a de-escalation and human-handoff path",
    rationale: "Frustrated callers were met with scripted questions instead of acknowledgement or a transfer, and the calls were lost.",
    diff: "+ If the caller expresses frustration, acknowledge it once ('I hear you, let's sort this quickly') and offer to transfer to a human before continuing the script."
  },
  "compliance_breach": {
    title: "Remove prohibited/compliance-risky language",
    rationale: "The agent used phrasing that may violate compliance guardrails.",
    diff: "+ Never use guarantees or medical/outcome claims. Stick to approved, factual phrasing."
  }
};

function signature(dev) {
  // group script/data deviations by their specific step; others by type only
  if ((dev.type === "script_deviation" || dev.type === "data_gap") && dev.stepKey) {
    return `${dev.type}:${dev.stepKey}`;
  }
  return dev.type;
}

/**
 * Aggregate scored calls for one agent into ranked recommendations + a summary.
 * @param {object} agent
 * @param {Array} results  scoreCall() outputs for this agent's calls
 */
export function analyzeAgent(agent, results) {
  const groups = new Map(); // signature -> { sig, type, severity, callIds:Set }
  for (const r of results) {
    for (const d of r.deviations) {
      if (d.type === "dead_air" || d.type === "long_call") continue; // efficiency noise, shown per-call only
      const sig = signature(d);
      if (!groups.has(sig)) groups.set(sig, { sig, type: d.type, severity: d.severity, callIds: new Set() });
      groups.get(sig).callIds.add(r.callId);
    }
  }

  const recommendations = [...groups.values()].map(g => {
    const tpl = TEMPLATES[g.sig] || TEMPLATES[g.type] || {
      title: `Address recurring ${g.type.replace(/_/g, " ")}`,
      rationale: `Multiple calls showed ${g.type.replace(/_/g, " ")}.`,
      diff: "+ Review these calls and adjust the agent prompt accordingly."
    };
    const frequency = g.callIds.size;
    const priority = SEVERITY_RANK[g.severity] * frequency;
    // confidence rises with evidence, capped
    const confidence = Math.min(0.95, 0.6 + 0.1 * frequency);
    return {
      signature: g.sig,
      type: g.type,
      severity: g.severity,
      title: tpl.title,
      rationale: tpl.rationale,
      proposedPromptDiff: tpl.diff,
      frequency,
      priority,
      confidence: Number(confidence.toFixed(2)),
      supportingCallIds: [...g.callIds],
      source: "rule"
    };
  }).sort((a, b) => b.priority - a.priority);

  const failureBreakdown = {};
  for (const r of results) for (const d of r.deviations) {
    failureBreakdown[d.type] = (failureBreakdown[d.type] || 0) + 1;
  }

  const scored = results.length;
  const goalRate = scored ? results.filter(r => r.kpis.goalCompleted).length / scored : 0;
  const avgHealth = scored ? Math.round(results.reduce((a, r) => a + r.health, 0) / scored) : 0;

  return {
    agentId: agent.id,
    summary: {
      callsScored: scored,
      goalCompletionRate: Number(goalRate.toFixed(2)),
      avgHealth,
      openRecommendations: recommendations.length
    },
    failureBreakdown,
    recommendations
  };
}

/**
 * Optional real-LLM enrichment of the top recommendation.
 * Called only when process.env.LLM_API_KEY is present. Never throws: on any
 * failure it returns the rule-based analysis unchanged.
 *
 * Supported providers via LLM_PROVIDER: "openai" (default) | "anthropic".
 */
export async function enrichAgentLLM(agent, results, analysis) {
  const key = process.env.LLM_API_KEY;
  if (!key || !analysis.recommendations.length) return analysis;

  const top = analysis.recommendations[0];
  const evidenceCalls = results
    .filter(r => top.supportingCallIds.includes(r.callId))
    .slice(0, 3)
    .map(r => ({ callId: r.callId, deviations: r.deviations.map(d => ({ type: d.type, evidence: d.evidence })) }));

  const prompt =
`You are a Voice AI QA analyst. Agent goal: "${agent.goal}".
Agent prompt:
"""${agent.promptSnapshot}"""
Recurring issue detected: ${top.type} across ${top.frequency} call(s).
Evidence:
${JSON.stringify(evidenceCalls, null, 2)}

Return ONLY strict JSON:
{"title": string, "rationale": string, "proposedPromptDiff": string (a single concrete +/- edit), "confidence": number 0-1}`;

  try {
    const provider = (process.env.LLM_PROVIDER || "openai").toLowerCase();
    let text;
    if (provider !== "anthropic") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({
          model: process.env.LLM_MODEL || "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" }, temperature: 0.2
        })
      });
      const data = await res.json();
      text = data.choices?.[0]?.message?.content;
    } else {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: process.env.LLM_MODEL || "claude-sonnet-4-20250514",
          max_tokens: 500,
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await res.json();
      text = data.content?.[0]?.text;
    }
    const parsed = JSON.parse(text);
    // Minimal validation before trusting model output.
    if (parsed && parsed.title && parsed.proposedPromptDiff) {
      analysis.recommendations[0] = {
        ...top,
        title: parsed.title,
        rationale: parsed.rationale || top.rationale,
        proposedPromptDiff: parsed.proposedPromptDiff,
        confidence: typeof parsed.confidence === "number" ? Number(parsed.confidence.toFixed(2)) : top.confidence,
        source: "llm"
      };
    }
  } catch (err) {
    // Fail soft: keep the rule-based recommendation.
    console.warn(`[analysis] LLM enrichment skipped: ${err.message}`);
  }
  return analysis;
}
