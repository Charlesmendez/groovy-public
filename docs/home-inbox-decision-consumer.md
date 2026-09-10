# Home Inbox decision consumer — gated preview

This is an incremental implementation of the unified Inbox plan, **not a full
production-readiness claim**. It reuses Groovy's existing `runOrchestratorRound`
harness; it does not build another orchestrator in Home or Inbox.

## Ownership

- Inbox project admins define/publish deterministic flows, message content,
  cadence, stop conditions, selected scalar inputs and decision outcomes.
- Inbox operators/viewers cannot edit those flow definitions. A Home project
  key with Inbox operator permission can claim/complete already-due decisions;
  it does not acquire admin/flow-edit permission.
- A Groovy personal Mind owner or current workspace admin connects a dedicated
  Mind to a Home tenant/project/harness reference. Workspace members and guests
  cannot configure this connection. Email matching is never authorization.
- Groovy returns only a selected `outcome_key` and optional summary. Inbox
  independently decides whether the result still applies and advances its
  pinned flow version. Groovy cannot send, schedule, delegate or return an
  arbitrary CRM action through this protocol.
- Groovy's independent signup, API, widget, and its own scheduling product are
  unchanged. A Home connection neither creates a Groovy user nor grants access
  to another Groovy workspace.

## Current capabilities and explicit gaps

The consumer supports client-supplied decision inputs, optionally allowlisted
web research, and Home's project-granted read operations (Salesforce first).
It rejects Minds with other tools in their allowlist instead of silently
dropping capabilities. The general data tool remains deliberately blocked:
the existing `data_query` implementation can issue arbitrary Datagran proxy
writes (including sending), and its natural-language confirmation heuristic is
not a proven read-only boundary. The separate `home_data_operations` and
`home_data_read` tools invoke Home's fixed capability gateway with the binding's
project key, never a model-selected URL, SQL query, credential or scope. They
reuse Home's verified Datagran connection; they do not enable Groovy's standalone
Memory or Datagran integration features without their required Datagran account,
`DATAGRAN_API_KEY` and `DATAGRAN_CHAT_MODEL` configuration.

Home migration 0051 / PR3 `e7d7d1a` is the matching read gateway. Each operation
is granted to an exact project key. Use a **dedicated key per Mind** and let the
Home tenant admin review object, fields, fixed project filters and parameter
schema. Reusing a key intentionally shares its grants; a Groovy prompt is not
a narrower row-access boundary. These are client-defined reads, not built-in
CRM stages or conversion rules. No raw credential reaches the model.

Both tools must be explicitly enabled on the dedicated Mind. Activation checks
for at least one active grant using catalog metadata only; it does not query
customer records or claim live provider health. Home's separate
`HOME_PROJECT_DATA_READS_ENABLED` gate must be enabled through controlled release.
At runtime the model discovers paginated operation metadata before a read;
typed inputs, exact scoped receipts, approved result fields and row limits are
validated again in Groovy. A caller cannot guess an undiscovered operation ID.
Home independently rechecks grant/key/project/connection ownership on each read.
Groovy rechecks the active binding, original owner's current workspace role and
the pinned Mind before and after every data request, and before returning the
final decision. A failed read holds the decision even if the model attempts to
treat missing evidence as a negative answer. The private model output is kept.

Calls share a 12-request and 1 MiB returned-data budget per decision, within the
existing decision deadline. Individual reads allow up to 50 seconds for Home's
ownership verification and provider query. Responses are streamed with byte and
abort limits, and network failures are not automatically retried. Repeated
explicit reads are new observations, not idempotent snapshots. `next_cursor`
means more grants remain; `limit_reached` means a record result may be incomplete.
Data parameters/results are not added to generic executor activity logs.

**Other CRM/database and Calendar providers, real provider/model/browser E2E,
guided grant setup and full data audit presentation remain required.** This
first adapter is not a replacement for those pending capabilities.

Other remaining release requirements:

