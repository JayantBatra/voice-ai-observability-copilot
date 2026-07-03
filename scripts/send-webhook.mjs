// Simulate a HighLevel Voice AI webhook without extra dependencies.
//
// Usage:
//   VERIFY_WEBHOOKS=false node server.js
//   npm run test:webhook
//
// For HMAC testing, set HL_WEBHOOK_SECRET on both server and this script.

import "../lib/env.js";
import crypto from "node:crypto";

const WEBHOOK_URL = process.env.WEBHOOK_URL || "http://localhost:3000/webhooks/hl";
const SECRET = process.env.HL_WEBHOOK_SECRET || "";
const body = JSON.stringify({
  type: "VoiceAICallCompleted",
  webhookId: `test-${Date.now()}`,
  callId: `test_call_${Date.now()}`,
  agentId: process.env.TEST_HL_AGENT_ID || "agent_dental_booking",
  locationId: process.env.TEST_HL_LOCATION_ID || process.env.HL_LOCATION_ID || "demo-location",
  contactId: process.env.TEST_HL_CONTACT_ID || "demo-contact",
  contactName: "Guest Visitor 001",
  callStatus: "completed",
  callType: "web_call",
  direction: "INBOUND",
  duration: 93,
  createdAt: new Date().toISOString(),
  transcript: [
    "bot: Hey, you have reached Bengaluru. How can I help you today?",
    "human: I need to know about the Bangalore traffic.",
    "bot: Happy to help. Am I speaking to Guest Visitor 001?",
    "human: Yeah.",
    "bot: I'm unable to find specific information about Bengaluru traffic right now.",
    "bot: A team member will follow up within the next business day.",
    "human: Thank you.",
    "bot: You're welcome! Have a great evening."
  ].join("\n"),
  summary: "Caller asked about Bangalore traffic. Agent could not resolve query. Promised follow-up.",
  extractedData: { phone: "9999999999" }
});

const headers = { "Content-Type": "application/json" };
if (SECRET) {
  headers["x-webhook-signature"] = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

console.log(`Sending test webhook to ${WEBHOOK_URL}`);
const res = await fetch(WEBHOOK_URL, { method: "POST", headers, body });
const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text);

if (res.status === 401) {
  console.log("\nSignature verification is enabled. Either set matching HL_WEBHOOK_SECRET values or start the server with VERIFY_WEBHOOKS=false for local testing.");
}
