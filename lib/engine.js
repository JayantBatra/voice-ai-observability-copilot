// engine.js — deterministic KPI / deviation scoring for Voice AI calls.
//
// Pure functions only: given a normalized call + its agent config, return a
// scored result. No LLM, no I/O, no randomness -> fully reproducible and
// unit-testable. This is the reliability backbone; the LLM layer (analysis.js)
// runs *after* this and only where human-like judgment adds value.

const SEVERITY_WEIGHT = { high: 30, medium: 15, low: 5 };

// Required-step keys that represent capturing data from the caller. When one of
// these is missing we report it as a data_gap rather than a generic script step.
const DATA_CAPTURE_STEPS = new Set(["capture_callback", "capture_email"]);

const POSITIVE_WORDS = ["great", "perfect", "yes", "works", "wonderful", "thanks", "good", "sure"];
const NEGATIVE_WORDS = ["frustrated", "ridiculous", "annoyed", "waste", "not helpful", "confusing", "angry", "forget it", "no."];
const INTENT_WORDS = ["interested", "love to", "get started", "sign me up", "let's do it", "ready to"];
const COMPLIANCE_DENYLIST = ["guarantee", "100% cure", "cure your", "medical advice", "risk free"];

// Confirmation that the agent's declared goal was met.
const GOAL_CONFIRM_PATTERNS = [
  "you're booked", "you are booked", "i've scheduled", "i have you down",
  "booked for", "booked.", "a specialist will call", "you're all set", "confirmed for"
];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;

function textOf(turns, role) {
  return turns.filter(t => !role || t.role === role).map(t => t.text.toLowerCase());
}

function stepMatch(turns, step) {
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== "agent") continue;
    const low = turns[i].text.toLowerCase();
    if (step.patterns.some(p => low.includes(p))) {
      return { passed: true, turnIndex: i, span: { start: turns[i].tStart, end: turns[i].tEnd } };
    }
  }
  return { passed: false };
}

function detectSentiment(turns) {
  const callerTurns = turns.filter(t => t.role === "caller");
  const scoreTurn = txt => {
    const low = txt.toLowerCase();
    let s = 0;
    POSITIVE_WORDS.forEach(w => { if (low.includes(w)) s += 1; });
    NEGATIVE_WORDS.forEach(w => { if (low.includes(w)) s -= 1; });
    return s;
  };
  const scores = callerTurns.map(t => scoreTurn(t.text));
  const total = scores.reduce((a, b) => a + b, 0);
  const label = total < -1 ? "negative" : total > 1 ? "positive" : "neutral";
  // worst caller turn (for human-review span)
  let worst = null, worstScore = 0;
  callerTurns.forEach(t => {
    const sc = scoreTurn(t.text);
    if (sc < worstScore) { worstScore = sc; worst = t; }
  });
  return {
    start: scores.length ? (scores[0] < 0 ? "negative" : scores[0] > 0 ? "positive" : "neutral") : "neutral",
    end: scores.length ? (scores[scores.length - 1] < 0 ? "negative" : scores[scores.length - 1] > 0 ? "positive" : "neutral") : "neutral",
    label,
    worstSpan: worst ? { start: worst.tStart, end: worst.tEnd, text: worst.text } : null
  };
}

