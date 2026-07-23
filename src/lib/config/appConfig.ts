export type AppConfig = {
  appUrl: string;
  relayUrl: string | null;
  brandName: string;
};

function normalizedHttpUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizedRelayUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function getConfiguredAppUrl(): string | null {
  return (
    normalizedHttpUrl(process.env.GROOVY_APP_URL) ||
    normalizedHttpUrl(process.env.NEXT_PUBLIC_APP_URL) ||
    normalizedHttpUrl(
      process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined
    )
  );
}

export function getAppUrl(): string {
  const configured = getConfiguredAppUrl();
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";
  throw new Error("GROOVY_APP_URL or NEXT_PUBLIC_APP_URL is required in production");
}

export function getConfiguredRelayUrl(): string | null {
  return (
    normalizedRelayUrl(process.env.GROOVY_RELAY_URL) ||
    normalizedRelayUrl(process.env.NEXT_PUBLIC_RELAY_URL)
  );
}

export const getRelayUrl = getConfiguredRelayUrl;

export function getBrandName(): string {
  return process.env.NEXT_PUBLIC_BRAND_NAME?.trim() || "Groovy";
}

export function getAppConfig(): AppConfig {
  return {
    appUrl: getAppUrl(),
    relayUrl: getRelayUrl(),
    brandName: getBrandName(),
  };
}
