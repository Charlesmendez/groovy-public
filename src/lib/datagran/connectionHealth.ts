import type { DatagranProvider } from "@/lib/datagran/prompts";

export type DatagranConnectionHealthCheck = {
  method: "GET" | "POST";
  endpoint: string;
  body?: unknown;
};

const REAUTH_CAPABLE_PROVIDERS = new Set<DatagranProvider>([
  "facebook_ads",
  "facebook_leads",
  "instagram",
  "google_ads",
  "google_calendar",
  "gmail",
  "linkedin_ads",
  "google_drive",
  "tiktok",
  "salesforce",
]);

export const DATAGRAN_CONNECTION_HEALTH_CHECKS: Partial<
  Record<DatagranProvider, DatagranConnectionHealthCheck>
> = {
  gmail: {
    method: "GET",
    endpoint: "/api/proxy/gmail/gmail/v1/users/me/profile",
  },
  google_calendar: {
    method: "GET",
    endpoint:
      "/api/proxy/google-calendar/calendar/v3/calendars/primary/events" +
      "?maxResults=1&singleEvents=true",
  },
  google_drive: {
    method: "GET",
    endpoint: "/api/proxy/google-drive/drive/v3/about?fields=user",
  },
  salesforce: {
    method: "GET",
    endpoint: "/api/proxy/salesforce/services/data",
  },
  postgres: {
    method: "POST",
    endpoint: "/api/proxy/postgres/query",
    body: {
      sql: "SELECT 1 AS connection_ok LIMIT 1",
      params: [],
    },
  },
};

function providerSupportsReauth(provider: unknown): boolean {
  return (
    typeof provider === "string" &&
    REAUTH_CAPABLE_PROVIDERS.has(provider as DatagranProvider)
  );
}

/**
 * Only credential failures become "Needs re-authentication". A 403 caused by
 * an endpoint requiring a broader OAuth scope is a health-check/configuration
 * error; reconnecting with the same scopes cannot repair it.
 */
export function isDatagranAuthorizationRequiredError(
  status: number,
  data: unknown,
  provider?: string,
): boolean {
  if (!providerSupportsReauth(provider)) return false;
  if (status === 401) return true;

  if (data && typeof data === "object") {
    const value = data as Record<string, unknown>;
    if (value.status === "authorization_required") return true;
    if (value.error === "authorization_required") return true;
    if (
      typeof value.error === "string" &&
      /token.*expired|invalid.*token|authorization.*required|requires reauthorization|reauthorization/i.test(
        value.error,
      )
    ) {
      return true;
    }
    if (
      typeof value.message === "string" &&
      /token.*expired|invalid.*token|authorization.*required|requires reauthorization|reauthorization/i.test(
        value.message,
      )
    ) {
      return true;
    }
  }

  return (
    typeof data === "string" &&
    /token.*expired|invalid.*token|authorization.*required|requires reauthorization|reauthorization/i.test(
      data,
    )
  );
}
