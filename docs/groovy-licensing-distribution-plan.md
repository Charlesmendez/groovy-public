# Groovy Licensing and Distribution Implementation Plan

Status: planning reference
Date: 2026-05-02
Scope: move Groovy from a closed usage-billed app to a source-available licensed product with personal, enterprise, and authorized reseller paths.

## Final Decisions

- All users move to the new licensing model.
- There is no customer migration/refund burden right now because there are effectively no real external customers yet.
- Token-consumption billing is disabled by default for personal and normal enterprise customers.
- Token usage may still be tracked for analytics, cost estimation, debugging, budgets, and optimization.
- Token-consumption billing may only be re-enabled for authorized enterprise reseller licenses.
- Customers should bring their own model provider keys by default.
- Personal users pay yearly for personal usage rights and receive packaged
  source snapshots and signed artifacts while active.
- Expired personal users keep fallback rights to the last paid version but lose
  the right to run newer releases and lose access to new portal artifacts,
  updates, activations, device resets, and support.
- Enterprise customers use a manual sales flow and receive commercial rights, source access, and fallback rights according to their agreement.
- GitHub stays as a release-synchronized public source-available mirror and contribution surface, not the payment or licensing system.
- Packaged source snapshots, signed installers, license files, and release metadata are distributed through the Groovy portal and Groovy CLI.
- CLI setup is first-class for developers and enterprise customers.
- AI-agent setup documentation is required so customers can copy a full instruction document into their AI agent and have the agent perform setup through the CLI.
- Datagran Memory and Datagran-backed Data Integrations are first-class setup requirements.

## Product Model

### Groovy Personal

- Price: $49.99 per year.
- Billing: Stripe yearly subscription.
- Rights: one individual, personal non-commercial use only.
- Devices: 2 activated devices.
- Source visibility: tagged releases are public.
- Usage rights: releases published during the active subscription, subject to
  the Personal terms.
- Packaged source snapshots and signed installers while active.
- Expiration:
  - Existing installed version may continue for personal non-commercial use.
  - User sees expired license state.
  - No new source snapshots, downloads, updates, activations, device resets, or support.

### Groovy Enterprise

- Price: contact sales.
- Billing: manual enterprise agreement.
- Rights: internal business use, self-hosting, modification, maintenance, and source access if included in the agreement.
- Expiration:
  - Customer keeps fallback rights to the last paid version within final licensed limits.
  - No new source snapshots, downloads, updates, support, security patches, package access, or expansion rights.

### Groovy Enterprise Reseller

- Not a public/default plan.
- Requires explicit written authorization.
- May enable reseller billing and token-consumption billing only when signed license flags permit it.
- Supports customer-level usage tracking, markup configuration, billing exports, reporting, and webhooks.

## Source Access and GitHub Strategy

GitHub should remain part of the product, but its job changes.

### GitHub Should Be Used For

- Public release-synchronized source-available mirror.
- Transparency and evaluation.
- Documentation.
- Examples and SDKs.
- Issues and pull requests.
- Security review.
- Public contribution workflow.

### GitHub Should Not Be Used For

- Personal payment unlock.
- Primary license activation.
- Usage rights or license activation.
- Signed installers and portal-only packaged artifacts.
- Current paid downloads.
- Enforcing update entitlement.

### Recommended Flow

1. Pushing a reviewed `source-v*` tag publishes the same release to public
   GitHub and makes it available to contribution branches.
2. Paid personal and enterprise customers authenticate to the Groovy portal or CLI.
3. Portal/CLI exposes packaged source snapshots, checksums, license files, release notes, and signed installers.
4. Expired customers may inspect newer public releases but retain usage rights
   only as defined by their fallback terms; they lose access to newer portal
   artifacts.
5. Enterprise customers may additionally receive private GitHub access or private patch workflow if included in their contract.

## Contribution Model

### Public Contributors

- Open issues and pull requests against the current public release.
- Must follow `CONTRIBUTING.md`.
- Must sign CLA or DCO, depending on final legal choice.

### Personal Paid Developers

- Download current source through portal/CLI.
- Develop locally.
- Submit patches or PRs against the public contribution branch when appropriate.
- Their personal license does not grant commercial/company use.

### Enterprise Customers

