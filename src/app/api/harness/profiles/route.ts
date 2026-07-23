import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PROFILE_SLUG_RE, sanitizeProfilePatch, slugifyProfileName } from "@/lib/orchestrator/profileApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Harness profiles ("Minds") CRUD. RLS enforces visibility: personal profiles
// (workspace_id null, user_id = auth.uid()) and workspace profiles the caller
// is a member of; writes require workspace admin or personal ownership.

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("orchestrator_profiles")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ profiles: data ?? [] });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const patch = sanitizeProfilePatch(body);
  const name = (patch.name as string) ?? body.name.trim();
  const slug = (patch.slug as string) ?? slugifyProfileName(name);
  if (!PROFILE_SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Could not derive a valid slug from name" }, { status: 400 });
  }

  const workspaceId = typeof body.workspace_id === "string" && body.workspace_id ? body.workspace_id : null;

  const { data, error } = await supabase
    .from("orchestrator_profiles")
    .insert({
      ...patch,
      name,
      slug,
      workspace_id: workspaceId,
      user_id: workspaceId ? null : user.id,
      created_by: user.id,
    })
    .select("*")
    .single();
  if (error) {
    const status = error.code === "23505" ? 409 : error.code === "42501" ? 403 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ profile: data }, { status: 201 });
}