1. Release and verify the separate multi-call/multi-model reporting receipts
   described below. Existing traces remain linked; the legacy single-model
   completion field remains `usage: null` and must not double-count the new
   report. Missing provider measurements/prices are unknown, not zero.
2. Verify Home key claim/complete authority without consuming real customer
   work, agent/project integration readiness, and the actual Inbox/Home/Groovy
   browser + provider flow. Queue-list verification proves **read access only**.
3. Operational reconciliation of unknown/held work, retention/redaction policy,
   a full detail/trace view, and deployment-safe polling throughput/monitoring.
4. Replace advanced UUID/key setup with a verified Home connection handoff
   without weakening tenant/project/actor boundaries. Local UI visual and
   authenticated browser verification remain pending.
5. Controlled migrations, review, release credentials and an explicit cron
   registration. No production database, Home binding, provider connection,
   model call or customer flow was activated while developing this preview.

## Configuration and API

Settings → Minds → selected saved Mind → **Home Inbox**. The panel reports
saved-profile readiness, connection state and recent decision metadata.
Save profile edits before refreshing its checks.

The Mind must be external/restricted, use profile-isolated memory, disable both
workspace skill/integration inheritance flags, and use an explicit tool
allowlist containing only `web_search`/`WebSearch` and/or the paired
`home_data_operations` + `home_data_read` (or empty for supplied inputs).
Every Mind is permanently associated with one Home tenant/project after first
connection, even when revoked; rotation within the same project is allowed.
Start a separate dedicated Mind for a different client/project.

Cookie-authenticated settings endpoints (same-origin required for writes):

- `GET /api/harness/profiles/:id/inbox-bindings`: admin-only public binding/run
  metadata and explicit readiness limitations. Never returns credentials,
  claim tokens, inputs, profile snapshots or decision summaries.
- `POST` same path: exact JSON fields `tenant_id`, `project_id`, `harness_ref`,
  `home_project_key`. Reads Home's queue, encrypts the key, and saves **paused**.
- `PATCH .../inbox-bindings/:bindingId`: exact `{ "status": "active" }`,
  `paused` or `revoked`. Activation rechecks the original credential owner's
  Groovy admin access/profile, Home queue-read access and, for data-enabled
  Minds, at least one active Home data grant. This is not provider readiness.
  Revocation is final;
  reconnecting creates a new binding and preserves the old run history.

No mutation accepts an owner override, arbitrary callback, message, cadence,
destination, integration payload or schedule. The Home origin is server-owned
(`DATAGRAN_HOME_URL`, default `https://home.datagran.io`) and pinned on the
binding. Changing the configured origin requires explicit reconnection. Keys
and claims use the existing `LLM_KEY_ENCRYPTION_KEY` encryption mechanism.

`HOME_INBOX_DECISIONS_ENABLED=true` is a separate **server** release gate; it is
off by default and no migration enables it. `POST /api/home-inbox/run` also
requires the existing `SCHEDULER_CRON_SECRET`/`CRON_SECRET` bearer credential.
It drains one already-due decision or saved receipt from an active binding per
request, rotating bindings by poll time. It is deliberately **not registered
in `vercel.json` yet**. Do not run a second customer cadence in Groovy.

## Durable lifecycle

`claiming → running → completed → delivered`

- Reserve a unique `(binding_id, decision_id)` row before contacting Home.
- A stable claim key and exact scope/receipt validation precede execution.
  Only an explicit `execute: true` response authorizes work.
- Persist the encrypted claim, original token, profile snapshot and a
  compare-and-swap execution barrier before invoking the existing harness.
  The private session and trace remain associated with this decision only;
  durable-memory tools and unscoped extension catalogs are not exposed.
- Unknown claim/harness/save acknowledgements are not grounds for invoking the
  harness again. Claiming/running rows abandoned through expiry become
  `unknown`. Malformed output is retained in the private session and held,
  not repaired by another model call. Normal internal harness reasoning/tool
  steps remain one bounded invocation; this is not a claim that every SDK or
  provider produces exactly one billable request.