- May maintain internal forks.
- May submit private patches, private PRs, or portal-uploaded patch bundles.
- Contract should define whether contributions are licensed back, assigned, optional, or covered by CLA.

## Current Codebase Findings

### Token Billing Is Deeply Wired

Primary files to change or gate:

- `src/lib/billing/pricing.ts`
  - Defines `groovy_key`, `external_key_fee`, and `no_charge`.
  - Currently has 20 percent fee constants.
  - Computes Groovy usage charge breakdowns.
- `src/lib/billing/guard.ts`
  - Runs preflight checks against balances, monthly limits, card state, and top-up settings.
  - Debits wallet ledger after usage.
- `src/lib/billing/events.ts`
  - Persists billing usage/tool events and charge fields.
- `src/app/api/billing/status/route.ts`
  - Returns current 20 percent fee messaging and wallet/top-up state.
- `src/app/api/billing/topup/route.ts`
  - Supports top-up flow.
- `src/app/api/billing/stripe/flush/route.ts`
  - Sends Stripe meter events when enabled.
- `src/app/api/billing/stripe/webhook/route.ts`
  - Handles current Stripe billing events.

Important call sites:

- `src/app/api/orchestrator/route.ts`
- `src/lib/orchestrator/runOrchestratorRound.ts`
- `src/app/api/chat/route.ts`
- `src/app/api/datagran/chat/route.ts`
- `src/app/api/claude-cli/route.ts`
- `src/app/api/claude-cli/usage/route.ts`
- `src/lib/orchestrator/toolExecutor.ts`
- `src/lib/heartbeat/runHeartbeat.ts`

Recommendation:

- Keep usage event collection.
- Change normal usage events to non-billable analytics.
- Gate all Groovy-charged usage, markups, top-ups, and Stripe meter flushes behind reseller license flags.

### API Key Storage Exists and Should Be Reused

Relevant files:

- `src/app/api/user-api-keys/route.ts`
- `src/lib/keys/resolveKeyMode.ts`
- `src/lib/crypto/llmKey.ts`
- `supabase/migrations/20260124000000_user_api_keys.sql`
- `supabase/migrations/20260208000000_add_claude_cli_provider.sql`

Recommendation:

- Preserve encrypted key storage.
- Remove "Groovy billing key" language.
- Make customer-owned provider keys the default.
- Add first-class setup for OpenAI, Anthropic, Google, Azure OpenAI, AWS Bedrock, Groq, Mistral, xAI, Claude CLI, and Codex CLI as applicable.
- Fix provider schema drift where UI/code supports providers that migrations do not yet allow.

### Onboarding and Product Messaging Must Change

Relevant files:

- `src/components/onboarding/WelcomeOnboarding.tsx`
- `src/components/command-center/SettingsModal.tsx`
- `src/app/setup/page.tsx`
- `src/app/page.tsx`
- `src/content/pseo/page-catalog.en.json`

Recommendation:

- Replace "Use Groovy's API keys" and 20 percent markup explanations.
- Use:
  - "Connect your model provider."
  - "Use your own OpenAI, Anthropic, Google, Azure, Bedrock, Groq, Mistral, or other provider credentials."
  - "Groovy does not charge a percentage over token usage by default."
  - "Enterprise reseller billing requires written authorization."

### Distribution Previously Used Public GitHub Releases

Relevant files:

- `src/lib/connector/catalog.ts`
- `.github/workflows/release-connector.yml`
- `docs/hosted-mac-runbook.md`

Recommendation:

- Keep GitHub Releases private as legacy/internal release automation during transition.
- Move paid download/source entitlement to portal/CLI.
- Use short-lived signed URLs, checksums, release notes, and license-gated source snapshots.
- Hosted Mac bootstrap must consume private/internal artifact URLs and should not fall back to public GitHub Release assets.

### Connector and Device Pairing Should Be Reused

Relevant files:

- `supabase/migrations/20260109000001_devices_and_claude_code.sql`
- `src/app/api/devices/pairing-code/route.ts`
- `apps/relay/server.mjs`
- `apps/connector/connector.mjs`

Recommendation:

- Reuse connector/device identity where appropriate.
- Do not conflate connector pairing with license activation.
- Add license activation records linked to license/device hash.

### Datagran Memory Is Required Setup

Relevant files:

- `src/lib/orchestrator/memory.ts`
- `src/lib/memory/groovyMemory.ts`
- `src/lib/datagran/memory.ts`
- `src/app/api/memory/brain/route.ts`
- `src/lib/heartbeat/runHeartbeat.ts`

Current behavior:

- Memory relies on server-side `DATAGRAN_API_KEY`.
- Memory uses Datagran Brain for durable context.
- If `DATAGRAN_API_KEY` is missing, memory disables itself.

Required plan changes:

- Document Datagran Memory as part of developer and enterprise setup.
- Add CLI memory setup/status/test commands.
- Add AI-agent setup questions for Datagran Memory.
- Add privacy documentation explaining what memory may store and how to disable or clear it.
- Avoid putting real key values in docs; list env var names only.

### Datagran Data Integrations Are Required Setup

Relevant files:

- `src/components/command-center/DataIntegrationsPanel.tsx`
- `src/components/datagran/DatagranPanel.tsx`
- `src/app/api/datagran/chat/route.ts`
- `src/app/api/datagran/connection/route.ts`
- `src/app/api/datagran/link-token/route.ts`
- `src/app/api/datagran/pixel/create/route.ts`
- `src/app/api/datagran/pixel-sites/route.ts`
- `src/app/api/agents/route.ts`
- `src/lib/orchestrator/executableTools.ts`

Supported integration providers observed in code:

- `facebook_ads`
- `facebook_leads`
- `instagram`
- `google_ads`
- `linkedin_ads`
- `google_drive`
- `tiktok`
- `postgres`
- `firecrawl`
- `salesforce`
- `web_pixel`
- `gmail`
- `google_calendar`

Required plan changes:

- Add Datagran integration setup to portal, CLI, and AI-agent docs.
- Support OAuth setup where available.
- Support manual existing Datagran connection ID plus API key setup.
- Add Web Pixel setup because it is separate from normal OAuth flows.
- Add connection health checks and reauth flows.

## Reference Infrastructure To Document

The setup documentation and CLI should explain the current Groovy reference infra so developers and enterprise customers can replace it with their own accounts and keys.

### Core

- Next.js app.
- Supabase Auth, Postgres, Storage, and migrations.
- Separate relay service in `apps/relay`.
- Fly.io relay deployment.
- Stripe for personal subscriptions.
- Groovy connector packages for macOS, Windows, and headless deployments.
- GitHub Actions for current connector release automation.
- Portal/CLI source snapshots and downloads for the new licensed model.

### Optional or Feature-Specific

- Datagran for Memory and Data Integrations.
- Aiyra/OpenClaw for voice and material-query flows.
- Kapso for WhatsApp-related platform integration where used.
- Vercel deployment APIs for generated site deployment.
- Hosted Mac bootstrap flow.

### Security Rule

Documentation must use placeholders for secret values. It should never include real local `.env` values.

## Implementation Phases

### Phase 0: Policy and Legal Foundation

Deliverables:

- Finalize personal, enterprise, reseller, and commercial-use terms.
- Define CLA or DCO policy.
- Define the source-tag release and public mirror synchronization policy.
- Define source snapshot retention policy.
- Define fallback rights by license type.

Files to add:

- `LICENSE.md`
- `PERSONAL-LICENSE.md`
- `ENTERPRISE-LICENSE-SUMMARY.md`
- `COMMERCIAL-USE.md`
- `RESELLER-TERMS-SUMMARY.md`
- `SECURITY.md`
- `CONTRIBUTING.md`

### Phase 1: Disable Normal Token Billing

Goal:

Groovy stops charging normal users a percentage over token usage.

Tasks:

- Add a central billing policy resolver based on license type and license feature flags.
- Make personal and normal enterprise usage events non-billable by default.
- Disable normal wallet debit and top-up requirements.
- Hide billing balance/top-up UI from normal users.
- Keep usage analytics available.
- Gate existing Stripe meter flushes behind reseller billing flags.
- Update all 20 percent markup messaging.

Acceptance criteria:

- Personal and normal enterprise users can run agents without Groovy token markup.
- Token usage still appears as analytics.
- Token-consumption billing UI is hidden unless reseller flags are present.

### Phase 2: Licensing Data Model

Goal:

Create durable licensing primitives.

Tables:

- `organizations`
- `licenses`
- `subscriptions`
- `license_devices`
- `license_checks`
- `downloads`
- `source_snapshots`
- `download_events`
- `enterprise_contracts`
- `license_admin_audit_events`

