# Kapso WhatsApp Runbook

## Enable Company WhatsApp (programmatic provisioning)

### Flow

1. Admin clicks **Enable Company WhatsApp** in Settings or selects "Company WhatsApp" during onboarding
2. Backend creates Kapso customer + setup link with `provision_phone_number: true`
3. User clicks the Kapso setup link (opens in new tab)
4. User completes Kapso's Facebook login + phone provisioning
5. Kapso redirects to `/whatsapp/success` with query params
6. Our success page calls `/api/whatsapp/kapso/redirect` which stores `phone_number_id` and marks workspace active
7. (Backup) Kapso sends project webhook to `/api/whatsapp/kapso/phone-connected` with `whatsapp.phone_number.created` event

### Setup Kapso Project Webhook (required for reliability)

In your Kapso dashboard:
1. Open Sidebar → **Webhooks** → **Project webhooks** tab
2. Click **Add Webhook**
3. Enter: `https://your-domain.com/api/whatsapp/kapso/phone-connected`
4. Subscribe to: `whatsapp.phone_number.created`
5. Copy the secret key and set it as `KAPSO_WEBHOOK_SECRET` (signature verification is enforced)

## Verification (DM allowlist)

1. User enters phone in Settings → **Verify your phone**
2. System generates a 6-digit code and stores it
3. User DMs Groovy: `verify <code>`
4. Kapso webhook (`/api/whatsapp/kapso/webhook`) validates code, marks phone verified, adds to allowlist

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/workspaces/company-whatsapp` | Create setup link (`action: "setup_link"`) |
| `GET /api/whatsapp/kapso/redirect` | Handle Kapso success redirect (stores phone_number_id) |
| `POST /api/whatsapp/kapso/phone-connected` | Kapso project webhook (backup detection) |
| `POST /api/whatsapp/kapso/webhook` | Inbound WhatsApp messages from Kapso |

## Environment Variables

```env
KAPSO_API_KEY=your_kapso_api_key
KAPSO_BASE_URL=https://api.kapso.ai/meta/whatsapp
KAPSO_PLATFORM_BASE_URL=https://api.kapso.ai/platform/v1
NEXT_PUBLIC_APP_URL=https://your-domain.com
KAPSO_WEBHOOK_SECRET=your_kapso_webhook_secret
```

## Docs

- Setup links: https://docs.kapso.ai/docs/platform/setup-links
- Connection detection: https://docs.kapso.ai/docs/platform/detecting-whatsapp-connection
- Webhooks: https://docs.kapso.ai/docs/platform/webhooks/overview
