# HighLevel Marketplace / Custom Page Setup

This assignment uses a HighLevel Marketplace draft app with **App Type = Sub-Account** and a Custom Page. The Vue UI is hosted by this repo's Node server and embedded inside the customer's HighLevel location in an iframe; the backend receives OAuth callbacks, stores tokens per location, syncs Voice AI agents/call logs, and ingests new call events through webhooks.

## 1. Host the App

Run the app locally or deploy it, then expose it over HTTPS:

```bash
node server.js
ngrok http 3000
```

Use the HTTPS tunnel/deploy URL as `APP_URL` below.

## 2. Marketplace App Settings

Create a draft app in the HighLevel Marketplace portal and configure:

| Setting | Value |
|---|---|
| App type | Sub-Account |
| UI surface | Custom Page or Custom Menu Link |
| Redirect URL | `APP_URL/oauth/callback` |
| Custom Page URL | `APP_URL/?location_id={{location.id}}&user_email={{user.email}}` |
| Marketplace Webhook URL | `APP_URL/webhooks/ghl` |
| Global/Workflow Webhook URL | `APP_URL/webhooks/hl` and `APP_URL/webhooks/hl-workflow` |
| Placement | Left navigation / custom page |

## 3. Required Scopes

Request read access for the Voice AI surfaces used by the Copilot:

- Voice AI agents read/write
- Voice AI call logs read
- Contacts read/write
- Location/account context read, if required by the Marketplace portal

The exact scope labels can vary in the Marketplace UI, but the app needs permission to list agents, fetch agent details, update agent prompts when the operator clicks **Apply Fix**, list call logs, fetch call-log details, tag contacts, and add contact notes.

## 4. Per-Location Connection

Each sandbox/customer location connects independently:

1. The user installs the Sub-Account app.
2. HighLevel redirects to `APP_URL/oauth/callback` with an authorization code.
3. `server.js` exchanges the code through `lib/ghl.js`.
4. `lib/tokens.js` stores the resulting access/refresh token under that `locationId` in gitignored `data/tokens.json`.
5. `lib/sync.js` uses that token to sync agents and call logs for the installed location.
6. `lib/orchestrator.js` uses the same location token to tag contacts and add analysis notes after live calls are scored.

The embedded dashboard also receives lightweight page context through the Custom Page URL query string:

```text
APP_URL/?location_id={{location.id}}&user_email={{user.email}}
```

For this assignment, the dashboard displays that context so reviewers can see the in-account location. A production version should additionally validate any signed HighLevel iframe payload with the app secret before trusting user identity.

## 5. Environment Variables

Create a local `.env` from `.env.example` and keep it out of git:

```bash
GHL_CLIENT_ID=...
GHL_CLIENT_SECRET=...
GHL_REDIRECT_URI=APP_URL/oauth/callback
GHL_ED25519_PUBLIC_KEY=...
GHL_RSA_PUBLIC_KEY=...
LLM_API_KEY=...
LLM_PROVIDER=openai
```

The webhook public keys are optional overrides; the defaults in `lib/webhook.js` are used unless HighLevel rotates keys. `LLM_API_KEY` is optional. Without it, the dashboard still produces rule-based recommendations.

## 6. Webhooks

Configure a webhook subscription for Voice AI call/transcript events:

```text
APP_URL/webhooks/ghl
```

The server also exposes `APP_URL/webhooks/hl` as an alias for the global webhook setup under **Settings -> Integrations -> Webhooks**. Use it when wiring HighLevel's general event webhook UI:

| Field | Value |
|---|---|
| Webhook name | `Voice AI Copilot` |
| URL | `APP_URL/webhooks/hl` |
| Events | `OutboundCall`, `InboundCall`, `ContactTagAdded`, `NoteAdded`, plus Voice AI call completion events if available |
| Method | `POST` |

`server.js` verifies the webhook signature via `lib/webhook.js`, normalizes the payload in `lib/ghl.js`, scores the call, and updates the dashboard metrics/recommendations.

For live calls with both `locationId` and `contactId`, the orchestrator also writes back to HighLevel:

- contact score tags such as `voice-ai-call-success`, `voice-ai-call-partial`, or `voice-ai-call-failed`
- `needs-human-followup` when the call creates a human-review Use Action
- an analysis note summarizing health, deviations, Use Actions, and prompt/script recommendations

Agent prompt updates are not automatic; the dashboard exposes an **Apply Fix to Agent** button so the operator reviews the recommendation before writing it back.

## 7. Workflow Trigger

Use a HighLevel workflow when you want business logic to call the app after a tag or stage event:

1. Go to **Automations -> Workflows -> New Workflow -> Start from Scratch**.
2. Trigger: `Contact Tag Added`.
3. Filter: `Tag = needs-human-followup`.
4. Add action: `Webhook`.
5. Method: `POST`.
6. URL:

```text
APP_URL/webhooks/hl-workflow
```

7. Body:

```json
{
  "type": "ContactTagAdded",
  "locationId": "{{location.id}}",
  "contactId": "{{contact.id}}",
  "contactName": "{{contact.name}}",
  "contactEmail": "{{contact.email}}",
  "contactPhone": "{{contact.phone}}",
  "tag": "{{trigger.tag}}",
  "triggeredAt": "{{now}}"
}
```

The workflow endpoint acknowledges the event and logs it. This creates the feedback-loop hook without adding production workflow automation complexity to the assignment.

## 8. Webhook Security

For official HighLevel webhooks, `lib/webhook.js` verifies `X-GHL-Signature` or legacy `X-WH-Signature` public-key signatures.

For workflow/test webhooks, you can configure a shared HMAC secret:

```bash
HL_WEBHOOK_SECRET=your-shared-secret
```

Send the hex HMAC-SHA256 signature in either:

```text
x-hl-signature
x-webhook-signature
```

For local testing only, you can bypass verification:

```bash
VERIFY_WEBHOOKS=false node server.js
```

## 9. Test vs Live Modes

- **Sandbox/live mode:** install the Marketplace draft app into a HighLevel sandbox and complete OAuth. The server syncs real agents and call logs.
- **Fixture mode:** run with no `.env`; the dashboard loads sample agents/calls from `fixtures/` so reviewers can evaluate the Monitor + Analyze loop without credentials.
- **Local webhook test:** set `VERIFY_WEBHOOKS=false` and run `npm run test:webhook`.

## 10. Install + Verify

1. Start the server with the env vars loaded.
2. Install the draft app into the HighLevel sandbox.
3. Complete the OAuth flow.
4. Confirm the callback prints an install/sync log.
5. Open the Custom Page in the sandbox left navigation.
6. Confirm the dashboard shows live/sandbox mode, agents, call metrics, recommendations, and Use Actions.

If the sandbox has no Voice AI call history yet, use the fixture demo or trigger `npm run simulate` locally with `VERIFY_WEBHOOKS=false` to show the same Monitor + Analyze workflow.
