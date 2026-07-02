// tokens.js — per-location OAuth token store with auto-refresh.
//
// File-backed (data/tokens.json) so tokens survive restarts without a database.
// One JSON object keyed by locationId. getValidAccessToken() transparently
// refreshes a token that's within 60s of expiry. Swapping to a real secret
// store later means replacing read()/write() only.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { refreshToken } from "./ghl.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "tokens.json");

function read() {
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return {}; }
}
function write(obj) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(obj, null, 2));
}

/** Persist the token response from an OAuth exchange/refresh. */
export function saveTokens(tokenResponse) {
  const { access_token, refresh_token, expires_in, locationId, companyId } = tokenResponse;
  const store = read();
  const key = locationId || companyId;
  if (!key) throw new Error("Token response missing locationId/companyId");
  store[key] = {
    locationId: key,
    access_token,
    refresh_token,
    expiresAt: Date.now() + (expires_in ? expires_in * 1000 : 3600 * 1000)
  };
  write(store);
  return store[key];
}

export function listLocations() {
  return Object.keys(read());
}

export function hasTokens() {
  return listLocations().length > 0;
}

/** Return a currently-valid access token for a location, refreshing if needed. */
export async function getValidAccessToken(locationId) {
  const store = read();
  const entry = store[locationId];
  if (!entry) throw new Error(`No tokens for location ${locationId}. Install the app first.`);
  if (Date.now() < entry.expiresAt - 60_000) return entry.access_token;

  const refreshed = await refreshToken(entry.refresh_token);
  const saved = saveTokens({ ...refreshed, locationId });
  return saved.access_token;
}
