type KapsoSendArgs = {
  phoneNumberId: string;
  to: string;
  body: string;
};

const KAPSO_API_KEY = process.env.KAPSO_API_KEY || "";
const KAPSO_BASE_URL = process.env.KAPSO_BASE_URL || "https://api.kapso.ai/meta/whatsapp";
const KAPSO_PLATFORM_BASE_URL =
  process.env.KAPSO_PLATFORM_BASE_URL || "https://api.kapso.ai/platform/v1";

function getAppBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    (process.env.PORT ? `http://localhost:${process.env.PORT}` : "") ||
    ""
  );
}

export async function sendKapsoText({ phoneNumberId, to, body }: KapsoSendArgs) {
  if (!KAPSO_API_KEY) {
    throw new Error("KAPSO_API_KEY not configured");
  }
  const res = await fetch(`${KAPSO_BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KAPSO_API_KEY}`,
    },
    body: JSON.stringify({
      phoneNumberId,
      to,
      body,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Kapso send failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return await res.json().catch(() => ({}));
}

export async function createKapsoCustomer(args: { name: string; externalCustomerId?: string }) {
  if (!KAPSO_API_KEY) {
    throw new Error("KAPSO_API_KEY not configured");
  }
  const res = await fetch(`${KAPSO_PLATFORM_BASE_URL}/customers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": KAPSO_API_KEY,
    },
    body: JSON.stringify({
      customer: {
        name: args.name,
        external_customer_id: args.externalCustomerId || null,
      },
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Kapso create customer failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return await res.json().catch(() => ({}));
}

export async function createKapsoSetupLink(args: {
  customerId: string;
  connectionTypes?: Array<"coexistence" | "dedicated">;
  provisionPhoneNumber?: boolean;
  countryIsos?: string[];
}) {
  if (!KAPSO_API_KEY) {
    throw new Error("KAPSO_API_KEY not configured");
  }
  const baseUrl = getAppBaseUrl();
  if (!baseUrl) {
    throw new Error("Missing NEXT_PUBLIC_APP_URL");
  }
  const res = await fetch(`${KAPSO_PLATFORM_BASE_URL}/customers/${args.customerId}/setup_links`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": KAPSO_API_KEY,
    },
    body: JSON.stringify({
      setup_link: {
        success_redirect_url: `${baseUrl}/whatsapp/success`,
        failure_redirect_url: `${baseUrl}/whatsapp/failed`,
        allowed_connection_types: args.connectionTypes || ["dedicated"],
        provision_phone_number: args.provisionPhoneNumber === true,
        phone_number_country_isos: args.countryIsos || ["US"],
      },
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Kapso create setup link failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return await res.json().catch(() => ({}));
}
