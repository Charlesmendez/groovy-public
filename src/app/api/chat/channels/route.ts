import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listWorkerAgents } from "@/lib/orchestrator/agentTasks";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";
import {
  createChatChannelInRlsOrder,
  slugifyChatChannel,
} from "@/lib/teamChat";

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
  const skillArtifactsResult =
    workspace.role === "guest"
      ? { data: [] }
      : await supabase
          .from("workspace_skill_artifacts")
          .select(
            "id,artifact_type,name,description,relative_path,targets,lifecycle",
          )
          .eq("workspace_id", workspace.id)
          .eq("lifecycle", "active")
          .order("name", { ascending: true });
  if ("error" in skillArtifactsResult && skillArtifactsResult.error) {
    return NextResponse.json(
      { error: skillArtifactsResult.error.message },
      { status: 500 },
    );
  }
  const skillArtifacts = skillArtifactsResult.data;
  const flowSkillArtifacts = (skillArtifacts || []).filter((artifact) => {
    const targets = Array.isArray(artifact.targets)
      ? artifact.targets.map(String)
      : [];
    return (
      targets.length === 0 ||
      targets.includes("all") ||
      targets.includes("flow")
    );
  });
  const skillAssignmentsResult =
    workspace.role === "guest" || channelIds.length === 0
      ? { data: [] }
      : await supabase
          .from("chat_channel_skill_assignments")
          .select("id,channel_id,artifact_id,created_at")
          .in("channel_id", channelIds);
  if ("error" in skillAssignmentsResult && skillAssignmentsResult.error) {
    const migrationPending =
      skillAssignmentsResult.error.code === "PGRST205" ||
      skillAssignmentsResult.error.code === "42P01" ||
      skillAssignmentsResult.error.message.includes(
        "chat_channel_skill_assignments",
      );
    if (!migrationPending) {
      return NextResponse.json(
        { error: skillAssignmentsResult.error.message },
        { status: 500 },
      );
    }
    console.warn(
      "[team-chat] channel skills migration is pending; loading chat without channel capability assignments",
    );
  }
  const skillAssignments = skillAssignmentsResult.data;

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
    skills: flowSkillArtifacts,
    skillAssignments: skillAssignments || [],
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

  // DMs are readable only by channel members. Asking PostgREST to return the
  // inserted row here would evaluate the SELECT policy before the creator's
  // member row exists and reject an otherwise valid insert. Assign the id up
  // front, insert with return=minimal, add members, and read the channel only
  // after it is visible to the creator.
  const channelId = randomUUID();
  const requestedUserIds = Array.isArray(body?.userIds)
    ? body.userIds.map(String)
    : [];
  const workspaceUserIds = new Set(workspace.members.map((member) => member.user_id));
  if (requestedUserIds.some((id) => !workspaceUserIds.has(id))) {
    return NextResponse.json(
      { error: "One or more people are no longer in this workspace" },
      { status: 400 },
    );
  }
  const userIds = Array.from(
    new Set([user.id, ...requestedUserIds.filter((id) => workspaceUserIds.has(id))]),
  );
  const agentIds = Array.isArray(body?.agentIds)
    ? Array.from(new Set(body.agentIds.map(String).filter(Boolean)))
    : [];
  const skillArtifactIds =
    kind === "channel" && Array.isArray(body?.skillArtifactIds)
      ? Array.from(
          new Set(body.skillArtifactIds.map(String).filter(Boolean)),
        )
      : [];
  if (
    kind === "dm" &&
    Array.isArray(body?.skillArtifactIds) &&
    body.skillArtifactIds.length > 0
  ) {
    return NextResponse.json(
      { error: "Direct messages cannot have channel skills" },
      { status: 400 },
    );
  }

  if (agentIds.length > 0) {
    const admin = createSupabaseAdminClient();
    const availableAgents = await listWorkerAgents(
      workspace.billing_admin_user_id,
      { supabase: admin },
    ).catch(() => []);
    const availableAgentIds = new Set(
      availableAgents.map((agent) => agent.id),
    );
    if (agentIds.some((agentId) => !availableAgentIds.has(agentId))) {
      return NextResponse.json(
        { error: "One or more agents are unavailable in this workspace" },
        { status: 400 },
      );
    }
  }

  if (skillArtifactIds.length > 0) {
    const requestedGuestIds = new Set(
      workspace.members
        .filter((member) => member.role === "guest")
        .map((member) => member.user_id),
    );
    if (userIds.some((userId) => requestedGuestIds.has(userId))) {
      return NextResponse.json(
        {
          error:
            "Channel skills cannot be assigned while a channel guest participates",
        },
        { status: 400 },
      );
    }
    const { data: availableSkills, error: skillsError } = await supabase
      .from("workspace_skill_artifacts")
      .select("id,targets")
      .eq("workspace_id", workspace.id)
      .eq("lifecycle", "active")
      .in("id", skillArtifactIds);
    if (skillsError) {
      return NextResponse.json(
        { error: skillsError.message },
        { status: skillsError.code === "42501" ? 403 : 500 },
      );
    }
    const validSkillIds = new Set(
      (availableSkills || [])
        .filter((artifact) => {
          const targets = Array.isArray(artifact.targets)
            ? artifact.targets.map(String)
            : [];
          return (
            targets.length === 0 ||
            targets.includes("all") ||
            targets.includes("flow")
          );
        })
        .map((artifact) => String(artifact.id)),
    );
    if (
      skillArtifactIds.some((artifactId) => !validSkillIds.has(artifactId))
    ) {
      return NextResponse.json(
        { error: "One or more skills are unavailable for Team Chat" },
        { status: 400 },
      );
    }
  }
  const memberRows = [
    ...userIds.map((userId) => ({
      channel_id: channelId,
      member_type: "user",
      user_id: userId,
      agent_id: null,
      added_by: user.id,
    })),
    ...agentIds.map((agentId) => ({
      channel_id: channelId,
      member_type: "agent",
      user_id: null,
      agent_id: agentId,
      added_by: user.id,
    })),
    {
      channel_id: channelId,
      member_type: "orchestrator",
      user_id: null,
      agent_id: null,
      added_by: user.id,
    },
  ];
  const result = await createChatChannelInRlsOrder({
    insertChannelWithoutReturning: async () => {
      const { error } = await supabase.from("chat_channels").insert({
        id: channelId,
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
      });
      return error;
    },
    insertMembers: async () => {
      const { error } = await supabase
        .from("chat_channel_members")
        .insert(memberRows);
      return error;
    },
    insertCapabilities:
      skillArtifactIds.length > 0
        ? async () => {
            const { error } = await supabase
              .from("chat_channel_skill_assignments")
              .insert(
                skillArtifactIds.map((artifactId) => ({
                  channel_id: channelId,
                  workspace_id: workspace.id,
                  artifact_id: artifactId,
                  added_by: user.id,
                })),
              );
            return error;
          }
        : undefined,
    readChannel: async () => {
      const { data, error } = await supabase
        .from("chat_channels")
        .select("*")
        .eq("id", channelId)
        .single();
      return { data, error };
    },
    rollbackChannel: async () => {
      await supabase.from("chat_channels").delete().eq("id", channelId);
    },
  });
  if (result.error) {
    const status =
      result.stage === "channel"
        ? result.error.code === "23505"
          ? 409
          : result.error.code === "42501"
            ? 403
            : 500
        : result.stage === "members"
          ? 400
          : result.stage === "capabilities"
            ? result.error.code === "23505"
              ? 409
              : result.error.code === "42501"
                ? 403
                : 400
          : 500;
    return NextResponse.json(
      { error: result.error.message },
      { status },
    );
  }

  return NextResponse.json({ channel: result.data }, { status: 201 });
}
