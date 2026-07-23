import { getAppUrl, getConfiguredAppUrl } from "@/lib/config/appConfig";

type DatagranLinkTokenArgs = {
  apiKeys: Array<string | null | undefined>;
  endUserExternalId: string;
  email?: string | null;
  origin: string;
  provider: string;
  scopes?: string[];
};

type DatagranLinkTokenResult =
  | {
      ok: true;
      data: unknown;
      linkToken?: string;
      usedApiKeyIndex: number;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

function uniqueApiKeys(apiKeys: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of apiKeys) {
    const normalized = typeof key === "string" ? key.trim() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function shouldTryNextKey(status: number): boolean {
  return status === 401 || status === 403;
}

export function normalizeDatagranLinkOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

export function resolveDatagranLinkOrigin(
  requestUrl?: string | null,
  fallback?: string,
): string {
  if (requestUrl) {
    try {
      return normalizeDatagranLinkOrigin(new URL(requestUrl).origin);
    } catch {
      // Fall through to configured fallback.
    }
  }

  return normalizeDatagranLinkOrigin(
    getConfiguredAppUrl() || fallback || getAppUrl(),
  );
}

export async function createDatagranLinkToken(
  args: DatagranLinkTokenArgs
): Promise<DatagranLinkTokenResult> {
  const apiKeys = uniqueApiKeys(args.apiKeys);
  if (apiKeys.length === 0) {
    return { ok: false, status: 500, error: "Datagran API key not configured" };
  }

  let lastError: { status: number; error: string } | null = null;
  for (let i = 0; i < apiKeys.length; i += 1) {
    const response = await fetch("https://www.datagran.io/api/link/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKeys[i],
      },
      body: JSON.stringify({
        endUser: {
          externalId: args.endUserExternalId,
          ...(args.email ? { email: args.email } : {}),
        },
        origin: args.origin,
        provider: args.provider,
        ...(Array.isArray(args.scopes) && args.scopes.length > 0
          ? { scopes: args.scopes }
          : {}),
      }),
    });

    const text = await response.text().catch(() => "");
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (response.ok) {
      const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const linkToken =
        typeof record.linkToken === "string"
          ? record.linkToken
          : typeof record.link_token === "string"
            ? record.link_token
            : undefined;
      return { ok: true, data, linkToken, usedApiKeyIndex: i };
    }

    const error =
      typeof data === "string"
        ? data
        : data
          ? JSON.stringify(data)
          : response.statusText || "Unknown Datagran error";
    lastError = { status: response.status, error };
    if (!shouldTryNextKey(response.status)) break;
  }

  return {
    ok: false,
    status: lastError?.status || 500,
    error: lastError?.error || "Datagran API error",
  };
}
