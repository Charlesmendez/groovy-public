# Groovy AI-Agent CLI Setup Instructions

Copy this whole document into the user's AI coding agent for developer source setup, enterprise self-hosting, or advanced local setup.

This is **not** the normal personal-user install path. Personal users usually buy or receive a license, sign in to the Groovy account portal, download the connector/current source snapshot they are entitled to, install the connector, and add their own provider keys. They do not need their own Vercel, Supabase, or Fly.io account just to use Groovy.

For developer and enterprise setup, the agent should ask the user for the missing values, write secrets only to local env files or platform secret stores, and run the setup through CLI commands wherever possible.

Do not paste secrets into source files, Markdown files, screenshots, logs, GitHub issues, or pull requests.

## Mission

Set up a Groovy developer checkout, self-hosted deployment, or enterprise environment using the command line.

Groovy uses this reference stack:

- Vercel for the Next.js web app and API routes.
- Supabase for auth, Postgres, RLS, migrations, and private storage.
- Fly.io for the websocket relay.
- Stripe for Groovy Personal yearly subscriptions.
- Datagran for Groovy Memory and Datagran-backed Data Integrations when enabled.
- Customer-owned model provider keys for OpenAI, Anthropic, Google, Azure OpenAI, AWS Bedrock, Groq, Mistral, xAI, or other supported providers.
- The Groovy CLI package, `@gogroovy/cli`, for setup checks and non-browser setup steps.

Developer and enterprise users may replace Groovy's reference infrastructure with their own Vercel, Supabase, Fly, Stripe, Datagran, and provider accounts.

## Rules For The AI Agent

1. Ask questions before choosing defaults that affect billing, hosting, source access, or secrets.
2. Prefer CLI commands over dashboard clicks.
3. Use dashboard/browser steps only when the provider requires OAuth, account creation, payment setup, or manual secret creation.
4. Never print raw secrets after the user provides them.
5. Store local secrets in `.env.local` unless the user chooses a different env file.
6. Store hosted secrets in the target platform secret manager, such as Vercel env vars, Supabase secrets, or Fly secrets.
7. Run verification commands after each setup phase.
8. If a command is unavailable in the current CLI, explain the exact manual fallback and continue.

## First Questions To Ask

Ask the user these questions and wait for answers:

1. Is this normal personal use, developer source setup, or enterprise self-hosting?
2. If this is normal personal use, does the user only need account portal, connector, license activation, and provider-key setup?
3. If this is developer or enterprise setup, is the target local only, Vercel/Supabase/Fly, Docker, or another deployment target?
4. What app URL should Groovy use? Default local value: `http://localhost:3000`.
5. What relay URL should Groovy use? Default production value: `wss://groovy-relay.fly.dev`.
6. For self-hosting, what Supabase project or replacement backend should be used?
7. Which model providers should be configured?
8. Does the user want Groovy Memory enabled?
9. Does the user have a Datagran account and `DATAGRAN_API_KEY`?
10. Which Datagran data integrations should be enabled?
11. Are integrations OAuth, existing Datagran connection IDs, Web Pixel, or a mix?
12. Does the user have a Groovy license key?
13. Should the local connector be installed, run from source, or skipped?

## Install Or Run The CLI

If working inside the Groovy repo:

```bash
npm install
npm run groovy -- doctor --json --env-file .env.local
```

If using the published CLI:

```bash
npm install -g @gogroovy/cli
groovy doctor --json --env-file .env.local
```

If the package is not published yet, use the repo command:

```bash
npm run groovy -- help
```

## Local Env File

Create or update `.env.local` with only the values needed for this setup.

Core app values:

```bash
NEXT_PUBLIC_APP_URL=http://localhost:3000
GROOVY_APP_URL=http://localhost:3000
GROOVY_RELAY_URL=wss://groovy-relay.fly.dev
```

Supabase values:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Security values:

```bash
RELAY_JWT_SECRET=...
LLM_KEY_ENCRYPTION_KEY=...
GROOVY_LICENSE_PUBLIC_KEY_PEM=...
GROOVY_LICENSE_PRIVATE_KEY_PEM=...
```

Optional browser/Home Screen notifications:

```bash
WEB_PUSH_VAPID_PUBLIC_KEY=...
WEB_PUSH_VAPID_PRIVATE_KEY=...
WEB_PUSH_CONTACT=mailto:notifications@example.com
```

Stripe values for Groovy Personal:

```bash
STRIPE_SECRET_KEY=...
STRIPE_GROOVY_PERSONAL_PRICE_ID=...
STRIPE_WEBHOOK_SECRET=...
```

Provider keys. Configure only the providers the user chooses:

```bash
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_GENERATIVE_AI_API_KEY=...
AZURE_OPENAI_API_KEY=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
GROQ_API_KEY=...
MISTRAL_API_KEY=...
XAI_API_KEY=...
```

Datagran Memory and Data Integrations:

```bash
DATAGRAN_API_KEY=...
DATAGRAN_CHAT_MODEL=claude-opus-4-6
```

If `DATAGRAN_API_KEY` is missing, Groovy Memory is disabled and Datagran-backed Data Integrations are unavailable until configured.

## Doctor And Provider Checks

Run:

```bash
npm run groovy -- doctor --env-file .env.local --json
npm run groovy -- provider-keys status --env-file .env.local --json
npm run groovy -- memory status --env-file .env.local --json
npm run groovy -- integrations list --json
```

Published CLI equivalent:

```bash
groovy doctor --env-file .env.local --json
groovy provider-keys status --env-file .env.local --json
groovy memory status --env-file .env.local --json
groovy integrations list --json
```

## License Activation

Ask the user for their Groovy license key, then run:

