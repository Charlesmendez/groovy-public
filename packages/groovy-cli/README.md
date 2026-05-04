# `@gogroovy/cli`

Groovy CLI for setup, validation, licensing, Datagran Memory, Datagran data integrations, provider keys, and connector commands.

Install:

```bash
npm install -g @gogroovy/cli
```

Run:

```bash
groovy doctor --json --env-file .env.local
groovy setup prompt
groovy memory status --env-file .env.local
groovy integrations list
groovy license activate --license-key "$GROOVY_LICENSE_KEY" --app https://www.gogroovy.ai
```

`groovy setup prompt` prints AI-agent setup instructions for developer source setup, enterprise self-hosting, or advanced local setup. Normal personal users usually use the Groovy account portal, download the connector/current source snapshot they are entitled to, install the connector, and add their own provider keys.

In the source repo, the full paste-ready document is `docs/ai-agent-setup.md`.

Datagran Memory and Datagran-backed Data Integrations require a Datagran account and `DATAGRAN_API_KEY` when enabled.

Groovy is source-available, not open source. Use of Groovy requires the appropriate Groovy license.
