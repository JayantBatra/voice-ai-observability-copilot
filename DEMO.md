# Demo Script

Use this script for a 2-5 minute Loom recording. The live sandbox path is preferred; the fixture path is included so reviewers can still run the Copilot without HighLevel credentials.

## Live HighLevel Sandbox Demo

### 0:00 - Setup

Show the terminal running the app:

```bash
node server.js
```

Mention that the Marketplace draft app is configured with:

- Custom Page: `APP_URL/?location_id={{location.id}}&user_email={{user.email}}`
- OAuth callback: `APP_URL/oauth/callback`
- Marketplace webhook: `APP_URL/webhooks/ghl`
- Global Settings webhook: `APP_URL/webhooks/hl`
- Workflow webhook: `APP_URL/webhooks/hl-workflow`

### 0:30 - Install / Ingest

Open the HighLevel sandbox and show the Copilot Custom Page in the left navigation.

Point out the status strip:

- `Live HighLevel sandbox`
- embedded or synced location id
- last synced time
- last analyzed time

Explain that OAuth installation triggers agent sync and call-log backfill, while new Voice AI calls arrive through the webhook.

### 1:15 - Dashboard

Show the unified overview:

- calls scored
- goal completion
- average health
- open Use Actions
- agent health table

Click an agent with a visible top failure or low health.

### 2:00 - Insight

In the agent deep-dive, show:

- observability parameters derived from the agent goal/KPI template
- failure breakdown
- prompt/script recommendations
- supporting call evidence

Open one supporting call.

### 3:00 - Evidence

In the call viewer, show:

- transcript segments highlighted inline
- KPI checklist
- deviations with timestamps
- sentiment/turn/duration context
- HighLevel action buttons for contact tagging, analysis notes, and prompt updates

Explain the bidirectional loop:

- scoring runs automatically after webhook/backfill ingestion
- live HighLevel calls with contact context are tagged automatically
- an analysis note is added to the contact
- the operator can manually click **Apply Fix to Agent** after reviewing a prompt recommendation

Close by explaining the loop: raw transcript -> KPI scoring -> deviation detection -> Use Action/recommendation -> tags/notes in HighLevel -> operator-approved prompt/script update.

## Fixture Fallback Demo

Use this when a reviewer wants to run the project locally without a HighLevel sandbox.

```bash
node server.js
# open http://localhost:3000
```

The dashboard starts in `Demo fixture mode` using `fixtures/agents.json` and `fixtures/calls.json`.

To show real-time ingestion behavior locally:

```bash
VERIFY_WEBHOOKS=false node server.js
npm run test:webhook
```

Then refresh the dashboard and show that a new call was scored and reflected in the Use Actions/recommendations.

Fixture calls do not have real HighLevel contact IDs, so write-back buttons show a safe message: `This action requires a live HighLevel contact.`

## What To Say

This is an assignment-scale observability copilot. The production-heavy pieces are intentionally minimized, but the required loop is implemented:

- Monitor: ingest transcripts from HighLevel sync/webhooks or demo fixtures.
- Analyze: score KPIs/deviations, rank failures, and generate prompt/script recommendations.
- Dashboard: give operators a unified view, drilldown evidence, Use Actions, and manual write-back controls.
- Bidirectional actions: live calls can auto-tag contacts and add analysis notes in HighLevel; prompt changes require an operator click.
