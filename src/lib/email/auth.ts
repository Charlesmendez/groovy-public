import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { verifyInternalRouteAuth } from "@/lib/internalRouteAuth";

export async function requireEmailUser(): Promise<
  | {
      ok: true;
      userId: string;
      email: string;
      supabase: ReturnType<typeof createSupabaseAdminClient>;
    }
  | { ok: false; response: NextResponse }
> {
  const sessionClient = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await sessionClient.auth.getUser();
  if (error || !user) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Unauthorized." },
        { status: 401 },
      ),
    };
  }
  return {
    ok: true,
    userId: user.id,
    email: user.email || "",
    supabase: createSupabaseAdminClient(),
  };
}

export async function requireEmailUserOrInternal(
  request: Request,
  internalScope: string,
): ReturnType<typeof requireEmailUser> {
  const internal = verifyInternalRouteAuth(request, internalScope);
  if (!internal) return requireEmailUser();
  const supabase = createSupabaseAdminClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.admin.getUserById(internal.userId);
  if (error || !user) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Unauthorized." },
        { status: 401 },
      ),
    };
  }
  return {
    ok: true,
    userId: user.id,
    email: user.email || "",
    supabase,
  };
}

export function jsonError(error: unknown, fallback: string, status = 500) {
  const message =
    error instanceof Error && error.message ? error.message : fallback;
  const upstreamStatus =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : null;
  const responseStatus =
    status !== 500
      ? status
      : upstreamStatus === 429
        ? 429
        : upstreamStatus === 401 || upstreamStatus === 403
          ? upstreamStatus
          : upstreamStatus === 0 ||
              (upstreamStatus !== null && upstreamStatus >= 500)
            ? 503
            : status;
  const retryAfterMs =
    error && typeof error === "object" && "retryAfterMs" in error
      ? Number((error as { retryAfterMs?: unknown }).retryAfterMs)
      : 0;
  return NextResponse.json(
    { ok: false, error: message },
    {
      status: responseStatus,
      headers:
        Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))) }
          : undefined,
    },
  );
}