```bash
npm run groovy -- license activate \
  --app "$GROOVY_APP_URL" \
  --license-key "$GROOVY_LICENSE_KEY" \
  --env-file .env.local \
  --json
```

Then check status:

```bash
npm run groovy -- license status \
  --app "$GROOVY_APP_URL" \
  --json
```

If the status command requires a web session, ask the user to log in through the portal and provide the supported session/auth method. Do not ask for a password.

## Datagran Memory Setup

If the user wants Groovy Memory:

```bash
npm run groovy -- memory setup \
  --env-file .env.local \
  --datagran-api-key "$DATAGRAN_API_KEY" \
  --datagran-chat-model "${DATAGRAN_CHAT_MODEL:-claude-opus-4-6}" \
  --json
```

Verify:

```bash
npm run groovy -- memory status --env-file .env.local --json
```

Expected behavior:

- `datagranApiKeyConfigured: true`
- `memoryEnabled: true`

## Datagran Data Integrations

List supported integrations:

```bash
npm run groovy -- integrations list --json
```

Supported integrations include:

- Facebook Ads
- Facebook Leads
- Instagram
- Google Ads
- LinkedIn Ads
- TikTok
- Google Drive
- Google Calendar
- Gmail
- Postgres or Supabase
- Firecrawl
- Salesforce
- Web Pixel

For each requested provider:

```bash
npm run groovy -- integrations test \
  --provider "$PROVIDER" \
  --env-file .env.local \
  --json
```

Use browser/OAuth handoff only where the integration provider requires it. For existing Datagran connection IDs or Web Pixel setup, ask the user for the provider-specific value and store it in the approved env file or secret manager.

## Local Web App Setup

Run:

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

Verify:

```bash
npm run lint
npx tsc --noEmit --pretty false
```

## Local Relay Setup

Run the relay from source:

```bash
npm run relay
```

For production relay on Fly.io, verify app and secrets:

```bash
fly apps list
fly secrets list -a groovy-relay
```

Set missing Fly secrets through CLI:

```bash
fly secrets set RELAY_JWT_SECRET="$RELAY_JWT_SECRET" -a groovy-relay
```

## Local Connector Setup

Print connector commands:

```bash
npm run groovy -- connector command --json
```

Run the local connector from source for development:

```bash
cd apps/connector
GROOVY_APP_URL="${GROOVY_APP_URL:-http://localhost:3000}" \
node connector.mjs \
  --relay "${GROOVY_RELAY_URL:-wss://groovy-relay.fly.dev}" \
  --kill-others \
  --no-autostart
```

Run the WhatsApp connector from source:

```bash
cd apps/connector
WHATSAPP_GROUP_NAME="${WHATSAPP_GROUP_NAME:-Groovy}" \
GROOVY_APP_URL="${GROOVY_APP_URL:-http://localhost:3000}" \
node connector.mjs \
  --relay "${GROOVY_RELAY_URL:-wss://groovy-relay.fly.dev}" \
  --whatsapp \
  --kill-others \
  --no-autostart
```

## Vercel Setup

Use Vercel CLI where possible:

```bash
vercel link
vercel env ls
```

Add required values:

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add RELAY_JWT_SECRET production
vercel env add LLM_KEY_ENCRYPTION_KEY production
vercel env add STRIPE_SECRET_KEY production
vercel env add STRIPE_GROOVY_PERSONAL_PRICE_ID production
vercel env add STRIPE_WEBHOOK_SECRET production
vercel env add DATAGRAN_API_KEY production
vercel env add DATAGRAN_CHAT_MODEL production
```

Repeat for `preview` and `development` if the user wants those environments configured.

Deploy:

```bash
vercel deploy
```

Production deploy:

```bash
vercel deploy --prod
```

## Supabase Setup

Use Supabase CLI where possible:

```bash
supabase login
supabase link --project-ref "$SUPABASE_PROJECT_REF"
supabase db push
```

If CLI login or DB password is unavailable, ask the user to apply migrations through:

```text
Supabase Dashboard > SQL Editor
```

Required production buckets:

- `groovy-downloads`
- `groovy-source-snapshots`

Create buckets with Supabase CLI or dashboard. Production downloads should use authenticated access and signed URLs.

## Stripe Setup

Use Stripe CLI where possible:

```bash
stripe login
stripe products list
stripe prices list --lookup-keys groovy_personal_yearly_usd
```

Groovy Personal should be:

- Product: `Groovy Personal`
- Price: `$49.99/year`
- Lookup key: `groovy_personal_yearly_usd`
- Env var: `STRIPE_GROOVY_PERSONAL_PRICE_ID`

Webhook events:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.payment_succeeded
invoice.payment_failed
charge.refunded
```

Webhook target:

```text
https://YOUR_APP_URL/api/billing/stripe/webhook
```

## Final Verification

Run:

```bash
npm run groovy -- doctor --env-file .env.local --json
npm run groovy -- provider-keys status --env-file .env.local --json
npm run groovy -- memory status --env-file .env.local --json
npm run lint
npx tsc --noEmit --pretty false
```

Then verify:

1. The app opens.
2. The user can log in.
3. License activation works.
4. Provider keys are configured.
5. Datagran Memory status matches the user's choice.
6. Requested Datagran integrations are configured or clearly pending OAuth/browser handoff.
7. The relay is reachable.
8. The connector can pair or run locally.
9. Personal checkout uses the `$49.99/year` Stripe price.
10. No raw secrets were committed to Git.

## Report Back To The User

Summarize:

- What was configured.
- Which env file or platform secret manager was updated.
- Which commands passed.
- Which browser/OAuth/account steps remain.
- Whether Groovy Memory and Datagran integrations are enabled.
- Whether the setup is personal, developer, or enterprise.
