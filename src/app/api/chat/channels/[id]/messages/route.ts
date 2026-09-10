import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { after, NextResponse } from "next/server";
import { MAX_CHAT_MESSAGE_CHARACTERS } from "@/lib/chat/messageLimits";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveHarnessProfile } from "@/lib/orchestrator/harnessProfiles";
import { runOrchestratorRound } from "@/lib/orchestrator/runOrchestratorRound";
import { resolveUserDeviceIds } from "@/lib/devices/resolveUserDeviceId";
import { callConnectorRpcViaRelay } from "@/lib/relay/connectorRpc";
import { filterExternalHarnessOutput } from "@/lib/publicApi/outputFilter";
import { sendTeamChatPush } from "@/lib/notifications/webPush";
import {
  ensureDefaultChatNotificationPreferences,
  notificationPreferencesSchemaUnavailable,
} from "@/lib/notifications/defaults";
import {
  buildChatVoiceStoragePath,
  CHAT_IMAGE_BUCKET,
  ChatImageValidationError,
  publicChatVoiceAttachment,
  validateChatVoiceNote,
  voiceNoteMessage,
} from "@/lib/chat/channelImages";
import {
  attachmentOnlyMessage,
  buildChatAttachmentStoragePath,
  publicChatAttachment,
  validateChatAttachments,
} from "@/lib/chat/channelAttachments";
import {
  ChatSnippetValidationError,
  textSnippetMessage,
  validateChatTextSnippet,
} from "@/lib/chat/snippets";
import {
  acquireTurnLock,
  getOrCreateExternalSession,
  shouldRunChannelOrchestrator,
  type ChatChannelRow,
} from "@/lib/teamChat";
import {
  approveAgentTask,
  createAgentTask,
  kickAgentTask,
  rejectAgentTask,
  type AgentTaskRow,
} from "@/lib/orchestrator/agentTasks";
import { shouldDeferAgentTaskFinal } from "@/lib/orchestrator/agentTaskContinuationPolicy";
import {
  chatRoundChangesScheduledTasks,
  resolveChatRoundText,
} from "@/lib/chat/orchestratorResponse";
import { getProductAccessForUser } from "@/lib/licensing/access";
import {
  channelAgentIds,
  directAgentMessageTargetId,
} from "@/lib/chat/channelAgentRoster";
import { buildChannelParticipantContext } from "@/lib/chat/channelParticipants";
import {
  GUEST_SAFE_MIND_REQUIREMENT,
  isGuestSafeMind,
} from "@/lib/chat/guestMind";
import {
  messageBelongsToThread,
  threadRootId,
} from "@/lib/chat/threadBoundary";
import {
  chatMessagePageInfo,
  decodeChatMessageCursor,
  newerThanChatMessageCursor,
  olderThanChatMessageCursor,
  parseChatMessagePageSize,
} from "@/lib/chat/messagePagination";
import { socialSchemaUnavailable } from "@/lib/chat/social";
import {
  matchingPendingApprovalTasks,
  parseTeamChatAgentTaskDecision,
} from "@/lib/chat/agentTaskApprovals";
import {
  completeTeamChatConnectorRoundTrips,
  type TeamChatConnectorToolResult,
} from "@/lib/chat/teamChatConnectorRoundTrip";
import { shouldUseDirectLocalCliForDiagnostic } from "@/lib/orchestrator/localCliRouting";
import { normalizeScheduleTimezone } from "@/lib/scheduler/cloud";
import { canManageChannelSkills } from "@/lib/chat/channelSkills";
import { canManageChannelSchedules } from "@/lib/chat/channelSchedules";
import {
  appendOrchestratorProgressEvent,
  type OrchestratorProgress,
  type OrchestratorToolEvent,
} from "@/lib/chat/orchestratorProgress";
import { verifyInternalRouteAuth } from "@/lib/internalRouteAuth";
import { CHAT_MESSAGE_SEND_INTERNAL_SCOPE } from "@/lib/chat/internalScopes";
import {
  authorizeChatChannelForUser,
  isMatchingInternalChatMessageReplay,
} from "@/lib/chat/channelCommandService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;
type Params = { params: Promise<{ id: string }> };
type RunControlRequest = {
  status: "stop_requested" | "redirect_requested";
  requestedBy: string | null;
  direction: string | null;
};

type PendingTeamChatApproval = {
  id: string;
  user_id: string;
  title: string | null;
};

type MindFollowupMetadata = {
  state: "pending" | "completed";
  session_id: string;
  trace_id: string;
  queued_at: string;
  completed_at?: string;
};

// Leave more than seven minutes of this route's 800-second budget for the
// actual follow-up turn. If the active run outlives this window, the user gets
// an explicit retry message and the queue marker is retired instead of
// poisoning every newer follow-up behind it.
const MIND_FOLLOWUP_WAIT_MS = 6 * 60 * 1000;
const MIND_FOLLOWUP_POLL_MS = 2_000;

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mindFollowupMetadata(value: unknown): MindFollowupMetadata | null {
  const metadata = recordValue(value);
  const followup = recordValue(metadata.mind_followup);
  if (
    (followup.state !== "pending" && followup.state !== "completed") ||
    typeof followup.session_id !== "string" ||
    typeof followup.trace_id !== "string" ||
    typeof followup.queued_at !== "string"
  ) {
    return null;
  }
  return followup as MindFollowupMetadata;
}

async function waitForQueuedMindTurnLock(args: {
  admin: SupabaseClient;
  sessionId: string;
  channelId: string;
  messageId: string;
}): Promise<Awaited<ReturnType<typeof acquireTurnLock>>> {
  const deadline = Date.now() + MIND_FOLLOWUP_WAIT_MS;
  while (Date.now() < deadline) {
    const lock = await acquireTurnLock(args.admin, args.sessionId);
    if (lock) {
      const { data: oldestPending, error } = await args.admin
        .from("chat_messages")
        .select("id")
        .eq("channel_id", args.channelId)
        .gte(
          "created_at",
          new Date(
            Date.now() - MIND_FOLLOWUP_WAIT_MS - 60_000,
          ).toISOString(),
        )
        .contains("metadata", {
          mind_followup: {
            state: "pending",
            session_id: args.sessionId,
          },
        })
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!error && String(oldestPending?.id || "") === args.messageId) {
        return lock;
      }
      await lock.release();
      if (error) {
        console.warn("[team-chat] queued_followup_order_check_failed", {
          channelId: args.channelId,
          messageId: args.messageId,
          error: error.message,
        });
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, MIND_FOLLOWUP_POLL_MS);
    });
  }
  return null;
}

async function completeQueuedMindFollowup(args: {
  admin: SupabaseClient;
  channelId: string;
  messageId: string;
}): Promise<void> {
  const { data, error } = await args.admin
    .from("chat_messages")
    .select("metadata")
    .eq("id", args.messageId)
    .eq("channel_id", args.channelId)
    .maybeSingle();
  if (error || !data) {
    throw new Error(error?.message || "queued_followup_message_not_found");
  }
  const metadata = recordValue(data.metadata);
  const followup = mindFollowupMetadata(metadata);
  if (!followup || followup.state === "completed") return;
  const { error: updateError } = await args.admin
    .from("chat_messages")
    .update({
      metadata: {
        ...metadata,
        mind_followup: {
          ...followup,
          state: "completed",
          completed_at: new Date().toISOString(),
        },
      },
    })
    .eq("id", args.messageId)
    .eq("channel_id", args.channelId);
  if (updateError) throw new Error(updateError.message);
}

async function executeTeamChatAgentTaskDecision(args: {
  admin: SupabaseClient;
  channelId: string;
  text: string;
  decidedByUserId: string;
  baseUrl: string;
}): Promise<
  | { handled: false }
  | {
      handled: true;
      action: "approve" | "reject";
      taskId: string | null;
      reply: string;
    }
> {
  const decision = parseTeamChatAgentTaskDecision(args.text);
  if (!decision) return { handled: false };

  const { data, error } = await args.admin
    .from("agent_tasks")
    .select("id,user_id,title")
    .eq("requested_channel", `team_chat:${args.channelId}`)
    .eq("status", "awaiting_approval")
    .order("created_at", { ascending: false })
    .limit(25);
  if (error) throw new Error(error.message);

  const matches = matchingPendingApprovalTasks(
    (data || []) as PendingTeamChatApproval[],
    decision.taskIdPrefix,
  );
  if (matches.length === 0) {
    return {
      handled: true,
      action: decision.action,
      taskId: null,
      reply: decision.taskIdPrefix
        ? "No task with that id is awaiting approval in this conversation."
        : "There is no task awaiting approval in this conversation.",
    };
  }
  if (matches.length > 1) {
    return {
      handled: true,
      action: decision.action,
      taskId: null,
      reply:
        "More than one task is awaiting approval. Use its card, or reply with approve/reject followed by the task id.",
    };
  }

  const task = matches[0];
  const decidedTask =
    decision.action === "approve"
      ? await approveAgentTask({
          userId: task.user_id,
          taskId: task.id,
          decidedBy: `team_chat:${args.channelId}:${args.decidedByUserId}`,
        })
      : await rejectAgentTask({
          userId: task.user_id,
          taskId: task.id,
          decidedBy: `team_chat:${args.channelId}:${args.decidedByUserId}`,
        });
  if (!decidedTask) {
    return {
      handled: true,
      action: decision.action,
      taskId: task.id,
      reply: "That task is no longer awaiting approval.",
    };
  }
  let kickedTask = decidedTask;
  if (decision.action === "approve") {
    const { data: taskOwner } =
      await args.admin.auth.admin.getUserById(task.user_id);
    kickedTask = await kickAgentTask({
      taskId: task.id,
      userId: task.user_id,
      userEmail: taskOwner.user?.email || null,
      baseUrl: args.baseUrl,
    });
  }
  return {
    handled: true,
    action: decision.action,
    taskId: task.id,
    reply:
      decision.action === "approve"
        ? kickedTask.status === "failed"
          ? `Approved, but "${task.title || "Agent task"}" could not start: ${kickedTask.error || "unknown error"}.`
          : `Approved — "${task.title || "Agent task"}" is queued.`
        : `Rejected — "${task.title || "Agent task"}" was canceled.`,
  };
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function messageHistory(
  rows: Array<{ role?: unknown; content?: unknown }>,
): ModelMessage[] {
  return rows
    .filter(
      (row) =>
        (row.role === "user" || row.role === "assistant") &&
        typeof row.content === "string",
    )
    .map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content as string,
    }));
}

