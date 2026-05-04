# Groovy Reference Infrastructure

This document describes the current Groovy-operated reference infrastructure so developers and enterprise customers can replace it with their own accounts and keys.

Do not copy real secret values into documentation. Use placeholders and ask the operator for values at setup time.

## Core Services

- Next.js app: main web app and API routes.
- Supabase: Auth, Postgres, Storage, migrations, RLS.
- Relay: `apps/relay`, WebSocket/device bridge, deployable to Fly.io.
- Connector: `apps/connector`, local Mac/Windows/headless runtime.
- Stripe: Groovy Personal yearly subscription and billing portal.
- Portal/CLI downloads: target system for licensed installers and source snapshots.
- GitHub: delayed source-available mirror, contribution surface, and legacy connector release automation during transition.
- npm: Groovy CLI publishing under `@gogroovy/cli`.

## Required Environment Names

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` or `NEXT_SUPABASE_SERVICE_ROLE_KEY`
- `RELAY_JWT_SECRET`
- `LLM_KEY_ENCRYPTION_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_GROOVY_PERSONAL_PRICE_ID`
- `GROOVY_LICENSE_PRIVATE_KEY_PEM`
- `GROOVY_LICENSE_PUBLIC_KEY_PEM` or `NEXT_PUBLIC_GROOVY_LICENSE_PUBLIC_KEY_PEM`
- `GROOVY_ADMIN_EMAILS`
- `ENTERPRISE_SALES_EMAIL` (defaults to `sales@gogroovy.ai`)
- `RESEND_API_KEY` and `ENTERPRISE_SALES_FROM` if direct sales email delivery uses Resend
- `SENDGRID_API_KEY` and `SENDGRID_FROM_EMAIL` can also deliver enterprise sales email when Resend is not configured
- `DATAGRAN_API_KEY` when Groovy Memory or Datagran-backed Data Integrations are enabled
- `DATAGRAN_CHAT_MODEL` when Groovy Memory is enabled

## Model Provider Keys

Customers should bring their own provider credentials by default.

Common provider env names:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `AZURE_OPENAI_API_KEY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `GROQ_API_KEY`
- `MISTRAL_API_KEY`
- `XAI_API_KEY`

## Datagran Memory and Data Integrations

Datagran is used for durable memory and data integrations. Developers and enterprise customers need a Datagran account when enabling Groovy Memory or Datagran-backed Data Integrations.

Required or strongly recommended:

- `DATAGRAN_API_KEY`
- `DATAGRAN_CHAT_MODEL`

Supported data integrations include Google Ads, Facebook Ads, Facebook Leads, Instagram, LinkedIn Ads, TikTok, Google Drive, Google Calendar, Gmail, Postgres/Supabase, Firecrawl, Salesforce, and Web Pixel.

If `DATAGRAN_API_KEY` is missing, memory should be treated as disabled and Datagran integrations should be treated as unavailable until configured.

## Optional Integrations

- Aiyra/OpenClaw voice: `AIYRA_BASE_URL`, `OPENCLAW_BASE_URL`, and related voice/wake-word env.
- Kapso WhatsApp/company messaging: Kapso API env.
- Vercel generated-site deployment: Vercel API env.
- Hosted Mac bootstrap: hosted connector tarball URL, relay URL, app URL, and admin allowlist.

## CLI Verification

Run:

```bash
npm run groovy -- doctor --env-file .env.local
npm run groovy -- memory status --env-file .env.local
npm run groovy -- integrations list
```

## npm CLI Publishing

The publishable CLI package lives at:

```text
packages/groovy-cli
```

Package name:

```text
@gogroovy/cli
```

Publishing requires an npm account with access to the `@gogroovy` npm organization and a GitHub Actions secret:

```text
NPM_TOKEN
```

Use an npm automation token or granular access token scoped to publish `@gogroovy/cli`. Do not use a broad personal npm token if a narrower token is available.

Publish by pushing a CLI tag:

```bash
git tag -a cli-v0.2.1 -m "Publish Groovy CLI v0.2.1"
git push origin cli-v0.2.1
```

or run:

```text
Actions > Publish Groovy CLI to npm > Run workflow
```

## Licensed Artifact Storage

Downloads and source snapshots can use permanent HTTPS URLs during development, but production should use private Supabase Storage references:

```text
supabase://<bucket>/<path>
storage://<bucket>/<path>
```

The account download API verifies the user license and converts those references into short-lived signed URLs.

Admin artifact creation can send either `fileUrl`/`archiveUrl` or `storageBucket` + `storagePath`.

## Enterprise and Reseller Exports

Enterprise admins can export true-up usage:

```text
GET /api/enterprise/usage-report?format=csv
```

Authorized enterprise resellers can configure markup and export billing data:

```text
GET /api/reseller/billing/settings
POST /api/reseller/billing/settings
GET /api/reseller/billing/export?format=csv
```

Installed apps can check for licensed updates:

```text
POST /api/updates/check
```

Security advisories are exposed through:

```text
GET /api/security/advisories
POST /api/security/advisories
```

Optional enterprise GitHub source access can be automated with:

```text
GITHUB_SOURCE_REPO=Charlesmendez/groovy
GITHUB_SOURCE_ACCESS_TOKEN=<fine-grained GitHub token with repository administration access>
```

Then Groovy admins can invite enterprise GitHub users through:

```text
POST /api/admin/source-access/github
```

Personal paid users should receive current source through portal/CLI source snapshots, not private GitHub collaborator access by default.
