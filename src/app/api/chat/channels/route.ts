import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listWorkerAgents } from "@/lib/orchestrator/agentTasks";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";
import {
  createChatChannelInRlsOrder,
  parseChannelOrchestratorInstructions,
  slugifyChatChannel,
} from "@/lib/teamChat";
import {
  GUEST_SAFE_MIND_REQUIREMENT,
  isGuestSafeMind,
} from "@/lib/chat/guestMind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unreadCountsMigrationPending(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  return (
    error.code === "42883" ||
    error.code === "PGRST202" ||
    error.message?.includes("chat_channel_unread_counts") === true
  );
}

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
  const unreadCounts = new Map<string, number>();
  let unreadMigrationPending = false;
  if (channelIds.length > 0) {
    const { data: unreadRows, error: unreadError } = await supabase.rpc(
      "chat_channel_unread_counts",
      { p_channel_ids: channelIds },
    );
    if (unreadError) {
      unreadMigrationPending = unreadCountsMigrationPending(unreadError);
      if (!unreadMigrationPending) {
        return NextResponse.json(
          { error: unreadError.message },
          { status: 500 },
        );
      }
    } else {
      for (const row of (unreadRows || []) as Array<{
        channel_id?: unknown;
        unread_count?: unknown;
      }>) {
        if (typeof row.channel_id !== "string") continue;
        const count = Number(row.unread_count);
        unreadCounts.set(
          row.channel_id,
          Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0,
        );
      }
    }
  }
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
        .select(
          "id,name,slug,is_default,workspace_id,surface,authorization_stance,memory_scope,inherit_workspace_skills,inherit_workspace_integrations",
        )
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
    channels: (channels || []).map((channel) => ({
      ...channel,
      unread_count: unreadCounts.get(String(channel.id)) || 0,
    })),
    unreadMigrationPending,
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
  const instructions = parseChannelOrchestratorInstructions(
    body?.orchestratorInstructions,
  );
  if (!instructions.ok) {
    return NextResponse.json(
      { error: instructions.error },
      { status: 400 },
    );
  }

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
  const guestUserIds = new Set(
    workspace.members
      .filter((member) => member.role === "guest")
      .map((member) => member.user_id),
  );
  const includesGuests = userIds.some((userId) => guestUserIds.has(userId));
  const profileAdmin = createSupabaseAdminClient();
  const { data: selectedProfile, error: selectedProfileError } = profileId
    ? await profileAdmin
        .from("orchestrator_profiles")
        .select(
          "id,workspace_id,surface,authorization_stance,memory_scope,inherit_workspace_skills,inherit_workspace_integrations",
        )
        .eq("id", profileId)
        .eq("workspace_id", workspace.id)
        .maybeSingle()
    : { data: null, error: null };
  if (selectedProfileError) {
    return NextResponse.json(
      { error: selectedProfileError.message },
      { status: 500 },
    );
  }
  if (profileId && !selectedProfile) {
    return NextResponse.json(
      { error: "The selected Mind is unavailable in this workspace." },
      { status: 400 },
    );
  }
  if (
    includesGuests &&
    orchestratorMode !== "off" &&
    !isGuestSafeMind(selectedProfile)
  ) {
    return NextResponse.json(
      {
        error: `${GUEST_SAFE_MIND_REQUIREMENT} Choose a guest-ready Mind or set attention to Humans only.`,
      },
      { status: 409 },
    );
  }
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
    if (kind === "channel" && workspace.role !== "admin") {
      return NextResponse.json(
        { error: "Only workspace admins can add agents to channels" },
        { status: 403 },
      );
    }
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
    if (includesGuests) {
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
      const channelInsert: Record<string, unknown> = {
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
      };
      // Keep ordinary channel creation available during a rolling deployment
      // before the optional prompt column reaches PostgREST's schema cache.
      if (kind === "channel" && instructions.value) {
        channelInsert.orchestrator_instructions = instructions.value;
      }
      const { error } = await supabase
        .from("chat_channels")
        .insert(channelInsert);
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
    const promptMigrationPending =
      Boolean(instructions.value) &&
      result.stage === "channel" &&
      (result.error.code === "42703" ||
        result.error.code === "PGRST204" ||
        result.error.message.includes("orchestrator_instructions"));
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
      {
        error: promptMigrationPending
          ? "Channel operating briefs are still being activated. Create the channel without a brief or try again shortly."
          : result.error.message,
      },
      { status },
    );
  }

  const [createdMembersResult, createdSkillAssignmentsResult] =
    await Promise.all([
      supabase
        .from("chat_channel_members")
        .select("id,channel_id,member_type,user_id,agent_id")
        .eq("channel_id", channelId),
      skillArtifactIds.length > 0
        ? supabase
            .from("chat_channel_skill_assignments")
            .select("id,channel_id,artifact_id,created_at")
            .eq("channel_id", channelId)
        : Promise.resolve({ data: [], error: null }),
    ]);

  return NextResponse.json(
    {
      channel: result.data,
      // Return the authoritative roster with the channel so the first @ menu
      // cannot briefly treat selected agents as outsiders while the sidebar
      // refresh is still in flight.
      members: createdMembersResult.error
        ? memberRows
        : createdMembersResult.data || memberRows,
      skillAssignments: createdSkillAssignmentsResult.error
        ? []
        : createdSkillAssignmentsResult.data || [],
    },
    { status: 201 },
  );
}
