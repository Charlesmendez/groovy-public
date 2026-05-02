# Security

Report security issues privately. Do not open a public issue for a vulnerability.

Security expectations:

- Do not commit secrets.
- Do not include raw API keys in documentation, logs, screenshots, traces, or test fixtures.
- Provider keys must be encrypted at rest and masked in UI.
- License signing private keys must stay server-side.
- Apps and CLIs may embed only the public license verification key.
- Download URLs should be authenticated, short-lived, and checksum-verified.
- License enforcement should not collect prompts, outputs, documents, workflows, credentials, local files, or business logic.

For self-hosted deployments, rotate any secret that has been exposed in a repository, logs, support bundle, or AI-agent transcript.
