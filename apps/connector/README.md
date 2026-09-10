# Groovy Local Connector

Runs on the user's machine and provides:
- a **real PTY terminal** (via `node-pty`)
- a **folder picker** (macOS: `osascript`, Windows: PowerShell dialog)
- **auto-reconnect** when network drops or Mac wakes from sleep
- **auto-start on login** (macOS LaunchAgent, Windows Task Scheduler/Startup)

Connects outbound to the Groovy relay websocket.

## Run (Development)

From repo root:

```bash
cd apps/connector && npm install
node connector.mjs --relay ws://localhost:8787 --pair ABCD-EFGH-IJKL-MNOP
```

Once paired, the connector stores a device token at `~/.groovy/connector.json` and you can run:

```bash
node connector.mjs --relay ws://localhost:8787
```

## Production

For the production relay:

```bash
node connector.mjs --relay wss://groovy-relay.fly.dev --pair YOUR-CODE
```

## Auto-Start on Login

### macOS (LaunchAgent)

After first successful pairing, the connector automatically installs a **LaunchAgent** at:
```
~/Library/LaunchAgents/ai.gogroovy.connector.plist
```

This means:
- ✅ Connector starts automatically when you log in
- ✅ Auto-reconnects after sleep/network changes
- ✅ Runs in background (no terminal window needed)

Logs are written to `~/.groovy/connector.log`.

### Disable Auto-Start

To prevent auto-start installation during pairing:
```bash
node connector.mjs --pair YOUR-CODE --no-autostart
```

Or via env (useful for local dev scripts):
```bash
GROOVY_NO_AUTOSTART=1 node connector.mjs --pair YOUR-CODE
```

To remove an existing LaunchAgent:
```bash
launchctl unload ~/Library/LaunchAgents/ai.gogroovy.connector.plist
rm ~/Library/LaunchAgents/ai.gogroovy.connector.plist
```

### Windows (Task Scheduler / Startup folder fallback)

Install using `Groovy-Connector-windows.exe` (or use the zip if you are testing manually).

