/**
 * Vercel REST API base client.
 * Server-only — VERCEL_API_TOKEN must never leave the server.
 */

const VERCEL_API_BASE = "https://api.vercel.com";

function getToken(): string {
  const t = process.env.VERCEL_API_TOKEN;
  if (!t) throw new Error("VERCEL_API_TOKEN is not set");
  return t;
}

function getTeamId(): string {
  const t = process.env.VERCEL_TEAM_ID;
  if (!t) throw new Error("VERCEL_TEAM_ID is not set");
  return t;
}

/** Append teamId query param to a URL. */
function withTeam(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}teamId=${encodeURIComponent(getTeamId())}`;
}

export type VercelRequestInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

/**
 * Low-level fetch wrapper. Adds Authorization + Content-Type headers and
 * prepends the Vercel API base URL.
 */
export async function vercelFetch<T = unknown>(
  path: string,
  init?: VercelRequestInit
): Promise<{ status: number; data: T }> {
  const url = withTeam(`${VERCEL_API_BASE}${path}`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getToken()}`,
    "Content-Type": "application/json",
    ...(init?.headers || {}),
  };

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = text as unknown as T;
  }

  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "error" in (data as Record<string, unknown>)
        ? JSON.stringify((data as Record<string, unknown>).error)
        : text.slice(0, 500);
    throw new VercelApiError(res.status, msg, path);
  }

  return { status: res.status, data };
}

export class VercelApiError extends Error {
  status: number;
  path: string;
  constructor(status: number, message: string, path: string) {
    super(`Vercel API ${status} ${path}: ${message}`);
    this.name = "VercelApiError";
    this.status = status;
    this.path = path;
  }
}
