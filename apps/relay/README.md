# FLOW Relay (WebSocket broker)

This service brokers:
- **Browser ↔ Local connector** connections
- **PTY terminal streams** (xterm.js UI ↔ node-pty on the user machine)
- **Workspace picking** (browser asks connector to pick a folder)

## Env vars

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RELAY_JWT_SECRET`
- `PORT` (default: `8787`)

## Run locally

From repo root:

```bash
node apps/relay/server.mjs
```

Health check: `GET /healthz` on the same port.

