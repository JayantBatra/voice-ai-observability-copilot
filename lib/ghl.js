// ghl.js — HighLevel API client + payload normalization.
//
// This is the REAL integration surface. The functions below implement the
// OAuth token exchange and the Voice AI Call Log endpoints exactly as
// documented. They are NOT exercised in the offline demo (no live sandbox
// reachable here), so treat them as the wiring you point at a real sandbox by
// setting the env vars in .env. normalizeCall() is used by both the live path
// and the webhook path, so it IS covered by the demo.
//
// Docs:
//   OAuth 2.0        https://marketplace.gohighlevel.com/docs/ghl/oauth/oauth-2-0-v-3
//   Voice AI APIs    https://marketplace.gohighlevel.com/docs/ghl/voice-ai/voice-ai-api
//   Call Logs        List/Get call logs incl. transcripts, filters, pagination

const API_BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28"; // sent as the Version header on v2/v3 calls

/** Exchange the OAuth authorization code for access + refresh tokens. */
export async function exchangeCode(code) {
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.GHL_REDIRECT_URI
    })
  });
  if (!res.ok) throw new Error(`OAuth exchange failed: ${res.status}`);
  return res.json(); // { access_token, refresh_token, expires_in, locationId, ... }
}

/** Refresh an expired access token. */
export async function refreshToken(refresh_token) {
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token
    })
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  return res.json();
}

function authHeaders(accessToken) {
  return { "Authorization": `Bearer ${accessToken}`, "Version": API_VERSION, "Accept": "application/json" };
}

function jsonHeaders(accessToken) {
  return { ...authHeaders(accessToken), "Content-Type": "application/json" };
}

/**
 * List Voice AI call logs for a location (paginated). Used for the initial
 * historical backfill when the app is installed and for periodic reconcile.
 */
export async function listCallLogs(accessToken, { locationId, agentId, startDate, endDate, page = 1, limit = 50 } = {}) {
  const params = new URLSearchParams({ locationId, page: String(page), limit: String(limit) });
  if (agentId) params.set("agentId", agentId);
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const res = await fetch(`${API_BASE}/voice-ai/call-logs?${params}`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`listCallLogs failed: ${res.status}`);
  return res.json();
}

/** Get a single call log (full detail incl. transcript) by call id. */
export async function getCallLog(accessToken, callId) {
  const res = await fetch(`${API_BASE}/voice-ai/call-logs/${callId}`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`getCallLog failed: ${res.status}`);
  return res.json();
}

/** List Voice AI agents for a location. */
export async function listAgents(accessToken, locationId) {
  const res = await fetch(`${API_BASE}/voice-ai/agents?locationId=${encodeURIComponent(locationId)}`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`listAgents failed: ${res.status}`);
  return res.json();
}

/** Get a single Voice AI agent's full configuration. */
export async function getAgent(accessToken, agentId) {
  const res = await fetch(`${API_BASE}/voice-ai/agents/${agentId}`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`getAgent failed: ${res.status}`);
  return res.json();
}

/** Fetch a contact profile so call actions can write back to the right person. */
export async function getContact(accessToken, contactId) {
  const res = await fetch(`${API_BASE}/contacts/${encodeURIComponent(contactId)}`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`getContact failed: ${res.status}`);
  return res.json();
}

/** Update selected Voice AI agent config fields, e.g. prompt/welcome message. */
export async function patchAgent(accessToken, agentId, fields) {
  const res = await fetch(`${API_BASE}/voice-ai/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(fields)
  });
  if (!res.ok) throw new Error(`patchAgent failed: ${res.status}`);
  return res.json();
}

/** Add one or more tags to a HighLevel contact. */
export async function tagContact(accessToken, contactId, tags) {
  const res = await fetch(`${API_BASE}/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: "POST",
    headers: jsonHeaders(accessToken),
    body: JSON.stringify({ tags })
  });
  if (!res.ok) throw new Error(`tagContact failed: ${res.status}`);
  return res.json();
}

/** Add an analysis note to a HighLevel contact. */
export async function addContactNote(accessToken, contactId, body) {
  const res = await fetch(`${API_BASE}/contacts/${encodeURIComponent(contactId)}/notes`, {
    method: "POST",
    headers: jsonHeaders(accessToken),
    body: JSON.stringify({ body })
  });
  if (!res.ok) throw new Error(`addContactNote failed: ${res.status}`);
  return res.json();
}

function normalizeTranscript(rawTranscript) {
  const t = rawTranscript || [];
  if (typeof t === "string") {
    return t.split(/\r?\n/)
      .map((line, i) => {
        const match = line.match(/^\s*(bot|agent|assistant|ai|human|caller|user)\s*:\s*(.+)$/i);
        const speaker = match?.[1] || (i % 2 === 0 ? "agent" : "caller");
        const text = match?.[2] || line.trim();
        return {
          role: /agent|assistant|ai|bot/i.test(speaker) ? "agent" : "caller",
          text,
          tStart: i * 5,
          tEnd: i * 5 + 4
        };
      })
      .filter(t => t.text);
  }
  if (!Array.isArray(t)) return [];
  return t.map((m, i) => ({
    role: /agent|assistant|ai|bot/i.test(m.role || m.speaker || "") ? "agent" : "caller",
    text: m.text || m.message || m.content || "",
    tStart: m.tStart ?? m.startTime ?? m.start ?? i * 5,
    tEnd: m.tEnd ?? m.endTime ?? m.end ?? i * 5 + 4
  }));
}

/**
 * Normalize a raw GHL Voice AI call payload (from webhook or Call Log API)
 * into our internal call shape. Tolerant of field-name variations because the
 * exact webhook schema is one of the open items to confirm against a sandbox.
 */
export function normalizeCall(raw) {
  const transcript = normalizeTranscript(raw.transcript || raw.messages || raw.turns || []);
  return {
    id: raw.id || raw.callId || raw.call_id,
    ghlCallId: raw.callId || raw.call_id || raw.id,
    agentId: raw.agentId || raw.agent_id,
    locationId: raw.locationId || raw.location_id,
    contactName: raw.contactName || raw.contact?.name || "Unknown",
    contactId: raw.contactId || raw.contact?.id || null,
    direction: raw.direction || "inbound",
    startedAt: raw.startedAt || raw.dateAdded || new Date().toISOString(),
    durationSec: raw.durationSec ?? raw.duration ?? (transcript.length ? transcript[transcript.length - 1].tEnd : 0),
    outcome: raw.outcome || raw.status || "completed",
    transcript
  };
}
