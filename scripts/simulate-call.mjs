// Post a sample Voice AI call to the running server's webhook, so you can watch
// a call get ingested + scored without a live GHL signer.
//
// Usage:  VERIFY_WEBHOOKS=false node server.js   (in one terminal)
//         node scripts/simulate-call.mjs          (in another)
//
// Requires the server booted in DEMO mode (fixtures) so agent_dental_booking exists.

const PORT = process.env.PORT || 3000;

const webhookEnvelope = {
  type: "VoiceAiCallCompleted",
  webhookId: `sim-${Date.now()}`,
  timestamp: new Date().toISOString(),
  data: {
    id: `call_sim_${Date.now()}`,
    agentId: "agent_dental_booking",
    contactName: "Simulated Caller",
    direction: "inbound",
    durationSec: 74,
    outcome: "completed",
    transcript: [
      { role: "agent", text: "Thanks for calling Bright Smile Dental, how can I help?", tStart: 0, tEnd: 4 },
      { role: "caller", text: "I want to book a cleaning.", tStart: 4, tEnd: 6 },
      { role: "agent", text: "Sure, we have an opening tomorrow at 9am, does that work?", tStart: 6, tEnd: 10 },
      { role: "caller", text: "Um, what time is that for me? This is confusing.", tStart: 10, tEnd: 14 },
      { role: "agent", text: "It's 9am. Okay, thanks for calling.", tStart: 14, tEnd: 17 }
    ]
  }
};

const res = await fetch(`http://localhost:${PORT}/webhooks/ghl`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(webhookEnvelope)
});
const body = await res.json();
console.log(`HTTP ${res.status}`);
console.log(body);
if (res.status === 401) {
  console.log("\nSignature check is ON. For local testing start the server with VERIFY_WEBHOOKS=false.");
} else if (body.success) {
  console.log(`\nScored: health ${body.health}, ${body.deviations} deviation(s). Open the dashboard and refresh — the new call appears under the Dental agent.`);
}