- Persist the result **before** Home completion. Delivery retries use only that
  saved result, original credential binding, claim token and stable completion
  idempotency key. If a database save committed but its acknowledgement was
  lost, the completed row can still be recovered without another invocation.
- Home can record a receipt with `applied: false` after the flow has moved on.
  The UI labels this “Recorded, not applied”, not a successful flow transition.
- Pause/revoke stops new claims and result delivery on subsequent authorization
  checks. It is not an instantaneous cancellation of an already-running model
  request. Output/history remain; Home still controls application of results.

The two new tables are private to the service role, with RLS enabled and no
`anon`/`authenticated` table privileges. Every browser route and worker explicitly
rechecks ownership; possession of service-role credentials never substitutes
for application authorization. Restrictive foreign keys preserve run history.

## Verification

Focused tests run offline with fake Home responses and a fake harness; no
provider or customer mutation is needed:

```sh
node --import tsx --test src/lib/homeInbox/*.test.ts src/lib/orchestrator/toolPolicy.test.ts
```

The repository has no direct `tsx` dependency; use an installed test runner
without changing the application dependency graph solely for this checkpoint.
TypeScript and targeted ESLint checks are also required.

`scripts/test-home-inbox-migration.mjs` requires an **empty local-only** database
named `groovy_inbox_test_*` through `HOME_INBOX_TEST_DATABASE_URL`. It builds
minimal parent fixtures (not the full Supabase schema), applies the actual
migration, and checks paused defaults, unique claims, state barriers, RLS/table
privileges, immutable scopes/credentials, revocation and preserved history.
It never reads production environment files. Full deployed-schema validation
is a separate release prerequisite.

### September 6 local checkpoint

- 71 focused consumer, policy, profile, prompt, public API and request-security
  tests passed (including 25 new consumer tests and one new policy test).
- 21 actual PostgreSQL migration/state/privacy checks passed in a disposable
  local cluster. The cluster was stopped afterward; data/logs were retained.
- Targeted ESLint and TypeScript checks passed. The production build generated
  all 503 pages using dummy local Supabase/app URL settings, not production
  credentials. Existing Google Fonts downloads required network access.
- Second-pass review tightened status validation, immutable project/credential
  boundaries, pending-receipt recovery, saved-result protection and exclusion
  of the owner's unscoped extension catalog from decision prompts.
- No authenticated browser/provider/model E2E, production migration, cron
  registration, release enablement or customer activation is claimed.

### Home data bridge follow-up — September 6

- 93 focused tests passed across the consumer, data bridge/body reader, actual
  executable tools, profile/prompt policy, independent public API and voice
  request security. Tests use synthetic records and fake Home responses, not
  customer data or real model/provider calls.
- `scripts/test-home-data-contract.mjs <local-home-checkout>` passed three
  offline parity tests against Home's actual description, query compilation and
  projection functions. Run it with an installed TypeScript import loader.
- Second-pass review added request/stream/aggregate budgets, late-revocation
  suppression, immutable catalog snapshots, private output preservation for
  held decisions, and the correct external-tool catalog boundary. An existing
  unscoped channel assignment fallback was also tightened in both tool exposure
  and execution; missing tool-policy context no longer implies workspace-admin
  authority when channel metadata is present.
- Standalone local packaging must not overwrite shared dependencies: this
  isolated worktree uses a `node_modules` symlink to the untouched original
  checkout. Next's standalone output reproduces that link, then reports EPERM
  when copying the SDK onto itself. Compilation/type checks/page generation are
  distinct from a verified isolated release package. Use the private PR preview
  with its own dependency installation for packaging verification.
- No additional Groovy migration, production grant, cron, model/provider
  execution or customer flow activation is included in this follow-up. Full
  usage receipts, remaining providers, guided setup, operational review,
  retention and authenticated end-to-end verification remain open.

### Provider reporting follow-up — September 6

The consumer now persists `usage_receipt` on its existing private decision run.
Trusted harness callbacks record each AI SDK step and summary, or every model
from the Claude Agent SDK result, including error results. The server normalizes
input/output and cache counters without adding cache twice. Only explicit
provider-reported USD is stored; no new price estimates are invented. The
existing AI SDK billing callback also uses `totalUsage` instead of final-step
`usage`, preventing multi-step undercounting there.

