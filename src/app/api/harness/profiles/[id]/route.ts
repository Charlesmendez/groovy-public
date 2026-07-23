import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sanitizeProfilePatch } from "@/lib/orchestrator/profileApi";

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
    .from("orchestrator_profiles")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ profile: data });
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const patch = sanitizeProfilePatch(body);
  const { data: existing } = await supabase
    .from("orchestrator_profiles")
    .select("workspace_id,user_id,surface")
    .eq("id", id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "Not found or not allowed" }, { status: 404 });
  }
  if (existing.surface === "external" && patch.surface !== "internal") {
    patch.authorization_stance = "restricted";
    patch.memory_scope = "profile";
    patch.inherit_workspace_skills = false;
    patch.inherit_workspace_integrations = false;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  // The partial unique default indexes require clearing the old default
  // before setting the new one. RLS still restricts both updates to the same
  // owner/workspace administrator.
  if (patch.is_default === true) {
    let defaults = supabase
      .from("orchestrator_profiles")
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq("is_default", true)
      .neq("id", id);
    defaults = existing.workspace_id
      ? defaults.eq("workspace_id", existing.workspace_id)
      : defaults.eq("user_id", existing.user_id).is("workspace_id", null);
    const { error: clearError } = await defaults;
    if (clearError) {
      return NextResponse.json({ error: clearError.message }, { status: 500 });
    }
  }

  const { data, error } = await supabase
    .from("orchestrator_profiles")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    const status = error.code === "23505" ? 409 : error.code === "42501" ? 403 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  // RLS silently filters rows the caller may not update.
  if (!data) return NextResponse.json({ error: "Not found or not allowed" }, { status: 404 });
  return NextResponse.json({ profile: data });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("orchestrator_profiles")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) {
    return NextResponse.json(
      {
        error:
          error.code === "23503"
            ? "This profile is still bound to a channel or another protected resource. Rebind it before deleting."
            : error.message,
      },
      { status: error.code === "23503" ? 409 : 500 },
    );
  }
  if (!data) return NextResponse.json({ error: "Not found or not allowed" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
