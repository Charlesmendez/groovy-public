import type { SupabaseClient } from "@supabase/supabase-js";
import { channelAgentIds } from "@/lib/chat/channelAgentRoster";
import { buildChannelParticipantContext } from "@/lib/chat/channelParticipants";
import {
  GUEST_SAFE_MIND_REQUIREMENT,
  isGuestSafeMind,
} from "@/lib/chat/guestMind";
import {
  parseTeamChatChannelId,
  resolveTeamChatScheduleChannelId,
} from "@/lib/chat/channelSchedules";
import { sendTeamChatPush } from "@/lib/notifications/webPush";
import {
  resolveHarnessProfile,
  type HarnessProfile,
} from "@/lib/orchestrator/harnessProfiles";
import { filterExternalHarnessOutput } from "@/lib/publicApi/outputFilter";
import { getOrCreateExternalSession } from "@/lib/teamChat";

type ExternalThreadRow = {
  provider: string;
  thread_key: string;
  orchestrator_session_id: string;
};

type ScheduledChannelRow = {
  id: string;
  workspace_id: string;
  kind: string;
  name: string;
  profile_id: string | null;
  orchestrator_mode: string;
  orchestrator_instructions: string | null;
  visibility: string;
  is_archived: boolean;
};

export type ScheduledChannelRuntime = {
  channelId: string;
  channelName: string;
  workspaceId: string;
  ownerUserId: string;
  sessionId: string;
  sourceProvider: "team_chat" | "team_chat_guest";
  hasGuests: boolean;
  profile: HarnessProfile | null;
  channelInstructions: string | null;
  channelParticipantContext: string;
  allowedAgentIds: string[];
  agentNamesById: Record<string, string>;
  additionalSkillArtifactIds: string[];
};

export class ScheduledChannelRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScheduledChannelRuntimeError";
  }
}

function requiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function isChannelColumnPending(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    Boolean(error.message?.includes("channel_id")) ||
    Boolean(error.message?.includes("schema cache"))
  );
}

function channelIdFromThreadKey(value: unknown): string | null {
  const threadKey = requiredString(value);
  return threadKey
    ? parseTeamChatChannelId(`team_chat:${threadKey}`)
    : null;
}

async function loadExternalThread(args: {
  admin: SupabaseClient;
  userId: string;
  sessionIds: string[];
  channelId: string | null;
}): Promise<ExternalThreadRow | null> {
  const select =
    "provider,thread_key,orchestrator_session_id";
  if (args.sessionIds.length > 0) {
    const { data, error } = await args.admin
      .from("orchestrator_external_threads")
      .select(select)
      .eq("user_id", args.userId)
      .in("provider", ["team_chat", "team_chat_guest"])
      .in("orchestrator_session_id", args.sessionIds)
      .limit(8);
    if (error) throw new Error(error.message);
    const rows = (data || []) as ExternalThreadRow[];
    if (args.channelId) {
      const exact = rows.find(
        (row) => channelIdFromThreadKey(row.thread_key) === args.channelId,
      );
      if (exact) return exact;
      // Preserve a conflicting session mapping so the caller can fail closed
      // instead of silently replacing it with a different channel lookup.
      if (rows[0]) return rows[0];
    }
    const legacyChannelIds = new Set(
      rows
        .map((row) => channelIdFromThreadKey(row.thread_key))
        .filter((value): value is string => Boolean(value)),
    );
    if (legacyChannelIds.size > 1) {
      throw new ScheduledChannelRuntimeError(
        "scheduled_channel_scope_conflict",
        "The scheduled task references more than one Team Chat channel.",
      );
    }
    if (rows[0]) return rows[0];
  }
  if (!args.channelId) return null;
  const { data, error } = await args.admin
    .from("orchestrator_external_threads")
    .select(select)
    .eq("user_id", args.userId)
    .in("provider", ["team_chat", "team_chat_guest"])
    .eq("thread_key", args.channelId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ExternalThreadRow | null) || null;
}

/**
 * Resolves the live Team Chat authority for a scheduled job. The channel's
 * current Mind and roster win over the creation-time snapshot, so changing a
 * channel binding changes future runs without moving the schedule elsewhere.
 *
 * During the additive channel_id migration rollout, the originating external
 * session remains a safe fallback. It is already scoped to the same owner and
 * exact Team Chat thread.
 */
