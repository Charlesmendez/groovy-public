/**
 * Agent tasks collection API.
 *
 * GET  — recent tasks for the signed-in user (dashboard rail initial load;
 *        live updates arrive over supabase realtime).
 * POST — create a task for a worker agent and kick execution.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  createAgentTask,
  kickAgentTask,
  listWorkerAgents,
  resolveWorkerAgentByRef,
} from "@/lib/orchestrator/agentTasks";
import { getProductAccessForUser } from "@/lib/licensing/access";
import { canonicalWorkspacePath } from "@/lib/workspaces/path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 50), 200);
  const agentId = url.searchParams.get("agentId");

  let query = supabase
    .from("agent_tasks")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (agentId) query = query.eq("agent_id", agentId);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ tasks: data || [] });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const access = await getProductAccessForUser({ userId: user.id }).catch(() => null);
  if (!access?.hasAccess) {
    return NextResponse.json(
      {
        error:
          access?.workspaceOwnerRequired
            ? "This workspace needs an active plan. Ask a workspace admin to activate Groovy."
            : access?.accessStatus === "trial_available"
            ? "Start your free 5-day trial to run agents."
            : "Your free trial has ended. Purchase a Groovy license to run agents.",
        code: access?.accessStatus === "trial_available" ? "trial_not_started" : "license_required",
      },
      { status: 402 }
    );
  }

  const body = (await req.json().catch(() => null)) as {
    agent?: string;
    prompt?: string;
    title?: string;
    context?: string;
    expectedWorkspaceRoot?: string;
    orchestratorSessionId?: string;
    requireApproval?: boolean;
  } | null;

  const agentRef = typeof body?.agent === "string" ? body.agent.trim() : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!agentRef || !prompt) {
    return NextResponse.json({ error: "Missing agent or prompt" }, { status: 400 });
  }

  const roster = await listWorkerAgents(user.id);
  const resolved = await resolveWorkerAgentByRef(user.id, agentRef, { roster });
  if (!resolved.ok) {
    return NextResponse.json(
      {
        error:
          resolved.error === "ambiguous"
            ? `Multiple agents match "${agentRef}": ${(resolved.candidates || []).join(", ")}`
            : `No worker agent named "${agentRef}"`,
      },
      { status: 400 }
    );
  }
  const expectedWorkspaceRoot =
    typeof body?.expectedWorkspaceRoot === "string"
      ? canonicalWorkspacePath(body.expectedWorkspaceRoot)
      : "";
  const agentWorkspaceRoot = canonicalWorkspacePath(resolved.agent.workspaceRootPath);
  if (expectedWorkspaceRoot && agentWorkspaceRoot !== expectedWorkspaceRoot) {
    return NextResponse.json(
      {
        error: `${resolved.agent.name} is attached to a different workspace. Choose an agent attached to ${expectedWorkspaceRoot}.`,
        code: "task_workspace_mismatch",
      },
      { status: 409 }
    );
  }

  const task = await createAgentTask({
    userId: user.id,
    agentId: resolved.agent.id,
    prompt,
    title: body?.title || null,
    context: body?.context || null,
    orchestratorSessionId: body?.orchestratorSessionId || null,
    requestedChannel: "dashboard",
    notify: { dashboard: true },
    requireApproval: body?.requireApproval === true,
    source: "api",
  });

  if (task.status === "queued") {
    kickAgentTask({
      taskId: task.id,
      userId: user.id,
      userEmail: user.email || null,
      baseUrl: new URL(req.url).origin,
    });
  }

  return NextResponse.json({ task });
}
