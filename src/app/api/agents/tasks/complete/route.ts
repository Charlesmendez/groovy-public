import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyInternalRouteAuth } from "@/lib/internalRouteAuth";
import { completeAgentTaskFromConnector } from "@/lib/orchestrator/agentTasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AGENT_TASK_COMPLETE_SCOPE = "agent_task_complete";

export async function POST(req: Request) {
  const internal = verifyInternalRouteAuth(req, AGENT_TASK_COMPLETE_SCOPE);
  if (!internal?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    taskId?: string;
    requestId?: string;
    result?: Record<string, unknown>;
  } | null;
  const taskId =
    typeof body?.taskId === "string" ? body.taskId.trim() : "";
  const requestId =
    typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const result =
    body?.result && typeof body.result === "object" && !Array.isArray(body.result)
      ? body.result
      : null;
  if (!taskId || !requestId || !result) {
    return NextResponse.json(
      { error: "Missing taskId, requestId, or result" },
      { status: 400 }
    );
  }

  let userEmail: string | null = null;
  try {
    const admin = createSupabaseAdminClient();
    const { data } = await admin.auth.admin.getUserById(internal.userId);
    userEmail = data.user?.email || null;
  } catch {
    userEmail = null;
  }

  try {
    const outcome = await completeAgentTaskFromConnector({
      taskId,
      userId: internal.userId,
      requestId,
      rpcResult: result,
      userEmail,
    });
    return NextResponse.json({
      ok: outcome.ok,
      taskId: outcome.task.id,
      status: outcome.task.status,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Task completion failed";
    const status = message === "agent_task_not_found" ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}