export async function resolveScheduledChannelRuntime(args: {
  admin: SupabaseClient;
  jobId: string;
  userId: string;
  taskSessionId?: string | null;
  jobSessionId?: string | null;
}): Promise<ScheduledChannelRuntime | null> {
  let storedChannelId: string | null = null;
  let storedSessionId = requiredString(args.jobSessionId);
  const scopeResult = await args.admin
    .from("scheduled_jobs")
    .select("channel_id,session_id")
    .eq("id", args.jobId)
    .eq("user_id", args.userId)
    .maybeSingle();
  if (scopeResult.error) {
    if (!isChannelColumnPending(scopeResult.error)) {
      throw new Error(scopeResult.error.message);
    }
    const legacyScope = await args.admin
      .from("scheduled_jobs")
      .select("session_id")
      .eq("id", args.jobId)
      .eq("user_id", args.userId)
      .maybeSingle();
    if (legacyScope.error) throw new Error(legacyScope.error.message);
    storedSessionId =
      requiredString(legacyScope.data?.session_id) || storedSessionId;
  } else {
    storedChannelId = channelIdFromThreadKey(scopeResult.data?.channel_id);
    storedSessionId =
      requiredString(scopeResult.data?.session_id) || storedSessionId;
  }

  const sessionIds = Array.from(
    new Set(
      [
        requiredString(args.taskSessionId),
        storedSessionId,
      ].filter((value): value is string => Boolean(value)),
    ),
  );
  const externalThread = await loadExternalThread({
    admin: args.admin,
    userId: args.userId,
    sessionIds,
    channelId: storedChannelId,
  });
  const resolvedChannel = resolveTeamChatScheduleChannelId({
    storedChannelId,
    externalThreadKey: externalThread?.thread_key,
  });
  if (resolvedChannel.conflict) {
    throw new ScheduledChannelRuntimeError(
      "scheduled_channel_scope_conflict",
      "The scheduled task channel no longer matches its Team Chat session.",
    );
  }
  const channelId = resolvedChannel.channelId;
  if (!channelId) return null;

  const { data: channelData, error: channelError } = await args.admin
    .from("chat_channels")
    // `orchestrator_instructions` is additive. Selecting the full row keeps
    // scheduled delivery compatible while that migration is rolling out.
    .select("*")
    .eq("id", channelId)
    .maybeSingle();
  if (channelError) throw new Error(channelError.message);
  const channel = channelData as ScheduledChannelRow | null;
  if (!channel || channel.kind !== "channel" || channel.is_archived) {
    throw new ScheduledChannelRuntimeError(
      "scheduled_channel_unavailable",
      "The channel for this scheduled task is unavailable or archived.",
    );
  }
  if (channel.orchestrator_mode === "off") {
    throw new ScheduledChannelRuntimeError(
      "scheduled_channel_orchestrator_disabled",
      "The channel Mind is disabled. Re-enable it or pause this scheduled task.",
    );
  }

  const [{ data: workspace, error: workspaceError }, membersResult] =
    await Promise.all([
      args.admin
        .from("workspaces")
        .select("billing_admin_user_id")
        .eq("id", channel.workspace_id)
        .maybeSingle(),
      args.admin
        .from("chat_channel_members")
        .select("member_type,user_id,agent_id")
        .eq("channel_id", channelId)
        .in("member_type", ["user", "agent"]),
    ]);
  if (workspaceError) throw new Error(workspaceError.message);
  if (membersResult.error) throw new Error(membersResult.error.message);
  const ownerUserId = requiredString(workspace?.billing_admin_user_id);
  if (!ownerUserId || ownerUserId !== args.userId) {
    throw new ScheduledChannelRuntimeError(
      "scheduled_channel_owner_mismatch",
      "The scheduled task is not owned by this channel's workspace.",
    );
  }

  const members = membersResult.data || [];
  const userIds = members
    .filter((member) => member.member_type === "user")
    .map((member) => requiredString(member.user_id))
    .filter((value): value is string => Boolean(value));
  const { data: workspaceMembers, error: workspaceMembersError } =
    userIds.length > 0
      ? await args.admin
          .from("workspace_members")
          .select("user_id,role")
          .eq("workspace_id", channel.workspace_id)
          .in("user_id", userIds)
      : { data: [], error: null };
  if (workspaceMembersError) throw new Error(workspaceMembersError.message);
  const roles = new Map(
    (workspaceMembers || []).map((member) => [
      String(member.user_id),
      String(member.role),
    ]),
  );
  const hasGuests = userIds.some(
    (userId) => (roles.get(userId) || "guest") === "guest",
  );
  const sourceProvider = hasGuests ? "team_chat_guest" : "team_chat";
  const profile = await resolveHarnessProfile(args.admin, {
    userId: ownerUserId,
    workspaceId: channel.workspace_id,
    explicitProfileId: channel.profile_id,
    provider: sourceProvider,
    threadKey: channelId,
  });
  if (channel.profile_id && !profile) {
    throw new ScheduledChannelRuntimeError(
      "scheduled_channel_profile_unavailable",
      "The Mind selected in this channel is unavailable.",
    );
  }
  if (hasGuests && (!channel.profile_id || !isGuestSafeMind(profile))) {
    throw new ScheduledChannelRuntimeError(
      "scheduled_channel_guest_profile_required",
      GUEST_SAFE_MIND_REQUIREMENT,
    );
  }

  const allowedAgentIds = channelAgentIds(members);
  const { data: agents, error: agentsError } =
    allowedAgentIds.length > 0
      ? await args.admin
          .from("agents")
          .select("id,name")
          .eq("user_id", ownerUserId)
          .in("id", allowedAgentIds)
      : { data: [], error: null };
  if (agentsError || (agents || []).length !== allowedAgentIds.length) {
    throw new ScheduledChannelRuntimeError(
      "scheduled_channel_agents_unavailable",
      "One or more worker agents selected in this channel are unavailable.",
    );
  }
  const humans = await Promise.all(
    userIds.map(async (userId) => {
      const { data } = await args.admin.auth.admin.getUserById(userId);
      const user = data.user;
      const displayName =
        (typeof user?.user_metadata?.full_name === "string" &&
          user.user_metadata.full_name.trim()) ||
        (typeof user?.user_metadata?.name === "string" &&
          user.user_metadata.name.trim()) ||
        user?.email?.split("@")[0] ||
        "Workspace member";
      const role = roles.get(userId);
      const workspaceRole: "admin" | "member" | "guest" =
        role === "admin" || role === "member" || role === "guest"
          ? role
          : "guest";
      return {
        userId,
        displayName,
        email: user?.email || null,
        workspaceRole,
      };
    }),
  );
  const channelParticipantContext = buildChannelParticipantContext({
    channelName: channel.name,
    visibility:
      channel.visibility === "private" ? "private" : "workspace",
    currentSpeakerUserId: null,
    humans,
    agents: (agents || []).map((agent) => ({
      id: String(agent.id),
      name: String(agent.name || "Worker agent"),
    })),
    mindName: profile?.name || "Groovy",
  });
  const { data: skillAssignments, error: skillAssignmentsError } =
    await args.admin
      .from("chat_channel_skill_assignments")
      .select("artifact_id")
      .eq("channel_id", channelId);
  if (skillAssignmentsError) {
    console.warn("[scheduler-run] channel skills unavailable", {
      channelId,
      jobId: args.jobId,
      error: skillAssignmentsError.message,
    });
  }
  const additionalSkillArtifactIds = skillAssignmentsError
    ? []
    : (skillAssignments || []).map((row) => String(row.artifact_id));
  const external = await getOrCreateExternalSession({
    admin: args.admin,
    ownerUserId,
    provider: sourceProvider,
    threadKey: channelId,
    threadName: `Team chat: ${channel.name}`,
    profileId: profile?.id || null,
  });

  return {
    channelId,
    channelName: channel.name,
    workspaceId: channel.workspace_id,
    ownerUserId,
    sessionId: external.sessionId,
    sourceProvider,
    hasGuests,
    profile,
    channelInstructions:
      requiredString(channel.orchestrator_instructions) || null,
    channelParticipantContext,
    allowedAgentIds,
    agentNamesById: Object.fromEntries(
      (agents || []).map((agent) => [
        String(agent.id),
        String(agent.name || "Worker agent"),
      ]),
    ),
    additionalSkillArtifactIds,
  };
}

