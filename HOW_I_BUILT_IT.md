# How I Built It

A short narrative of the decisions behind the Voice AI Observability Copilot — what I built, in what order, and (just as important) what I deliberately left out to avoid over-engineering.

## 1. I started from the problem, not the stack

The brief is really two loops: **Monitor** (score calls against goals) and **Analyze** (surface issues + recommend fixes). Before writing code I pinned down the vocabulary that everything else hangs off:

- a **KPI taxonomy** (outcome, conversation-quality, efficiency), and
- six concrete **deviation types** — missed goal, missed opportunity, script deviation, recovery failure, compliance breach, data gap.

Every deviation carries a severity, a transcript span, and a fix category. That triple is the join between Monitor and Analyze: the same object that flags a call is what becomes a recommendation and a highlighted transcript segment. Fixing the data model first meant the engine, API, and UI never had to negotiate shapes later.

## 2. The core bet: a deterministic engine with the LLM as a second pass

The single most important design decision was **not** to throw every transcript at an LLM and ask "how did this call go?" Instead:

- **`lib/engine.js` is pure and deterministic.** Required-step coverage, data capture (regex for phone/email), goal completion, sentiment (lexicon), dead-air (from turn timings), compliance denylist, qualification logic. It runs on 100% of calls, costs nothing, and is fully unit-testable.
- **`lib/analysis.js` adds the LLM only where judgment helps** — writing the root cause and the actual prompt edit for the top recommendation. It's gated on `LLM_API_KEY`, and if the key is missing or the call fails, it falls back to rule-based templates. Same output shape either way.

This keeps the product cheap, reproducible, and resilient: the dashboard is fully functional with no LLM at all, and the LLM is an enhancement, not a dependency. It's the "cheap filter → expensive judge" pattern.

## 3. Deliberately lean choices (anti-over-engineering)

The architecture doc sketched Postgres + Redis + BullMQ + a monorepo with a bundled Vue SPA. For a single-account demo that's ceremony, so I cut it:

- **No database.** An in-memory store (`lib/store.js`) seeded from fixtures. In production it's rebuilt from the GHL Call Log backfill. Swapping in Postgres later touches exactly one file.
- **No job queue.** Scoring is synchronous on ingest — a call is scored the moment it arrives. A queue only earns its keep at high volume.
- **No web framework.** The server is Node's built-in `http` module. No Express, no middleware stack.
- **No frontend build.** Vue 3 via CDN, plain `app.js`. No Vite, no `node_modules`, no bundler config.
- **Net result: `node server.js` with zero `npm install`.** That was a conscious target — a reviewer should run it in one command, and fewer moving parts means fewer ways for it to break (which also mattered because I couldn't run a build in my authoring environment).

Each of these is a defensible "not yet," not a gap — and the seams to upgrade are isolated to one module apiece.

## 4. Build order

1. **Fixtures first** (`fixtures/`) — two realistic agents (dental booking, solar qualification) and eight transcripts engineered to exercise every deviation type: a clean success, a skipped-timezone drop, a missing-callback data gap, a frustrated caller, a dead-air/overlong call, a qualified booking, a qualified-but-not-booked miss, and a correctly-declined renter. Fixtures doubled as the test oracle.
2. **Engine** — scored those fixtures deterministically.
3. **Analysis** — aggregated deviations into ranked recommendations (severity × frequency), with the optional LLM path.
4. **Server + store** — wired the API, webhook, and OAuth callback.
5. **Vue dashboard** — the three surfaces.
6. **Tests + docs.**

## 5. QA approach

`test/engine.test.js` asserts a known-correct outcome for each fixture call (e.g. the frustrated caller must produce a `recovery_failure` and a `human_review` Use-Action and a health of 0; the renter must produce **no** penalty). This locks the scoring so future edits can't silently regress it. The analysis test checks that recommendations are ranked high-severity-first.

One QA-driven refinement worth calling out: a correctly-disqualified renter was initially penalized for "skipping" the downstream qualification steps. That's a false positive — declining a renter is correct behavior — so the engine suppresses those step-misses once disqualification is detected. It's the kind of thing you only catch by scoring real-ish transcripts and checking the output against intent.

> Note on execution: the tests were **hand-traced** against the fixtures while writing them because the build sandbox couldn't start a Node process. They're written to run with `npm test` (`node --test`); that's the verification step to run on a normal machine.

## 6. The real HighLevel surface

`lib/ghl.js` is not a mock — it implements the OAuth authorization-code exchange, token refresh, and the Voice AI Call Log `list`/`get` endpoints as documented, plus `normalizeCall()` which maps a raw GHL payload (webhook or API) into the internal shape. `normalizeCall()` *is* exercised in the demo via `POST /webhooks/ghl`. The live API calls simply need a reachable sandbox and the `GHL_*` env vars; they weren't run here because no sandbox was reachable from the build environment. The server also honors the Custom Pages hosting rules (frame-ancestors CSP, no `X-Frame-Options`) so it embeds cleanly.

## 7. Making it fully live (second pass)

The first pass ran on fixtures. The second pass wired the whole real HighLevel pipeline so the app functions against a live sandbox, not just seed data:

- **OAuth token persistence + refresh** (`lib/tokens.js`) — per-location tokens in `data/tokens.json`, auto-refreshed 60s before expiry. The `/oauth/callback` stores them on install.
- **Live agent sync + call backfill** (`lib/sync.js`) — on install the server fetches the location's real Voice AI agents, merges each with the operator's `config/observability.json` (GHL owns the prompt; the KPI checklist is a QA decision, so it stays config-driven and honest), then pages through the Call Log API to backfill history. Re-runnable via `npm run sync`.
- **Signed webhooks** (`lib/webhook.js`) — I looked up the actual mechanism rather than guessing: HighLevel signs the raw body with Ed25519 (`X-GHL-Signature`, current) and RSA (`X-WH-Signature`, legacy, deprecated 2026-07-01). The server verifies the raw bytes before parsing, Ed25519-first with RSA fallback, using HighLevel's published public keys. `VERIFY_WEBHOOKS=false` unlocks local `curl`/`npm run simulate` testing.
- **Two boot modes** — no install → fixtures (instant demo); installed → live sync, fixtures ignored.
- **LLM** — defaults to OpenAI (`gpt-4o-mini`) per the chosen provider, key supplied at runtime.

The one thing I could not do is execute this against a live sandbox from the build environment (no Node runtime there, no HighLevel account), so the live paths are written to the documented spec and verified by reading rather than a live round-trip. Everything needed to run them — credentials + a runtime — is now the operator's to provide.

## 8. What I'd still do next

Move the in-memory store to Postgres for durability at scale; add a background queue if call volume warrants it; and add the third loop — letting an operator apply a recommended prompt diff straight back to the agent via the Agents API, closing the flywheel end to end.
