/**
 * Durable agent-task execution endpoint.
 *
 * POST { taskId } — 202s immediately and starts a relay-owned background run
 * in this route's `after()` window. The relay streams progress to the task row
 * and posts the final result back to /api/agents/tasks/complete, so the harness
 * run does not depend on this request or a mobile browser staying connected.
 * Pass { sync: true } to run inline and get the outcome in the response.
 *
 * Auth: user cookie session, or internal HMAC headers (scope agent_task_run)
 * for detached kicks from other server contexts.
 */

import { NextResponse, after } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyInternalRouteAuth } from "@/lib/internalRouteAuth";
import { runAgentTask, AGENT_TASK_RUN_SCOPE } from "@/lib/orchestrator/agentTasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    taskId?: string;
    userEmail?: string | null;
    sync?: boolean;
  } | null;
  const taskId = typeof body?.taskId === "string" ? body.taskId.trim() : "";
  if (!taskId) {
    return NextResponse.json({ error: "Missing taskId" }, { status: 400 });
  }

  // Internal server-to-server auth first, then cookie session.
  let userId: string | null = null;
  let userEmail: string | null = null;
  const internal = verifyInternalRouteAuth(req, AGENT_TASK_RUN_SCOPE);
  if (internal?.userId) {
    userId = internal.userId;
    userEmail = typeof body?.userEmail === "string" ? body.userEmail : null;
    if (!userEmail) {
      // Best-effort email lookup so billing workspace resolution works.
      try {
        const admin = createSupabaseAdminClient();
        const { data } = await admin.auth.admin.getUserById(internal.userId);
        userEmail = data.user?.email || null;
      } catch {
        userEmail = null;
      }
    }
  } else {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = user.id;
    userEmail = user.email || null;
  }

  if (body?.sync === true) {
    try {
      const outcome = await runAgentTask({ taskId, userId, userEmail });
      return NextResponse.json({
        ok: outcome.ok,
        task: outcome.task,
        error: outcome.error,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Server error";
      const status = message === "agent_task_not_found" ? 404 : 500;
      return NextResponse.json({ error: message }, { status });
    }
  }

  // Async: only prepare and hand off to the relay in this invocation.
  const finalUserId = userId;
  const finalUserEmail = userEmail;
  const completionBaseUrl = new URL(req.url).origin;
  after(async () => {
    try {
      await runAgentTask({
        taskId,
        userId: finalUserId,
        userEmail: finalUserEmail,
        detached: true,
        completionBaseUrl,
      });
    } catch (error) {
      console.warn(
        "[agents/tasks/run] async run failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  return NextResponse.json({ ok: true, accepted: true, taskId }, { status: 202 });
}
