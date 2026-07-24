import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import {
  approveAgentTask,
  createAgentTask,
  kickAgentTask,
  rejectAgentTask,
  type AgentTaskNotifyTargets,
} from "@/lib/orchestrator/agentTasks";
import { callConnectorRpcViaRelay } from "@/lib/relay/connectorRpc";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { parseTeamChatControlRequest } from "@/lib/teamChat";
import { sendTeamChatPush } from "@/lib/notifications/webPush";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };
type ActiveAgentTask = {
  id: string;
  user_id: string;
  agent_id: string;
  status: "queued" | "running" | "awaiting_approval";
  title: string | null;
  prompt: string;
  context: string | null;
  result_meta: Record<string, unknown> | null;
  orchestrator_session_id: string | null;
  requested_channel: string | null;
  notify: AgentTaskNotifyTargets | null;
  trace_id: string | null;
  turn_id: string | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function resolveVisibleChannel(
  channelId: string,
): Promise<
  | {
      user: { id: string; email?: string | null };
      channel: { id: string; workspace_id: string; name: string };
    }
  | NextResponse
> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data: channel, error } = await supabase
    .from("chat_channels")
    .select("id,workspace_id,name")
    .eq("id", channelId)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }
  return {
    user: { id: user.id, email: user.email },
    channel: {
      id: String(channel.id),
      workspace_id: String(channel.workspace_id),
      name: String(channel.name || "channel"),
    },
  };
}

async function listActiveAgentTasks(
  admin: SupabaseClient,
  channelId: string,
): Promise<ActiveAgentTask[]> {
  const { data, error } = await admin
    .from("agent_tasks")
    .select(
      "id,user_id,agent_id,status,title,prompt,context,result_meta,orchestrator_session_id,requested_channel,notify,trace_id,turn_id",
    )
    .eq("requested_channel", `team_chat:${channelId}`)
    .in("status", ["queued", "running", "awaiting_approval"])
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []) as ActiveAgentTask[];
}

async function publicAgentTasks(
  admin: SupabaseClient,
  tasks: ActiveAgentTask[],
) {
  const ids = Array.from(new Set(tasks.map((task) => task.agent_id)));
  const { data: agents } = ids.length
    ? await admin.from("agents").select("id,name").in("id", ids)
    : { data: [] as Array<{ id: string; name: string }> };
  const names = new Map(
    (agents || []).map((agent) => [String(agent.id), String(agent.name || "Agent")]),
  );
  return tasks.map((task) => ({
    id: task.id,
    status: task.status,
    title: task.title || "Agent task",
    agentId: task.agent_id,
    agentName: names.get(task.agent_id) || "Agent",
    traceId: task.trace_id,
  }));
}

