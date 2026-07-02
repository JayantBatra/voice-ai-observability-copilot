// Manually re-sync a location's agents + call history from HighLevel.
// Useful after adding a new agent, or to backfill on demand.
//
// Usage:  node scripts/sync.mjs <locationId>
//         node scripts/sync.mjs            (syncs all installed locations)

import "../lib/env.js";
import { syncLocation } from "../lib/sync.js";
import { listLocations } from "../lib/tokens.js";

const arg = process.argv[2];
const locations = arg ? [arg] : listLocations();

if (!locations.length) {
  console.error("No installed locations found. Install the app (complete OAuth) first, or pass a locationId.");
  process.exit(1);
}

for (const loc of locations) {
  try {
    const r = await syncLocation(loc);
    console.log(`location ${loc}: synced ${r.agents} agents, ${r.calls} calls`);
  } catch (e) {
    console.error(`location ${loc}: sync failed — ${e.message}`);
  }
}