License fields:

- `license_type`: `personal`, `enterprise`, `enterprise_reseller`
- `status`: `active`, `past_due`, `expired`, `canceled`, `suspended`, `terminated`
- `license_key_hash`
- `signed_license_payload`
- `valid_from`
- `valid_until`
- `fallback_allowed`
- `max_devices`
- `max_users`
- `max_agents`
- `max_environments`
- `reseller_billing_enabled`
- `token_consumption_billing_enabled`

Acceptance criteria:

- Server can create signed personal, enterprise, and reseller licenses.
- App/CLI can verify license signatures locally.
- Admin actions are auditable.

### Phase 3: License Activation

Goal:

Users can activate Groovy without always-online enforcement.

Tasks:

- Add activation API.
- Add device hash generation.
- Add signed activation token.
- Store activation token locally.
- Add license status API.
- Add device deactivation.
- Add personal 30-day online check and 14-day grace behavior.
- Add enterprise soft-warning/fallback behavior.

Acceptance criteria:

- Personal license activates on up to 2 devices.
- Expired personal license shows expired state but does not suddenly shut down existing installed version.
- Enterprise expired license shows fallback state.

### Phase 4: Personal Purchase and Portal

Goal:

Personal users can buy, activate, download, and manage Groovy.

Pages:

- `/pricing`
- `/account`
- `/account/downloads`
- `/account/source`
- `/account/license`
- `/account/devices`
- `/account/billing`

Stripe events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `charge.refunded`

Acceptance criteria:

- User pays $49.99/year.
- Account and license are created.
- User can download current release and source snapshot.
- User can activate two devices.
- Billing links to Stripe customer portal.

### Phase 5: Enterprise Manual Sales

Goal:

Enterprise customers can be onboarded manually.

Tasks:

- Add `/enterprise` contact form.
- Send lead to sales inbox or CRM.
- Add admin org/license creation.
- Add enterprise portal.
- Add source snapshot access.
- Add deployment package access.
- Add usage report export.
- Add support/security/contract pages.

Acceptance criteria:

- Sales can create enterprise account and license.
- Customer can download license file, source snapshot, and deployment package.
- Customer can export usage report.

### Phase 6: API Key Refactor

Goal:

Customers understand that they bring their own provider credentials.

Tasks:

- Rewrite onboarding key-selection UI.
- Rewrite settings API key text.
- Rename Groovy-managed key concepts where they imply billing.
- Preserve encrypted provider-key storage.
- Add key rotation, deletion, masking, testing, and default provider selection.
- Add provider-per-agent/workflow support where already supported by architecture.

Acceptance criteria:

- Product does not say users need a Groovy billing key.
- Customer-owned provider key setup is the default flow.
- Keys are encrypted at rest and never logged or returned raw.

### Phase 7: Datagran Memory and Data Integrations Setup

Goal:

Developers and enterprise customers can configure memory and data integrations through portal, CLI, and AI-agent setup docs.

Memory tasks:

- Add `groovy memory status`.
- Add `groovy memory setup`.
- Add `groovy memory test`.
- Add `groovy memory disable`.
- Verify `DATAGRAN_API_KEY`.
- Verify `DATAGRAN_CHAT_MODEL`.
- Verify memory connection creation.
- Document memory privacy boundaries.

Data integration tasks:

- Add `groovy integrations list`.
- Add `groovy integrations connect`.
- Add `groovy integrations test`.
- Add `groovy integrations reauth`.
- Add `groovy integrations disconnect`.
- Support OAuth-capable providers.
- Support existing Datagran connection ID plus API key.
- Support Web Pixel creation and install snippet retrieval.

Acceptance criteria:

- CLI can verify Datagran Memory health.
- CLI can verify configured data integration health.
- AI-agent docs include memory and data integration setup questions.

### Phase 8: Groovy CLI

Goal:

Developers and enterprise customers can complete setup from the command line.

Commands:

- `groovy auth login`
- `groovy license activate`
- `groovy license status`
- `groovy provider-keys add`
- `groovy provider-keys test`
- `groovy provider-keys list`
- `groovy source download`
- `groovy source verify`
- `groovy downloads list`
- `groovy connector install`
- `groovy connector pair`
- `groovy connector start`
- `groovy relay deploy`
- `groovy app doctor`
- `groovy supabase check`
- `groovy memory status`
- `groovy memory setup`
- `groovy integrations connect`
- `groovy integrations test`
- `groovy doctor --json`

