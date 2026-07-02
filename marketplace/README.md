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
| Webhook URL | `APP_URL/webhooks/ghl` |
| Placement | Left navigation / custom page |

## 3. Required Scopes

Request read access for the Voice AI surfaces used by the Copilot:

- Voice AI agents read
- Voice AI call logs read
- Location/account context read, if required by the Marketplace portal

The exact scope labels can vary in the Marketplace UI, but the app needs permission to list agents, fetch agent details, list call logs, and fetch call-log details.

## 4. Per-Location Connection

Each sandbox/customer location connects independently:

1. The user installs the Sub-Account app.
2. HighLevel redirects to `APP_URL/oauth/callback` with an authorization code.
3. `server.js` exchanges the code through `lib/ghl.js`.
4. `lib/tokens.js` stores the resulting access/refresh token under that `locationId` in gitignored `data/tokens.json`.
5. `lib/sync.js` uses that token to sync agents and call logs for the installed location.

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

`server.js` verifies the webhook signature via `lib/webhook.js`, normalizes the payload in `lib/ghl.js`, scores the call, and updates the dashboard metrics/recommendations.

## 7. Test vs Live Modes

- **Sandbox/live mode:** install the Marketplace draft app into a HighLevel sandbox and complete OAuth. The server syncs real agents and call logs.
- **Fixture mode:** run with no `.env`; the dashboard loads sample agents/calls from `fixtures/` so reviewers can evaluate the Monitor + Analyze loop without credentials.
- **Local webhook test:** set `VERIFY_WEBHOOKS=false` and run `npm run simulate`.

## 8. Install + Verify

1. Start the server with the env vars loaded.
2. Install the draft app into the HighLevel sandbox.
3. Complete the OAuth flow.
4. Confirm the callback prints an install/sync log.
5. Open the Custom Page in the sandbox left navigation.
6. Confirm the dashboard shows live/sandbox mode, agents, call metrics, recommendations, and Use Actions.

If the sandbox has no Voice AI call history yet, use the fixture demo or trigger `npm run simulate` locally with `VERIFY_WEBHOOKS=false` to show the same Monitor + Analyze workflow.
