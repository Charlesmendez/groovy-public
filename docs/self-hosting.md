# Self-hosting Groovy

Groovy's self-hosted distribution runs the Next.js web application and the
always-on relay in Docker, while using Supabase for Auth, Postgres, Storage,
and Realtime. It does not require a Stripe account or a hosted Groovy license
row at runtime. Use of the source and self-hosted distribution remains subject
to `LICENSE.md`: personal use requires Groovy Personal rights, and company,
team, client, or other commercial use requires Groovy Enterprise rights.

## Prerequisites

- Docker Engine with Docker Compose v2.
- Node.js 22 and npm when running migrations from the checkout.
- Supabase CLI.
- A hosted Supabase project, or the official local stack started with
  `supabase start`.
- At least one model provider credential, supplied server-side or saved
  per-user through Groovy's encrypted key settings.

Groovy does not vendor a partial Supabase replacement. Auth, Storage, Realtime,
and the database policies are coupled enough that a hosted project or the
official local Supabase stack is the supported configuration.

## 1. Configure the environment

Copy the example and replace every placeholder:

```bash
cp .env.self-hosted.example .env
```

Generate independent high-entropy values for:

- `RELAY_JWT_SECRET`
- `LLM_KEY_ENCRYPTION_KEY`
- `HARNESS_THREAD_TOKEN_SECRET`
- `SCHEDULER_CRON_SECRET`

On Vercel, set `CRON_SECRET` to the same value as
`SCHEDULER_CRON_SECRET`; Vercel supplies that value as the bearer token for
the cron declared in `vercel.json`.

`GROOVY_APP_URL` and `GROOVY_RELAY_URL` must be browser-reachable URLs. Use
HTTPS/WSS behind a reverse proxy outside local development.

To enable browser and installed Home Screen notifications, generate one VAPID
pair for this deployment and keep the private half server-side:

```bash
npx web-push generate-vapid-keys --json
```

Set `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and a
`WEB_PUSH_CONTACT` value such as `mailto:notifications@example.com`. Push
requires a secure HTTPS origin outside localhost.

Do not configure Stripe for self-hosting. Compose sets
`GROOVY_EDITION=self-hosted`, which switches off hosted checkout, metering,
and online license-row checks. This is a deployment-mode switch, not a grant
of license rights. Outside Compose, set that edition explicitly; deployments
default to the cloud edition so a missing environment variable cannot
accidentally disable hosted access controls.

## 2. Prepare Supabase

For a hosted project:

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push --include-all --yes
```

For the official local stack:

```bash
npx supabase start
npx supabase db reset
```

Copy the local URL, anonymous key, and service-role key printed by the CLI into
`.env`. The service-role key is server-only; never expose it as a
`NEXT_PUBLIC_*` value.

## 3. Start web and relay

```bash
docker compose up --build -d
docker compose ps
```

The defaults expose:

- Web: `http://localhost:3000`
- Relay: `ws://localhost:8080`

The relay is the always-on scheduler tick source for self-hosted deployments.
It authenticates each tick with `SCHEDULER_CRON_SECRET`; the web route also
accepts the same bearer secret for platform cron invocations.

## 4. Configure a local connector

The connector has no hosted-service fallback. Supply both endpoints:

```bash
cd apps/connector
GROOVY_APP_URL=http://localhost:3000 \
GROOVY_RELAY_URL=ws://localhost:8080 \
node connector.mjs --relay ws://localhost:8080
```

Pair the connector from the dashboard before enabling browser, filesystem,
WhatsApp, voice, or other machine-local capabilities.

## 5. Optional Datagran features

Groovy works without Datagran. When `DATAGRAN_API_KEY` is unset, `remember`
and `recall` use the user's private Wiki, while Datagran semantic ranking and
Datagran-backed Data Integrations remain unavailable.

Groovy Memory and Datagran-backed Data Integrations require a Datagran account
when enabled:

- `DATAGRAN_API_KEY`
- `DATAGRAN_CHAT_MODEL`

## Operations and security

- Back up the Supabase database and private Storage buckets.
- Keep the service-role key, VAPID private key, and all four application
  secrets server-side.
- Rotate a compromised harness API key from the Harness editor; raw keys are
  shown only once and only hashes are stored.
- Put web and relay behind TLS before exposing them to the internet.
- Restrict widget origins and use secret keys for server-to-server API calls.
- Run `npx supabase db push --include-all --yes` after upgrading.

Verification:

```bash
curl -fsS http://localhost:3000/api/config/edition
curl -fsS http://localhost:8080/healthz
docker compose logs --tail=100 web relay
npx tsc --noEmit --pretty false
```

The edition response should report `"selfHosted": true`. An authorized
self-hosted deployment can run the orchestrator without a local license row or
Stripe configuration.