export async function publishScheduledChannelResult(args: {
  admin: SupabaseClient;
  runtime: ScheduledChannelRuntime;
  jobId: string;
  jobName: string | null;
  runId: string;
  traceId: string;
  taskMessage: string;
  text: string;
  author?:
    | { type: "orchestrator" }
    | { type: "agent"; agentId: string; agentName: string };
}): Promise<string> {
  const rawText = args.text.trim();
  if (!rawText) {
    throw new ScheduledChannelRuntimeError(
      "scheduled_channel_empty_result",
      "The channel Mind returned an empty scheduled-task result.",
    );
  }
  const safeText = (
    args.runtime.hasGuests
      ? filterExternalHarnessOutput(rawText)
      : rawText
  )
    .trim()
    .slice(0, 40_000);
  if (!safeText) {
    throw new ScheduledChannelRuntimeError(
      "scheduled_channel_empty_result",
      "The scheduled result contained no guest-safe content.",
    );
  }
  const runMetadata = {
    kind: "scheduled_task_result",
    scheduled_job_id: args.jobId,
    scheduled_run_id: args.runId,
  };
  const { data: existing, error: existingError } = await args.admin
    .from("chat_messages")
    .select("id,content")
    .eq("channel_id", args.runtime.channelId)
    .contains("metadata", runMetadata)
    .limit(1)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existing?.id) {
    return requiredString(existing.content) || safeText;
  }

  const author = args.author || { type: "orchestrator" as const };
  const { data: chatMessage, error: chatError } = await args.admin
    .from("chat_messages")
    .insert({
      channel_id: args.runtime.channelId,
      author_type: author.type,
      ...(author.type === "agent"
        ? {
            author_agent_id: author.agentId,
            profile_id: null,
          }
        : {
            profile_id: args.runtime.profile?.id || null,
          }),
      content: safeText,
      metadata: {
        ...runMetadata,
        scheduled_task_name: args.jobName || "Scheduled task",
        scheduled_runner: author.type,
        trace_id: args.traceId,
        orchestrator_session_id: args.runtime.sessionId,
      },
    })
    .select("id")
    .single();
  if (chatError || !chatMessage?.id) {
    throw new Error(chatError?.message || "Could not post the scheduled result");
  }

  // Only a Mind-owned scheduled run belongs in the Mind's alternating
  // user/assistant history. A worker-authored channel message must not be
  // misrepresented as if the Mind generated it.
  if (author.type === "orchestrator") {
    const { error: historyError } = await args.admin
      .from("orchestrator_messages")
      .insert([
        {
          session_id: args.runtime.sessionId,
          user_id: args.runtime.ownerUserId,
          role: "user",
          content: args.taskMessage,
          trace_id: args.traceId,
          metadata: {
            provider: args.runtime.sourceProvider,
            channel_id: args.runtime.channelId,
            kind: "scheduled_task_trigger",
            scheduled_job_id: args.jobId,
            scheduled_run_id: args.runId,
          },
        },
        {
          session_id: args.runtime.sessionId,
          user_id: args.runtime.ownerUserId,
          role: "assistant",
          content: safeText,
          trace_id: args.traceId,
          metadata: {
            provider: args.runtime.sourceProvider,
            channel_id: args.runtime.channelId,
            chat_message_id: chatMessage.id,
            ...runMetadata,
          },
        },
      ]);
    if (historyError) {
      await args.admin
        .from("chat_messages")
        .delete()
        .eq("id", chatMessage.id)
        .eq("channel_id", args.runtime.channelId);
      throw new Error(historyError.message);
    }
  }

  await sendTeamChatPush({
    admin: args.admin,
    channelId: args.runtime.channelId,
    messageId: String(chatMessage.id),
    authorType: author.type,
    authorLabel:
      author.type === "agent"
        ? author.agentName
        : args.runtime.profile?.name || "Groovy",
    content: safeText,
  }).catch((error) => {
    console.warn("[scheduler-run] channel push delivery failed", {
      channelId: args.runtime.channelId,
      jobId: args.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return safeText;
}