After first successful pairing, the connector installs auto-start for the current user:
- Primary: Task Scheduler task `Groovy Connector`
- Fallback: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Groovy Connector.cmd`
- Logs: `%USERPROFILE%\.groovy\connector.log`

On first run without a saved token, the installer/launcher shows a pairing-code dialog first, then falls back to terminal input if dialogs are blocked.

Disable during pair:
```powershell
node connector.mjs --pair YOUR-CODE --no-autostart
```

Or via env:
```powershell
$env:GROOVY_NO_AUTOSTART="1"; node connector.mjs --pair YOUR-CODE
```

Remove Task Scheduler entry:
```powershell
schtasks /delete /tn "Groovy Connector" /f
```

## Flags

- `--relay <url>` — Relay WebSocket URL
- `--pair <code>` — Pairing code from the web app
- `--device-name <name>` — Custom device name (defaults to hostname)
- `--reset` — Discard stored token and re-pair
- `--no-autostart` — Don't install auto-start entry (LaunchAgent/Task Scheduler)
- `GROOVY_NO_AUTOSTART=1` (or `GROOVY_CONNECTOR_NO_AUTOSTART=1`) — env alternative to skip auto-start install

### Claude CLI runner rollback flag

If you need to temporarily force the legacy non-Windows headless Claude runner:

```bash
GROOVY_CONNECTOR_USE_LEGACY_CLAUDE_RUNNER=1 node connector.mjs --relay ws://localhost:8787
```

## WhatsApp Web Bridge (Local)

This lets you talk to Groovy from a WhatsApp group on **this Mac**, without any cloud WhatsApp APIs.

### Requirements

- Set `WHATSAPP_GROUP_NAME` to the exact WhatsApp group name (e.g. `Groovy`)
- Set `GROOVY_APP_URL` to your Flow app URL (recommended: deployed URL)
- (Optional) `GROOVY_CODE_CWD` (or `--code-cwd`) to enable `@code` mode (path to your repo/workspace)

### Run

```bash
WHATSAPP_GROUP_NAME="Groovy" GROOVY_APP_URL="https://your-app" node connector.mjs --relay wss://groovy-relay.fly.dev --whatsapp
```

### Browser power and resource controls

The WhatsApp bridge runs Chromium in headless mode by default once a local
WhatsApp Web session exists. First-time pairing or reset sessions open a visible
browser window so the QR code can be scanned, unless headless mode is explicitly
forced with `GROOVY_WHATSAPP_HEADLESS=1`.

Groovy prefers an up-to-date installed Chrome or Edge because WhatsApp Web can
raise its minimum supported browser faster than the connector's Puppeteer
dependency. The current tested floor is Chromium 150; older cached browsers are
rejected with an actionable health error. Puppeteer's expected protocol revision
and the selected browser skew are logged for diagnostics. The launch policy
keeps hardware acceleration on and restores Chromium's background
timer/renderer throttling.

Before startup, Groovy measures the persistent WhatsApp browser profile. A
profile at or above 4 GB is renamed to a timestamped, recoverable
`session-battery-backup-*` directory and a fresh profile is opened. This prevents
pathological IndexedDB growth from being loaded forever; the user scans the QR
once to relink. Groovy never silently deletes the archived profile.

The event listener remains the primary inbound path. A recovery scan reads only
the already-loaded message tail every minute by default; it never invokes
WhatsApp's history loader. Page-wide request interception is off by default.

The connector samples the full WhatsApp browser process tree once per minute. It
restarts the browser between active operations at 2 GB RSS, or after three
consecutive samples at 125% total CPU once the browser is at least five minutes
old. Normal idle refresh and the eight-hour maximum renderer age remain in
place. If CPU or memory pressure would cause a third resource restart in one
hour, Groovy opens a circuit breaker and stops the WhatsApp browser to protect
the Mac's battery instead of entering an infinite restart loop. Resource samples
include aggregate CPU, RSS, largest child process, and RSS growth rate.

Rollback/debug switches:

- `GROOVY_WHATSAPP_HEADLESS=0` or `--whatsapp-headed` — run WhatsApp Web in a visible browser window
- `GROOVY_WHATSAPP_BLOCK_IMAGES=1` — opt into post-auth image/media request blocking (enables page-wide request interception)
- `WHATSAPP_INBOUND_POLL_INTERVAL_MS=<ms>` — tune the loaded-message recovery scan (default one minute; `0` disables it)
- `GROOVY_WHATSAPP_RECYCLE_MS=0` — disable time-based page refresh (CPU and memory safeguards remain active)
- `GROOVY_WHATSAPP_RECYCLE_IDLE_MS=<ms>` — tune how long the bridge must be idle before a refresh can happen
- `GROOVY_WHATSAPP_RECYCLE_MAX_AGE_MS=<ms>` — tune the hard renderer lifetime, or set `0` to disable the hard limit
- `GROOVY_WHATSAPP_RECYCLE_MEMORY_MB=<mb>` — tune the browser process-tree RSS limit, or set `0` to disable the memory guard
- `GROOVY_WHATSAPP_RECYCLE_CPU_PERCENT=<percent>` — tune aggregate browser CPU pressure, or set `0` to disable the CPU guard
- `GROOVY_WHATSAPP_RECYCLE_CPU_CHECKS=<count>` — tune the consecutive high-CPU samples required before restart
- `GROOVY_WHATSAPP_RESOURCE_CIRCUIT_MAX_RECYCLES=<count>` — tune allowed resource restarts inside the circuit window
- `GROOVY_WHATSAPP_RESOURCE_CIRCUIT_WINDOW_MS=<ms>` — tune the resource restart-loop window
- `GROOVY_WHATSAPP_PROFILE_MAX_MB=<mb>` — tune oversized-profile rotation (default 4096 MB; `0` disables it)
- `GROOVY_WHATSAPP_MIN_CHROME_MAJOR=<major>` — tune the tested WhatsApp Web browser floor
- `GROOVY_WHATSAPP_CHROME_PATH=<path>` — use an explicit Chrome/Edge/Chromium executable
- `GROOVY_WHATSAPP_ALLOW_OLD_BROWSER=1` — emergency-only opt-in for an explicit browser below the tested floor

Useful before/after checks while the connector is running:

```bash
ps -axo rss,command | grep -i groovy | grep -v grep | awk '{s+=$1} END {printf "%.0f MB\n", s/1024}'
ps -axo pid,command | grep -i groovy | grep -E "MacOS/Google Chrome" | grep -vE "type=" | sed 's/ --/\n    --/g'
ps -axo rss,command | grep -i groovy | grep "type=utility" | grep -oE "utility-sub-type=[^ ]*" | sort | uniq -c
```

### Commands in the group

- `@orch <message>` — talk to the orchestrator
- `@orch new` — start a new orchestrator session for that group
- `@code <message>` — send input to local `claude` CLI (requires a workspace; set `GROOVY_CODE_CWD` or pass `--code-cwd`)
