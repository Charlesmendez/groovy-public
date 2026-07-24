import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listWorkerAgents } from "@/lib/orchestrator/agentTasks";

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
    .from("chat_channel_members")
    .select("id,member_type,user_id,agent_id,created_at")
    .eq("channel_id", id)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ members: data || [] });
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const memberType =
    body?.memberType === "agent" || body?.memberType === "orchestrator"
      ? body.memberType
      : "user";
  const userId = memberType === "user" && typeof body?.userId === "string" ? body.userId : null;
  const agentId =
    memberType === "agent" && typeof body?.agentId === "string" ? body.agentId : null;
  if ((memberType === "user" && !userId) || (memberType === "agent" && !agentId)) {
    return NextResponse.json({ error: "Missing member id" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data: channel } = await admin
    .from("chat_channels")
    .select("workspace_id,workspaces!inner(billing_admin_user_id)")
    .eq("id", id)
    .maybeSingle();
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  // Ensure a user being added actually belongs to the channel workspace.
  if (userId) {
    const { data: membership } = channel
      ? await admin
          .from("workspace_members")
          .select("user_id,role")
          .eq("workspace_id", channel.workspace_id)
          .eq("user_id", userId)
          .maybeSingle()
      : { data: null };
    if (!membership) {
      return NextResponse.json({ error: "User is not a workspace member" }, { status: 400 });
    }
    if (membership.role === "guest") {
      const { data: actorMembership } = await admin
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", channel?.workspace_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (actorMembership?.role !== "admin") {
        return NextResponse.json(
          { error: "Only workspace admins can expand a guest's channel access" },
          { status: 403 },
        );
      }
    }
  }
  if (agentId) {
    const workspaceRelation = Array.isArray(channel.workspaces)
      ? channel.workspaces[0]
      : channel.workspaces;
    const billingAdminUserId =
      workspaceRelation &&
      typeof workspaceRelation === "object" &&
      "billing_admin_user_id" in workspaceRelation
        ? String(
            (
              workspaceRelation as {
                billing_admin_user_id?: unknown;
              }
            ).billing_admin_user_id || "",
          )
        : "";
    const availableAgents = billingAdminUserId
      ? await listWorkerAgents(billingAdminUserId, { supabase: admin }).catch(
          () => [],
        )
      : [];
    if (!availableAgents.some((agent) => agent.id === agentId)) {
      return NextResponse.json(
        { error: "Agent is unavailable in this workspace" },
        { status: 400 },
      );
    }
  }

  const { data, error } = await supabase
    .from("chat_channel_members")
    .insert({
      channel_id: id,
      member_type: memberType,
      user_id: userId,
      agent_id: agentId,
      added_by: user.id,
    })
    .select("*")
    .single();
  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: error.code === "23505" ? 409 : error.code === "42501" ? 403 : 500 },
    );
  }
  return NextResponse.json({ member: data }, { status: 201 });
}

export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { memberId?: unknown } | null;
  const memberId = typeof body?.memberId === "string" ? body.memberId : "";
  if (!memberId) return NextResponse.json({ error: "memberId required" }, { status: 400 });
  const admin = createSupabaseAdminClient();
  const { data: targetMember } = await admin
    .from("chat_channel_members")
    .select("user_id,member_type,chat_channels!inner(workspace_id)")
    .eq("channel_id", id)
    .eq("id", memberId)
    .maybeSingle();
  if (
    targetMember?.member_type === "user" &&
    targetMember.user_id &&
    targetMember.user_id !== user.id
  ) {
    const relation = Array.isArray(targetMember.chat_channels)
      ? targetMember.chat_channels[0]
      : targetMember.chat_channels;
    const workspaceId =
      relation &&
      typeof relation === "object" &&
      "workspace_id" in relation
        ? String((relation as { workspace_id?: unknown }).workspace_id || "")
        : "";
    const [{ data: targetWorkspaceMember }, { data: actorWorkspaceMember }] =
      await Promise.all([
        admin
          .from("workspace_members")
          .select("role")
          .eq("workspace_id", workspaceId)
          .eq("user_id", targetMember.user_id)
          .maybeSingle(),
        admin
          .from("workspace_members")
          .select("role")
          .eq("workspace_id", workspaceId)
          .eq("user_id", user.id)
          .maybeSingle(),
      ]);
    if (
      targetWorkspaceMember?.role === "guest" &&
      actorWorkspaceMember?.role !== "admin"
    ) {
      return NextResponse.json(
        { error: "Only workspace admins can change a guest's channel access" },
        { status: 403 },
      );
    }
  }
  const { data, error } = await supabase
    .from("chat_channel_members")
    .delete()
    .eq("channel_id", id)
    .eq("id", memberId)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found or not allowed" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
