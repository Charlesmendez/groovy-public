# Hosted Mac Runbook

## Build headless connector artifact

```bash
cd apps/connector
npm install
npm run build:headless
```

This creates:
- `apps/connector/dist/Groovy-Connector-Headless.tar.gz`

Upload `apps/connector/dist/Groovy-Connector-Headless.tar.gz` to a private artifact
location. `Charlesmendez/groovy-releases` is private and can be used as internal
staging, but the bootstrap job needs a URL it can fetch server-side.

---

## Provisioning Flow (step-by-step)

### 1. User requests a Groovy Mac

- User selects "Groovy Mac" in onboarding/settings
- Clicks "Request Groovy Mac"
- Creates `hosted_mac_requests` row with `status: waiting_for_credentials`
- Sends Slack notification to admin

### 2. Admin purchases Mac from provider

Go to a provider (e.g., Macly, OakHost) and purchase a Mac. Get:
- Hostname/IP
- SSH port (usually 22)
- SSH user
- SSH private key or password

**Important**: The Mac must have Node.js installed.

### 3. Admin enters credentials in admin panel

1. Go to `/admin/hosted-macs`
2. Find the request
3. Fill in:
   - Provider (e.g., "macly")
   - Hostname (e.g., "192.168.1.100" or "macly-12345.cloud")
   - SSH user (e.g., "admin")
   - SSH port (usually 22)
   - SSH private key OR password
4. Click **Save credentials**

### 4. Admin generates pairing code

1. Click **Generate** next to the pairing code field
2. This creates a 30-minute pairing code for the requesting user
3. The code auto-fills in the input

### 5. Admin runs bootstrap

1. Check **Enable WhatsApp Web** if needed
2. Click **Run bootstrap**
3. This SSHs into the Mac and:
   - Downloads the headless tarball
   - Creates a LaunchDaemon
   - Starts the connector with the pairing code

### 6. Verify and mark ready

1. Check relay logs or dashboard to confirm connector connected
2. Copy the device_id from the relay/dashboard
3. Paste device_id in admin panel
4. Click **Mark ready** or **Mark online**

### 7. User is notified (manual for now)

Send email to user that their Mac is ready.

---

## Updating the hosted connector (1-click)

Once the hosted connector is online, workspace admins can update it from the dashboard:

- Open the connector menu / settings
- If it shows **Update available**, click **Update now**
- The connector will:
  - download the latest headless tarball
  - extract it over the existing install
  - restart itself (launchd keeps it alive)

No DMG download is needed for Groovy Macs.

If the hosted connector is **offline**, use the Settings “Request update” button (Slack ping) or re-run bootstrap.

---

## SSH Connection Test (manual)

```bash
# With private key
ssh -i /path/to/key -p 22 user@hostname

# With password
ssh -p 22 user@hostname
```

Verify Node.js is installed:
```bash
node --version  # Should show v18+ or v20+
```

---

## Important Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `HOSTED_MACS_SLACK_WEBHOOK_URL` | Slack webhook for notifications | `https://hooks.slack.com/...` |
| `HOSTED_MAC_ADMIN_EMAILS` | Comma-separated admin emails | `admin@example.com,ops@example.com` |
| `HOSTED_MAC_BOOTSTRAP_TARBALL_URL` | Private signed/internal URL to headless tarball | `https://.../Groovy-Connector-Headless.tar.gz?...` |
| `NEXT_PUBLIC_APP_URL` | App URL (connector API target) | `https://gogroovy.ai` |
| `RELAY_JWT_SECRET` | Same secret as relay | `your-secret-key` |

---

## Status Lifecycle

```
waiting_for_credentials → bootstrapping → bootstrapped → ready → connector_online
```

- `waiting_for_credentials`: Initial state after user request
- `bootstrapping`: Admin is setting up the Mac
- `bootstrapped`: Bootstrap script completed successfully
- `ready`: Connector is configured and should be online
- `connector_online`: Verified that connector is connected to relay

---

## Troubleshooting

### Bootstrap fails with "node not found"
SSH into the Mac and install Node.js:
```bash
# Using Homebrew
brew install node

# Or using nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
```

### Connector not connecting
Check logs on the Mac:
```bash
sudo cat /var/log/groovy-connector.log
```

### Restart the connector
```bash
sudo launchctl unload /Library/LaunchDaemons/ai.gogroovy.connector.plist
sudo launchctl load /Library/LaunchDaemons/ai.gogroovy.connector.plist
```

### Re-run bootstrap with new pairing code
1. Generate a new pairing code in admin panel
2. Click "Run bootstrap" again (will overwrite the old config)
