# Groovy

Groovy is a source-available AI agent platform for running personal and enterprise workflows with your own model provider credentials, local connector runtimes, memory, Datagran/data integrations, and self-hosted deployment options.

Groovy is **source-available, not open source**. Public source is provided through a delayed public mirror for transparency, evaluation, security review, documentation, and contributions. Viewing, cloning, or forking the public mirror does not grant production, commercial, internal business, hosted, resale, sublicensing, or managed-service rights.

Use of Groovy requires a paid license unless Groovy has explicitly granted different written rights.

## Licensing

Groovy has two primary customer paths:

- **Groovy Personal**: yearly license for one individual using Groovy for personal, non-commercial projects.
- **Groovy Enterprise**: commercial license for companies that want source access, self-hosting, internal modification rights, support, and fallback rights to the last paid version.

Resale, sublicensing, third-party hosting, managed services, Groovy-powered customer services, and token-consumption billing require explicit written reseller or partner authorization.

Read:

- [LICENSE.md](LICENSE.md)
- [PERSONAL-LICENSE.md](PERSONAL-LICENSE.md)
- [COMMERCIAL-USE.md](COMMERCIAL-USE.md)
- [ENTERPRISE-LICENSE-SUMMARY.md](ENTERPRISE-LICENSE-SUMMARY.md)
- [RESELLER-TERMS-SUMMARY.md](RESELLER-TERMS-SUMMARY.md)

## Public Source And Forks

Yes, public GitHub repositories can be forked.

That does **not** mean forks are free to use commercially. A fork of the delayed public mirror is allowed for evaluation, review, and contribution, but the license still controls usage rights. If someone wants to use Groovy for a company, client, team, revenue-generating project, hosted service, resale, or internal business workflow, they need the correct Groovy license.

The paid product is not GitHub access alone. Paid access includes license rights, account portal access, downloads, updates, source snapshots, support, enterprise terms, and renewal/fallback rights.

## Billing Model

Groovy does not charge a percentage over token usage by default.

Customers bring their own provider credentials, such as:

- OpenAI
- Anthropic
- Google Gemini
- Azure OpenAI
- AWS Bedrock
- Groq
- Mistral
- Datagran

Token-consumption billing is only available for authorized enterprise resellers or partners whose license explicitly enables it.

## Easy Setup With An AI Agent

Groovy includes a paste-ready setup guide for AI coding agents:

- [docs/ai-agent-setup.md](docs/ai-agent-setup.md)

Copy that document into Claude Code, Codex, Cursor, or another AI coding agent. The agent will ask the user for the missing values and then run the Groovy CLI to configure the setup step by step.

The fastest way to get the setup prompt is:

```bash
npx @gogroovy/cli setup prompt
```

The setup flow covers local development, Vercel, Supabase, Fly.io, Stripe, provider API keys, Groovy license activation, Datagran Memory, Datagran-backed Data Integrations, and connector startup. Browser steps are only needed for account creation, OAuth, or provider dashboards that do not support full CLI setup.

## Repository Roles

The private production repository is for:

- current product development
- Vercel deployment
- unreleased source
- current paid source snapshots
- internal release preparation

The delayed public GitHub mirror is for:

- source code
- documentation
- issues
- pull requests
- security review
- developer evaluation

The separate `groovy-releases` repository is for:

- signed connector installers
- headless connector tarballs
- checksums
- CI-produced release artifacts

GitHub is not the payment or license authority. The Groovy account portal and license system control paid access, device activation, downloads, updates, and enterprise source snapshots.

## Contributing

Contributions are welcome, but contribution does not change the license terms.

Before contributing:

- Read [CONTRIBUTING.md](CONTRIBUTING.md).
- Do not include secrets, customer data, prompts, outputs, documents, credentials, or proprietary data.
- Keep changes focused.
- Include tests or verification notes for behavior changes.

Groovy may require a CLA or DCO before accepting contributions.

## Local Development

Install dependencies:

```bash
npm install
```

Run the web app:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Run the relay locally:

```bash
npm run relay
```

Run the local connector:

```bash
npm run connector -- --relay ws://localhost:8787 --pair YOUR-CODE
```

## Required Infrastructure

Groovy currently uses:

- Vercel for the Next.js app
- Supabase for auth, database, RLS, and private storage
- Fly.io for the websocket relay
- Stripe for personal yearly subscriptions
- GitHub Releases for connector release artifacts

See:

- [docs/reference-infrastructure.md](docs/reference-infrastructure.md)
- [docs/ai-agent-setup.md](docs/ai-agent-setup.md)
- [docs/groovy-licensing-distribution-plan.md](docs/groovy-licensing-distribution-plan.md)

## Security

Do not commit secrets.

Provider keys, license signing private keys, Stripe secrets, Supabase service role keys, relay secrets, and admin tokens must stay in server-side environment variables.

Read [SECURITY.md](SECURITY.md) before reporting vulnerabilities.
