/**
 * Single agent-task API.
 *
 * GET   — fetch one task.
 * PATCH — { action: "approve" | "reject" | "cancel" }.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  approveAgentTask,
  createAgentTask,
  getAgentTask,
  kickAgentTask,
  listWorkerAgents,
  rejectAgentTask,
  resolveWorkerAgentByRef,
} from "@/lib/orchestrator/agentTasks";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { callConnectorRpcViaRelay } from "@/lib/relay/connectorRpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const task = await getAgentTask(user.id, id);
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ task });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as {
    action?: string;
    /** For approve_plan: worker agent (name or id) that should execute the plan. */
    executeAgent?: string;
    plan?: string;
    title?: string;
  } | null;
  const action = typeof body?.action === "string" ? body.action : "";

  if (action === "update_plan") {
    const task = await getAgentTask(user.id, id);
    if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const meta = (task.result_meta || {}) as Record<string, unknown>;
    if (meta.plan_mode !== true || task.status !== "done" || meta.plan_approved_at) {
      return NextResponse.json(
        { error: "Only an unapproved completed plan can be edited" },
        { status: 409 }
      );
    }
    const plan = typeof body?.plan === "string" ? body.plan.trim() : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!plan) {
      return NextResponse.json({ error: "Plan content is required" }, { status: 400 });
    }
    const admin = createSupabaseAdminClient();
    const { data: updated, error } = await admin
      .from("agent_tasks")
      .update({
        result_text: plan,
        ...(title ? { title } : {}),
        result_meta: {
          ...meta,
          user_edited_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", user.id)
      .select("*")
      .single();
    if (error || !updated) {
      return NextResponse.json({ error: "Failed to update plan" }, { status: 500 });
    }
    return NextResponse.json({ task: updated });
  }

  // Approve a plan-mode task: save the plan into the workspace's
  // .claude/plans/ (visible to Claude Code AND Codex working there, and in the
  // Plans browser), then optionally queue an execution task on a chosen agent.
  if (action === "approve_plan") {
    const task = await getAgentTask(user.id, id);
    if (!task) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const isPlan =
      (task.result_meta as { plan_mode?: unknown } | null)?.plan_mode === true;
    if (!isPlan || task.status !== "done" || !task.result_text?.trim()) {
      return NextResponse.json(
        { error: "Task is not a completed plan" },
        { status: 409 }
      );
    }
    const existingMeta =
      ((task.result_meta as Record<string, unknown> | null) || {});
    if (existingMeta.plan_approved_at) {
      return NextResponse.json(
        {
          error:
            "This plan is already approved. Open Plans to run it again or choose another agent.",
          code: "plan_already_approved",
        },
        { status: 409 }
      );
    }
    const executeAgentRef =
      typeof body?.executeAgent === "string" ? body.executeAgent.trim() : "";
    let executionAgent: Awaited<ReturnType<typeof listWorkerAgents>>[number] | null = null;
    if (executeAgentRef) {
      const roster = await listWorkerAgents(user.id);
      const resolved = await resolveWorkerAgentByRef(user.id, executeAgentRef, { roster });
      if (!resolved.ok) {
        return NextResponse.json(
          { error: `No worker agent named "${executeAgentRef}"` },
          { status: 400 }
        );
      }
      executionAgent = resolved.agent;
    }

    // Resolve the planning agent's device + workspace root for the save.
    const admin = createSupabaseAdminClient();
    const { data: config } = await admin
      .from("claude_code_agent_configs")
      .select("device_id, workspace_id")
      .eq("agent_id", task.agent_id)
      .eq("user_id", user.id)
      .maybeSingle();
    const deviceId =
      typeof (config as { device_id?: unknown } | null)?.device_id === "string"
        ? String((config as { device_id: string }).device_id)
        : null;
    const workspaceId =
      typeof (config as { workspace_id?: unknown } | null)?.workspace_id === "string"
        ? String((config as { workspace_id: string }).workspace_id)
        : null;
    let rootPath: string | null = null;
    if (workspaceId) {
      const { data: workspace } = await admin
        .from("device_workspaces")
        .select("root_path")
        .eq("id", workspaceId)
        .eq("user_id", user.id)
        .maybeSingle();
      rootPath =
        typeof (workspace as { root_path?: unknown } | null)?.root_path === "string"
          ? String((workspace as { root_path: string }).root_path)
          : null;
    }
    if (!deviceId || !rootPath) {
      return NextResponse.json(
        { error: "The planning agent has no device/workspace to save the plan into" },
        { status: 400 }
      );
    }
    if (
      executionAgent &&
      (executionAgent.deviceId !== deviceId || executionAgent.workspaceId !== workspaceId)
    ) {
      return NextResponse.json(
        {
          error: `${executionAgent.name} is attached to a different workspace. Choose an agent attached to ${rootPath}.`,
          code: "plan_executor_workspace_mismatch",
        },
        { status: 409 }
      );
    }

    const plannedSnapshot = (
      task.result_meta as { repository_snapshot?: Record<string, unknown> } | null
    )?.repository_snapshot;
    if (plannedSnapshot) {
      try {
        const currentSnapshot = await callConnectorRpcViaRelay({
          userId: user.id,
          deviceId,
          rpcType: "workspace_repo_snapshot",
          payload: { workspace_root: rootPath },
          timeoutMs: 20_000,
        });
        const changed =
          currentSnapshot.ok === false ||
          currentSnapshot.commit_sha !== plannedSnapshot.commit_sha ||
          currentSnapshot.status_hash !== plannedSnapshot.status_hash;
        if (changed) {
          return NextResponse.json(
            {
              error:
                "The repository changed after this plan was researched. Refresh the plan before approving it.",
              code: "planning_snapshot_stale",
              plannedSnapshot,
              currentSnapshot,
            },
            { status: 409 }
          );
        }
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? `Could not verify repository freshness: ${error.message}`
                : "Could not verify repository freshness",
            code: "planning_snapshot_unavailable",
          },
          { status: 503 }
        );
      }
    }

    const planTitle = task.title?.replace(/^Schedule: /, "") || "Plan";
    const planContent = `# ${planTitle}\n\n_Drafted ${new Date().toISOString().slice(0, 10)} via Groovy plan mode (task ${task.id.slice(0, 8)})._\n\n${task.result_text.trim()}\n`;

    let savedPath: string | null = null;
    let savedFilename: string | null = null;
    try {
      const result = await callConnectorRpcViaRelay({
        userId: user.id,
        deviceId,
        rpcType: "workspace_plan_write",
        payload: {
          workspace_root: rootPath,
          slug: planTitle.slice(0, 60),
          content: planContent,
        },
        timeoutMs: 30_000,
      });
      if (result.ok === false) {
        return NextResponse.json(
          { error: String(result.error || "plan_save_failed") },
          { status: 400 }
        );
      }
      savedPath = typeof result.path === "string" ? result.path : null;
      savedFilename = typeof result.filename === "string" ? result.filename : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connector unavailable";
      return NextResponse.json(
        {
          error: message.includes("device_not_online")
            ? "Device is offline — bring the connector online to save the plan"
            : message,
        },
        { status: 503 }
      );
    }

    // Optionally queue execution with the chosen agent (any harness).
    let executionTask = null;
    if (executionAgent) {
      try {
        executionTask = await createAgentTask({
          userId: user.id,
          agentId: executionAgent.id,
          prompt: `Execute the approved plan${savedFilename ? ` saved at .claude/plans/${savedFilename}` : ""} in this workspace. Follow it step by step, verify the result, and report what you completed.`,
          title: `Execute plan: ${planTitle}`,
          context: `[APPROVED PLAN]\n${planContent}`,
          orchestratorSessionId: task.orchestrator_session_id,
          requestedChannel: task.requested_channel || "dashboard",
          notify: task.notify,
          source: "orchestrator",
        });
        kickAgentTask({
          taskId: executionTask.id,
          userId: user.id,
          userEmail: user.email || null,
          baseUrl: new URL(req.url).origin,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not queue execution";
        await admin
          .from("agent_tasks")
          .update({
            result_meta: {
              ...existingMeta,
              plan_approved_at: new Date().toISOString(),
              plan_saved_path: savedPath,
              plan_filename: savedFilename,
              planning_status: "approved",
              plan_execution_error: message,
            },
            updated_at: new Date().toISOString(),
          })
          .eq("id", task.id)
          .eq("user_id", user.id);
        return NextResponse.json(
          {
            error: `The plan was saved, but execution could not be queued: ${message}. Open Plans to try again.`,
            code: "plan_execution_queue_failed",
            planSaved: true,
            planSavedPath: savedPath,
          },
          { status: 502 }
        );
      }
    }

    const approvedAt = new Date().toISOString();
    const { error: approvalUpdateError } = await admin
      .from("agent_tasks")
      .update({
        result_meta: {
          ...existingMeta,
          plan_approved_at: approvedAt,
          plan_saved_path: savedPath,
          plan_filename: savedFilename,
          planning_status: executionAgent ? "executing" : "approved",
          ...(executionTask && executionAgent
            ? {
                plan_execution_task_id: executionTask.id,
                plan_execution_agent_id: executionAgent.id,
                plan_execution_agent_name: executionAgent.name,
              }
            : {}),
        },
        updated_at: approvedAt,
      })
      .eq("id", task.id)
      .eq("user_id", user.id);
    if (approvalUpdateError) {
      return NextResponse.json(
        {
          error:
            "The plan was saved and execution may have started, but Groovy could not update its plan status. Refresh Tasks before trying again.",
          code: "plan_approval_status_failed",
          planSaved: true,
          executionTask,
        },
        { status: 500 }
      );
    }

    const updatedTask = await getAgentTask(user.id, id);
    return NextResponse.json({
      task: updatedTask,
      planSavedPath: savedPath,
      executionTask,
    });
  }

  if (action === "approve") {
    const task = await approveAgentTask({ userId: user.id, taskId: id, decidedBy: "dashboard" });
    if (!task) {
      return NextResponse.json({ error: "Task is not awaiting approval" }, { status: 409 });
    }
    kickAgentTask({
      taskId: task.id,
      userId: user.id,
      userEmail: user.email || null,
      baseUrl: new URL(req.url).origin,
    });
    return NextResponse.json({ task });
  }

  if (action === "reject") {
    const task = await rejectAgentTask({ userId: user.id, taskId: id, decidedBy: "dashboard" });
    if (!task) {
      return NextResponse.json({ error: "Task is not awaiting approval" }, { status: 409 });
    }
    return NextResponse.json({ task });
  }

  if (action === "cancel") {
    const admin = createSupabaseAdminClient();
    const { data: task } = await admin
      .from("agent_tasks")
      .update({
        status: "canceled",
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", user.id)
      .in("status", ["queued", "awaiting_approval"])
      .select("*")
      .maybeSingle();
    if (!task) {
      return NextResponse.json(
        { error: "Only queued or awaiting-approval tasks can be canceled" },
        { status: 409 }
      );
    }
    return NextResponse.json({ task });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
