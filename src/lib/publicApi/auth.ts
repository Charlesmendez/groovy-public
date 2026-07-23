import { createHash, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  profileRowToHarnessProfile,
  type HarnessProfile,
  type OrchestratorProfileRow,
} from "../orchestrator/harnessProfiles";

export type HarnessApiKeyAuth = {
  key: {
    id: string;
    profileId: string;
    ownerUserId: string;
    workspaceId: string | null;
    kind: "secret" | "publishable";
    scopes: string[];
    allowedOrigins: string[];
    rateLimitPerMinute: number;
  };
  profile: HarnessProfile;
  rateLimit: {
    limit: number;
    remaining: number;
    resetAt: number;
  };
  requestOrigin: string | null;
};

export class PublicApiAuthError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function hashHarnessApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || "";
}

function normalizedOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function resolveHarnessRequestOrigin(req: Request): {
  requestOrigin: string | null;
  claimedParentOrigin: string | null;
  browserOrigin: string | null;
  apiOrigin: string | null;
} {
  const claimedParentOrigin = normalizedOrigin(req.headers.get("x-harness-origin"));
  const browserOrigin = normalizedOrigin(req.headers.get("origin"));
  const apiOrigin = normalizedOrigin(req.url);
  const crossOriginBrowserRequest =
    browserOrigin !== null && apiOrigin !== null && browserOrigin !== apiOrigin;

  // An embedded widget makes same-origin API calls from the hosted iframe and
  // carries its CSP-bound parent origin in X-Harness-Origin. For a genuinely
  // cross-origin browser request, however, the browser's immutable Origin
  // header must agree with that claim before any write is allowed.
  if (
    crossOriginBrowserRequest &&
    claimedParentOrigin &&
    claimedParentOrigin !== browserOrigin
  ) {
    throw new PublicApiAuthError(
      "Browser origin does not match the claimed harness origin",
      403,
      "origin_mismatch",
    );
  }

  return {
    requestOrigin: crossOriginBrowserRequest
      ? browserOrigin
      : claimedParentOrigin || browserOrigin,
    claimedParentOrigin,
    browserOrigin,
    apiOrigin,
  };
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
}

export function rateLimitHeaders(auth: HarnessApiKeyAuth): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(auth.rateLimit.limit),
    "X-RateLimit-Remaining": String(auth.rateLimit.remaining),
    "X-RateLimit-Reset": String(auth.rateLimit.resetAt),
  };
}

