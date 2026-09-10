# Workspace secrets for Minds and skills

Workspace admins declare secret names in **Workspace settings → Secrets**. The
plaintext value is entered in a native Groovy Connector dialog and encrypted in
that device's local vault. Groovy's server stores only metadata, grants, and a
per-device readiness flag.

An action may use a secret only when the same secret is granted to both:

1. the selected Mind (or worker), and
2. the skill that declares the action.

Guest participants can ask the channel's selected Mind to use an eligible
action. They cannot enumerate secrets, read values, or use the action through a
public API/widget. The action still requires the assigned local Connector.

## Skill action manifest

Put `groovy-actions.json` beside `SKILL.md`. Secret values never belong in this
file. Example:

```json
{
  "schemaVersion": 1,
  "actions": [
    {
      "name": "lookup_customer",
      "description": "Look up one customer in the approved service.",
      "secrets": ["CUSTOMER_API_KEY"],
      "inputSchema": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"],
        "additionalProperties": false
      },
      "http": {
        "method": "GET",
        "url": "https://api.example.com/customers/{{args.id}}",
        "headers": {
          "Authorization": "Bearer {{secret.CUSTOMER_API_KEY}}"
        },
        "timeoutMs": 30000
      }
    }
  ]
}
```

HTTP actions require a fixed public HTTPS host. Secrets are prohibited in URLs.
CLI actions use `node`, `python3`, or `python` directly (never a shell); their
script must be inside the skill directory and secrets may be injected only via
the declared environment. Connector output is bounded and secret-redacted.
