import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveHarnessProfile } from "@/lib/orchestrator/harnessProfiles";
import { runOrchestratorRound } from "@/lib/orchestrator/runOrchestratorRound";
import { filterExternalHarnessOutput } from "@/lib/publicApi/outputFilter";
import { sendTeamChatPush } from "@/lib/notifications/webPush";
import {
  buildChatImageStoragePath,
  CHAT_IMAGE_BUCKET,
  ChatImageValidationError,
  imageOnlyMessage,
  publicChatImageAttachment,
  validateChatImages,
} from "@/lib/chat/channelImages";
import {
  acquireTurnLock,
  getOrCreateExternalSession,
  shouldRunChannelOrchestrator,
  type ChatChannelRow,
} from "@/lib/teamChat";
import {
  createAgentTask,
  kickAgentTask,
} from "@/lib/orchestrator/agentTasks";
import { resolveChatRoundText } from "@/lib/chat/orchestratorResponse";
import { getProductAccessForUser } from "@/lib/licensing/access";
import { channelAgentIds } from "@/lib/chat/channelAgentRoster";
import { buildChannelParticipantContext } from "@/lib/chat/channelParticipants";
import {
  GUEST_SAFE_MIND_REQUIREMENT,
  isGuestSafeMind,
} from "@/lib/chat/guestMind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;
type Params = { params: Promise<{ id: string }> };
type RunControlRequest = {
  status: "stop_requested" | "redirect_requested";
  requestedBy: string | null;
  direction: string | null;
};

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

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("channel_id", id)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ messages: [...(data || [])].reverse() });
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const rawClientMessageId = body?.clientMessageId;
  const clientMessageId =
    typeof rawClientMessageId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      rawClientMessageId,
    )
      ? rawClientMessageId
      : null;
  if (rawClientMessageId !== undefined && !clientMessageId) {
    return NextResponse.json(
      { error: "clientMessageId must be a UUID" },
      { status: 400 },
    );
  }
  let inlineImages: ReturnType<typeof validateChatImages>;
  try {
    inlineImages = validateChatImages(body?.files);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof ChatImageValidationError
            ? error.message
            : "Could not validate the attached images.",
      },
      { status: 400 },
    );
  }
  const typedContent =
    typeof body?.content === "string" ? body.content.trim() : "";
  if ((!typedContent && inlineImages.length === 0) || typedContent.length > 40000) {
    return NextResponse.json(
      { error: "Add a message or up to 3 images (40,000 characters maximum)." },
      { status: 400 },
    );
  }
  const content =
    typedContent || imageOnlyMessage(inlineImages.length);
  const replyTo =
    typeof body?.replyToMessageId === "string" && body.replyToMessageId
      ? body.replyToMessageId
      : null;

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
  if (inlineImages.length > 0) {
    if (channel.kind !== "channel" || channel.orchestrator_mode === "off") {
      return NextResponse.json(
        {
          error:
            "Images can be shared in channels where the orchestrator is available.",
        },
        { status: 409 },
      );
    }
    const { data: orchestratorMember, error: orchestratorMemberError } =
      await supabase
        .from("chat_channel_members")
        .select("id")
        .eq("channel_id", id)
        .eq("member_type", "orchestrator")
        .maybeSingle();
    if (orchestratorMemberError) {
      return NextResponse.json(
        { error: "Could not verify the channel orchestrator." },
        { status: 500 },
      );
    }
    if (!orchestratorMember) {
      return NextResponse.json(
        {
          error:
            "Add the orchestrator to this channel before sharing images.",
        },
        { status: 409 },
      );
    }
  }

  if (replyTo) {
    const { data: replyTarget, error: replyError } = await supabase
      .from("chat_messages")
      .select("id")
      .eq("id", replyTo)
      .eq("channel_id", id)
      .maybeSingle();
    if (replyError) {
      return NextResponse.json({ error: replyError.message }, { status: 500 });
    }
    if (!replyTarget) {
      return NextResponse.json(
        { error: "replyToMessageId must belong to this channel" },
        { status: 400 },
      );
    }
  }

  const admin = createSupabaseAdminClient();
  if (inlineImages.length > 0) {
    const { error: imageSchemaError } = await admin
      .from("chat_message_attachments")
      .select("id")
      .limit(1);
    if (imageSchemaError) {
      return NextResponse.json(
        {
          error:
            "Channel images are ready in the app but need the latest database migration before they can be sent.",
        },
        { status: 503 },
      );
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from("chat_messages")
    .insert({
      channel_id: id,
      author_type: "user",
      author_user_id: user.id,
      content,
      reply_to_message_id: replyTo,
      metadata: clientMessageId
        ? { client_message_id: clientMessageId }
        : {},
    })
    .select("*")
    .single();
  if (insertError) {
    return NextResponse.json(
      { error: insertError.message },
      { status: insertError.code === "42501" ? 403 : 500 },
    );
  }

  const uploadedImagePaths: string[] = [];
  const cleanupMessageAndImages = async () => {
    if (uploadedImagePaths.length > 0) {
      await admin.storage.from(CHAT_IMAGE_BUCKET).remove(uploadedImagePaths);
    }
    await admin
      .from("chat_messages")
      .delete()
      .eq("id", inserted.id)
      .eq("channel_id", id)
      .eq("author_user_id", user.id);
  };
  if (inlineImages.length > 0) {
    try {
      const uploaded = [];
      for (const [position, image] of inlineImages.entries()) {
        const storagePath = buildChatImageStoragePath({
          uploaderId: user.id,
          channelId: id,
          mediaType: image.mediaType,
        });
        const { error: uploadError } = await admin.storage
          .from(CHAT_IMAGE_BUCKET)
          .upload(storagePath, image.bytes, {
            contentType: image.mediaType,
            cacheControl: "3600",
            upsert: false,
          });
        if (uploadError) throw new Error(uploadError.message);
        uploadedImagePaths.push(storagePath);
        uploaded.push({
          channel_id: id,
          message_id: inserted.id,
          uploaded_by: user.id,
          storage_path: storagePath,
          file_name: image.filename,
          mime_type: image.mediaType,
          size_bytes: image.byteSize,
          position,
        });
      }
      const { data: attachmentRows, error: attachmentError } = await admin
        .from("chat_message_attachments")
        .insert(uploaded)
        .select("id,storage_path,file_name,mime_type,size_bytes");
      if (attachmentError || !attachmentRows) {
        throw new Error(
          attachmentError?.message || "Could not save image attachments",
        );
      }
      const attachmentByPath = new Map(
        attachmentRows.map((attachment) => [
          String(attachment.storage_path),
          attachment,
        ]),
      );
      const attachments = uploaded.map((upload) => {
        const attachment = attachmentByPath.get(upload.storage_path);
        if (!attachment) throw new Error("Could not resolve an uploaded image");
        return publicChatImageAttachment(attachment);
      });
      const metadata = {
        ...(clientMessageId
          ? { client_message_id: clientMessageId }
          : {}),
        attachments,
        image_only: !typedContent,
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
          metadataError?.message || "Could not attach images to the message",
        );
      }
      inserted.metadata = updatedMessage.metadata;
    } catch (error) {
      await cleanupMessageAndImages();
      console.error("[team-chat] image_upload_failed", {
        channelId: id,
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: "Could not securely attach those images. Please try again." },
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
      });
    } catch (cause) {
      console.warn("[team-chat] human push delivery failed", {
        channelId: id,
        messageId: inserted.id,
        error: cause instanceof Error ? cause.message : "Unknown push error",
      });
    }
  };
  const { data: workspace, error: workspaceError } = await admin
    .from("workspaces")
    .select("id,name,billing_admin_user_id")
    .eq("id", channel.workspace_id)
    .maybeSingle();
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
  const { data: channelMembers, error: channelMembersError } = await admin
    .from("chat_channel_members")
    .select("member_type,user_id,agent_id")
    .eq("channel_id", id)
    .in("member_type", ["user", "agent"]);
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
  const uniqueAgentIds = channelAgentIds(channelMembers || []);
  const channelUserIds = (channelMembers || [])
    .filter((member) => member.member_type === "user")
    .map((member) => (typeof member.user_id === "string" ? member.user_id : ""))
    .filter(Boolean);
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

  const directDmAgent =
    channel.kind === "dm" &&
    uniqueAgentIds.length === 1 &&
    (agents || []).length === 1
      ? agents?.[0]
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
      await cleanupMessageAndImages();
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
        context: `Direct message from ${speaker} in ${channel.name}.`,
        requestedChannel: `team_chat:${id}`,
        notify: { dashboard: true },
        source: "api",
        traceId,
        turnId: traceId,
      });
      kickAgentTask({
        taskId: task.id,
        userId: workspace.billing_admin_user_id,
        baseUrl: new URL(req.url).origin,
      });
      return NextResponse.json(
        {
          message: inserted,
          orchestrator: null,
          agentTask: {
            id: task.id,
            status: task.status,
            title: task.title || "Agent task",
            agentId: String(directDmAgent.id),
            agentName: String(directDmAgent.name || "Agent"),
            traceId,
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
    await cleanupMessageAndImages();
    return NextResponse.json(
      {
        orchestrator: null,
        error: "This channel's bound profile is unavailable. Ask a workspace admin to rebind it.",
      },
      { status: 409 },
    );
  }
  const { data: channelWorkspaceMembers, error: guestMemberError } =
    channelUserIds.length > 0
      ? await admin
          .from("workspace_members")
          .select("user_id,role")
          .eq("workspace_id", channel.workspace_id)
          .in("user_id", channelUserIds)
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
      await cleanupMessageAndImages();
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
  const requestedOrchestratorReply =
    inlineImages.length > 0 ||
    shouldRunChannelOrchestrator({
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
    shouldReply && !channelHasGuests
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
  const attributedContent = `[From: ${speaker}]\n${content}${imageContext}`;
  const routedContent = attributedContent;
  const loadHistoryAndPersistUser = async () => {
    const { data: priorRows, error: historyError } = await admin
      .from("orchestrator_messages")
      .select("role,content")
      .eq("session_id", external.sessionId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (historyError) throw new Error(historyError.message);
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
          ...(inlineImages.length > 0
            ? {
                attachments: inlineImages.map((image) => ({
                  name: image.filename,
                  mimeType: image.mediaType,
                  sizeBytes: image.byteSize,
                })),
              }
            : {}),
        },
      })
      .select("id")
      .single();
    if (persistenceError || !persistedUser) {
      throw new Error(persistenceError?.message || "Could not save channel history");
    }
    return [
      ...(priorRows || []).reverse(),
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

  const lock = await acquireTurnLock(admin, external.sessionId);
  if (!lock) {
    await cleanupMessageAndImages();
    return NextResponse.json(
      {
        orchestrator: null,
        error: "The channel orchestrator is already handling another message. Try again shortly.",
      },
      { status: 409 },
    );
  }
  await notifyHumanMessage();

  let assistantChatMessageId: string | null = null;
  let runId: string | null = null;
  let activeTraceId = traceId;
  let controlPoll: ReturnType<typeof setInterval> | null = null;
  let controlPollBusy = false;
  let activeAbortController: AbortController | null = null;
  let requestedControl: RunControlRequest | null = null;

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
    const { data: owner } = await admin.auth.admin.getUserById(
      workspace.billing_admin_user_id,
    );

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
        started_by: user.id,
      })
      .select("id")
      .single();
    if (runInsertError || !runRow?.id) {
      throw new Error(
        runInsertError?.message || "Could not register the active channel run",
      );
    }
    runId = String(runRow.id);

    let roundHistory: ModelMessage[] = messageHistory(priorRows || []);
    let roundMessage = routedContent;
    let replyTargetMessageId = String(inserted.id);
    let result: Awaited<ReturnType<typeof runOrchestratorRound>> | null = null;
    let redirectsHandled = 0;

    for (;;) {
      const controller = new AbortController();
      activeAbortController = controller;
      startControlMonitor(controller);
      try {
        result = await runOrchestratorRound({
          supabase: admin,
          userId: workspace.billing_admin_user_id,
          userEmail: owner.user?.email || null,
          history: roundHistory,
          message: roundMessage,
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
          memoryScopeId: channelHasGuests ? id : undefined,
          additionalSkillArtifactIds: channelSkillArtifactIds,
          channelInstructions: channel.orchestrator_instructions,
          channelParticipantContext,
          deviceId: null,
          traceId: activeTraceId,
          abortController: controller,
          taskRequestedChannel: `team_chat:${id}`,
          allowedAgentIds: uniqueAgentIds,
          agentRosterMode: "replace",
        });
        stopControlMonitor();
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
            user_id: workspace.billing_admin_user_id,
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
    const rawText = resolveChatRoundText(result);
    const text = channelHasGuests
      ? filterExternalHarnessOutput(rawText)
      : rawText;
    const { data: assistant, error: assistantError } = await admin
      .from("chat_messages")
      .insert({
        channel_id: id,
        author_type: "orchestrator",
        profile_id: profile?.id || null,
        content: text,
        reply_to_message_id: replyTargetMessageId,
        metadata: {
          trace_id: activeTraceId,
          run_id: runId,
          orchestrator_session_id: external.sessionId,
        },
      })
      .select("*")
      .single();
    if (assistantError) throw new Error(assistantError.message);
    assistantChatMessageId = String(assistant.id);
    const { error: assistantHistoryError } = await admin.from("orchestrator_messages").insert({
      session_id: external.sessionId,
      user_id: workspace.billing_admin_user_id,
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
      { message: inserted, orchestrator: assistant },
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
    const failureText = "The orchestrator could not complete this turn. Please try again.";
    const { data: failureMessage } = await admin
      .from("chat_messages")
      .insert({
        channel_id: id,
        author_type: "system",
        content: failureText,
        reply_to_message_id: inserted.id,
        metadata: {
          trace_id: activeTraceId,
          run_id: runId,
          orchestrator_error: true,
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
    await lock.release();
  }
}
