# Groovy Desktop

Electron shell that loads the hosted Groovy web app (https://www.gogroovy.ai)
and manages the local connector (`apps/connector`) as a bundled child process.
One DMG: install, sign in, auto-pair.

## Layout

- `src/main/` — main process (window, connector manager, tray, updater, IPC)
- `src/preload/` — `window.groovyDesktop` bridge (typed twin:
  `src/lib/desktop/shell.ts` in the web repo)
- `resources/connector/` — bundled connector runtime (generated, git-ignored):
  `connector.mjs` + `node_modules/` + `node/bin/node` (vanilla Node v20 arm64;
  the connector's native addons require the vanilla Node ABI, so it is spawned
  with the bundled node binary — never `ELECTRON_RUN_AS_NODE`)

## Dev workflow

```bash
# once: connector deps (the bundler copies its node_modules)
cd apps/connector && npm ci

cd ../desktop
npm install
GROOVY_APP_URL=http://localhost:3000 \
GROOVY_RELAY_URL=ws://localhost:8787 \
npm run bundle-connector   # populate connector + non-secret runtime config
GROOVY_APP_URL=http://localhost:3000 \
GROOVY_RELAY_URL=ws://localhost:8787 \
npm run dev                # tsc + electron .
```

Runtime environment variables override the build configuration, so point the
shell at a local deployment with `GROOVY_APP_URL` and `GROOVY_RELAY_URL`.

## Release

Use the `Release Groovy Desktop (macOS)` GitHub workflow
(`.github/workflows/release-desktop.yml`, workflow_dispatch). It bundles the
connector, builds + signs + notarizes the DMG/ZIP with electron-builder, and
publishes the license-gated artifacts + `latest-mac.yml` update feed via
`scripts/publish-connector-downloads.mjs --desktop-*`.

Auto-updates are served from `https://www.gogroovy.ai/api/updates/desktop-feed`
(generic electron-updater feed, authenticated with the connector's device
token and license-gated like `/api/updates/check`).

## Connector lifecycle

- Spawned with `--relay wss://groovy-relay.fly.dev` and env
  `GROOVY_MANAGED_BY_DESKTOP=1` + `GROOVY_CONNECTOR_NO_AUTO_UPDATE=1`.
- Exponential backoff restarts (1s → 60s, reset after 5 min healthy).
- Pairing is driven by the web app (`useDesktopAutoPair`): it mints a pairing
  code and calls `groovyDesktop.pair(code)`; the manager runs the connector
  once with `--pair` and polls `~/.groovy/connector.json`.
- An existing standalone install's LaunchAgent
  (`~/Library/LaunchAgents/ai.gogroovy.connector.plist`) is adopted (booted
  out + removed) on startup; the same label is reinstalled on quit when
  "Keep running in background" is enabled.
- Connector logs: `~/.groovy/desktop-connector.log`.