async function cancelAgentTask(
  admin: SupabaseClient,
  task: ActiveAgentTask,
  controlledBy: string,
): Promise<string | null> {
  const { data: canceledRows, error } = await admin.rpc(
    "cancel_team_chat_agent_task",
    {
      p_task_id: task.id,
      p_requested_channel: task.requested_channel,
      p_controlled_by: controlledBy,
    },
  );
  if (error) throw new Error(error.message);
  const canceledTask = Array.isArray(canceledRows)
    ? canceledRows[0]
    : canceledRows;
  if (!canceledTask) {
    throw new Error("The agent task finished before it could be stopped.");
  }

  const deliverCancellation = async (requestId: string): Promise<boolean> => {
    const { data: config, error: configError } = await admin
      .from("claude_code_agent_configs")
      .select("device_id")
      .eq("agent_id", task.agent_id)
      .eq("user_id", task.user_id)
      .maybeSingle();
    const deviceId = text(config?.device_id);
    if (configError || !deviceId) {
      throw new Error(
        "The agent is running, but its connector is unavailable for cancellation.",
      );
    }
    const result = await callConnectorRpcViaRelay({
      userId: task.user_id,
      deviceId,
      rpcType: "claude_run_cancel",
      payload: {
        target_request_id: requestId,
        agent_id: task.agent_id,
        cancel_all_for_agent: false,
      },
      timeoutMs: 15_000,
    });
    if (result.ok !== true) {
      throw new Error(
        text(result.error) ||
          "The connector did not accept the agent cancellation request.",
      );
    }
    return Number(result.canceled || 0) > 0;
  };

  const previousStatus = text(canceledTask.previous_status);
  const resultMeta =
    canceledTask.result_meta &&
    typeof canceledTask.result_meta === "object" &&
    !Array.isArray(canceledTask.result_meta)
      ? (canceledTask.result_meta as Record<string, unknown>)
      : {};
  const requestId = text(resultMeta.relay_request_id);
  if (previousStatus !== "running" || !requestId) return null;
  try {
    await deliverCancellation(requestId);
    return null;
  } catch (cancelError) {
    // The durable task is already canceled. Its completion route and runner
    // both reject canceled results, so an unreachable connector cannot revive
    // the task; report that only local process termination was not confirmed.
    return cancelError instanceof Error
      ? cancelError.message
      : "The task was canceled, but connector process termination was not confirmed.";
  }
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const visible = await resolveVisibleChannel(id);
  if (visible instanceof NextResponse) return visible;

  const admin = createSupabaseAdminClient();
  const [{ data: activeRun, error: runError }, tasks] = await Promise.all([
    admin
      .from("chat_orchestrator_runs")
      .select(
        "id,trace_id,status,profile_id,started_by,control_requested_by,started_at,control_requested_at",
      )
      .eq("channel_id", id)
      .in("status", ["running", "stop_requested", "redirect_requested"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    listActiveAgentTasks(admin, id),
  ]);
  if (runError) {
    return NextResponse.json({ error: runError.message }, { status: 500 });
  }
  return NextResponse.json({
    orchestrator: activeRun || null,
    agents: await publicAgentTasks(admin, tasks),
  });
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const visible = await resolveVisibleChannel(id);
  if (visible instanceof NextResponse) return visible;

  const parsed = parseTeamChatControlRequest(
    await req.json().catch(() => null),
  );
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { action, target, taskId, direction } = parsed.value;

  const admin = createSupabaseAdminClient();
  if (target === "agent") {
    const tasks = await listActiveAgentTasks(admin, id);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      return NextResponse.json(
        { error: "That agent task is no longer active in this channel" },
        { status: 409 },
      );
    }
    try {
      let replacement = null;
      let cancellationWarning: string | null = null;
      if (action === "redirect") {
        replacement = await createAgentTask({
          userId: task.user_id,
          agentId: task.agent_id,
          prompt: direction!,
          title: `Redirect: ${direction!.slice(0, 100)}`,
          context: [
            "A team member redirected an in-progress task in Team Chat.",
            `Previous task: ${task.title || task.prompt}`,
            task.context ? `Previous context:\n${task.context}` : "",
            "Continue from any valid work already completed, but follow the new direction below.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          orchestratorSessionId: task.orchestrator_session_id,
          requestedChannel: task.requested_channel || `team_chat:${id}`,
          notify: task.notify || { dashboard: true },
          requireApproval: true,
          source: "orchestrator",
          traceId: `team-redirect-${randomUUID()}`,
          turnId: task.turn_id,
          resultMeta: {
            redirected_from_task_id: task.id,
            redirected_by_user_id: visible.user.id,
          },
        });
      }
      try {
        cancellationWarning = await cancelAgentTask(
          admin,
          task,
          visible.user.id,
        );
        if (cancellationWarning) {
          console.warn("[team-chat] agent cancellation not confirmed", {
            taskId: task.id,
            error: cancellationWarning,
            stoppedAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        if (replacement) {
          await rejectAgentTask({
            userId: task.user_id,
            taskId: replacement.id,
            decidedBy: `team_chat_redirect_rollback:${visible.user.id}`,
          }).catch(() => null);
        }
        throw error;
      }
      if (replacement) {
        let approved = null;
        try {
          approved = await approveAgentTask({
            userId: task.user_id,
            taskId: replacement.id,
            decidedBy: `team_chat_redirect:${visible.user.id}`,
          });
        } catch (error) {
          await rejectAgentTask({
            userId: task.user_id,
            taskId: replacement.id,
            decidedBy: `team_chat_redirect_start_failed:${visible.user.id}`,
          }).catch(() => null);
          throw error;
        }
        if (!approved) {
          await rejectAgentTask({
            userId: task.user_id,
            taskId: replacement.id,
            decidedBy: `team_chat_redirect_start_failed:${visible.user.id}`,
          }).catch(() => null);
          throw new Error(
            "The original task stopped, but the redirected task could not be started.",
          );
        }
        replacement = approved;
        const { data: taskOwner } = await admin.auth.admin.getUserById(
          task.user_id,
        );
        kickAgentTask({
          taskId: replacement.id,
          userId: task.user_id,
          userEmail: taskOwner.user?.email || null,
          baseUrl: new URL(req.url).origin,
        });
      }
      const controlledAgentName =
        (await publicAgentTasks(admin, [task]))[0]?.agentName || "the agent";
      const controllerName = await displayName(admin, visible.user.id);
      const controlMessage =
        action === "redirect"
          ? `${controllerName} redirected ${controlledAgentName}: ${direction!}`
          : `${controllerName} stopped ${controlledAgentName}.`;
      const { data: systemMessage, error: systemMessageError } = await admin
        .from("chat_messages")
        .insert({
          channel_id: id,
          author_type: "system",
          content: controlMessage,
          metadata: {
            kind: "work_control",
            action,
            target: "agent",
            task_id: task.id,
            replacement_task_id: replacement?.id || null,
            controlled_by: visible.user.id,
          },
        })
        .select("id")
        .single();
      if (systemMessageError || !systemMessage) {
        throw new Error(
          systemMessageError?.message || "Could not save the control update",
        );
      }
      await sendTeamChatPush({
        admin,
        channelId: id,
        messageId: String(systemMessage.id),
        authorType: "system",
        authorUserId: visible.user.id,
        authorLabel: "System",
        content: controlMessage,
      }).catch((cause) => {
        console.warn("[team-chat] agent control push delivery failed", {
          channelId: id,
          error:
            cause instanceof Error ? cause.message : "Unknown push error",
        });
      });
      return NextResponse.json({
        ok: true,
        action,
        target,
        taskId: task.id,
        replacementTaskId: replacement?.id || null,
        cancellationWarning: cancellationWarning || null,
      });
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Could not control the agent task",
        },
        { status: 409 },
      );
    }
  }

  const { data: run, error: runError } = await admin
    .from("chat_orchestrator_runs")
    .select("id,trace_id,status")
    .eq("channel_id", id)
    .in("status", ["running", "stop_requested", "redirect_requested"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runError) {
    return NextResponse.json({ error: runError.message }, { status: 500 });
  }
  if (!run) {
    return NextResponse.json(
      { error: "The channel orchestrator is no longer working" },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await admin
    .from("chat_orchestrator_runs")
    .update({
      status: action === "redirect" ? "redirect_requested" : "stop_requested",
      control_requested_by: visible.user.id,
      control_requested_at: now,
      redirect_content: action === "redirect" ? direction! : null,
      updated_at: now,
    })
    .eq("id", run.id)
    .in("status", ["running", "stop_requested", "redirect_requested"])
    .select("id,status")
    .maybeSingle();
  if (updateError || !updated) {
    return NextResponse.json(
      { error: updateError?.message || "The orchestrator run already ended" },
      { status: 409 },
    );
  }

  const taskWarnings: string[] = [];
  const spawnedTasks = (await listActiveAgentTasks(admin, id)).filter(
    (task) => task.trace_id === run.trace_id,
  );
  for (const task of spawnedTasks) {
    try {
      const warning = await cancelAgentTask(admin, task, visible.user.id);
      if (warning) taskWarnings.push(warning);
    } catch (error) {
      taskWarnings.push(
        error instanceof Error ? error.message : `Could not stop task ${task.id}`,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    action,
    target,
    runId: run.id,
    taskWarnings,
  });
}

async function displayName(
  admin: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data } = await admin.auth.admin.getUserById(userId);
  const user = data.user;
  const candidate =
    text(user?.user_metadata?.full_name) ||
    text(user?.user_metadata?.name) ||
    text(user?.email).split("@")[0];
  return candidate.replace(/[\r\n]+/g, " ").slice(0, 100) || "A teammate";
}
