# Incoming channel webhooks

In **Settings → Webhooks**, choose a channel, optionally name the service, and
select **Create webhook**. Copy the URL into the service's HTTP request action.
Use `POST`, `Content-Type: application/json`, and a JSON body:

```json
{ "text": "Hello from my service!" }
```

The same page includes copyable cURL and JavaScript examples, a **Send test
message** button, delivery status, and pause, replace-URL, and removal controls.
Channel settings also links to this page with that channel preselected.

Hosted Groovy URLs use `https://www.gogroovy.ai/api/hooks/...` directly, avoiding
the bare-domain redirect. **Copy URL** also corrects the address of existing
webhooks without changing their secret or channel; there is no need to replace
the webhook. Services that saved an older `https://gogroovy.ai/...` address
should re-copy the URL. The cURL example follows redirects and exits with an
error while preserving the response body when delivery fails.

## Delivery contract

- The URL is a secret, write-only credential for one channel. No login cookie,
  API key header, or separate service account is needed to post.
- Messages appear live with the service name and a Webhook badge. They use the
  existing unread and notification flow. They never automatically run a Mind.
- The required `text` field supports Groovy Markdown. Other fields, including
  `channel`, `username`, metadata, Slack blocks, and attachments, are ignored.
  This is a simple text webhook, not a full Slack payload implementation.
- Limits: 40,000 characters, 256 KiB JSON body, and 60 new messages per minute
  per webhook. `429` includes `Retry-After` in seconds.
- Success is HTTP `200` with `ok`, `message_id`, `channel_id`, and `duplicate`.
- An optional `Idempotency-Key` header (1–128 visible ASCII characters, no
  spaces) deduplicates retries with the same trimmed text. Reusing a key for
  different text returns `409`. Keep the same key when retrying uncertain
  deliveries. Deduplication lasts as long as the original message exists.
- Invalid/removed/replaced URLs return `404`; paused webhooks or lost channel
  access return `403`. Invalid JSON/text returns `400`, size violations `413`,
  and an incorrect content type `415`. Retry transient `503` responses with
  exponential backoff; do not continuously retry permanent errors.
- Use this from servers or automation tools, not public browser code where the
  URL would be exposed. Cross-origin browser requests are not enabled.

## Access and credential safety

Workspace admins and channel creators who are full members can manage webhooks
for their channels, including private channels. Guests cannot manage them.
Delivery rechecks the creator's current workspace/channel authority; leaving the
workspace, losing management rights, or archiving the channel prevents posting.
Switching the creator's active workspace does not break their integrations.

Credentials use 256 bits of randomness. Only their SHA-256 lookup hash and an
AES-256-GCM encrypted copy are stored. The table and delivery function are
service-role-only. List responses never contain credentials. URL reveal and
management require an authenticated channel manager. Treat URLs as secrets in
hosting/access logs as well; do not send them to analytics or error trackers.

Replacing a URL immediately invalidates the old one. Pausing preserves the URL.
Removing a webhook revokes its credential but preserves existing messages.
Delivery, rate accounting, and idempotency are atomic in PostgreSQL, including
concurrent requests. Duplicate deliveries do not trigger additional push alerts.

## Rollout

Apply `supabase/migrations/20260905010000_channel_incoming_webhooks.sql` before
deploying the feature. It adds one private table, one partial message index, and
one service-role delivery function; no backfill is needed. Do not expose the
new table through client grants or realtime publication.

The server reuses `LLM_KEY_ENCRYPTION_KEY` (32 bytes, base64), the existing
Supabase service-role credentials, and the normal notification setup. No new
external provider or subscription is needed. The copied URL uses the configured
`GROOVY_APP_URL` / `NEXT_PUBLIC_APP_URL` when present, otherwise the request
origin. Hosted Groovy's bare domain is normalized to its direct HTTPS `www`
address. Custom domains, preview deployments, and local development addresses
are preserved. Ensure that a self-hosted base URL is reachable directly by the
external service, without a redirect.

## Verification

```bash
npx tsx --test src/lib/chat/incomingWebhook.test.ts
npx tsx --test src/lib/chat/incomingWebhookCurl.test.ts
WEBHOOK_TEST_DATABASE_URL=postgresql://127.0.0.1:55489/postgres npx tsx --test src/lib/chat/incomingWebhookDatabase.test.ts
```

The optional database test must use an isolated local PostgreSQL instance. It
creates and drops its own uniquely named database and creates missing Supabase
role names on that local instance. It never migrates an existing application
database. It covers concurrent retries, quotas, channel/workspace isolation,
permission loss, pause, rotation, revocation, and service-role-only access.