export function corsHeaders(
  req: Request,
  auth?: HarnessApiKeyAuth | null,
): Record<string, string> {
  const requested =
    normalizedOrigin(req.headers.get("x-harness-origin")) ||
    normalizedOrigin(req.headers.get("origin"));
  const allowed =
    auth?.key.kind === "publishable" &&
    requested &&
    auth.key.allowedOrigins.includes(requested)
      ? requested
      : null;
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": allowed, Vary: "Origin" } : {}),
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, X-Harness-Origin, X-Harness-Thread-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

export async function authenticateHarnessApiRequest(args: {
  req: Request;
  admin: SupabaseClient;
  slug: string;
  requiredScope: "threads:read" | "threads:write";
}): Promise<HarnessApiKeyAuth> {
  const rawKey = bearerToken(args.req);
  if (!rawKey || !/^ghk_(secret|pub)_[A-Za-z0-9_-]{24,}$/.test(rawKey)) {
    throw new PublicApiAuthError("Invalid API key", 401, "invalid_api_key");
  }
  const keyHash = hashHarnessApiKey(rawKey);
  const { data: row, error } = await args.admin
    .from("harness_api_keys")
    .select("*")
    .eq("key_hash", keyHash)
    .maybeSingle();
  if (error || !row || row.revoked_at) {
    throw new PublicApiAuthError("Invalid or revoked API key", 401, "invalid_api_key");
  }

  const scopes = jsonStringArray(row.scopes);
  if (!scopes.includes(args.requiredScope)) {
    throw new PublicApiAuthError("API key scope does not allow this operation", 403, "scope_denied");
  }
  const { data: profileRow } = await args.admin
    .from("orchestrator_profiles")
    .select("*")
    .eq("id", row.profile_id)
    .eq("slug", args.slug)
    .maybeSingle();
  if (!profileRow) {
    throw new PublicApiAuthError("Harness not found for this key", 404, "harness_not_found");
  }
  const persistedProfile = profileRow as OrchestratorProfileRow;
  const profileWorkspaceId = persistedProfile.workspace_id
    ? String(persistedProfile.workspace_id)
    : null;
  const keyWorkspaceId = row.workspace_id ? String(row.workspace_id) : null;
  const ownershipMatches =
    profileWorkspaceId !== null
      ? keyWorkspaceId === profileWorkspaceId
      : keyWorkspaceId === null &&
        persistedProfile.user_id === String(row.owner_user_id);
  if (!ownershipMatches) {
    throw new PublicApiAuthError(
      "API key ownership does not match its harness profile",
      403,
      "key_profile_mismatch",
    );
  }
  if (profileWorkspaceId) {
    const { data: ownerMembership, error: ownerMembershipError } = await args.admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", profileWorkspaceId)
      .eq("user_id", row.owner_user_id)
      .eq("role", "admin")
      .maybeSingle();
    if (ownerMembershipError || !ownerMembership) {
      throw new PublicApiAuthError(
        "The API key owner is no longer a workspace administrator",
        403,
        "key_owner_access_revoked",
      );
    }
  }
  const profile = profileRowToHarnessProfile(persistedProfile);
  if (
    profile.surface !== "external" ||
    profile.authorizationStance !== "restricted" ||
    profile.memoryScope !== "profile"
  ) {
    throw new PublicApiAuthError(
      "Public keys require an external, restricted, profile-memory harness",
      403,
      "internal_profile_denied",
    );
  }

  const { requestOrigin } = resolveHarnessRequestOrigin(args.req);
  const allowedOrigins = jsonStringArray(row.allowed_origins)
    .map(normalizedOrigin)
    .filter((origin): origin is string => Boolean(origin));
  if (row.kind === "publishable") {
    if (!requestOrigin || !allowedOrigins.includes(requestOrigin)) {
      throw new PublicApiAuthError("Origin is not allowed for this key", 403, "origin_denied");
    }
  } else if (requestOrigin && allowedOrigins.length > 0 && !allowedOrigins.includes(requestOrigin)) {
    throw new PublicApiAuthError("Origin is not allowed for this key", 403, "origin_denied");
  }

  const limit = Math.max(1, Number(row.rate_limit_per_minute) || 60);
  const { data: consumed, error: consumeError } = await args.admin.rpc(
    "consume_harness_api_rate_limit",
    { p_key_id: row.id, p_limit: limit },
  );
  if (consumeError || !consumed || typeof consumed !== "object") {
    throw new PublicApiAuthError("Rate limiter unavailable", 503, "rate_limiter_unavailable");
  }
  const rateLimit = {
    limit: Number(consumed.limit) || limit,
    remaining: Math.max(0, Number(consumed.remaining) || 0),
    resetAt: Number(consumed.reset_at) || Math.ceil(Date.now() / 1000) + 60,
  };
  if (consumed.allowed !== true) {
    throw new PublicApiAuthError("Rate limit exceeded", 429, "rate_limit_exceeded", {
      "Retry-After": String(Math.max(1, rateLimit.resetAt - Math.floor(Date.now() / 1000))),
      "X-RateLimit-Limit": String(rateLimit.limit),
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(rateLimit.resetAt),
    });
  }

  return {
    key: {
      id: String(row.id),
      profileId: String(row.profile_id),
      ownerUserId: String(row.owner_user_id),
      workspaceId: row.workspace_id ? String(row.workspace_id) : null,
      kind: row.kind === "publishable" ? "publishable" : "secret",
      scopes,
      allowedOrigins,
      rateLimitPerMinute: limit,
    },
    profile,
    rateLimit,
    requestOrigin,
  };
}

export function constantTimeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
