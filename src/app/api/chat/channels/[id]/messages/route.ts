import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveHarnessProfile } from "@/lib/orchestrator/harnessProfiles";
import { runOrchestratorRound } from "@/lib/orchestrator/runOrchestratorRound";
import { filterExternalHarnessOutput } from "@/lib/publicApi/outputFilter";
import {
  acquireTurnLock,
  getOrCreateExternalSession,
  shouldRunChannelOrchestrator,
  type ChatChannelRow,
} from "@/lib/teamChat";

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
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  if (!content || content.length > 40000) {
    return NextResponse.json({ error: "content must be 1-40000 characters" }, { status: 400 });
  }
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

  const { data: inserted, error: insertError } = await supabase
    .from("chat_messages")
    .insert({
      channel_id: id,
      author_type: "user",
      author_user_id: user.id,
      content,
      reply_to_message_id: replyTo,
      metadata: {},
    })
    .select("*")
    .single();
  if (insertError) {
    return NextResponse.json(
      { error: insertError.message },
      { status: insertError.code === "42501" ? 403 : 500 },
    );
  }

  const admin = createSupabaseAdminClient();
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
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        error: "Message delivered, but the channel orchestrator is not configured.",
      },
      { status: 201 },
    );
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
    await admin
      .from("chat_messages")
      .delete()
      .eq("id", inserted.id)
      .eq("channel_id", id)
      .eq("author_user_id", user.id);
    return NextResponse.json(
      {
        orchestrator: null,
        error: "This channel's bound profile is unavailable. Ask a workspace admin to rebind it.",
      },
      { status: 409 },
    );
  }
  const { data: channelMembers, error: channelMembersError } = await admin
    .from("chat_channel_members")
    .select("member_type,user_id,agent_id")
    .eq("channel_id", id)
    .in("member_type", ["user", "agent"]);
  if (channelMembersError) {
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        error: "Message delivered, but channel members could not be resolved.",
      },
      { status: 201 },
    );
  }
  const agentIds = (channelMembers || [])
    .filter((member) => member.member_type === "agent")
    .map((member) => (typeof member.agent_id === "string" ? member.agent_id : ""))
    .filter(Boolean);
  const channelUserIds = (channelMembers || [])
    .filter((member) => member.member_type === "user")
    .map((member) => (typeof member.user_id === "string" ? member.user_id : ""))
    .filter(Boolean);
  const { count: guestMemberCount, error: guestMemberError } =
    channelUserIds.length > 0
      ? await admin
          .from("workspace_members")
          .select("user_id", { count: "exact", head: true })
          .eq("workspace_id", channel.workspace_id)
          .eq("role", "guest")
          .in("user_id", channelUserIds)
      : { count: 0, error: null };
  if (guestMemberError) {
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        error: "Message delivered, but channel access could not be resolved.",
      },
      { status: 201 },
    );
  }
  const channelHasGuests = Number(guestMemberCount || 0) > 0;
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
      await admin
        .from("chat_messages")
        .delete()
        .eq("id", inserted.id)
        .eq("channel_id", id)
        .eq("author_user_id", user.id);
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
  const { data: agents, error: agentsError } = agentIds.length
    ? await admin.from("agents").select("id,name").in("id", agentIds)
    : { data: [], error: null };
  if (agentsError) {
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        error: "Message delivered, but channel agents could not be resolved.",
      },
      { status: 201 },
    );
  }
  const requestedOrchestratorReply = shouldRunChannelOrchestrator({
    content,
    channel,
    profileName: profile?.name,
    profileSlug: profile?.slug,
    agentNames: (agents || []).map((agent) => String(agent.name || "")),
  });
  const guestSafeProfile =
    Boolean(channel.profile_id) &&
    profile?.surface === "external" &&
    profile.authorizationStance === "restricted" &&
    profile.memoryScope === "profile";
  if (channelHasGuests && !guestSafeProfile) {
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        ...(requestedOrchestratorReply
          ? {
              error:
                "Message delivered. This channel contains guests, so an admin must bind an external, restricted Mind before the orchestrator can reply.",
            }
          : {}),
      },
      { status: 201 },
    );
  }
  const shouldReply = requestedOrchestratorReply;
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
    return NextResponse.json(
      {
        message: inserted,
        orchestrator: null,
        error: "Message delivered, but the shared orchestrator session is unavailable.",
      },
      { status: 201 },
    );
  }
  const speaker =
    (
      (typeof user.user_metadata?.full_name === "string" &&
        user.user_metadata.full_name.trim()) ||
      (typeof user.user_metadata?.name === "string" && user.user_metadata.name.trim()) ||
      user.email ||
      "Workspace member"
    )
      .replace(/[\r\n[\]]+/g, " ")
      .trim()
      .slice(0, 300) || "Workspace member";
  const attributedContent = `[From: ${speaker}]\n${content}`;
  const directDmAgent =
    channel.kind === "dm" && (agents || []).length === 1
      ? String(agents?.[0]?.name || "").trim()
      : "";
  const routedContent = directDmAgent
    ? `[From: ${speaker}]\n@${directDmAgent.replace(/\s+/g, "")} ${content}`
    : attributedContent;
  const traceId = randomUUID();
  const loadHistoryAndPersistUser = async () => {
    const { data: priorRows, error: historyError } = await admin
      .from("orchestrator_messages")
      .select("role,content")
      .eq("session_id", external.sessionId)
      .contains("metadata", {
        provider: teamChatProvider,
        channel_id: id,
      })
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
        },
      })
      .select("id")
      .single();
    if (persistenceError || !persistedUser) {
      throw new Error(persistenceError?.message || "Could not save channel history");
    }
    return [...(priorRows || [])].reverse();
  };

  if (!shouldReply) {
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
    await admin
      .from("chat_messages")
      .delete()
      .eq("id", inserted.id)
      .eq("channel_id", id)
      .eq("author_user_id", user.id);
    return NextResponse.json(
      {
        orchestrator: null,
        error: "The channel orchestrator is already handling another message. Try again shortly.",
      },
      { status: 409 },
    );
  }

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
          orchestratorSessionId: external.sessionId,
          profile,
          sourceProvider: teamChatProvider,
          memoryScopeId: channelHasGuests ? id : undefined,
          additionalSkillArtifactIds: channelSkillArtifactIds,
          deviceId: null,
          traceId: activeTraceId,
          abortController: controller,
          taskRequestedChannel: `team_chat:${id}`,
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
        roundHistory = [
          ...roundHistory,
          { role: "user", content: roundMessage },
        ];
        const direction = control.direction;
        const redirectAttributed = `[Redirect from: ${requestedByName}]\n${direction}`;
        roundMessage = directDmAgent
          ? `[Redirect from: ${requestedByName}]\n@${directDmAgent.replace(/\s+/g, "")} ${direction}`
          : redirectAttributed;
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
    const rawText =
      result.kind === "final"
        ? result.text.trim()
        : "This channel turn could not be completed without a local connector.";
    const text = channelHasGuests
      ? filterExternalHarnessOutput(rawText)
      : rawText;
    const { data: assistant, error: assistantError } = await admin
      .from("chat_messages")
      .insert({
        channel_id: id,
        author_type: "orchestrator",
        profile_id: profile?.id || null,
        content: text || "Done.",
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
      content: text || "Done.",
      trace_id: activeTraceId,
      metadata: {
        provider: teamChatProvider,
        channel_id: id,
        chat_message_id: assistant.id,
      },
    });
    if (assistantHistoryError) throw new Error(assistantHistoryError.message);
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
