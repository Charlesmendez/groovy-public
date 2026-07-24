# Groovy Licensing Launch Readiness

This checklist is the operating reference for finishing the licensing/distribution cutover.

## Current Model

- Private source of truth: `Charlesmendez/groovy`
- Public release-synchronized mirror: `Charlesmendez/groovy-public`
- Release artifacts: `Charlesmendez/groovy-releases`
- App host: Vercel project `groovy`
- Database/storage/auth: Supabase project `tjcdifsssxgxitaccadb`
- Relay: Fly app `groovy-relay`
- Personal payments: Stripe product/price for Groovy Personal
- CLI package: `@gogroovy/cli`

## 1. GitHub

### Already done

- `Charlesmendez/groovy-public` exists and is public.
- `Charlesmendez/groovy` remains private.
- `Charlesmendez/groovy-releases` exists, is private, and remains an internal release artifact repo.
- `groovy-public/main` has branch protection.
- `PUBLIC_MIRROR_SSH_KEY` exists as a secret on private `groovy`.
- A write deploy key exists on `groovy-public`.

### Still required

Commit and push the local workflow/code changes to private `groovy`; GitHub Actions cannot run files that only exist locally.

Upload the current connector installers/source artifacts into private storage and register them in `/admin` so licensed users download through `/account/downloads`. Do not rely on public GitHub Release asset URLs for customer downloads.

macOS customer DMGs must come from the signed/notarized release workflow, not from a local developer build. The release workflow runs `scripts/publish-connector-downloads.mjs`, which refuses to publish a macOS DMG unless `codesign`, `spctl`, and `stapler validate` all pass. A local unsigned `apps/connector/dist/Groovy-Connector-macOS.dmg` will produce Gatekeeper errors such as Apple being unable to verify the app or forcing the user to move it to Trash.

If hosted Groovy Macs are used, upload the headless connector tarball to private
storage and set:

```text
HOSTED_MAC_BOOTSTRAP_TARBALL_URL=supabase://groovy-downloads/connector/Groovy-Connector-Headless.tar.gz
```

The bootstrap route signs that storage reference at runtime before the target
Mac downloads it.

### Where to go

GitHub > `Charlesmendez/groovy` > Actions.

### Public mirror source tags

Only use source snapshot tags matching `source-v*`:

```bash
git tag -a source-v1.2.3 -m "Groovy source release v1.2.3"
git push origin source-v1.2.3
```

Do not use connector tags like `v0.2.0` for public source mirroring.

### Public mirror workflow

Workflow:

```text
.github/workflows/publish-public-mirror.yml
```

Default behavior:

- A `source-v*` tag push publishes that snapshot to
  `Charlesmendez/groovy-public` immediately.
- A weekly reconciliation run selects the newest matching tag and repairs a
  missed or failed publication.
- Public `public-source-v*` tags are immutable.
- Does nothing if no matching tag exists.

Manual behavior:

GitHub > private `groovy` > Actions > Publish Public Mirror > Run workflow.

Inputs:

- `source_ref=source-v1.2.3`
- `tag_pattern=source-v*`
- `target_repo=Charlesmendez/groovy-public`

### Private branch protection gap

GitHub refused branch protection on private `groovy` for the current account/plan:

```text
Upgrade to GitHub Pro or make this repository public to enable this feature.
```

Until the GitHub plan supports private branch protection, rely on discipline:

- use PRs
- use squash merge
- keep write access limited
- do not force-push `main`

## 2. Vercel

### Already done

Production and development envs are set for:

- `STRIPE_GROOVY_PERSONAL_PRICE_ID`
- `STRIPE_PERSONAL_PRICE_ID`
- `GROOVY_LICENSE_PRIVATE_KEY_PEM`
- `GROOVY_LICENSE_PUBLIC_KEY_PEM`
- `NEXT_PUBLIC_GROOVY_LICENSE_PUBLIC_KEY_PEM`
- `GROOVY_ADMIN_EMAILS`
- `ENTERPRISE_SALES_EMAIL=sales@gogroovy.ai`
- `RESEND_API_KEY` (Preview and Production)
- Resend sending domain `hi.gogroovy.ai` (the application defaults to
  `Groovy <notifications@hi.gogroovy.ai>` and
  `Groovy Sales <sales@hi.gogroovy.ai>`)
- `SUPABASE_SERVICE_ROLE_KEY`
- `GITHUB_SOURCE_REPO=Charlesmendez/groovy`

### Still required

Set this only if enterprise contracts need private GitHub collaborator access:

```text
GITHUB_SOURCE_ACCESS_TOKEN
```

This should be a fine-grained GitHub token, not a broad personal token.

Browser and Home Screen push notifications require one stable VAPID key pair
for the deployment:

```text
WEB_PUSH_VAPID_PUBLIC_KEY
WEB_PUSH_VAPID_PRIVATE_KEY
WEB_PUSH_CONTACT=mailto:support@gogroovy.ai
```

Generate the pair once with `npx web-push generate-vapid-keys --json`. Store the
private key only in Vercel; never expose it through a `NEXT_PUBLIC_*` variable
or commit it. Configure Production, Preview, and Development independently if
all three environments should send notifications.

### Where to go

Vercel > Project `groovy` > Settings > Environment Variables.

Recommended environments:

- Production
- Development

Preview can be added later for a specific preview branch if needed.

## 3. Supabase

### Already done

Private storage buckets exist:

- `groovy-downloads`
- `groovy-source-snapshots`

### Already done

The harness-platform migrations through
`20260723006000_chat_channel_skills.sql` are present in production.
PostgREST schema checks confirm the profile, team-chat, public-API,
cloud-scheduler, shared-settings/invite-scope, run-control, and channel-skill
tables/functions are live.

The channel/settings UX and multi-workspace membership flow add five pending
additive migrations:

```text
20260724000000_chat_channel_orchestrator_instructions.sql
20260724010000_chat_web_push_notifications.sql
20260724020000_scheduled_jobs_chat_channel.sql
20260724030000_chat_channel_image_attachments.sql
20260724040000_multi_workspace_selection.sql
```

Apply them before enabling channel operating-brief writes and Web Push in
production. The workspace-selection migration adds the normalized active
workspace preference used by multi-workspace accounts; until it is applied,
the app uses the existing protected onboarding preferences JSON as a
backward-compatible fallback. The scheduler migration binds scheduled tasks to their originating
Team Chat channel and backfills existing channel-session schedules; the image
attachment migration adds channel-scoped authorization records for objects in
the existing private `chat_uploads` bucket. The web
deployment remains backward-compatible while they are pending: existing
Chat/settings reads and channel creation without a brief continue to work,
notification preferences remain safely off, and existing scheduler jobs keep
running while the channel panel reports that activation is pending. Text-only
channel messages also keep working; image sends report that activation is
pending until the attachment migration is live.

### Future migration operations

The local Supabase CLI session is not authenticated. Before the next migration,
authenticate it with a scoped Supabase access token and the production database
password, then run:

```bash
npx supabase link --project-ref tjcdifsssxgxitaccadb
npx supabase db push --include-all --yes
```

Use Supabase Dashboard > Project `tjcdifsssxgxitaccadb` to obtain the project
connection details. Do not store the production database password in the
repository.

## 4. Stripe

### Already done

Groovy Personal yearly price exists:

```text
price_1TSkAAGbgScAVEenm6g2Nqqy
```

Webhook endpoint exists:

```text
https://www.gogroovy.ai/api/billing/stripe/webhook
```

Enabled events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `charge.refunded`

### Where to go

Stripe Dashboard > Developers > Webhooks.

Confirm the endpoint is enabled and points to production.

## 5. npm CLI

### Already done

CLI package exists in repo:

```text
packages/groovy-cli
```

Workflow exists:

```text
.github/workflows/publish-cli-npm.yml
```

Intended package:

```text
@gogroovy/cli
```

### Still required

Create/configure npm account and scope:

1. Go to npmjs.com.
2. Create or log into the Groovy npm account.
3. Create the `@gogroovy` organization/scope.
4. Create an npm automation token or granular access token.
5. Add it to GitHub:
   - GitHub > private `groovy` > Settings > Secrets and variables > Actions
   - Secret name: `NPM_TOKEN`

### Publish

```bash
git tag -a cli-v0.2.1 -m "Publish Groovy CLI v0.2.1"
git push origin cli-v0.2.1
```

or:

GitHub > private `groovy` > Actions > Publish Groovy CLI to npm > Run workflow.

## 6. Datagran

### Already configured in Vercel

`DATAGRAN_API_KEY` exists in Vercel for development, preview, and production.

### Requirement

Users enabling Groovy Memory or Datagran-backed Data Integrations need a Datagran account.

Required envs:

- `DATAGRAN_API_KEY`
- `DATAGRAN_CHAT_MODEL`

If `DATAGRAN_API_KEY` is missing, memory and Datagran integrations are unavailable.

### Where to go

Datagran account/dashboard for API keys and integration setup.

## 7. Fly

### Already done

Fly app `groovy-relay` exists and has required secrets:

- `RELAY_JWT_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

No licensing-specific Fly envs are required.

### Where to go

Fly Dashboard > `groovy-relay`.

## 8. Paid Customer Source Access

Default source access is not GitHub collaborator access.

Personal paid users:

- Groovy portal/CLI source snapshots.
- No private GitHub access.

Enterprise customers:

- Groovy portal/CLI source snapshots by default.
- Optional private GitHub collaborator access only if the contract includes it.

Optional GitHub invite route:

```text
POST /api/admin/source-access/github
```

Requires:

```text
GITHUB_SOURCE_ACCESS_TOKEN
```

## 9. First Launch Sequence

1. Commit and push all local changes to private `groovy`.
2. Apply Supabase migrations.
3. Redeploy Vercel production.
4. Confirm Stripe webhook receives events.
5. Create first paid source tag:
   ```bash
   git tag -a source-v0.2.0 -m "Groovy source release v0.2.0"
   git push origin source-v0.2.0
   ```
6. Upload current source snapshot and artifacts to private Supabase buckets.
7. Add download/source records through admin APIs.
8. Create npm `@gogroovy` org and `NPM_TOKEN`.
9. Publish CLI when ready:
   ```bash
   git tag -a cli-v0.2.0 -m "Publish Groovy CLI v0.2.0"
   git push origin cli-v0.2.0
   ```
10. Confirm the tag-triggered public mirror Action completed and
    `public-source-v0.2.0` exists in `groovy-public`; use the manual workflow if
    reconciliation is needed.

## 10. Verification Commands

```bash
npm run lint
npx tsc --noEmit --pretty false
npm run build
npm run groovy -- doctor --json --env-file .env.local
cd packages/groovy-cli && npm pack --dry-run
```
