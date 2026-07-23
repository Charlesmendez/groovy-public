import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { slugifyChatChannel } from "@/lib/teamChat";

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

  const [{ data: channel, error }, { data: members }, { data: messages }] =
    await Promise.all([
      supabase.from("chat_channels").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("chat_channel_members")
        .select("id,member_type,user_id,agent_id,created_at")
        .eq("channel_id", id),
      supabase
        .from("chat_messages")
        .select("*")
        .eq("channel_id", id)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!channel) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    channel,
    members: members || [],
    messages: [...(messages || [])].reverse(),
  });
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

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.name === "string" && body.name.trim()) {
    patch.name = body.name.trim().slice(0, 100);
  }
  if (typeof body.slug === "string" && body.slug.trim()) {
    const slug = slugifyChatChannel(body.slug);
    if (!slug) return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
    patch.slug = slug;
  }
  if ("topic" in body) {
    patch.topic =
      typeof body.topic === "string" && body.topic.trim()
        ? body.topic.trim().slice(0, 500)
        : null;
  }
  if ("profileId" in body) {
    patch.profile_id =
      typeof body.profileId === "string" && body.profileId.trim()
        ? body.profileId.trim()
        : null;
  }
  if (
    body.orchestratorMode === "mention" ||
    body.orchestratorMode === "always" ||
    body.orchestratorMode === "off"
  ) {
    patch.orchestrator_mode = body.orchestratorMode;
  }
  if (body.visibility === "workspace" || body.visibility === "private") {
    patch.visibility = body.visibility;
  }
  if (typeof body.isArchived === "boolean") patch.is_archived = body.isArchived;

  const { data, error } = await supabase
    .from("chat_channels")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: error.code === "23505" ? 409 : error.code === "42501" ? 403 : 500 },
    );
  }
  if (!data) return NextResponse.json({ error: "Not found or not allowed" }, { status: 404 });
  return NextResponse.json({ channel: data });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await supabase
    .from("chat_channels")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found or not allowed" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
