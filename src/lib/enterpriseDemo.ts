export const ENTERPRISE_DEMO_ROUTE = "/enterprise-review";

function isTruthyEnv(value: string | undefined) {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeEnterpriseDemoLogoSrc(value: string | undefined) {
  const raw = (value || "").trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw) || raw.startsWith("data:")) {
    return raw;
  }

  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("public/")) {
    return `/${normalized.slice("public/".length).replace(/^\/+/, "")}`;
  }

  const publicMarker = "/public/";
  const publicIdx = normalized.lastIndexOf(publicMarker);
  if (publicIdx >= 0) {
    return `/${normalized.slice(publicIdx + publicMarker.length).replace(/^\/+/, "")}`;
  }

  // Backwards-compatible: keep supporting direct web paths like /logo.svg.
  if (normalized.startsWith("/")) {
    return normalized;
  }

  return raw;
}

export type EnterpriseDemoConfig = {
  enabled: boolean;
  userId: string | null;
  brandName: string;
  logoUrl: string | null;
};

export function getEnterpriseDemoConfig(): EnterpriseDemoConfig {
  const userId = (process.env.ENTERPRISE_DEMO_USER_ID || "").trim() || null;
  const brandName = (process.env.ENTERPRISE_DEMO_BRAND_NAME || "").trim() || "Enterprise Review";
  const logoUrl = normalizeEnterpriseDemoLogoSrc(
    process.env.ENTERPRISE_DEMO_LOGO_PATH || process.env.ENTERPRISE_DEMO_LOGO_URL
  );
  const enabled = isTruthyEnv(process.env.ENTERPRISE_DEMO_ENABLED) && !!userId;

  return {
    enabled,
    userId,
    brandName,
    logoUrl,
  };
}

export function isEnterpriseDemoUserId(userId: string | null | undefined) {
  const config = getEnterpriseDemoConfig();
  if (!config.enabled || !config.userId) return false;
  return !!userId && userId === config.userId;
}
