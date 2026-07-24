import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data, error } = await supabase
    .from("chat_channel_skill_assignments")
    .select("id,channel_id,artifact_id,created_at")
    .eq("channel_id", id)
    .order("created_at", { ascending: true });
  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: error.code === "42501" ? 403 : 500 },
    );
  }
  return NextResponse.json({ assignments: data || [] });
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const workspace = await getOrCreateWorkspaceForUser();
  if (workspace.role === "guest") {
    return NextResponse.json(
      { error: "Channel guests cannot assign skills" },
      { status: 403 },
    );
  }
  const body = (await req.json().catch(() => null)) as {
    artifactId?: unknown;
  } | null;
  const artifactId =
    typeof body?.artifactId === "string" ? body.artifactId.trim() : "";
  if (!artifactId) {
    return NextResponse.json(
      { error: "artifactId is required" },
      { status: 400 },
    );
  }
  const { data, error } = await supabase
    .from("chat_channel_skill_assignments")
    .insert({
      channel_id: id,
      workspace_id: workspace.id,
      artifact_id: artifactId,
      added_by: user.id,
    })
    .select("id,channel_id,artifact_id,created_at")
    .single();
  if (error) {
    return NextResponse.json(
      { error: error.message },
      {
        status:
          error.code === "23505"
            ? 409
            : error.code === "42501" || error.code === "23514"
              ? 403
              : 500,
      },
    );
  }
  return NextResponse.json({ assignment: data }, { status: 201 });
}

export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as {
    assignmentId?: unknown;
  } | null;
  const assignmentId =
    typeof body?.assignmentId === "string" ? body.assignmentId.trim() : "";
  if (!assignmentId) {
    return NextResponse.json(
      { error: "assignmentId is required" },
      { status: 400 },
    );
  }
  const { data, error } = await supabase
    .from("chat_channel_skill_assignments")
    .delete()
    .eq("id", assignmentId)
    .eq("channel_id", id)
    .select("id")
    .maybeSingle();
  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: error.code === "42501" ? 403 : 500 },
    );
  }
  if (!data) {
    return NextResponse.json(
      { error: "Not found or not allowed" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
