# Custom Page URL

Use this URL in the HighLevel Marketplace Custom Page or Custom Menu Link configuration after replacing `APP_URL` with the HTTPS URL for the running app:

```text
APP_URL/?location_id={{location.id}}&user_email={{user.email}}
```

Example with an ngrok tunnel:

```text
https://example.ngrok-free.app/?location_id={{location.id}}&user_email={{user.email}}
```

HighLevel loads this URL in an iframe inside the customer's sub-account. The frontend is the Vue app served from `public/`, so no separate build artifact is required for the assignment.

The app reads the query string for reviewer context in the embedded dashboard:

- `location_id` shows which sub-account/location the iframe is opened from.
- `user_email` is shown only as page context if supplied by HighLevel.

OAuth and webhook ingestion still happen through backend endpoints:

```text
APP_URL/oauth/callback
APP_URL/webhooks/ghl
```
