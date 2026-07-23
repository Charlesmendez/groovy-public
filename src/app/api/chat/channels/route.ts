import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listWorkerAgents } from "@/lib/orchestrator/agentTasks";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";
import { slugifyChatChannel } from "@/lib/teamChat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await getOrCreateWorkspaceForUser();
  const { data: channels, error } = await supabase
    .from("chat_channels")
    .select("*")
    .eq("workspace_id", workspace.id)
    .eq("is_archived", false)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const channelIds = (channels || []).map((channel) => String(channel.id));
  const { data: members } = channelIds.length
    ? await supabase
        .from("chat_channel_members")
        .select("id,channel_id,member_type,user_id,agent_id")
        .in("channel_id", channelIds)
    : { data: [] };
  const admin = createSupabaseAdminClient();
  const allAgents = await listWorkerAgents(workspace.billing_admin_user_id, {
    supabase: admin,
  }).catch(() => []);
  const visibleUserIds = new Set<string>([user.id]);
  const visibleAgentIds = new Set<string>();
  for (const member of members || []) {
    if (member.member_type === "user" && member.user_id) {
      visibleUserIds.add(String(member.user_id));
    }
    if (member.member_type === "agent" && member.agent_id) {
      visibleAgentIds.add(String(member.agent_id));
    }
  }
  const visibleMembers =
    workspace.role === "guest"
      ? workspace.members.filter((member) => visibleUserIds.has(member.user_id))
      : workspace.members;
  const agents =
    workspace.role === "guest"
      ? allAgents.filter((agent) => visibleAgentIds.has(agent.id))
      : allAgents;
  const profileIds = Array.from(
    new Set(
      (channels || [])
        .map((channel) =>
          typeof channel.profile_id === "string" ? channel.profile_id : "",
        )
        .filter(Boolean),
    ),
  );
  const { data: boundProfiles } = profileIds.length
    ? await admin
        .from("orchestrator_profiles")
        .select("id,name,slug,is_default,workspace_id")
        .eq("workspace_id", workspace.id)
        .in("id", profileIds)
    : { data: [] };

  return NextResponse.json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      role: workspace.role,
      currentUserId: user.id,
      members: visibleMembers,
    },
    channels: channels || [],
    members: members || [],
    profiles: boundProfiles || [],
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      harness: agent.harness,
      model: agent.model,
      deviceOnline: agent.deviceOnline,
    })),
  });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspaceForUser();
  if (workspace.role === "guest") {
    return NextResponse.json(
      { error: "Channel guests cannot create channels" },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 100) : "";
  const kind = body?.kind === "dm" ? "dm" : "channel";
  const slug =
    typeof body?.slug === "string" && body.slug.trim()
      ? slugifyChatChannel(body.slug)
      : slugifyChatChannel(name);
  if (!name || !slug) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const orchestratorMode =
    body?.orchestratorMode === "always" || body?.orchestratorMode === "off"
      ? body.orchestratorMode
      : "mention";
  const profileId =
    typeof body?.profileId === "string" && body.profileId.trim()
      ? body.profileId.trim()
      : null;
  const visibility =
    kind === "dm" || body?.visibility === "private" ? "private" : "workspace";

  const { data: channel, error } = await supabase
    .from("chat_channels")
    .insert({
      workspace_id: workspace.id,
      kind,
      name,
      slug,
      topic:
        typeof body?.topic === "string" && body.topic.trim()
          ? body.topic.trim().slice(0, 500)
          : null,
      profile_id: profileId,
      visibility,
      orchestrator_mode: orchestratorMode,
      created_by: user.id,
    })
    .select("*")
    .single();
  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: error.code === "23505" ? 409 : error.code === "42501" ? 403 : 500 },
    );
  }

  const requestedUserIds = Array.isArray(body?.userIds)
    ? body.userIds.map(String)
    : [];
  const workspaceUserIds = new Set(workspace.members.map((member) => member.user_id));
  const userIds = Array.from(
    new Set([user.id, ...requestedUserIds.filter((id) => workspaceUserIds.has(id))]),
  );
  const agentIds = Array.isArray(body?.agentIds)
    ? Array.from(new Set(body.agentIds.map(String).filter(Boolean)))
    : [];
  const memberRows = [
    ...userIds.map((userId) => ({
      channel_id: channel.id,
      member_type: "user",
      user_id: userId,
      agent_id: null,
      added_by: user.id,
    })),
    ...agentIds.map((agentId) => ({
      channel_id: channel.id,
      member_type: "agent",
      user_id: null,
      agent_id: agentId,
      added_by: user.id,
    })),
    {
      channel_id: channel.id,
      member_type: "orchestrator",
      user_id: null,
      agent_id: null,
      added_by: user.id,
    },
  ];
  const { error: membersError } = await supabase
    .from("chat_channel_members")
    .insert(memberRows);
  if (membersError) {
    await supabase.from("chat_channels").delete().eq("id", channel.id);
    return NextResponse.json({ error: membersError.message }, { status: 400 });
  }

  return NextResponse.json({ channel }, { status: 201 });
}