export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const pageSize = parseChatMessagePageSize(url.searchParams.get("limit"));
  const beforeValue = url.searchParams.get("before");
  const before = decodeChatMessageCursor(beforeValue);
  if (beforeValue && !before) {
    return NextResponse.json(
      { error: "Invalid message history cursor" },
      { status: 400 },
    );
  }
  const aroundValue = url.searchParams.get("around");
  const aroundId = isUuid(aroundValue) ? aroundValue : null;
  if (aroundValue && !aroundId) {
    return NextResponse.json(
      { error: "Invalid message anchor" },
      { status: 400 },
    );
  }
  const requestedThreadRootValue = url.searchParams.get("threadRootId");
  const requestedThreadRootId = isUuid(requestedThreadRootValue)
    ? requestedThreadRootValue
    : null;
  if (requestedThreadRootValue && !requestedThreadRootId) {
    return NextResponse.json(
      { error: "Invalid thread root" },
      { status: 400 },
    );
  }

  const { data: anchorMessage, error: anchorError } = aroundId
    ? await supabase
        .from("chat_messages")
        .select("*")
        .eq("channel_id", id)
        .eq("id", aroundId)
        .maybeSingle()
    : { data: null, error: null };
  if (anchorError) {
    return NextResponse.json({ error: anchorError.message }, { status: 500 });
  }
  if (aroundId && !anchorMessage) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  const effectiveThreadRootId =
    requestedThreadRootId ||
    (typeof anchorMessage?.thread_root_message_id === "string"
      ? anchorMessage.thread_root_message_id
      : null);
  if (
    requestedThreadRootId &&
    anchorMessage &&
    anchorMessage.id !== requestedThreadRootId &&
    anchorMessage.thread_root_message_id !== requestedThreadRootId
  ) {
    return NextResponse.json(
      { error: "Message anchor does not belong to this thread" },
      { status: 400 },
    );
  }

  let messages: Array<Record<string, unknown>> = [];
  let pageInfo = chatMessagePageInfo([], {
    hasOlder: false,
    hasNewer: false,
  });
  let replyCount: number | null = null;
  let targetThreadRootId: string | null = null;

  if (effectiveThreadRootId) {
    const { data: root, error: rootError } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("channel_id", id)
      .eq("id", effectiveThreadRootId)
      .is("thread_root_message_id", null)
      .maybeSingle();
    if (rootError) {
      return NextResponse.json({ error: rootError.message }, { status: 500 });
    }
    if (!root) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    targetThreadRootId = effectiveThreadRootId;
    let replies: Array<Record<string, unknown>> = [];
    let hasOlder = false;
    let hasNewer = false;
    if (
      anchorMessage &&
      anchorMessage.id !== effectiveThreadRootId &&
      typeof anchorMessage.created_at === "string"
    ) {
      const anchorCursor = {
        createdAt: anchorMessage.created_at,
        id: String(anchorMessage.id),
      };
      const olderTake = Math.floor((pageSize - 1) / 2);
      const newerTake = pageSize - 1 - olderTake;
      const [olderResult, newerResult] = await Promise.all([
        supabase
          .from("chat_messages")
          .select("*")
          .eq("channel_id", id)
          .eq("thread_root_message_id", effectiveThreadRootId)
          .or(olderThanChatMessageCursor(anchorCursor))
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(olderTake + 1),
        supabase
          .from("chat_messages")
          .select("*")
          .eq("channel_id", id)
          .eq("thread_root_message_id", effectiveThreadRootId)
          .or(newerThanChatMessageCursor(anchorCursor))
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(newerTake + 1),
      ]);
      const pageError = olderResult.error || newerResult.error;
      if (pageError) {
        return NextResponse.json(
          { error: pageError.message },
          { status: 500 },
        );
      }
      hasOlder = (olderResult.data || []).length > olderTake;
      hasNewer = (newerResult.data || []).length > newerTake;
      replies = [
        ...(olderResult.data || []).slice(0, olderTake).reverse(),
        anchorMessage,
        ...(newerResult.data || []).slice(0, newerTake),
      ];
    } else {
      let repliesQuery = supabase
        .from("chat_messages")
        .select("*")
        .eq("channel_id", id)
        .eq("thread_root_message_id", effectiveThreadRootId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
      if (before) {
        repliesQuery = repliesQuery.or(
          olderThanChatMessageCursor(before),
        );
      }
      const repliesResult = await repliesQuery.limit(pageSize + 1);
      if (repliesResult.error) {
        return NextResponse.json(
          { error: repliesResult.error.message },
          { status: 500 },
        );
      }
      hasOlder = (repliesResult.data || []).length > pageSize;
      hasNewer = Boolean(before);
      replies = (repliesResult.data || []).slice(0, pageSize).reverse();
    }
    const countResult = await supabase
      .from("chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("channel_id", id)
      .eq("thread_root_message_id", effectiveThreadRootId);
    if (countResult.error) {
      return NextResponse.json(
        { error: countResult.error.message },
        { status: 500 },
      );
    }
    replyCount = countResult.count || 0;
    messages = [root, ...replies];
    pageInfo = chatMessagePageInfo(
      replies as Array<{ id: string; created_at: string }>,
      { hasOlder, hasNewer },
    );
  } else if (anchorMessage) {
    const anchorCursor = {
      createdAt: String(anchorMessage.created_at),
      id: String(anchorMessage.id),
    };
    const olderTake = Math.floor((pageSize - 1) / 2);
    const newerTake = pageSize - 1 - olderTake;
    const [olderResult, newerResult] = await Promise.all([
      supabase
        .from("chat_messages")
        .select("*")
        .eq("channel_id", id)
        .is("thread_root_message_id", null)
        .or(olderThanChatMessageCursor(anchorCursor))
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(olderTake + 1),
      supabase
        .from("chat_messages")
        .select("*")
        .eq("channel_id", id)
        .is("thread_root_message_id", null)
        .or(newerThanChatMessageCursor(anchorCursor))
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(newerTake + 1),
    ]);
    const pageError = olderResult.error || newerResult.error;
    if (pageError) {
      return NextResponse.json(
        { error: pageError.message },
        { status: 500 },
      );
    }
    const hasOlder = (olderResult.data || []).length > olderTake;
    const hasNewer = (newerResult.data || []).length > newerTake;
    messages = [
      ...(olderResult.data || []).slice(0, olderTake).reverse(),
      anchorMessage,
      ...(newerResult.data || []).slice(0, newerTake),
    ];
    pageInfo = chatMessagePageInfo(
      messages as Array<{ id: string; created_at: string }>,
      { hasOlder, hasNewer },
    );
  } else {
    let mainQuery = supabase
      .from("chat_messages")
      .select("*")
      .eq("channel_id", id)
      .is("thread_root_message_id", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (before) {
      mainQuery = mainQuery.or(olderThanChatMessageCursor(before));
    }
    const mainResult = await mainQuery.limit(pageSize + 1);
    if (mainResult.error) {
      return NextResponse.json(
        { error: mainResult.error.message },
        { status: 500 },
      );
    }
    const hasOlder = (mainResult.data || []).length > pageSize;
    messages = (mainResult.data || []).slice(0, pageSize).reverse();
    pageInfo = chatMessagePageInfo(
      messages as Array<{ id: string; created_at: string }>,
      { hasOlder, hasNewer: Boolean(before) },
    );
  }

  const messageIds = messages
    .map((message) => message.id)
    .filter((value): value is string => typeof value === "string");
  const messageIdSet = new Set(messageIds);
  const quotedMessageIds = Array.from(
    new Set(
      messages
        .map((message) => message.reply_to_message_id)
        .filter(
          (value): value is string =>
            typeof value === "string" && !messageIdSet.has(value),
        ),
    ),
  );
  const [
    reactionsResult,
    pinsResult,
    savedResult,
    recentRepliesResult,
    contextMessagesResult,
  ] = await Promise.all([
      messageIds.length > 0
        ? supabase
            .from("chat_message_reactions")
            .select("id,channel_id,message_id,user_id,emoji,created_at")
            .eq("channel_id", id)
            .in("message_id", messageIds)
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from("chat_channel_pins")
        .select("channel_id,message_id,pinned_by,created_at")
        .eq("channel_id", id)
        .order("created_at", { ascending: false }),
      messageIds.length > 0
        ? supabase
            .from("chat_saved_messages")
            .select("message_id")
            .eq("channel_id", id)
            .eq("user_id", user.id)
            .in("message_id", messageIds)
        : Promise.resolve({ data: [], error: null }),
      effectiveThreadRootId
        ? Promise.resolve({ data: [], error: null })
        : supabase
            .from("chat_messages")
            .select("thread_root_message_id")
            .eq("channel_id", id)
            .not("thread_root_message_id", "is", null)
            .order("created_at", { ascending: false })
            .limit(500),
      quotedMessageIds.length > 0
        ? supabase
            .from("chat_messages")
            .select("*")
            .eq("channel_id", id)
            .in("id", quotedMessageIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
  const messageReadError =
    recentRepliesResult.error || contextMessagesResult.error;
  if (messageReadError) {
    return NextResponse.json(
      { error: messageReadError.message },
      { status: 500 },
    );
  }
  const socialErrors = [
    reactionsResult.error,
    pinsResult.error,
    savedResult.error,
  ].filter(Boolean);
  const socialMigrationPending = socialErrors.some(socialSchemaUnavailable);
  const unexpectedSocialError = socialErrors.find(
    (socialError) => !socialSchemaUnavailable(socialError),
  );
  if (unexpectedSocialError) {
    return NextResponse.json(
      { error: unexpectedSocialError.message },
      { status: 500 },
    );
  }
  const threadReplyCounts: Record<string, number> = {};
  for (const row of recentRepliesResult.data || []) {
    if (typeof row.thread_root_message_id !== "string") continue;
    threadReplyCounts[row.thread_root_message_id] =
      (threadReplyCounts[row.thread_root_message_id] || 0) + 1;
  }
  if (effectiveThreadRootId && replyCount !== null) {
    threadReplyCounts[effectiveThreadRootId] = replyCount;
  }
  return NextResponse.json({
    messages,
    pageInfo,
    target: aroundId
      ? {
          messageId: aroundId,
          threadRootId: targetThreadRootId,
        }
      : null,
    replyCount,
    threadReplyCounts,
    contextMessages: contextMessagesResult.data || [],
    reactions: reactionsResult.data || [],
    pins: pinsResult.data || [],
    savedMessageIds: (savedResult.data || []).map((row) => row.message_id),
    socialMigrationPending,
  });
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const sessionSupabase = await createSupabaseServerClient();
  const internal = verifyInternalRouteAuth(
    req,
    CHAT_MESSAGE_SEND_INTERNAL_SCOPE,
  );
  let supabase: SupabaseClient = sessionSupabase;
  let user: User | null = null;
  let internalAdmin: SupabaseClient | null = null;
  const isInternalRequest = Boolean(internal);
  if (internal) {
    internalAdmin = createSupabaseAdminClient();
    const { data, error } = await internalAdmin.auth.admin.getUserById(
      internal.userId,
    );
    if (!error && data.user) user = data.user;
  } else {
    const sessionResult = await sessionSupabase.auth.getUser();
    user = sessionResult.data.user;
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (internalAdmin) {
    try {
      const authorization = await authorizeChatChannelForUser({
        admin: internalAdmin,
        userId: user.id,
        channelId: id,
      });
      if (!authorization.ok) {
        return authorization.reason === "archived"
          ? NextResponse.json(
              { error: "Archived channels are read-only" },
              { status: 409 },
            )
          : NextResponse.json(
              { error: "Channel not found" },
              { status: 404 },
            );
      }
      // Service-role reads and writes are safe only after the explicit policy
      // mirror above has authorized this canonical auth user in their active
      // workspace.
      supabase = internalAdmin;
    } catch (error) {
      console.error("[team-chat] internal_channel_authorization_failed", {
        channelId: id,
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: "Could not authorize this Team Chat conversation" },
        { status: 500 },
      );
    }
  }
  const currentSpeakerUserId = user.id;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (isInternalRequest) {
    const allowedInternalFields = new Set([
      "content",
      "clientMessageId",
      "timezone",
    ]);
    const unsupportedFields = Object.keys(body || {}).filter(
      (key) => !allowedInternalFields.has(key),
    );
    if (unsupportedFields.length > 0) {
      return NextResponse.json(
        { error: "Internal Team Chat commands support text messages only" },
        { status: 400 },
      );
    }
  }
  const localTimezone = normalizeScheduleTimezone(body?.timezone);
  const rawClientMessageId = body?.clientMessageId;
  const clientMessageId = isUuid(rawClientMessageId)
    ? rawClientMessageId
    : null;
  if (rawClientMessageId !== undefined && !clientMessageId) {
    return NextResponse.json(
      { error: "clientMessageId must be a UUID" },
      { status: 400 },
    );
  }
  if (isInternalRequest && !clientMessageId) {
    return NextResponse.json(
      { error: "clientMessageId is required for internal Team Chat commands" },
      { status: 400 },
    );
  }
  let attachments: ReturnType<typeof validateChatAttachments>;
  let voiceNote: ReturnType<typeof validateChatVoiceNote>;
  let snippet: ReturnType<typeof validateChatTextSnippet>;
  try {
    attachments = validateChatAttachments(body?.files);
    voiceNote = validateChatVoiceNote(body?.voiceNote);
    snippet = validateChatTextSnippet(body?.snippet);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof ChatImageValidationError ||
          error instanceof ChatSnippetValidationError
            ? error.message
            : "Could not validate the attached content.",
      },
      { status: 400 },
    );
  }
  const inlineImages = attachments.filter(
    (attachment) => attachment.kind === "image",
  );
  const generalFiles = attachments.filter(
    (attachment) => attachment.kind === "file",
  );
  const attachmentKindCount =
    (attachments.length > 0 ? 1 : 0) +
    (voiceNote ? 1 : 0) +
    (snippet ? 1 : 0);
  if (attachmentKindCount > 1) {
    return NextResponse.json(
      {
        error:
          "Send files, one voice note, or one text snippet at a time.",
      },
      { status: 400 },
    );
  }
  const typedContent =
    typeof body?.content === "string" ? body.content.trim() : "";
  if (
    (!typedContent && attachmentKindCount === 0) ||
    typedContent.length > MAX_CHAT_MESSAGE_CHARACTERS
  ) {
    return NextResponse.json(
      {
        error:
          `Add a message, up to 5 files, one voice note, or one text snippet (${MAX_CHAT_MESSAGE_CHARACTERS.toLocaleString()} message characters maximum).`,
      },
      { status: 400 },
    );
  }
  const content =
    typedContent ||
    (attachments.length > 0
      ? attachmentOnlyMessage(attachments)
      : voiceNote
        ? voiceNoteMessage()
        : textSnippetMessage(snippet!));
  const rawReplyTo = body?.replyToMessageId;
  const replyTo = isUuid(rawReplyTo) ? rawReplyTo : null;
  if (rawReplyTo !== undefined && rawReplyTo !== null && !replyTo) {
    return NextResponse.json(
      { error: "replyToMessageId must be a UUID" },
      { status: 400 },
    );
  }
  const rawThreadRoot = body?.threadRootMessageId;
  const requestedThreadRoot = isUuid(rawThreadRoot) ? rawThreadRoot : null;
  if (
    rawThreadRoot !== undefined &&
    rawThreadRoot !== null &&
    !requestedThreadRoot
  ) {
    return NextResponse.json(
      { error: "threadRootMessageId must be a UUID" },
      { status: 400 },
    );
  }
  const rawResendOf = body?.resendOfMessageId;
  const resendOf = isUuid(rawResendOf) ? rawResendOf : null;
  if (rawResendOf !== undefined && rawResendOf !== null && !resendOf) {
    return NextResponse.json(
      { error: "resendOfMessageId must be a UUID" },
      { status: 400 },
    );
  }
  if (resendOf && attachmentKindCount > 0) {
    return NextResponse.json(
      {
        error:
          "Edit the message text without adding new attachments. Existing attachments stay with the message.",
      },
      { status: 400 },
    );
  }

  const { data: channelData, error: channelError } = await supabase
    .from("chat_channels")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (channelError) return NextResponse.json({ error: channelError.message }, { status: 500 });
  if (!channelData) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  const channel = channelData as ChatChannelRow;
  if (channel.is_archived) {
    return NextResponse.json({ error: "Archived channels are read-only" }, { status: 409 });
  }
  if (isInternalRequest && clientMessageId && internalAdmin) {
    const { data: replay, error: replayError } = await internalAdmin
      .from("chat_messages")
      .select("*")
      .eq("id", clientMessageId)
      .maybeSingle();
    if (replayError) {
      return NextResponse.json(
        { error: "Could not verify the Team Chat message request" },
        { status: 500 },
      );
    }
    if (replay) {
      if (
        !isMatchingInternalChatMessageReplay({
          row: replay,
          channelId: id,
          userId: user.id,
          clientMessageId,
          content,
        })
      ) {
        return NextResponse.json(
          { error: "clientMessageId conflicts with another message" },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { message: replay, orchestrator: null, replayed: true },
        { status: 200 },
      );
    }
  }
  let replyTarget:
    | {
        id: string;
        thread_root_message_id: string | null;
      }
    | null = null;
  if (replyTo) {
    const { data, error: replyError } = await supabase
      .from("chat_messages")
      .select("id,thread_root_message_id")
      .eq("id", replyTo)
      .eq("channel_id", id)
      .maybeSingle();
    if (replyError) {
      return NextResponse.json({ error: replyError.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json(
        { error: "replyToMessageId must belong to this channel" },
        { status: 400 },
      );
    }
    replyTarget = {
      id: String(data.id),
      thread_root_message_id:
        typeof data.thread_root_message_id === "string"
          ? data.thread_root_message_id
          : null,
    };
  }

  let threadRoot:
    | {
        id: string;
        content: string;
      }
    | null = null;
  const effectiveThreadRoot =
    requestedThreadRoot || replyTarget?.thread_root_message_id || null;
  if (effectiveThreadRoot) {
    const { data: requestedRoot, error: threadRootError } = await supabase
      .from("chat_messages")
      .select("id,content,thread_root_message_id")
      .eq("id", effectiveThreadRoot)
      .eq("channel_id", id)
      .maybeSingle();
    if (threadRootError) {
      return NextResponse.json(
        { error: threadRootError.message },
        { status: 500 },
      );
    }
    if (!requestedRoot) {
      return NextResponse.json(
        { error: "threadRootMessageId must belong to this channel" },
        { status: 400 },
      );
    }
    const normalizedRootId = threadRootId({
      id: String(requestedRoot.id),
      thread_root_message_id:
        typeof requestedRoot.thread_root_message_id === "string"
          ? requestedRoot.thread_root_message_id
          : null,
    });
    let normalizedRoot:
      | {
          id: string;
          content: string;
          thread_root_message_id: string | null;
        }
      | null = {
        id: String(requestedRoot.id),
        content: String(requestedRoot.content || ""),
        thread_root_message_id:
          typeof requestedRoot.thread_root_message_id === "string"
            ? requestedRoot.thread_root_message_id
            : null,
      };
    if (normalizedRootId !== requestedRoot.id) {
      const { data, error: normalizedRootError } = await supabase
        .from("chat_messages")
        .select("id,content,thread_root_message_id")
        .eq("id", normalizedRootId)
        .eq("channel_id", id)
        .is("thread_root_message_id", null)
        .maybeSingle();
      if (normalizedRootError) {
        return NextResponse.json(
          { error: normalizedRootError.message },
          { status: 500 },
        );
      }
      normalizedRoot = data;
    }
    if (!normalizedRoot) {
      return NextResponse.json(
        { error: "The thread root is no longer available" },
        { status: 409 },
      );
    }
    threadRoot = {
      id: String(normalizedRoot.id),
      content: String(normalizedRoot.content || ""),
    };
    if (
      replyTarget &&
      !messageBelongsToThread(replyTarget, threadRoot.id)
    ) {
      return NextResponse.json(
        { error: "Replies cannot cross thread boundaries" },
        { status: 400 },
      );
    }
  }
  let resendSource:
    | {
        id: string;
        author_type: string | null;
        author_user_id: string | null;
        content: string;
        reply_to_message_id: string | null;
        thread_root_message_id: string | null;
        metadata: Record<string, unknown> | null;
        created_at: string;
      }
    | null = null;
  if (resendOf) {
    const { data, error: resendError } = await supabase
      .from("chat_messages")
      .select(
        "id,author_type,author_user_id,content,reply_to_message_id,thread_root_message_id,metadata,created_at",
      )
      .eq("id", resendOf)
      .eq("channel_id", id)
      .maybeSingle();
    if (resendError) {
      return NextResponse.json({ error: resendError.message }, { status: 500 });
    }
    if (
      !data ||
      data.author_type !== "user" ||
      data.author_user_id !== user.id
    ) {
      return NextResponse.json(
        {
          error:
            "You can only edit and resend one of your own messages from this channel.",
        },
        { status: 403 },
      );
    }
    resendSource = {
      id: String(data.id),
      author_type:
        typeof data.author_type === "string" ? data.author_type : null,
      author_user_id:
        typeof data.author_user_id === "string" ? data.author_user_id : null,
      content: String(data.content || ""),
      reply_to_message_id:
        typeof data.reply_to_message_id === "string"
          ? data.reply_to_message_id
          : null,
      thread_root_message_id:
        typeof data.thread_root_message_id === "string"
          ? data.thread_root_message_id
          : null,
      metadata:
        data.metadata &&
        typeof data.metadata === "object" &&
        !Array.isArray(data.metadata)
          ? (data.metadata as Record<string, unknown>)
          : {},
      created_at: String(data.created_at),
    };
    if (
      resendSource.reply_to_message_id !== replyTo ||
      resendSource.thread_root_message_id !== (threadRoot?.id || null)
    ) {
      return NextResponse.json(
        {
          error:
            "Editing a message cannot move it into another reply or thread.",
        },
        { status: 409 },
      );
    }
  }

  const admin = createSupabaseAdminClient();
  if (attachments.length > 0 || voiceNote) {
    const { error: attachmentSchemaError } = await admin
      .from("chat_message_attachments")
      .select(voiceNote ? "id,kind,duration_ms" : "id")
      .limit(1);
    if (attachmentSchemaError) {
      return NextResponse.json(
        {
          error:
            "Chat attachments are ready in the app but need the latest database migration before they can be sent.",
        },
        { status: 503 },
      );
    }
  }

  const messageWriteAt = new Date().toISOString();
  const baseMessageMetadata: Record<string, unknown> = {
    ...(resendSource?.metadata || {}),
    ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
    ...(resendSource
      ? {
          edited_at: messageWriteAt,
          edit_count:
            (typeof resendSource.metadata?.edit_count === "number"
              ? resendSource.metadata.edit_count
              : 0) + 1,
          image_only: false,
          file_only: false,
          voice_only: false,
          snippet_only: false,
        }
      : {}),
    ...(snippet
      ? {
          snippet,
          snippet_only: !typedContent,
        }
      : {}),
  };
  const writeResult = resendSource
    ? await admin
        .from("chat_messages")
        .update({
          content,
          metadata: baseMessageMetadata,
          created_at: messageWriteAt,
        })
        .eq("id", resendSource.id)
        .eq("channel_id", id)
        .eq("author_type", "user")
        .eq("author_user_id", user.id)
        .select("*")
        .single()
    : await supabase
        .from("chat_messages")
        .insert({
          ...(isInternalRequest && clientMessageId
            ? { id: clientMessageId }
            : {}),
          channel_id: id,
          author_type: "user",
          author_user_id: user.id,
          content,
          reply_to_message_id: replyTo,
          thread_root_message_id: threadRoot?.id || null,
          metadata: baseMessageMetadata,
        })
        .select("*")
        .single();
  const { data: inserted, error: insertError } = writeResult;
  if (insertError) {
    if (
      isInternalRequest &&
      clientMessageId &&
      internalAdmin &&
      insertError.code === "23505"
    ) {
      const { data: replay } = await internalAdmin
        .from("chat_messages")
        .select("*")
        .eq("id", clientMessageId)
        .maybeSingle();
      if (
        isMatchingInternalChatMessageReplay({
          row: replay,
          channelId: id,
          userId: user.id,
          clientMessageId,
          content,
        })
      ) {
        return NextResponse.json(
          { message: replay, orchestrator: null, replayed: true },
          { status: 200 },
        );
      }
      return NextResponse.json(
        { error: "clientMessageId conflicts with another message" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: insertError.message },
      { status: insertError.code === "42501" ? 403 : 500 },
    );
  }

  const uploadedAttachmentPaths: string[] = [];
  const cleanupMessageAndAttachments = async () => {
    if (uploadedAttachmentPaths.length > 0) {
      await admin.storage
        .from(CHAT_IMAGE_BUCKET)
        .remove(uploadedAttachmentPaths);
    }
    if (resendSource) {
      await admin
        .from("chat_messages")
        .update({
          content: resendSource.content,
          metadata: resendSource.metadata || {},
          created_at: resendSource.created_at,
        })
        .eq("id", resendSource.id)
        .eq("channel_id", id)
        .eq("author_type", "user")
        .eq("author_user_id", user.id);
      return;
    }
    await admin
      .from("chat_messages")
      .delete()
      .eq("id", inserted.id)
      .eq("channel_id", id)
      .eq("author_user_id", user.id);
  };
  if (attachments.length > 0) {
    try {
      const uploaded = [];
      for (const [position, attachment] of attachments.entries()) {
        const storagePath = buildChatAttachmentStoragePath({
          uploaderId: user.id,
          channelId: id,
          mediaType: attachment.mediaType,
        });
        const { error: uploadError } = await admin.storage
          .from(CHAT_IMAGE_BUCKET)
          .upload(storagePath, attachment.bytes, {
            contentType: attachment.mediaType,
            cacheControl: "3600",
            upsert: false,
          });
        if (uploadError) throw new Error(uploadError.message);
        uploadedAttachmentPaths.push(storagePath);
        uploaded.push({
          channel_id: id,
          message_id: inserted.id,
          uploaded_by: user.id,
          storage_path: storagePath,
          file_name: attachment.filename,
          mime_type: attachment.mediaType,
          size_bytes: attachment.byteSize,
          position,
          kind: attachment.kind,
        });
      }
      const { data: attachmentRows, error: attachmentError } = await admin
        .from("chat_message_attachments")
        .insert(uploaded)
        .select("id,kind,storage_path,file_name,mime_type,size_bytes");
      if (attachmentError || !attachmentRows) {
        throw new Error(
          attachmentError?.message || "Could not save file attachments",
        );
      }
      const attachmentByPath = new Map(
        attachmentRows.map((attachment) => [
          String(attachment.storage_path),
          attachment,
        ]),
      );
      const publicAttachments = uploaded.map((upload) => {
        const attachment = attachmentByPath.get(upload.storage_path);
        if (!attachment) throw new Error("Could not resolve an uploaded file");
        return publicChatAttachment(attachment);
      });
      const metadata = {
        ...baseMessageMetadata,
        attachments: publicAttachments,
        image_only: !typedContent && generalFiles.length === 0,
        file_only: !typedContent && generalFiles.length > 0,
      };
      const { data: updatedMessage, error: metadataError } = await admin
        .from("chat_messages")
        .update({ metadata })
        .eq("id", inserted.id)
        .eq("channel_id", id)
        .select("metadata")
        .single();
      if (metadataError || !updatedMessage) {
        throw new Error(
          metadataError?.message || "Could not attach files to the message",
        );
      }
      inserted.metadata = updatedMessage.metadata;
    } catch (error) {
      await cleanupMessageAndAttachments();
      console.error("[team-chat] attachment_upload_failed", {
        channelId: id,
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: "Could not securely attach those files. Please try again." },
        { status: 500 },
      );
    }
  }
  if (voiceNote) {
    try {
      const storagePath = buildChatVoiceStoragePath({
        uploaderId: user.id,
        channelId: id,
        mediaType: voiceNote.mediaType,
      });
      const { error: uploadError } = await admin.storage
        .from(CHAT_IMAGE_BUCKET)
        .upload(storagePath, voiceNote.bytes, {
          contentType: voiceNote.mediaType,
          cacheControl: "3600",
          upsert: false,
        });
      if (uploadError) throw new Error(uploadError.message);
      uploadedAttachmentPaths.push(storagePath);
      const { data: attachment, error: attachmentError } = await admin
        .from("chat_message_attachments")
        .insert({
          channel_id: id,
          message_id: inserted.id,
          uploaded_by: user.id,
          storage_path: storagePath,
          file_name: voiceNote.filename,
          mime_type: voiceNote.mediaType,
          size_bytes: voiceNote.byteSize,
          position: 0,
          kind: "voice",
          duration_ms: voiceNote.durationMs,
        })
        .select(
          "id,storage_path,file_name,mime_type,size_bytes,duration_ms",
        )
        .single();
      if (attachmentError || !attachment) {
        throw new Error(
          attachmentError?.message || "Could not save the voice note",
        );
      }
      const metadata = {
        ...baseMessageMetadata,
        voice_note: publicChatVoiceAttachment(attachment),
        voice_only: !typedContent,
      };
      const { data: updatedMessage, error: metadataError } = await admin
        .from("chat_messages")
        .update({ metadata })
        .eq("id", inserted.id)
        .eq("channel_id", id)
        .select("metadata")
        .single();
      if (metadataError || !updatedMessage) {
        throw new Error(
          metadataError?.message || "Could not attach the voice note",
        );
      }
      inserted.metadata = updatedMessage.metadata;
    } catch (error) {
      await cleanupMessageAndAttachments();
      console.error("[team-chat] voice_note_upload_failed", {
        channelId: id,
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: "Could not securely attach that voice note. Please try again." },
        { status: 500 },
      );
    }
  }

  const speaker =
    (
      (typeof user.user_metadata?.full_name === "string" &&
        user.user_metadata.full_name.trim()) ||
      (typeof user.user_metadata?.name === "string" &&
        user.user_metadata.name.trim()) ||
      user.email ||
      "Workspace member"
    )
      .replace(/[\r\n[\]]+/g, " ")
      .trim()
      .slice(0, 300) || "Workspace member";
  let humanPushSent = false;
  const notifyHumanMessage = async () => {
    if (humanPushSent) return;
    humanPushSent = true;
    try {
      await sendTeamChatPush({
        admin,
        channelId: id,
        messageId: String(inserted.id),
        authorType: "user",
        authorUserId: user.id,
        authorLabel: speaker,
        content,
        threadRootMessageId:
          threadRoot && !resendSource ? threadRoot.id : null,
      });
    } catch (cause) {
      console.warn("[team-chat] human push delivery failed", {
        channelId: id,
        messageId: inserted.id,
        error: cause instanceof Error ? cause.message : "Unknown push error",
      });
    }
  };
  const [workspaceResult, channelMembersResult] = await Promise.all([
    admin
      .from("workspaces")
      .select("id,name,billing_admin_user_id")
      .eq("id", channel.workspace_id)
      .maybeSingle(),
    admin
      .from("chat_channel_members")
      .select("member_type,user_id,agent_id")
      .eq("channel_id", id)
      .in("member_type", ["user", "agent"]),
  ]);
  const { data: workspace, error: workspaceError } = workspaceResult;
  const { data: channelMembers, error: channelMembersError } =
    channelMembersResult;
  const channelUserIds = (channelMembers || [])
    .filter((member) => member.member_type === "user")
    .map((member) =>
      typeof member.user_id === "string" ? member.user_id : "",
    )
    .filter(Boolean);
  if (channel.kind === "dm" && !resendSource && !channelMembersError) {
    const defaultNotificationsResult =
      await ensureDefaultChatNotificationPreferences({
        admin,
        channelId: id,
        kind: "dm",
        userIds: channelUserIds,
      });
    if (
      defaultNotificationsResult.error &&
      !notificationPreferencesSchemaUnavailable(
        defaultNotificationsResult.error,
      )
    ) {
      console.warn("[team-chat] DM notification default failed", {
        channelId: id,
        code: defaultNotificationsResult.error.code || null,
      });
    }
  }
  if (workspaceError || !workspace?.billing_admin_user_id) {
    console.error("[team-chat] workspace_resolution_failed", {
      channelId: id,
      error: workspaceError?.message || "workspace owner unavailable",
    });
    await notifyHumanMessage();
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        error: "Message delivered, but the channel orchestrator is not configured.",
      },
      { status: 201 },
    );
  }
  const traceId = randomUUID();
  if (channelMembersError) {
    await notifyHumanMessage();
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        error: "Message delivered, but channel members could not be resolved.",
      },
      { status: 201 },
    );
  }
  if (!resendSource) {
    let taskDecision:
      | Awaited<ReturnType<typeof executeTeamChatAgentTaskDecision>>
      | null = null;
    try {
      taskDecision = await executeTeamChatAgentTaskDecision({
        admin,
        channelId: id,
        text: content,
        decidedByUserId: user.id,
        baseUrl: new URL(req.url).origin,
      });
    } catch (decisionError) {
      if (parseTeamChatAgentTaskDecision(content)) {
        await notifyHumanMessage();
        return NextResponse.json(
          {
            message: inserted,
            orchestrator: null,
            error:
              decisionError instanceof Error
                ? `Message delivered, but the task approval could not be checked: ${decisionError.message}`
                : "Message delivered, but the task approval could not be checked.",
          },
          { status: 201 },
        );
      }
    }
    if (taskDecision?.handled) {
      const { data: decisionMessage, error: decisionMessageError } = await admin
        .from("chat_messages")
        .insert({
          channel_id: id,
          author_type: "system",
          content: taskDecision.reply,
          reply_to_message_id: inserted.id,
          thread_root_message_id: threadRoot?.id || null,
          metadata: {
            kind: "agent_task_decision",
            action: taskDecision.action,
            task_id: taskDecision.taskId,
            decided_by: user.id,
          },
        })
        .select("*")
        .single();
      await notifyHumanMessage();
      if (decisionMessageError || !decisionMessage) {
        return NextResponse.json(
          {
            message: inserted,
            orchestrator: null,
            error:
              "The task decision was handled, but its confirmation could not be posted. Chat will refresh the task card.",
          },
          { status: 201 },
        );
      }
      return NextResponse.json(
        {
          message: inserted,
          orchestrator: decisionMessage,
        },
        { status: 201 },
      );
    }
  }
  const uniqueAgentIds = channelAgentIds(channelMembers || []);
  const { data: agents, error: agentsError } = uniqueAgentIds.length
    ? await admin
        .from("agents")
        .select("id,name")
        .eq("user_id", workspace.billing_admin_user_id)
        .in("id", uniqueAgentIds)
    : { data: [], error: null };
  if (agentsError || (agents || []).length !== uniqueAgentIds.length) {
    await notifyHumanMessage();
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        error: "Message delivered, but channel agents could not be resolved.",
      },
      { status: 201 },
    );
  }

  const directDmAgentId = directAgentMessageTargetId({
    kind: channel.kind,
    members: channelMembers || [],
  });
  const directDmAgent = directDmAgentId
    ? (agents || []).find((agent) => agent.id === directDmAgentId) || null
    : null;
  if (directDmAgent?.id) {
    // A one-to-one worker DM must never depend on a Mind, orchestrator
    // session, turn lock, prompt router, or orchestration model. The durable
    // worker task and its eventual team-chat completion are the whole path.
    const access = await getProductAccessForUser({
      userId: workspace.billing_admin_user_id,
      workspaceId: channel.workspace_id,
    }).catch(() => null);
    if (!access?.hasAccess) {
      await cleanupMessageAndAttachments();
      return NextResponse.json(
        {
          error:
            access?.accessStatus === "trial_available"
              ? "The workspace owner needs to start their free trial before agents can run here."
              : "The workspace owner needs to activate Groovy before agents can run here.",
          code:
            access?.accessStatus === "trial_available"
              ? "trial_not_started"
              : "license_required",
        },
        { status: 402 },
      );
    }

    await notifyHumanMessage();
    try {
      const task = await createAgentTask({
        userId: workspace.billing_admin_user_id,
        agentId: String(directDmAgent.id),
        prompt: content,
        context: [
          `Direct message from ${speaker} in ${channel.name}.`,
          threadRoot
            ? `This is a thread reply to: ${threadRoot.content.slice(0, 2_000)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        requestedChannel: `team_chat:${id}`,
        notify: { dashboard: true },
        source: "api",
        traceId,
        turnId: traceId,
        resultMeta: threadRoot
          ? { thread_root_message_id: threadRoot.id }
          : undefined,
      });
      const kickedTask = await kickAgentTask({
        taskId: task.id,
        userId: workspace.billing_admin_user_id,
        baseUrl: new URL(req.url).origin,
      });
      return NextResponse.json(
        {
          message: inserted,
          orchestrator: null,
          agentTask: {
            id: kickedTask.id,
            status: kickedTask.status,
            title: kickedTask.title || "Agent task",
            agentId: String(directDmAgent.id),
            agentName: String(directDmAgent.name || "Agent"),
            traceId,
            startedAt: kickedTask.created_at,
          },
        },
        { status: 201 },
      );
    } catch (error) {
      console.error("[team-chat] direct_agent_dispatch_failed", {
        channelId: id,
        agentId: directDmAgent.id,
        traceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        {
          message: inserted,
          orchestrator: null,
          error:
            "Message delivered, but the agent task could not be started. Please try again.",
        },
        { status: 201 },
      );
    }
  }

  let profile: Awaited<ReturnType<typeof resolveHarnessProfile>>;
  try {
    profile = await resolveHarnessProfile(admin, {
      userId: workspace.billing_admin_user_id,
      workspaceId: channel.workspace_id,
      explicitProfileId: channel.profile_id,
    });
  } catch (error) {
    console.error("[team-chat] profile_resolution_failed", {
      channelId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    await notifyHumanMessage();
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        error: "Message delivered, but the channel profile could not be resolved.",
      },
      { status: 201 },
    );
  }
  if (channel.profile_id && !profile) {
    await cleanupMessageAndAttachments();
    return NextResponse.json(
      {
        orchestrator: null,
        error: "This channel's bound profile is unavailable. Ask a workspace admin to rebind it.",
      },
      { status: 409 },
    );
  }
  const roleLookupUserIds = Array.from(new Set([...channelUserIds, user.id]));
  const { data: channelWorkspaceMembers, error: guestMemberError } =
    roleLookupUserIds.length > 0
      ? await admin
          .from("workspace_members")
          .select("user_id,role")
          .eq("workspace_id", channel.workspace_id)
          .in("user_id", roleLookupUserIds)
      : { data: [], error: null };
  if (guestMemberError) {
    await notifyHumanMessage();
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        error: "Message delivered, but channel access could not be resolved.",
      },
      { status: 201 },
    );
  }
  const channelRoleByUserId = new Map(
    (channelWorkspaceMembers || []).map((member) => [
      String(member.user_id),
      member.role === "admin" || member.role === "guest"
        ? member.role
        : "member",
    ]),
  );
  const channelHasGuests = channelUserIds.some(
    (participantUserId) =>
      (channelRoleByUserId.get(participantUserId) || "guest") === "guest",
  );
  const teamChatProvider = channelHasGuests
    ? "team_chat_guest"
    : "team_chat";
  const canManageCurrentChannelSkills =
    channel.kind === "channel" &&
    canManageChannelSkills({
      actorUserId: user.id,
      channelCreatedBy: channel.created_by,
      workspaceRole: channelRoleByUserId.get(user.id) || null,
    });
  const canManageCurrentChannelSchedules =
    channel.kind === "channel" &&
    canManageChannelSchedules({
      workspaceRole: channelRoleByUserId.get(user.id) || null,
      channelCreatedBy: channel.created_by,
      userId: user.id,
    });
  const canManageWorkspaceAssignments =
    channelRoleByUserId.get(user.id) === "admin";
  if (!channel.profile_id) {
    const { data: stickyThread, error: stickyThreadError } = await admin
      .from("orchestrator_external_threads")
      .select("profile_id")
      .eq("user_id", workspace.billing_admin_user_id)
      .eq("provider", teamChatProvider)
      .eq("thread_key", id)
      .maybeSingle();
    if (stickyThreadError) {
      await notifyHumanMessage();
      return NextResponse.json(
        {
          message: inserted,
          orchestrator: null,
          error: "Message delivered, but the channel Mind binding could not be loaded.",
        },
        { status: 201 },
      );
    }
    try {
      profile = await resolveHarnessProfile(admin, {
        userId: workspace.billing_admin_user_id,
        workspaceId: channel.workspace_id,
        provider: teamChatProvider,
        threadKey: id,
      });
    } catch (error) {
      console.error("[team-chat] sticky_profile_resolution_failed", {
        channelId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      profile = null;
    }
    if (stickyThread?.profile_id && !profile) {
      await cleanupMessageAndAttachments();
      return NextResponse.json(
        {
          orchestrator: null,
          error:
            "This channel's sticky Mind is unavailable. Ask a workspace admin to bind another Mind.",
        },
        { status: 409 },
      );
    }
  }
  // Attachments are first-class human messages. They only reach a Mind when
  // the room is configured to always invoke it or the sender explicitly
  // mentions a Mind/agent in the message text.
  const requestedOrchestratorReply = shouldRunChannelOrchestrator({
    content,
    channel,
    profileName: profile?.name,
    profileSlug: profile?.slug,
    agentNames: (agents || []).map((agent) => String(agent.name || "")),
  });
  const guestSafeProfile =
    Boolean(channel.profile_id) && isGuestSafeMind(profile);
  if (channelHasGuests && !guestSafeProfile) {
    await notifyHumanMessage();
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        ...(requestedOrchestratorReply
          ? {
              error:
                `Message delivered. ${GUEST_SAFE_MIND_REQUIREMENT} Ask a workspace admin to configure or bind one before the orchestrator can reply.`,
            }
          : {}),
      },
      { status: 201 },
    );
  }
  const shouldReply = requestedOrchestratorReply;
  const channelParticipantContext = shouldReply
    ? buildChannelParticipantContext({
        channelName: channel.name,
        visibility:
          channel.visibility === "private" ? "private" : "workspace",
        currentSpeakerUserId: user.id,
        humans: await Promise.all(
          channelUserIds.map(async (participantUserId) => {
            const { data } =
              await admin.auth.admin.getUserById(participantUserId);
            const participant = data.user;
            const displayName =
              (typeof participant?.user_metadata?.full_name === "string" &&
                participant.user_metadata.full_name.trim()) ||
              (typeof participant?.user_metadata?.name === "string" &&
                participant.user_metadata.name.trim()) ||
              participant?.email?.split("@")[0] ||
              "Workspace member";
            return {
              userId: participantUserId,
              displayName,
              email: participant?.email || null,
              workspaceRole:
                channelRoleByUserId.get(participantUserId) ||
                ("guest" as const),
            };
          }),
        ),
        agents: (agents || []).map((agent) => ({
          id: String(agent.id),
          name: String(agent.name || "Worker agent"),
        })),
        mindName: profile?.name || "Groovy",
      })
    : null;
  const { data: channelSkillAssignments, error: channelSkillsError } =
    shouldReply
      ? await admin
          .from("chat_channel_skill_assignments")
          .select("artifact_id")
          .eq("channel_id", id)
      : { data: [], error: null };
  if (channelSkillsError) {
    console.error("[team-chat] channel_skills_unavailable", {
      channelId: id,
      error: channelSkillsError.message,
    });
  }
  const channelSkillArtifactIds = channelSkillsError
    ? []
    : (channelSkillAssignments || []).map((row) => String(row.artifact_id));

  let external: Awaited<ReturnType<typeof getOrCreateExternalSession>>;
  try {
    external = await getOrCreateExternalSession({
      admin,
      ownerUserId: workspace.billing_admin_user_id,
      provider: teamChatProvider,
      threadKey: id,
      threadName: `Team chat: ${channel.name}`,
      profileId: profile?.id || null,
    });
  } catch (error) {
    console.error("[team-chat] session_resolution_failed", {
      channelId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    await notifyHumanMessage();
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        error: "Message delivered, but the shared orchestrator session is unavailable.",
      },
      { status: 201 },
    );
  }
  const imageContext =
    inlineImages.length > 0
      ? `\n[Attached image filenames (untrusted labels only): ${JSON.stringify(
          inlineImages.map((image) => image.filename),
        )}]`
      : "";
  const fileContext =
    generalFiles.length > 0
      ? `\n[Attached files (untrusted filenames and labels only; contents are not included): ${JSON.stringify(
          generalFiles.map((file) => ({
            filename: file.filename,
            mimeType: file.mediaType,
          })),
        )}]`
      : "";
  const voiceContext = voiceNote
    ? `\n[Attached voice note (audio is not transcribed): ${JSON.stringify({
        filename: voiceNote.filename,
        durationMs: voiceNote.durationMs,
      })}]`
    : "";
  const snippetContext = snippet
    ? `\n[Attached text snippet: ${JSON.stringify({
        title: snippet.title,
        language: snippet.language,
      })}]\n${snippet.content.slice(0, 20_000)}${
        snippet.content.length > 20_000
          ? "\n[Snippet truncated in Mind history]"
          : ""
      }`
    : "";
  const threadContext = threadRoot
    ? `[Thread root: ${threadRoot.content.slice(0, 2_000)}]\n`
    : "";
  const attributedContent =
    `${threadContext}[From: ${speaker}]\n${content}${imageContext}${fileContext}${voiceContext}${snippetContext}`;
  const routedContent = attributedContent;
  const loadHistoryAndPersistUser = async () => {
    const [historyResult, replacedHistoryResult, matchingHistoryResult] =
      await Promise.all([
      admin
        .from("orchestrator_messages")
        .select("id,role,content")
        .eq("session_id", external.sessionId)
        .order("created_at", { ascending: false })
        .limit(100),
      resendSource
        ? admin
            .from("orchestrator_messages")
            .select("id")
            .eq("session_id", external.sessionId)
            .eq("role", "user")
            .contains("metadata", { chat_message_id: resendSource.id })
        : Promise.resolve({ data: [], error: null }),
      admin
        .from("orchestrator_messages")
        .select("id,role,content,trace_id")
        .eq("session_id", external.sessionId)
        .eq("role", "user")
        .contains("metadata", { chat_message_id: inserted.id })
        .order("created_at", { ascending: false })
        .limit(5),
    ]);
    const { data: priorRows, error: historyError } = historyResult;
    if (historyError) throw new Error(historyError.message);
    if (replacedHistoryResult.error) {
      throw new Error(replacedHistoryResult.error.message);
    }
    if (matchingHistoryResult.error) {
      throw new Error(matchingHistoryResult.error.message);
    }
    const replacedHistoryIds = (replacedHistoryResult.data || []).map((row) =>
      String(row.id),
    );
    const persistedMatch = (matchingHistoryResult.data || []).find(
      (row) =>
        !replacedHistoryIds.includes(String(row.id)) &&
        row.content === attributedContent,
    );
    const filteredPriorRows = (priorRows || []).filter(
      (row) =>
        !replacedHistoryIds.includes(String(row.id)) &&
        String(row.id) !== String(persistedMatch?.id || ""),
    );
    if (!persistedMatch) {
      const { data: persistedUser, error: persistenceError } = await admin
        .from("orchestrator_messages")
        .insert({
          session_id: external.sessionId,
          user_id: workspace.billing_admin_user_id,
          role: "user",
          content: attributedContent,
          trace_id: traceId,
          metadata: {
            provider: teamChatProvider,
            channel_id: id,
            chat_message_id: inserted.id,
            speaker_user_id: user.id,
            ...(threadRoot
              ? { thread_root_message_id: threadRoot.id }
              : {}),
            ...(attachments.length > 0
              ? {
                  attachments: attachments.map((attachment) => ({
                    kind: attachment.kind,
                    name: attachment.filename,
                    mimeType: attachment.mediaType,
                    sizeBytes: attachment.byteSize,
                  })),
                }
              : {}),
            ...(voiceNote
              ? {
                  voice_note: {
                    name: voiceNote.filename,
                    mimeType: voiceNote.mediaType,
                    sizeBytes: voiceNote.byteSize,
                    durationMs: voiceNote.durationMs,
                  },
                }
              : {}),
            ...(snippet
              ? {
                  snippet: {
                    title: snippet.title,
                    language: snippet.language,
                    sizeBytes: snippet.sizeBytes,
                  },
                }
              : {}),
          },
        })
        .select("id")
        .single();
      if (persistenceError || !persistedUser) {
        throw new Error(
          persistenceError?.message || "Could not save channel history",
        );
      }
    }
    if (replacedHistoryIds.length > 0) {
      const { error: replacedHistoryDeleteError } = await admin
        .from("orchestrator_messages")
        .delete()
        .in("id", replacedHistoryIds)
        .eq("session_id", external.sessionId)
        .eq("role", "user");
      if (replacedHistoryDeleteError) {
        console.warn("[team-chat] replaced_history_cleanup_failed", {
          channelId: id,
          messageId: inserted.id,
          error: replacedHistoryDeleteError.message,
        });
      }
    }
    return [
      ...filteredPriorRows.reverse(),
      { role: "user", content: routedContent },
    ];
  };
  if (!shouldReply) {
    await notifyHumanMessage();
    try {
      await loadHistoryAndPersistUser();
      return NextResponse.json({ message: inserted, orchestrator: null }, { status: 201 });
    } catch (error) {
      console.error("[team-chat] history_persistence_failed", {
        channelId: id,
        traceId,
        error: error instanceof Error ? error.message : String(error),
      });
      // The human message was already delivered to Team Chat. Return success
      // with a visible warning so the client does not restore the draft and
      // encourage a duplicate send.
      return NextResponse.json(
        {
          message: inserted,
          orchestrator: null,
          error: "Message delivered, but it could not be added to the orchestrator history.",
        },
        { status: 201 },
      );
    }
  }

  const mindWorkspace = workspace;
  const mindUser = user;
  const lock = await acquireTurnLock(admin, external.sessionId);
  if (!lock) {
    // Human chat delivery is independent of the current Mind turn. Mark this
    // message as a queued follow-up, but do not write it into shared Mind
    // history until this request owns the session lock. Persisting it early
    // lets the in-flight turn (including a scheduled channel run) absorb a
    // message that does not belong to that turn.
    await notifyHumanMessage();
    const queuedAt = new Date().toISOString();
    const queuedMetadata = {
      ...recordValue(inserted.metadata),
      mind_followup: {
        state: "pending",
        session_id: external.sessionId,
        trace_id: traceId,
        queued_at: queuedAt,
      } satisfies MindFollowupMetadata,
    };
    const { data: queuedMessage, error: queueError } = await admin
      .from("chat_messages")
      .update({ metadata: queuedMetadata })
      .eq("id", inserted.id)
      .eq("channel_id", id)
      .select("*")
      .single();
    if (queueError || !queuedMessage) {
      console.error("[team-chat] busy_turn_queue_failed", {
        channelId: id,
        traceId,
        messageId: inserted.id,
        error: queueError?.message || "queued message was not returned",
      });
      return NextResponse.json(
        {
          message: inserted,
          orchestrator: null,
          error:
            "Message delivered, but Groovy could not queue its Mind follow-up. Send another message to retry.",
        },
        { status: 201 },
      );
    }
    Object.assign(inserted, queuedMessage);
    after(async () => {
      let followupLock: Awaited<ReturnType<typeof acquireTurnLock>> = null;
      let executionOwnsLock = false;
      try {
        followupLock = await waitForQueuedMindTurnLock({
          admin,
          sessionId: external.sessionId,
          channelId: id,
          messageId: String(inserted.id),
        });
        if (!followupLock) {
          console.warn("[team-chat] queued_followup_wait_expired", {
            channelId: id,
            messageId: inserted.id,
            sessionId: external.sessionId,
          });
          const timeoutText =
            "Groovy could not start this queued Mind follow-up within six minutes because the previous task is still running. Your message is preserved—send a follow-up to retry it.";
          const { data: timeoutMessage, error: timeoutMessageError } = await admin
            .from("chat_messages")
            .insert({
              channel_id: id,
              author_type: "system",
              content: timeoutText,
              reply_to_message_id: inserted.id,
              thread_root_message_id: threadRoot?.id || null,
              metadata: {
                kind: "queued_mind_followup_timeout",
                queued_message_id: inserted.id,
                trace_id: traceId,
              },
            })
            .select("*")
            .maybeSingle();
          if (timeoutMessageError) {
            console.error("[team-chat] queued_followup_timeout_notice_failed", {
              channelId: id,
              messageId: inserted.id,
              error: timeoutMessageError.message,
            });
          } else if (timeoutMessage) {
            await sendTeamChatPush({
              admin,
              channelId: id,
              messageId: String(timeoutMessage.id),
              authorType: "system",
              authorLabel: "System",
              content: timeoutText,
              threadRootMessageId: threadRoot?.id || null,
            }).catch((cause) => {
              console.warn("[team-chat] queued follow-up timeout push failed", {
                channelId: id,
                error:
                  cause instanceof Error ? cause.message : "Unknown push error",
              });
            });
          }
          await completeQueuedMindFollowup({
            admin,
            channelId: id,
            messageId: String(inserted.id),
          });
          return;
        }

        const { data: queuedState, error: queuedStateError } = await admin
          .from("chat_messages")
          .select("metadata")
          .eq("id", inserted.id)
          .eq("channel_id", id)
          .maybeSingle();
        if (queuedStateError) throw new Error(queuedStateError.message);
        const followup = mindFollowupMetadata(queuedState?.metadata);
        if (
          !followup ||
          followup.state !== "pending" ||
          followup.session_id !== external.sessionId
        ) {
          return;
        }

        const { data: existingReply, error: existingReplyError } = await admin
          .from("chat_messages")
          .select("id")
          .eq("channel_id", id)
          .eq("reply_to_message_id", inserted.id)
          .in("author_type", ["orchestrator", "system"])
          .limit(1)
          .maybeSingle();
        if (existingReplyError) throw new Error(existingReplyError.message);
        if (existingReply?.id) {
          await completeQueuedMindFollowup({
            admin,
            channelId: id,
            messageId: String(inserted.id),
          });
          return;
        }

        executionOwnsLock = true;
        await executeMindTurn(followupLock);
        followupLock = null;
        await completeQueuedMindFollowup({
          admin,
          channelId: id,
          messageId: String(inserted.id),
        });
      } catch (error) {
        console.error("[team-chat] queued_followup_failed", {
          channelId: id,
          traceId,
          messageId: inserted.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (followupLock && !executionOwnsLock) {
          await followupLock.release().catch(() => undefined);
        }
      }
    });
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        notice:
          "Message delivered. Groovy will handle it immediately after the current task.",
        orchestratorBusy: true,
        orchestratorQueued: true,
      },
      { status: 201 },
    );
  }
  await notifyHumanMessage();
  // The human message and turn lock are durable at this point. Return the
  // receipt before starting model work so iOS/Android background suspension
  // cannot turn a successful send into a broken long-lived HTTP response.
  // Chat realtime plus the foreground control/message reconciliation path
  // deliver the eventual assistant result, just as they do for queued turns.
  after(async () => {
    try {
      await executeMindTurn(lock);
    } catch (error) {
      console.error("[team-chat] post_response_orchestrator_failed", {
        channelId: id,
        traceId,
        messageId: inserted.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return NextResponse.json(
    {
      message: inserted,
      orchestrator: null,
      orchestratorBusy: true,
    },
    { status: 201 },
  );

  async function executeMindTurn(
    turnLock: NonNullable<Awaited<ReturnType<typeof acquireTurnLock>>>,
  ) {
  let assistantChatMessageId: string | null = null;
  let runId: string | null = null;
  let activeTraceId = traceId;
  let controlPoll: ReturnType<typeof setInterval> | null = null;
  let controlPollBusy = false;
  let activeAbortController: AbortController | null = null;
  let requestedControl: RunControlRequest | null = null;
  let orchestratorProgress: OrchestratorProgress = {
    events: [],
    updatedAt: null,
  };
  let progressWrite = Promise.resolve();
  let progressMessageMetadata = recordValue(inserted.metadata);

  const recordOrchestratorProgress = (event: OrchestratorToolEvent) => {
    if (!runId) return;
    const next = appendOrchestratorProgressEvent(orchestratorProgress, event);
    if (next === orchestratorProgress) return;
    orchestratorProgress = next;
    const progressSnapshot = orchestratorProgress;
    const currentRunId = runId;
    progressWrite = progressWrite
      .then(async () => {
        progressMessageMetadata = {
          ...progressMessageMetadata,
          orchestrator_run_id: currentRunId,
          orchestrator_progress: progressSnapshot,
        };
        const { error } = await admin
          .from("chat_messages")
          .update({
            metadata: progressMessageMetadata,
          })
          .eq("id", inserted.id)
          .eq("channel_id", id);
        if (error) {
          console.warn("[team-chat] orchestrator_progress_write_failed", {
            channelId: id,
            runId: currentRunId,
            error: error.message,
          });
        }
      })
      .catch(() => undefined);
  };

  const stopControlMonitor = () => {
    if (controlPoll) clearInterval(controlPoll);
    controlPoll = null;
    controlPollBusy = false;
  };
  const startControlMonitor = (controller: AbortController) => {
    stopControlMonitor();
    requestedControl = null;
    const inspect = async () => {
      if (!runId || controlPollBusy || controller.signal.aborted) return;
      controlPollBusy = true;
      try {
        const { data: row } = await admin
          .from("chat_orchestrator_runs")
          .select("status,control_requested_by,redirect_content")
          .eq("id", runId)
          .maybeSingle();
        if (
          row?.status === "stop_requested" ||
          row?.status === "redirect_requested"
        ) {
          requestedControl = {
            status: row.status,
            requestedBy:
              typeof row.control_requested_by === "string"
                ? row.control_requested_by
                : null,
            direction:
              typeof row.redirect_content === "string"
                ? row.redirect_content.trim()
                : null,
          };
          controller.abort(new Error("team_chat_control_requested"));
        }
      } finally {
        controlPollBusy = false;
      }
    };
    void inspect();
    controlPoll = setInterval(() => {
      void inspect();
    }, 750);
  };

  const controlRequesterName = async (userId: string | null) => {
    if (!userId) return "A teammate";
    const { data } = await admin.auth.admin.getUserById(userId);
    const candidate =
      (typeof data.user?.user_metadata?.full_name === "string" &&
        data.user.user_metadata.full_name.trim()) ||
      (typeof data.user?.user_metadata?.name === "string" &&
        data.user.user_metadata.name.trim()) ||
      data.user?.email?.split("@")[0] ||
      "A teammate";
    return candidate.replace(/[\r\n]+/g, " ").slice(0, 100);
  };

  try {
    const priorRows = await loadHistoryAndPersistUser();
    const [{ data: owner }, connectorDeviceIds] = await Promise.all([
      admin.auth.admin.getUserById(
        mindWorkspace.billing_admin_user_id,
      ),
      resolveUserDeviceIds(
        admin,
        mindWorkspace.billing_admin_user_id,
      ),
    ]);
    const connectorDeviceId = connectorDeviceIds[0] || null;

    // A dead serverless invocation must not leave the channel permanently
    // blocked after both the turn lock and its documented maximum duration
    // have elapsed.
    await admin
      .from("chat_orchestrator_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("channel_id", id)
      .in("status", [
        "running",
        "stop_requested",
        "redirect_requested",
        "finalizing",
      ])
      .lt("updated_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());

    const { data: runRow, error: runInsertError } = await admin
      .from("chat_orchestrator_runs")
      .insert({
        channel_id: id,
        orchestrator_session_id: external.sessionId,
        profile_id: profile?.id || null,
        trace_id: traceId,
        status: "running",
        started_by: mindUser.id,
        thread_root_message_id: threadRoot?.id || null,
      })
      .select("id")
      .single();
    if (runInsertError || !runRow?.id) {
      throw new Error(
        runInsertError?.message || "Could not register the active channel run",
      );
    }
    runId = String(runRow.id);
    progressMessageMetadata = {
      ...recordValue(inserted.metadata),
      orchestrator_run_id: runId,
      orchestrator_progress: orchestratorProgress,
    };
    const { error: progressLinkError } = await admin
      .from("chat_messages")
      .update({ metadata: progressMessageMetadata })
      .eq("id", inserted.id)
      .eq("channel_id", id);
    if (progressLinkError) {
      console.warn("[team-chat] orchestrator_progress_link_failed", {
        channelId: id,
        runId,
        error: progressLinkError.message,
      });
    }

    let roundHistory: ModelMessage[] = messageHistory(priorRows || []);
    let roundMessage = routedContent;
    let replyTargetMessageId = String(inserted.id);
    let result: Awaited<ReturnType<typeof runOrchestratorRound>> | null = null;
    let redirectsHandled = 0;
    // Keep connector work inside the route's 800-second budget, including
    // model continuations and any user redirect.
    const connectorDeadlineAtMs = Date.now() + 9 * 60 * 1000;

    for (;;) {
      const controller = new AbortController();
      activeAbortController = controller;
      startControlMonitor(controller);
      try {
        const preferDirectLocalDiagnostic =
          shouldUseDirectLocalCliForDiagnostic({
            message: roundMessage,
            workerNames: (agents || []).map((agent) =>
              String(agent.name || ""),
            ),
          });
        const runMindRound = (continuation?: {
          history: ModelMessage[];
          toolResults: TeamChatConnectorToolResult[];
          traceId: string;
        }) =>
          runOrchestratorRound({
            supabase: admin,
            userId: mindWorkspace.billing_admin_user_id,
            usageActorUserId: currentSpeakerUserId,
            userEmail: owner.user?.email || null,
            history: continuation?.history || roundHistory,
            message: continuation ? "" : roundMessage,
            toolResults: continuation?.toolResults,
            files:
              inlineImages.length > 0
                ? inlineImages.map((image) => ({
                    mediaType: image.mediaType,
                    base64: image.base64,
                    filename: image.filename,
                  }))
                : undefined,
            orchestratorSessionId: external.sessionId,
            profile,
            sourceProvider: teamChatProvider,
            preferDirectLocalDiagnostic,
            memoryScopeId: channelHasGuests ? id : undefined,
            additionalSkillArtifactIds: channelSkillArtifactIds,
            skillWorkspaceId: channel.workspace_id,
            channelSkillManagement: canManageCurrentChannelSkills
              ? {
                  workspaceId: channel.workspace_id,
                  channelId: id,
                  actorUserId: currentSpeakerUserId,
                  canCreateSkills:
                    channelRoleByUserId.get(currentSpeakerUserId) === "admin",
                }
              : null,
            channelScheduleManagement: canManageCurrentChannelSchedules
              ? {
                  workspaceId: channel.workspace_id,
                  channelId: id,
                  actorUserId: currentSpeakerUserId,
                }
              : null,
            workspaceAssignmentManagement: canManageWorkspaceAssignments
              ? {
                  workspaceId: channel.workspace_id,
                  actorUserId: currentSpeakerUserId,
                }
              : null,
            channelInstructions: channel.orchestrator_instructions,
            channelParticipantContext,
            deviceId: connectorDeviceId,
            traceId: continuation?.traceId || activeTraceId,
            abortController: controller,
            taskRequestedChannel: `team_chat:${id}`,
            taskThreadRootMessageId: threadRoot?.id || null,
            allowedAgentIds: uniqueAgentIds,
            agentRosterMode: "replace",
            localTimezone: localTimezone || undefined,
            onToolEvent: recordOrchestratorProgress,
          });

        const initialResult = await runMindRound();
        result = connectorDeviceId
          ? await completeTeamChatConnectorRoundTrips({
              initialResult,
              initialHistory: roundHistory,
              deadlineAtMs: connectorDeadlineAtMs,
              execute: async (execute, timeoutMs) => {
                recordOrchestratorProgress({
                  phase: "start",
                  toolName: execute.toolName,
                });
                try {
                  let connectorResult: Record<string, unknown> | null = null;
                  let lastConnectorError: unknown = null;
                  for (const candidateDeviceId of connectorDeviceIds) {
                    try {
                      connectorResult = await callConnectorRpcViaRelay({
                        userId: mindWorkspace.billing_admin_user_id,
                        deviceId: candidateDeviceId,
                        rpcType: execute.connectorType,
                        payload: execute.connectorParams,
                        timeoutMs,
                      });
                      break;
                    } catch (error) {
                      lastConnectorError = error;
                      if (!(error instanceof Error) || error.message !== "device_not_online") {
                        throw error;
                      }
                    }
                  }
                  if (!connectorResult) {
                    throw lastConnectorError || new Error("device_not_online");
                  }
                  recordOrchestratorProgress({
                    phase: "end",
                    toolName: execute.toolName,
                    success: connectorResult.ok === true,
                  });
                  return connectorResult;
                } catch (error) {
                  recordOrchestratorProgress({
                    phase: "end",
                    toolName: execute.toolName,
                    success: false,
                  });
                  console.warn("[team-chat] connector_rpc_failed", {
                    channelId: id,
                    traceId: activeTraceId,
                    toolName: execute.toolName,
                    connectorType: execute.connectorType,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                  throw error;
                }
              },
              continueRound: runMindRound,
            })
          : initialResult;
        stopControlMonitor();
        await progressWrite;
        const { data: finalizing, error: finalizingError } = await admin
          .from("chat_orchestrator_runs")
          .update({
            status: "finalizing",
            updated_at: new Date().toISOString(),
          })
          .eq("id", runId)
          .eq("status", "running")
          .select("id")
          .maybeSingle();
        if (finalizingError) throw new Error(finalizingError.message);
        if (!finalizing) {
          const { data: pending } = await admin
            .from("chat_orchestrator_runs")
            .select("status,control_requested_by,redirect_content")
            .eq("id", runId)
            .maybeSingle();
          if (
            pending?.status === "stop_requested" ||
            pending?.status === "redirect_requested"
          ) {
            requestedControl = {
              status: pending.status,
              requestedBy:
                typeof pending.control_requested_by === "string"
                  ? pending.control_requested_by
                  : null,
              direction:
                typeof pending.redirect_content === "string"
                  ? pending.redirect_content.trim()
                  : null,
            };
            controller.abort(new Error("team_chat_control_requested"));
            throw new Error("team_chat_control_requested");
          }
          throw new Error("The channel run changed state before completion");
        }
        break;
      } catch (error) {
        stopControlMonitor();
        const control = requestedControl as RunControlRequest | null;
        if (!controller.signal.aborted || !control) throw error;

        const requestedByName = await controlRequesterName(control.requestedBy);
        if (
          control.status === "stop_requested" ||
          !control.direction ||
          redirectsHandled >= 8
        ) {
          const stoppedText =
            redirectsHandled >= 8
              ? "The orchestrator was stopped after too many consecutive redirects."
              : `${requestedByName} stopped the orchestrator.`;
          const { data: stoppedMessage } = await admin
            .from("chat_messages")
            .insert({
              channel_id: id,
              author_type: "system",
              content: stoppedText,
              reply_to_message_id: replyTargetMessageId,
              thread_root_message_id: threadRoot?.id || null,
              metadata: {
                kind: "work_control",
                action: "stop",
                target: "orchestrator",
                trace_id: activeTraceId,
                run_id: runId,
                controlled_by: control.requestedBy,
              },
            })
            .select("*")
            .single();
          if (stoppedMessage) {
            await sendTeamChatPush({
              admin,
              channelId: id,
              messageId: String(stoppedMessage.id),
              authorType: "system",
              authorUserId: control.requestedBy,
              authorLabel: "System",
              content: stoppedText,
              threadRootMessageId: threadRoot?.id || null,
            }).catch((cause) => {
              console.warn("[team-chat] control push delivery failed", {
                channelId: id,
                error:
                  cause instanceof Error ? cause.message : "Unknown push error",
              });
            });
          }
          await admin
            .from("chat_orchestrator_runs")
            .update({
              status: "stopped",
              finished_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", runId);
          return NextResponse.json(
            {
              message: inserted,
              orchestrator: stoppedMessage || null,
              controlled: { action: "stop", runId },
            },
            { status: 201 },
          );
        }

        redirectsHandled += 1;
        const direction = control.direction;
        const redirectAttributed = `[Redirect from: ${requestedByName}]\n${direction}`;
        roundMessage = redirectAttributed;
        roundHistory = [
          ...roundHistory,
          { role: "user", content: roundMessage },
        ];
        activeTraceId = randomUUID();

        const { data: redirectMessage, error: redirectMessageError } = await admin
          .from("chat_messages")
          .insert({
            channel_id: id,
            author_type: "user",
            author_user_id: control.requestedBy,
            content: direction,
            reply_to_message_id: replyTargetMessageId,
            thread_root_message_id: threadRoot?.id || null,
            metadata: {
              kind: "work_control",
              action: "redirect",
              target: "orchestrator",
              prior_trace_id: traceId,
              trace_id: activeTraceId,
              run_id: runId,
            },
          })
          .select("*")
          .single();
        if (redirectMessageError || !redirectMessage) {
          throw new Error(
            redirectMessageError?.message || "Could not save the redirect",
          );
        }
        await sendTeamChatPush({
          admin,
          channelId: id,
          messageId: String(redirectMessage.id),
          authorType: "user",
          authorUserId: control.requestedBy,
          authorLabel: requestedByName,
          content: direction,
          threadRootMessageId: threadRoot?.id || null,
        }).catch((cause) => {
          console.warn("[team-chat] redirect push delivery failed", {
            channelId: id,
            error:
              cause instanceof Error ? cause.message : "Unknown push error",
          });
        });
        replyTargetMessageId = String(redirectMessage.id);
        const { error: redirectHistoryError } = await admin
          .from("orchestrator_messages")
          .insert({
            session_id: external.sessionId,
            user_id: mindWorkspace.billing_admin_user_id,
            role: "user",
            content: redirectAttributed,
            trace_id: activeTraceId,
            metadata: {
              provider: teamChatProvider,
              channel_id: id,
              chat_message_id: redirectMessage.id,
              speaker_user_id: control.requestedBy,
              kind: "work_control_redirect",
            },
          });
        if (redirectHistoryError) throw new Error(redirectHistoryError.message);
        const { error: resumeError } = await admin
          .from("chat_orchestrator_runs")
          .update({
            status: "running",
            trace_id: activeTraceId,
            redirect_content: null,
            control_requested_by: null,
            control_requested_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", runId);
        if (resumeError) throw new Error(resumeError.message);
      }
    }

    if (!result) throw new Error("The channel orchestrator returned no result");
    const { data: delegatedTasks, error: delegatedTasksError } = await admin
      .from("agent_tasks")
      .select("id,status")
      .eq("user_id", mindWorkspace.billing_admin_user_id)
      .eq("orchestrator_session_id", external.sessionId)
      .eq("source", "orchestrator")
      .eq("requested_channel", `team_chat:${id}`)
      .eq("trace_id", activeTraceId)
      .limit(50);
    if (delegatedTasksError) throw new Error(delegatedTasksError.message);
    const roundDelegatedTasks = (delegatedTasks || []) as Array<{
      id: string;
      status: AgentTaskRow["status"];
    }>;
    if (shouldDeferAgentTaskFinal(roundDelegatedTasks)) {
      const { error: completedRunError } = await admin
        .from("chat_orchestrator_runs")
        .update({
          status: "completed",
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", runId)
        .eq("status", "finalizing");
      if (completedRunError) throw new Error(completedRunError.message);
      return NextResponse.json(
        {
          message: inserted,
          orchestrator: null,
          delegatedTaskIds: roundDelegatedTasks.map((task) => task.id),
          orchestratorWaitingForAgents: true,
        },
        { status: 201 },
      );
    }
    const rawText = resolveChatRoundText(result);
    const text = channelHasGuests
      ? filterExternalHarnessOutput(rawText)
      : rawText;
    const scheduledTasksChanged = chatRoundChangesScheduledTasks(result);
    const { data: assistant, error: assistantError } = await admin
      .from("chat_messages")
      .insert({
        channel_id: id,
        author_type: "orchestrator",
        profile_id: profile?.id || null,
        content: text,
        reply_to_message_id: replyTargetMessageId,
        thread_root_message_id: threadRoot?.id || null,
        metadata: {
          trace_id: activeTraceId,
          run_id: runId,
          orchestrator_session_id: external.sessionId,
          ...(scheduledTasksChanged ? { scheduled_tasks_changed: true } : {}),
        },
      })
      .select("*")
      .single();
    if (assistantError) throw new Error(assistantError.message);
    assistantChatMessageId = String(assistant.id);
    const { error: assistantHistoryError } = await admin.from("orchestrator_messages").insert({
      session_id: external.sessionId,
      user_id: mindWorkspace.billing_admin_user_id,
      role: "assistant",
      content: text,
      trace_id: activeTraceId,
      metadata: {
        provider: teamChatProvider,
        channel_id: id,
        chat_message_id: assistant.id,
      },
    });
    if (assistantHistoryError) throw new Error(assistantHistoryError.message);
    await sendTeamChatPush({
      admin,
      channelId: id,
      messageId: String(assistant.id),
      authorType: "orchestrator",
      authorLabel: profile?.name || "Groovy",
      content: text,
      threadRootMessageId: threadRoot?.id || null,
    }).catch((cause) => {
      console.warn("[team-chat] orchestrator push delivery failed", {
        channelId: id,
        error: cause instanceof Error ? cause.message : "Unknown push error",
      });
    });
    await admin
      .from("chat_orchestrator_runs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .eq("status", "finalizing");
    return NextResponse.json(
      { message: inserted, orchestrator: assistant, scheduledTasksChanged },
      { status: 201 },
    );
  } catch (error) {
    stopControlMonitor();
    if (runId) {
      await admin
        .from("chat_orchestrator_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", runId)
        .in("status", [
          "running",
          "stop_requested",
          "redirect_requested",
          "finalizing",
        ]);
    }
    if (assistantChatMessageId) {
      await admin
        .from("chat_messages")
        .delete()
        .eq("id", assistantChatMessageId)
        .eq("channel_id", id);
    }
    // If the assistant history write succeeded but the UI write became
    // ambiguous, remove only this turn's assistant record. Preserve the human
    // message and its brain-history record: chat delivery already succeeded.
    await admin
      .from("orchestrator_messages")
      .delete()
      .eq("session_id", external.sessionId)
      .eq("trace_id", activeTraceId)
      .eq("role", "assistant");
    const failureText =
      "Groovy couldn't complete this turn after automatic model recovery. " +
      "Your message is preserved—send a follow-up to retry or redirect the current work.";
    const failureCode =
      error instanceof Error && error.name
        ? error.name.slice(0, 80)
        : "OrchestratorTurnError";
    const { data: failureMessage } = await admin
      .from("chat_messages")
      .insert({
        channel_id: id,
        author_type: "system",
        content: failureText,
        reply_to_message_id: inserted.id,
        thread_root_message_id: threadRoot?.id || null,
        metadata: {
          trace_id: activeTraceId,
          run_id: runId,
          orchestrator_error: true,
          orchestrator_error_code: failureCode,
          message_preserved: true,
        },
      })
      .select("*")
      .maybeSingle();
    if (failureMessage) {
      await sendTeamChatPush({
        admin,
        channelId: id,
        messageId: String(failureMessage.id),
        authorType: "system",
        authorLabel: "System",
        content: failureText,
        threadRootMessageId: threadRoot?.id || null,
      }).catch((cause) => {
        console.warn("[team-chat] failure push delivery failed", {
          channelId: id,
          error:
            cause instanceof Error ? cause.message : "Unknown push error",
        });
      });
    }
    console.error("[team-chat] orchestrator_turn_failed", {
      channelId: id,
      traceId: activeTraceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: failureMessage || null,
        error: failureText,
      },
      { status: 201 },
    );
  } finally {
    stopControlMonitor();
    if (activeAbortController && !activeAbortController.signal.aborted) {
      activeAbortController.abort();
    }
    await turnLock.release();
  }
  }
}