AI-agent support:

- `--json`
- `--yes`
- `--non-interactive`
- `--env-file`
- clear exit codes
- machine-readable validation errors

Acceptance criteria:

- A developer can set up a local/dev instance through CLI.
- Enterprise can follow a CLI-only deployment path.
- An AI agent can ask the user questions and execute the setup without browser-only steps except where external OAuth requires a browser handoff.

### Phase 9: AI-Agent Setup Documents

Goal:

Customers can give their AI agent a complete instruction file.

Documents:

- Personal local setup.
- Developer source setup.
- Enterprise self-host setup.
- Enterprise private infra replacement guide.
- Datagran Memory setup.
- Datagran Data Integrations setup.
- Connector setup.
- Provider API key setup.
- Troubleshooting and verification.

The AI-agent doc should ask:

- What license key or account should be used?
- Do you want personal, dev, or enterprise setup?
- Which model providers should be configured?
- Do you want Datagran Memory enabled?
- Do you have a Datagran API key?
- Which data integrations should be enabled?
- Are integrations OAuth, manual Datagran connection ID, or Web Pixel?
- What Supabase project should be used?
- What app URL should be used?
- What relay URL should be used?
- Is this local, Vercel, Fly, Docker, or other infra?

Acceptance criteria:

- The AI-agent doc can drive setup through CLI commands.
- Secret values are requested from the user at runtime, not hardcoded.
- Final setup includes verification commands.

### Phase 10: Source Snapshots and Downloads

Goal:

Paid users get current artifacts through portal/CLI.

Tasks:

- Add source snapshot build/upload process.
- Add checksums and release notes.
- Add signed short-lived download URLs.
- Add entitlement checks.
- Add release/channel model.
- Keep public source publication tied to reviewed `source-v*` releases and
  separate from private development commits.

Acceptance criteria:

- Active paid users can download current source.
- Expired users cannot download newer snapshots.
- Last paid version remains visible.

### Phase 11: Enterprise Reseller Billing

Goal:

Only authorized reseller customers can enable token-consumption billing.

Tasks:

- Add signed feature flags:
  - `reseller_billing_enabled`
  - `token_consumption_billing_enabled`
- Add reseller customer model.
- Add customer-level usage events.
- Add markup settings.
- Add billing exports.
- Add reseller admin dashboard.
- Gate UI and API routes by signed license flags.

Acceptance criteria:

- Normal personal and enterprise licenses cannot enable reseller billing.
- Reseller billing cannot be accidentally enabled by env var alone.
- Usage reports separate provider cost, Groovy analytics, reseller markup, and billable amount.

### Phase 12: Verification and Migration

Test coverage:

- Stripe webhook behavior.
- License signing and verification.
- Personal device activation limits.
- Personal expiration behavior.
- Enterprise fallback behavior.
- Token billing disabled default.
- Reseller-only token billing.
- Provider-key encryption, masking, rotation, deletion, and test flow.
- Datagran Memory setup and failure mode.
- Datagran Data Integration setup and reauth behavior.
- CLI JSON/noninteractive behavior.
- Portal download entitlement.
- Release-synchronized GitHub mirror process.

Migration:

- Since there are effectively no external customers, use a clean cutover.
- Disable old token-billing defaults immediately.
- Keep old usage data only as historical analytics.
- Do not build refund or grandfathering logic.

## Open Decisions

- Whether public source publication should remain tag-based or move to
  commit-by-commit mirroring in the future.
- CLA vs DCO.
- Whether enterprise private source access uses GitHub, portal snapshots, or both by default.
- Whether the first CLI is a Node package in this repo or a separate package published later.
- Which provider keys are required for the default self-host install versus optional.
- Whether Datagran Memory is required by default or a strongly recommended optional feature for self-hosters.

## Guiding Principle

Public source for trust.
Paid license for use.
Personal users buy online.
Enterprise customers contact sales.
Token billing is disabled by default.
Customers bring their own provider keys.
Datagran Memory and Data Integrations are explicit setup surfaces.
Reseller billing requires written authorization.
No sudden shutdown.
No invasive tracking.