// Solar-style qualification: homeowner AND monthly bill over $120.
function detectQualified(turns) {
  const callerText = textOf(turns, "caller").join(" ");
  const rents = /\b(i rent|renting|i'?m renting|no,? i rent)\b/.test(callerText);
  const owns = /\b(i own|own it|own my|yes,? i (do|own)|homeowner)\b/.test(callerText) && !rents;
  const billMatch = callerText.match(/\$\s?(\d{2,4})/);
  const bill = billMatch ? parseInt(billMatch[1], 10) : null;
  const qualified = owns && bill != null && bill > 120;
  return { owns, rents, bill, qualified };
}

function detectDeadAir(turns, deadAirSec) {
  const gaps = [];
  for (let i = 1; i < turns.length; i++) {
    const gap = turns[i].tStart - turns[i - 1].tEnd;
    if (gap > deadAirSec) {
      gaps.push({ start: turns[i - 1].tEnd, end: turns[i].tStart, seconds: gap });
    }
  }
  return gaps;
}

function detectCompliance(turns) {
  const hits = [];
  turns.forEach(t => {
    if (t.role !== "agent") return;
    const low = t.text.toLowerCase();
    COMPLIANCE_DENYLIST.forEach(term => {
      if (low.includes(term)) hits.push({ term, span: { start: t.tStart, end: t.tEnd }, text: t.text });
    });
  });
  return hits;
}

/**
 * Score a single call against its agent config.
 * @returns {{callId, agentId, kpis, deviations, useActions, health}}
 */
export function scoreCall(call, agent) {
  const turns = call.transcript || [];
  const deviations = [];
  const useActions = [];
  const thresholds = agent.thresholds || {};
  const deadAirSec = thresholds.deadAirSec ?? 4;
  const maxDurationSec = thresholds.maxDurationSec ?? 600;

  // --- Required-step coverage -------------------------------------------
  const steps = (agent.requiredSteps || []).map(step => {
    const m = stepMatch(turns, step);
    return { key: step.key, label: step.label, passed: m.passed, span: m.span || null,
             category: DATA_CAPTURE_STEPS.has(step.key) ? "data" : "script" };
  });

  // --- Data capture ------------------------------------------------------
  const callerText = textOf(turns, "caller").join(" ");
  const phoneCaptured = PHONE_RE.test(callerText);
  const emailCaptured = EMAIL_RE.test(callerText);

  // --- Sentiment ---------------------------------------------------------
  const sentiment = detectSentiment(turns);

  // --- Goal completion ---------------------------------------------------
  const transcriptJoined = turns.map(t => t.text.toLowerCase()).join(" ");
  const goalCompleted =
    call.outcome === "transferred" ? false :
    GOAL_CONFIRM_PATTERNS.some(p => transcriptJoined.includes(p));

  // Whether the goal *should* have completed (drives missed_goal vs correct decline)
  let expected = true, qualification = null;
  if (agent.type === "qualification") {
    qualification = detectQualified(turns);
    expected = qualification.qualified; // renter / low bill -> correct to not book
  }
  // When a caller is correctly disqualified (renter), skipping the remaining
  // qualification steps is correct behavior, not a deviation.
  const disqualified = agent.type === "qualification" && qualification && qualification.rents;
  const DOWNSTREAM_OF_DQ = new Set(["monthly_bill", "book_consult"]);

  // --- Deviations --------------------------------------------------------
  // 1. Missing steps -> script_deviation or data_gap
  steps.filter(s => !s.passed).forEach(s => {
    if (disqualified && DOWNSTREAM_OF_DQ.has(s.key)) return;
    if (s.category === "data") {
      deviations.push({ type: "data_gap", severity: "medium", stepKey: s.key,
        evidence: `Required data step never completed: ${s.label}`, span: null, fixCategory: "data_capture" });
    } else {
      deviations.push({ type: "script_deviation", severity: "medium", stepKey: s.key,
        evidence: `Required step missing or out of order: ${s.label}`, span: null, fixCategory: "script_step" });
    }
  });

  // 2. Data gaps for hard-required contact info (dental callback number)
  if (agent.type === "booking" && !phoneCaptured && !deviations.some(d => d.stepKey === "capture_callback")) {
    deviations.push({ type: "data_gap", severity: "medium", stepKey: "phone",
      evidence: "No callback number captured from the caller.", span: null, fixCategory: "data_capture" });
  }

  // 3. Missed goal / missed opportunity
  if (!goalCompleted && expected) {
    const intentPresent = INTENT_WORDS.some(w => callerText.includes(w)) || sentiment.label !== "negative";
    if (agent.type === "qualification") {
      deviations.push({ type: "missed_opportunity", severity: "high",
        evidence: "Caller was qualified and showed intent, but no consultation was booked.",
        span: turns.length ? { start: turns[turns.length - 1].tStart, end: turns[turns.length - 1].tEnd } : null,
        fixCategory: "closing" });
    } else {
      deviations.push({ type: "missed_goal", severity: "high",
        evidence: intentPresent ? "Caller intended to book but the call ended without a confirmed appointment."
                                : "Call ended without meeting the agent's goal.",
        span: turns.length ? { start: turns[turns.length - 1].tStart, end: turns[turns.length - 1].tEnd } : null,
        fixCategory: "closing" });
    }
  }

  // 4. Recovery failure (frustrated caller + goal not met)
  if (sentiment.label === "negative" && !goalCompleted) {
    deviations.push({ type: "recovery_failure", severity: "high",
      evidence: "Caller expressed frustration and the agent did not de-escalate or hand off before the call ended.",
      span: sentiment.worstSpan ? { start: sentiment.worstSpan.start, end: sentiment.worstSpan.end } : null,
      fixCategory: "recovery" });
  }

  // 5. Compliance breaches
  detectCompliance(turns).forEach(h => {
    deviations.push({ type: "compliance_breach", severity: "high",
      evidence: `Agent used a prohibited phrase: "${h.term}".`, span: h.span, fixCategory: "compliance" });
  });

  // 6. Dead air
  detectDeadAir(turns, deadAirSec).forEach(g => {
    deviations.push({ type: "dead_air", severity: "low",
      evidence: `Silence of ${g.seconds}s between turns.`, span: { start: g.start, end: g.end }, fixCategory: "latency" });
  });

  // 7. Overlong call
  if (call.durationSec > maxDurationSec) {
    deviations.push({ type: "long_call", severity: "low",
      evidence: `Call ran ${call.durationSec}s vs target ${maxDurationSec}s.`, span: null, fixCategory: "efficiency" });
  }

  // --- Use Actions -------------------------------------------------------
  deviations.forEach(d => {
    if (d.type === "recovery_failure" || d.type === "compliance_breach") {
      useActions.push({ callId: call.id, reason: "human_review", span: d.span, note: d.evidence });
    } else if ((d.type === "missed_goal" || d.type === "missed_opportunity") && d.span) {
      useActions.push({ callId: call.id, reason: "training", span: d.span, note: d.evidence });
    }
  });

  // --- Health score ------------------------------------------------------
  let health = 100;
  deviations.forEach(d => { health -= SEVERITY_WEIGHT[d.severity] || 0; });
  health = Math.max(0, health);

  return {
    callId: call.id,
    agentId: agent.id,
    kpis: {
      goalCompleted,
      expected,
      qualification,
      stepsPassed: steps.filter(s => s.passed).length,
      stepsTotal: steps.length,
      steps,
      phoneCaptured,
      emailCaptured,
      sentiment: { start: sentiment.start, end: sentiment.end, label: sentiment.label },
      transferred: call.outcome === "transferred",
      durationSec: call.durationSec,
      turns: turns.length
    },
    deviations,
    useActions,
    health
  };
}
