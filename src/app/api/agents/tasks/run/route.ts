/**
 * Durable agent-task execution endpoint.
 *
 * POST { taskId } — prepares the run and waits only until the relay confirms
 * ownership. The relay then streams progress to the task row and posts the
 * final result back to /api/agents/tasks/complete, so the long worker run does
 * not depend on this request or a mobile browser staying connected.
 * Pass { sync: true } to run inline and get the outcome in the response.
 *
 * Auth: user cookie session, or internal HMAC headers (scope agent_task_run)
 * for detached kicks from other server contexts.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyInternalRouteAuth } from "@/lib/internalRouteAuth";
import { getCanonicalAppUrl } from "@/lib/config/appConfig";
import { runAgentTask, AGENT_TASK_RUN_SCOPE } from "@/lib/orchestrator/agentTasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;
const SYNC_AGENT_TASK_TIMEOUT_MS = 700_000;

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
      const outcome = await runAgentTask({
        taskId,
        userId,
        userEmail,
        timeoutMs: SYNC_AGENT_TASK_TIMEOUT_MS,
      });
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

  // Async worker execution, but synchronous durable handoff: do not return
  // until the relay has accepted the callback-owned request. Starting this in
  // `after()` left a process-loss window where a 202 response could precede
  // any actual dispatch.
  // The relay only accepts callbacks to its configured canonical app origin.
  // Preview aliases and reverse-proxy request origins must not leak into the
  // durable callback URL. Keep the exact request origin in local development
  // where Next may intentionally run on a non-default port.
  const completionBaseUrl =
    process.env.NODE_ENV === "production"
      ? getCanonicalAppUrl()
      : new URL(req.url).origin;
  if (!completionBaseUrl) {
    return NextResponse.json(
      {
        error:
          "GROOVY_APP_URL or NEXT_PUBLIC_APP_URL is required for durable task callbacks.",
      },
      { status: 500 },
    );
  }
  try {
    const outcome = await runAgentTask({
      taskId,
      userId,
      userEmail,
      detached: true,
      completionBaseUrl,
    });
    const queuedBehindActiveTask =
      outcome.task.status === "queued" && outcome.error === "agent_busy";
    const alreadyRunning =
      outcome.task.status === "running" &&
      outcome.error === "task_already_running";
    const alreadyComplete = outcome.task.status === "done";
    const handoffAccepted =
      outcome.accepted === true ||
      queuedBehindActiveTask ||
      alreadyRunning ||
      alreadyComplete;
    return NextResponse.json(
      {
        ok: handoffAccepted,
        accepted: outcome.accepted === true,
        queued: queuedBehindActiveTask,
        taskId,
        status: outcome.task.status,
        error: outcome.error,
      },
      {
        status: handoffAccepted
          ? outcome.task.status === "done"
            ? 200
            : 202
          : outcome.task.status === "awaiting_approval" ||
              outcome.task.status === "canceled"
            ? 409
            : 503,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Server error";
    const status = message === "agent_task_not_found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
