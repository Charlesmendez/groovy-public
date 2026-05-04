# Groovy Licensing Launch Readiness

This checklist is the operating reference for finishing the licensing/distribution cutover.

## Current Model

- Private source of truth: `Charlesmendez/groovy`
- Public delayed mirror: `Charlesmendez/groovy-public`
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

### Where to go

GitHub > `Charlesmendez/groovy` > Actions.

### Public mirror source tags

Only use source snapshot tags matching `source-v*`:

```bash
git tag -a source-v1.2.3 -m "Paid source snapshot v1.2.3"
git push origin source-v1.2.3
```

Do not use connector tags like `v0.2.0` for public source mirroring.

### Public mirror workflow

Workflow:

```text
.github/workflows/publish-public-mirror.yml
```

Default behavior:

- Runs weekly.
- Looks for the newest `source-v*` tag older than 90 days.
- Publishes that snapshot to `Charlesmendez/groovy-public`.
- Does nothing if no eligible tag exists.

Manual behavior:

GitHub > private `groovy` > Actions > Publish Public Mirror > Run workflow.

Inputs:

- `source_ref=source-v1.2.3`
- `delay_days=90`
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
- `ENTERPRISE_SALES_FROM_NAME=Groovy Sales`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GITHUB_SOURCE_REPO=Charlesmendez/groovy`

### Still required

Set this only if enterprise contracts need private GitHub collaborator access:

```text
GITHUB_SOURCE_ACCESS_TOKEN
```

This should be a fine-grained GitHub token, not a broad personal token.

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

### Still required

Database migrations must be pushed.

Blocked because the local Supabase CLI is not authenticated and no DB password is available.

### Where to go

Supabase Dashboard > Project `tjcdifsssxgxitaccadb`.

Either provide:

- Supabase access token through `SUPABASE_ACCESS_TOKEN`, and DB password if CLI asks, or
- direct database password for `npx supabase db push`.

After credentials are available, run:

```bash
npx supabase link --project-ref tjcdifsssxgxitaccadb
npx supabase db push --include-all --yes
```

The licensing tables, provider key license model, RLS changes, downloads, source snapshots, reseller billing tables, and security advisories depend on these migrations.

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
   git tag -a source-v0.2.0 -m "Paid source snapshot v0.2.0"
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
10. Wait for delayed public mirror automation, or manually publish an approved old tag.

## 10. Verification Commands

```bash
npm run lint
npx tsc --noEmit --pretty false
npm run build
npm run groovy -- doctor --json --env-file .env.local
cd packages/groovy-cli && npm pack --dry-run
```
