# Groovy GitHub Source Workflow

## Final Repository Model

Use three repositories:

| Repository | Visibility | Purpose |
| --- | --- | --- |
| `Charlesmendez/groovy` | Private | Current production source, Vercel deployment, paid source snapshots, internal development. |
| `Charlesmendez/groovy-public` | Public | Delayed source-available mirror, public issues, public pull requests, security review, evaluation. |
| `Charlesmendez/groovy-releases` | Private | Internal connector release artifact staging for signed installers, checksums, and headless tarballs. |

`groovy` is the source of truth. `groovy-public` is a delayed mirror. Never automatically merge public mirror code back into private source.

## Public Mirror Publishing

The private repo contains `.github/workflows/publish-public-mirror.yml`.

It publishes delayed source from private `groovy` to public `groovy-public`.

Default behavior:

- Weekly scheduled run.
- Looks for the newest source tag matching `source-v*` that is older than `90` days.
- Publishes that tag to `groovy-public`.
- If no eligible tag exists during scheduled runs, it exits without publishing.

Manual behavior:

1. Open private `groovy` on GitHub.
2. Go to **Actions**.
3. Choose **Publish Public Mirror**.
4. Click **Run workflow**.
5. Optional inputs:
   - `source_ref`: a release tag or commit SHA to publish.
   - `delay_days`: default `90`.
   - `tag_pattern`: default `source-v*`.
   - `target_repo`: default `Charlesmendez/groovy-public`.

The workflow uses:

- a write deploy key on `groovy-public`
- private repo secret `PUBLIC_MIRROR_SSH_KEY`
- script `scripts/publish-public-mirror.mjs`

The public mirror publisher excludes local/env/build/deployment-only files such as `.env*`, `.vercel`, `.next`, connector build output, and private release/deploy workflows.

## Source Tags

Use dedicated source snapshot tags in the private `groovy` repo:

```bash
git tag -a source-v1.2.3 -m "Paid source snapshot v1.2.3"
git push origin source-v1.2.3
```

Do not rely on connector artifact tags for public mirroring. Connector release automation may use tags like `v0.2.0`; public source mirroring should use only `source-v*` tags so installer/package releases do not accidentally publish source.

## Public Contributions

Public contributors use `groovy-public`.

Allowed public contribution types:

- documentation
- examples
- SDKs
- small bug fixes
- tests that apply to the delayed source
- security reports through the security policy

Do not use the public repo as the private development trunk.

To bring a public PR into private `groovy`:

1. Review the public PR.
2. Pull the patch or cherry-pick the commit locally.
3. Apply it to private `groovy`.
4. Resolve conflicts against current private source.
5. Run tests.
6. Merge into private `groovy` through the normal private PR flow.
7. Let the change appear in `groovy-public` later through the delayed mirror workflow.

## Paid Customer Source Access

Personal paid users should receive source through Groovy portal/CLI source snapshots, not private GitHub collaborator access.

Enterprise customers should also receive source through portal/CLI snapshots by default.

Private GitHub collaborator access should be reserved for enterprise contracts that explicitly include it.

Optional enterprise GitHub access automation:

- Set `GITHUB_SOURCE_REPO=Charlesmendez/groovy`.
- Set `GITHUB_SOURCE_ACCESS_TOKEN` to a fine-grained GitHub token that can invite collaborators to the private source repo.
- Use `POST /api/admin/source-access/github` to invite an enterprise customer GitHub username with `pull` permission.

This avoids manual GitHub clicking while keeping personal licenses off private GitHub.

## GitHub Settings

Private `groovy`:

- Keep private.
- Keep Vercel connected.
- Enable squash merge only.
- Disable merge commits and rebase merges.
- Auto-delete branches after merge.
- Keep write access limited to admins/maintainers.

Public `groovy-public`:

- Public.
- Issues enabled.
- Pull requests enabled.
- Wiki disabled.
- Squash merge only.
- Auto-delete branches after merge.
- `main` branch protection enabled.
- Require PR review.
- Require conversation resolution.
- Disable force pushes and branch deletion.
- Require first-time contributor approval for fork pull request workflows.
- Enable secret scanning and Dependabot alerts.

`groovy-releases`:

- Keep private. It is not a public download surface.
- Do not use it as the license or payment system.
- Paid users should receive current connector installers through the Groovy account portal/CLI download entitlement.
- Store production customer-facing artifacts in private storage and serve them through short-lived signed URLs from the portal.
- Hosted Mac bootstrap must use `HOSTED_MAC_BOOTSTRAP_TARBALL_URL` pointing to an internal/private artifact reference, preferably `supabase://groovy-downloads/connector/Groovy-Connector-Headless.tar.gz`, not a public GitHub Release URL.
