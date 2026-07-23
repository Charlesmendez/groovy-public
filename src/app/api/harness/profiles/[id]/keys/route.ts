import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hashHarnessApiKey } from "@/lib/publicApi/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await supabase
    .from("harness_api_keys")
    .select(
      "id,profile_id,name,key_prefix,kind,scopes,rate_limit_per_minute,allowed_origins,request_count,revoked_at,last_used_at,created_at",
    )
    .eq("profile_id", id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ keys: data || [] });
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: profile } = await supabase
    .from("orchestrator_profiles")
    .select("id,user_id,workspace_id,surface,authorization_stance,memory_scope")
    .eq("id", id)
    .maybeSingle();
  if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  if (
    profile.surface !== "external" ||
    profile.authorization_stance !== "restricted" ||
    profile.memory_scope !== "profile"
  ) {
    return NextResponse.json(
      { error: "Only external, restricted profiles with isolated memory can issue public API keys" },
      { status: 400 },
    );
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const kind = body?.kind === "publishable" ? "publishable" : "secret";
  const name =
    typeof body?.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 100)
      : kind === "publishable"
        ? "Widget key"
        : "API key";
  const rawKey = `ghk_${kind === "publishable" ? "pub" : "secret"}_${randomBytes(32).toString("base64url")}`;
  const scopes = Array.isArray(body?.scopes)
    ? body.scopes
        .map(String)
        .filter((scope) => scope === "threads:read" || scope === "threads:write")
    : ["threads:read", "threads:write"];
  const allowedOrigins = Array.isArray(body?.allowedOrigins)
    ? body.allowedOrigins
        .map((origin) => {
          try {
            const parsed = new URL(String(origin));
            return parsed.protocol === "http:" || parsed.protocol === "https:"
              ? parsed.origin
              : null;
          } catch {
            return null;
          }
        })
        .filter((origin): origin is string => Boolean(origin))
    : [];
  if (kind === "publishable" && allowedOrigins.length === 0) {
    return NextResponse.json(
      { error: "Publishable keys require at least one allowed origin" },
      { status: 400 },
    );
  }
  const rateLimit = Math.max(
    1,
    Math.min(10000, Math.trunc(Number(body?.rateLimitPerMinute) || 60)),
  );
  const { data, error } = await supabase
    .from("harness_api_keys")
    .insert({
      profile_id: id,
      owner_user_id: user.id,
      workspace_id: profile.workspace_id,
      name,
      key_prefix: rawKey.slice(0, 20),
      key_hash: hashHarnessApiKey(rawKey),
      kind,
      scopes,
      rate_limit_per_minute: rateLimit,
      allowed_origins: allowedOrigins,
    })
    .select(
      "id,profile_id,name,key_prefix,kind,scopes,rate_limit_per_minute,allowed_origins,request_count,revoked_at,last_used_at,created_at",
    )
    .single();
  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: error.code === "42501" ? 403 : 500 },
    );
  }
  return NextResponse.json({ key: data, plaintext: rawKey }, { status: 201 });
}