Snapshots persist serially by receipt ID. Identical callbacks count once;
conflicting or missing observations mark the run partial. Save failures never
trigger another harness invocation. Failed/held runs retain observed work even
when Inbox cannot apply the decision. Empty/historical runs remain unmetered.
The legacy completion protocol still has `usage: null` because a one-model
object cannot safely represent these components; this is a separate feed, not
a second billing debit or a new orchestration system.

Apply additive migration `20260906160000_home_inbox_usage_receipts.sql` after
the consumer migration. It leaves existing rows unchanged and restricts
`home_inbox_usage_report` to service-role access. Aggregation matches the exact
pinned Home origin, tenant and project, includes revoked bindings' history,
and counts executions started in a UTC half-open range of at most 90 days.

`POST /api/home-inbox/usage` is a server-to-server read endpoint requiring
`DATAGRAN_HOME_REPORTING_SECRET` (32+ characters) in
`x-datagran-platform-secret`. Home configures the full trusted feed URL
(`https://www.gogroovy.ai/api/home-inbox/usage`) and matching reporting-only secret
in its separate `PRODUCT_REPORTING_TARGETS.groovy` entry as `{url, secret}`.
This does not configure product provisioning, enable a product, or change
independent Groovy signup/workspace linking. Do not create a fictitious
`PRODUCT_PROVISIONING_TARGETS.groovy` entry for cost reporting. Home authorizes
current **Inbox** project access before and after the read. No standalone Groovy
signup is needed to view a project's Inbox decision costs. This secret grants
no harness execution, settings change, deterministic messaging or scheduling.
The endpoint accepts only `{tenant_id, project_id, from, to}` and returns
aggregates, never prompts, CRM data, credentials or private run/profile IDs.

The API returns known costs and explicit unmetered/unpriced counts, not an
invoice. Non-SDK provider pricing, upstream retries without a provider receipt,
standalone Groovy usage, retention/reconciliation and actual provider/browser
E2E remain separate work. No migration, reporting secret, cron, binding or
customer flow was activated in production by the September 6 local changes;
the subsequent database release checkpoint is recorded below.

Recorder/reporting tests extend the focused suite to 107 passing cases. The
actual local migration/state/privacy fixture now passes 28 checks, including
preserved historical null usage, multi-model totals, wrong-scope/origin denial,
shape validation and denied authenticated-role access to the aggregate RPC.
Targeted ESLint, TypeScript and production-build checks pass; standalone local
packaging retains the documented shared-dependency copy warning. These are
local/synthetic checks, not a provider invoice reconciliation.

### Release packaging and dependency review — September 6

The Inbox runner and existing orchestrator explicitly share the SDK subprocess
file-tracing list. The SDK starts a separate CLI process; tracing ordinary
imports alone does not guarantee its executable is in the deployed function.
After a clean production build, run
`node scripts/check-home-inbox-runtime-package.mjs` to verify both function traces
and the standalone package. The production Vercel runtime is Node 24; use a
matching Node 24 runtime for this verification. Patched sanitizer dependencies
require at least Node 22.12, so the old local Node 20.17 is not a release runtime.
Dependency updates do not activate the decision consumer, register a cron,
change signup, or migrate a production database.

### Production database checkpoint — September 7

The two additive migrations (`20260906130000` and `20260906160000`) were applied
together in one reviewed transaction to the existing production database after
verifying its scheduled backup. This database has no migration-history table;
these were explicit manual applications, not a replay of the migration folder.
Do not run `db push --include-all` to manufacture historical migration state.

The transaction verified unchanged counts for all four existing parent tables,
zero new bindings/runs, RLS on both new tables, and denied anonymous/user access.
A separate service-role read verified the exact-project aggregate RPC and
matched both installed function bodies to the reviewed source. No client flow,
cron, execution flag, or model call was enabled by the database deployment.
Application deployment and reporting configuration are separate release steps.
