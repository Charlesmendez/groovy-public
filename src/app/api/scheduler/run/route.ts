import { NextResponse } from "next/server";
import type { ModelMessage } from "ai";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runOrchestratorRound } from "@/lib/orchestrator/runOrchestratorRound";
import { resolveHarnessProfile } from "@/lib/orchestrator/harnessProfiles";
import { getOrCreateRuntimeSessionForAgent } from "@/lib/orchestrator/runtimeGraph";
import {
  createOrchestratorRuntimeAgentId,
  ensureOrchestratorRuntimeAgentId,
  resolveOwnedAgentId,
} from "@/lib/orchestrator/runtimeAgents";
import { runHeartbeat, type HeartbeatTaskConfig } from "@/lib/heartbeat/runHeartbeat";
import { reconcileStaleAgentTasks, runScheduledWorkerJob } from "@/lib/orchestrator/agentTasks";
import { normalizeConnectorPlatform, type ConnectorClientPlatform } from "@/lib/connector/platform";
import { sendTelegramText } from "@/lib/telegram/client";
import { decryptTelegramBotToken } from "@/lib/telegram/botToken";
import { inferScheduledWhatsAppDeliveryIntent } from "@/lib/scheduler/delivery";
import { inferProviderForModelId } from "@/lib/ai/modelCatalog";
import { isSchedulerCronAuthorized } from "@/lib/scheduler/cronAuth";
import { runCloudSchedulerTick } from "@/lib/scheduler/cloudRunner";
import { cloudScheduledJobEligibility } from "@/lib/scheduler/cloud";
import { getAppUrl } from "@/lib/config/appConfig";

// Ensure long-running scheduled jobs don't get cut off by Edge defaults.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Pro cap: serverless maxDuration must be 1..800 seconds.
export const maxDuration = 800;
const SCHEDULER_ORCH_MAX_STEPS = (() => {
  const raw = Number(process.env.SCHEDULER_ORCH_MAX_STEPS);
  if (!Number.isFinite(raw)) return 10;
  return Math.max(1, Math.min(20, Math.trunc(raw)));
})();
const SCHEDULER_ORCH_SOFT_BUDGET_MS = (() => {
  const raw = Number(process.env.SCHEDULER_ORCH_SOFT_BUDGET_MS);
  if (!Number.isFinite(raw)) return 10 * 60 * 1000;
  return Math.max(60_000, Math.min(780_000, Math.trunc(raw)));
})();
const SCHEDULER_DATA_QUERY_TIMEOUT_MS = (() => {
  const raw = Number(process.env.SCHEDULED_DATA_QUERY_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return null;
  return Math.max(30_000, Math.min(10 * 60 * 1000, Math.trunc(raw)));
})();

type Body = {
  /** Cron/relay coordinator request. Never accepted through device auth. */
  cronTick?: boolean;
  jobId?: string;
  traceId?: string;
  /** Stable id for one logical schedule occurrence across transport retries. */
  runId?: string;
  toolResults?: Array<{
    toolCallId: string;
    toolName: string;
    result: string;
  }>;
  /** IANA timezone from the connector (e.g., "America/New_York") */
  timezone?: string;
  /** Raw WhatsApp group chat id from connector (e.g. 120...@g.us) */
  whatsappThreadKey?: string;
  connectorPlatform?: ConnectorClientPlatform;
  /** Dev-only: force heartbeat generation even if it would __SKIP__ */
  forceSend?: boolean;
};

function requireString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function looksLikeConnectorLocalPath(rawPath: string): boolean {
  const value = rawPath.trim();
  if (!value) return false;
  if (/^[a-z]+:\/\//i.test(value)) return false;
  if (value.startsWith("~/") || value.startsWith("~\\")) return true;
  if (value.startsWith("/") || value.startsWith("\\")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return false;
}

function parseIntInRange(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseJson(v: string): unknown | null {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function createKeepaliveJsonResponse(
  run: () => Promise<unknown>
): Response {
  const encoder = new TextEncoder();
  const KEEPALIVE_MS = 10_000;
  const KEEPALIVE_CHUNK = " ".repeat(1024) + "\n";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let keepalive: ReturnType<typeof setInterval> | null = null;
      try {
        // Send one chunk immediately so upstreams don't consider this idle.
        controller.enqueue(encoder.encode(KEEPALIVE_CHUNK));
        keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(KEEPALIVE_CHUNK));
          } catch {
            // ignore (e.g. stream already closed)
          }
        }, KEEPALIVE_MS);

        const payload = await run();
        if (keepalive) clearInterval(keepalive);
        keepalive = null;

        controller.enqueue(
          encoder.encode(
            JSON.stringify(
              payload && typeof payload === "object"
                ? payload
                : { ok: false, error: "scheduler_empty_payload" }
            )
          )
        );
        controller.close();
      } catch (err) {
        if (keepalive) clearInterval(keepalive);
        const msg = err instanceof Error ? err.message : String(err);
        try {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ ok: false, error: msg || "scheduler_run_failed" })
            )
          );
        } catch {
          // ignore
        }
        try {
          controller.close();
        } catch {
          // ignore
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isRetryableWhatsAppSendError(v: unknown): boolean {
  const err = requireString(v);
  if (!err) return false;
  const t = err.toLowerCase();
  if (
    t.includes("whatsapp_not_running") ||
    t.includes("client_not_ready") ||
    t.includes("chat_not_ready") ||
    t.includes("bridge_needs_restart") ||
    t.includes("detached frame") ||
    t.includes("execution context was destroyed") ||
    t.includes("target closed") ||
    t.includes("download_failed") ||
    t.includes("timed out") ||
    t.includes("timeout") ||
    t.includes("econnreset") ||
    t.includes("socket hang up") ||
    t.includes("network")
  ) {
    return true;
  }
  return false;
}

function scheduledTaskRequiresWhatsAppDelivery(taskObj: Record<string, unknown> | null): boolean {
  if (!taskObj) return false;
  const safeTask = (taskObj || {}) as Record<string, unknown>;

  const delivery =
    safeTask.delivery && typeof safeTask.delivery === "object"
      ? (safeTask.delivery as Record<string, unknown>)
      : null;
  if (delivery && typeof delivery.whatsapp === "boolean") {
    return delivery.whatsapp;
  }

  const options =
    safeTask.options && typeof safeTask.options === "object"
      ? (safeTask.options as Record<string, unknown>)
      : null;
  if (options && typeof options.requires_whatsapp_delivery === "boolean") {
    return options.requires_whatsapp_delivery;
  }

  return inferScheduledWhatsAppDeliveryIntent(safeTask.message);
}

async function resolveExistingOrchestratorSessionId(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string | null;
}): Promise<string | null> {
  const sessionId = requireString(args.sessionId);
  if (!sessionId) return null;
  const { data: existing } = await args.supabase
    .from("orchestrator_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("user_id", args.userId)
    .limit(1)
    .maybeSingle();
  return typeof existing?.id === "string" && existing.id ? existing.id : null;
}

async function selfHealScheduledRuntimeScope(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  jobId: string;
  userId: string;
  jobName: string | null;
  jobAgentId: string | null;
  taskObj: Record<string, unknown> | null;
}): Promise<{
  agentId: string | null;
  sessionId: string | null;
  taskObj: Record<string, unknown> | null;
}> {
  const taskObj = args.taskObj ? { ...args.taskObj } : {};
  const rawTaskAgentId = requireString(taskObj.orchestrator_agent_id);
  const rawJobAgentId = requireString(args.jobAgentId);
  const currentSessionId = requireString(taskObj.orchestrator_session_id);
  const taskAgentId = await resolveOwnedAgentId(args.supabase, args.userId, rawTaskAgentId);
  const jobAgentId = await resolveOwnedAgentId(args.supabase, args.userId, rawJobAgentId);
  const hadDeletedAgentReference =
    (!!rawTaskAgentId && !taskAgentId) || (!!rawJobAgentId && !jobAgentId);
  const agentId =
    taskAgentId ||
    jobAgentId ||
    (hadDeletedAgentReference
      ? await createOrchestratorRuntimeAgentId(args.supabase, args.userId)
      : await ensureOrchestratorRuntimeAgentId(args.supabase, args.userId));
  let sessionId = await resolveExistingOrchestratorSessionId({
    supabase: args.supabase,
    userId: args.userId,
    sessionId: hadDeletedAgentReference ? null : currentSessionId,
  });

  if (!sessionId && agentId) {
    sessionId = await getOrCreateRuntimeSessionForAgent({
      supabase: args.supabase,
      userId: args.userId,
      agentId,
      title: args.jobName || "Scheduled task",
    });
  }

  if (agentId) {
    taskObj.orchestrator_agent_id = agentId;
  } else {
    delete taskObj.orchestrator_agent_id;
  }
  if (sessionId) {
    taskObj.orchestrator_session_id = sessionId;
  } else {
    delete taskObj.orchestrator_session_id;
  }

  if (rawTaskAgentId !== agentId || rawJobAgentId !== agentId || currentSessionId !== sessionId) {
    try {
      const { error } = await args.supabase
        .from("scheduled_jobs")
        .update({
          agent_id: agentId,
          task: taskObj,
          updated_at: new Date().toISOString(),
        })
        .eq("id", args.jobId);
      if (error) {
        throw new Error(error.message);
      }
    } catch (error) {
      console.warn("[scheduler-run] self_heal_runtime_scope_failed", {
        jobId: args.jobId,
        userId: args.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    agentId,
    sessionId,
    taskObj,
  };
}

export async function POST(req: Request) {
  const deviceToken = req.headers.get("x-device-token") || "";
  const relaySecret = process.env.RELAY_JWT_SECRET || "";
  let verified = verifyRelayDeviceToken(deviceToken, relaySecret);
  const cronAuthorized = isSchedulerCronAuthorized(req);
  if (!verified && !cronAuthorized) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (body?.cronTick === true) {
    if (!cronAuthorized) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    try {
      return NextResponse.json(await runCloudSchedulerTick(req));
    } catch (error) {
      console.error("[scheduler-run] cloud tick failed", error);
      return NextResponse.json(
        { ok: false, error: "cloud_scheduler_tick_failed" },
        { status: 500 }
      );
    }
  }
  const jobId = requireString(body?.jobId);
  const connectorPlatform = normalizeConnectorPlatform(body?.connectorPlatform);
  if (!jobId) {
    return NextResponse.json({ ok: false, error: "jobId required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // Device-authenticated calls remain bound to that device. Cron-authenticated
  // dispatches resolve the owner/device from the job and are separately
  // restricted to connector-independent jobs below.
  let jobQuery = supabase
    .from("scheduled_jobs")
    .select(
      "id,user_id,name,agent_id,device_id,kind,task,schedule,enabled,target_agent_id,last_run_at,skip_next_run"
    )
    .eq("id", jobId)
    .limit(1);
  if (verified) jobQuery = jobQuery.eq("device_id", verified.deviceId);
  const { data: job, error: jobErr } = await jobQuery.maybeSingle();

  if (jobErr) {
    return NextResponse.json({ ok: false, error: jobErr.message }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ ok: false, error: "job_not_found" }, { status: 404 });
  }
  if (verified && job.user_id !== verified.userId) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!verified) {
    verified = { userId: String(job.user_id), deviceId: String(job.device_id) };
  }
  // From this point both auth paths have a concrete owner/device identity.
  const actor = verified;
  if (!actor) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Piggyback the agent-task reconciler on scheduler activity.
  void reconcileStaleAgentTasks(actor.userId).catch(() => {});
  if (job.enabled === false) {
    return NextResponse.json({ ok: false, error: "job_disabled" }, { status: 409 });
  }
  if (job.kind !== "orchestrator") {
    return NextResponse.json({ ok: false, error: "job_kind_not_orchestrator" }, { status: 400 });
  }

  // A pinned profile is an authorization boundary. Do not silently widen the
  // job to the default all-tools profile when the profile column cannot be
  // loaded (for example, during an incomplete migration rollout).
  const { data: jobProfileRow, error: jobProfileError } = await supabase
    .from("scheduled_jobs")
    .select("profile_id")
    .eq("id", jobId)
    .maybeSingle();
  if (jobProfileError) {
    return NextResponse.json(
      {
        ok: false,
        error: "scheduled_profile_resolution_failed",
        detail: jobProfileError.message,
      },
      { status: 500 },
    );
  }
  const jobProfileId = (jobProfileRow?.profile_id as string | null) ?? null;

  const task = job.task as unknown;
  let taskObj =
    task && typeof task === "object" ? (task as Record<string, unknown>) : null;
  if (cronAuthorized) {
    const eligibility = cloudScheduledJobEligibility({
      ...(job as unknown as Parameters<typeof cloudScheduledJobEligibility>[0]),
      task: taskObj,
    });
    if (!eligibility.eligible) {
      return NextResponse.json(
        {
          ok: false,
          error: "cloud_scheduler_job_requires_connector",
          reason: eligibility.reason,
        },
        { status: 409 }
      );
    }
  }
  const taskOptions =
    taskObj && typeof taskObj.options === "object" && taskObj.options
      ? (taskObj.options as Record<string, unknown>)
      : null;
  const scheduledModel = requireString(taskOptions?.model_name);
  const scheduledProviderRaw = requireString(taskOptions?.model_provider);
  const scheduledProvider = scheduledModel
    ? scheduledProviderRaw === "anthropic" || scheduledProviderRaw === "openai"
      ? scheduledProviderRaw
      : inferProviderForModelId(scheduledModel)
    : null;
  const scheduledReasoningEffort = requireString(taskOptions?.reasoning_effort);
  const requiresWhatsAppDelivery = scheduledTaskRequiresWhatsAppDelivery(taskObj);

  // ── Heartbeat branch ──────────────────────────────────────────────────
  if (taskObj?.type === "heartbeat_v1") {
    // Continuation round: connector already sent WhatsApp, we're done.
    const toolResults = Array.isArray(body?.toolResults) ? body!.toolResults! : [];
    const waDone = toolResults.find(
      (tr) =>
        tr &&
        typeof tr === "object" &&
        (tr.toolName === "whatsapp_send_default_group" || tr.toolName === "whatsapp_send_text")
    ) as null | { toolName?: unknown; result?: unknown };
    if (waDone) {
      const parsed = typeof waDone.result === "string" ? parseJson(waDone.result) : null;
      const obj =
        parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      const ok = obj && typeof obj.ok === "boolean" ? obj.ok : false;
      console.log("[scheduler-run] heartbeat whatsapp continuation", {
        jobId,
        traceId: requireString(body?.traceId),
        toolName: typeof waDone.toolName === "string" ? waDone.toolName : null,
        ok,
        error: obj && typeof obj.error === "string" ? obj.error : null,
        fallback: obj && typeof obj.fallback === "string" ? obj.fallback : null,
      });
      if (ok) {
        return NextResponse.json({
          ok: true,
          kind: "final",
          traceId: requireString(body?.traceId),
          text: "Heartbeat delivered.",
        });
      }
      const errMsg =
        obj && typeof obj.error === "string"
          ? obj.error
          : "whatsapp_send_failed";
      const retryable = isRetryableWhatsAppSendError(errMsg);
      return NextResponse.json(
        { ok: false, error: errMsg, retryable },
        { status: retryable ? 503 : 502 }
      );
    }

    let userEmail: string | null = null;
    try {
      const { data: u } = await supabase.auth.admin.getUserById(actor.userId);
      userEmail = u.user?.email || null;
    } catch { userEmail = null; }

    const forceSend = body?.forceSend === true && process.env.NODE_ENV !== "production";
    const taskCfg = (taskObj as unknown as HeartbeatTaskConfig) || ({} as HeartbeatTaskConfig);
    const nextOptions = {
      ...(taskCfg.options || {}),
      ...(forceSend ? { force_send: true } : {}),
    };
    const incomingWhatsAppThreadKey = requireString(body?.whatsappThreadKey);
    const currentTaskAgentId =
      typeof taskObj.orchestrator_agent_id === "string" && taskObj.orchestrator_agent_id.trim()
        ? taskObj.orchestrator_agent_id.trim()
        : typeof job.agent_id === "string" && job.agent_id.trim()
          ? job.agent_id.trim()
          : null;
    const currentTaskSessionId =
      typeof taskObj.orchestrator_session_id === "string" && taskObj.orchestrator_session_id.trim()
        ? taskObj.orchestrator_session_id.trim()
        : null;
    const effectiveTaskConfig: HeartbeatTaskConfig = {
      ...taskCfg,
      ...(currentTaskAgentId ? { orchestrator_agent_id: currentTaskAgentId } : {}),
      options: nextOptions,
    };
    // Heartbeat runs can take several minutes; stream whitespace keepalives so upstream
    // timeouts don't abort before we return the final JSON payload.
    return createKeepaliveJsonResponse(async () => {
      const hbResult = await runHeartbeat({
        supabase,
        userId: actor.userId,
        userEmail,
        agentId: currentTaskAgentId,
        taskConfig: effectiveTaskConfig,
        jobId,
        timezone: typeof body?.timezone === "string" ? body.timezone : undefined,
      });

      console.log("[scheduler-run] heartbeat result", {
        jobId,
        userId: actor.userId,
        ok: hbResult.ok,
        textLen: hbResult.text?.length || 0,
        sendWhatsApp: hbResult.sendWhatsApp,
        agentId: hbResult.agentId || null,
        sessionId: hbResult.sessionId || null,
        delivery:
          taskObj && typeof taskObj === "object" && "delivery" in taskObj
            ? (taskObj as { delivery?: unknown }).delivery || null
            : null,
        whatsappThreadKey: incomingWhatsAppThreadKey || null,
      });

      if (!hbResult.ok) {
        return { ok: false, error: hbResult.error || "heartbeat_failed" };
      }

      // Keep job task runtime scope in sync with where heartbeat messages are persisted.
      const nextTaskAgentId = hbResult.agentId || currentTaskAgentId;
      const nextTaskSessionId = hbResult.sessionId || currentTaskSessionId;
      const taskAgentChanged = !!nextTaskAgentId && nextTaskAgentId !== currentTaskAgentId;
      const taskSessionChanged = !!nextTaskSessionId && nextTaskSessionId !== currentTaskSessionId;
      if (taskAgentChanged || taskSessionChanged) {
        try {
          // IMPORTANT: runHeartbeat may have updated scheduled_jobs.task (e.g. last_integrations_fetch, dedupe fingerprints).
          // Re-read latest task so we don't clobber those updates when syncing runtime identifiers.
          const { data: latestJob } = await supabase
            .from("scheduled_jobs")
            .select("task")
            .eq("id", jobId)
            .maybeSingle();
          const latestTask =
            latestJob?.task && typeof latestJob.task === "object"
              ? (latestJob.task as Record<string, unknown>)
              : taskObj || {};

          const nextTask = {
            ...latestTask,
            ...(nextTaskAgentId ? { orchestrator_agent_id: nextTaskAgentId } : {}),
            ...(nextTaskSessionId ? { orchestrator_session_id: nextTaskSessionId } : {}),
          };
          const updatePayload: Record<string, unknown> = {
            task: nextTask,
            updated_at: new Date().toISOString(),
          };
          if (nextTaskAgentId) {
            updatePayload.agent_id = nextTaskAgentId;
          }

          await supabase
            .from("scheduled_jobs")
            .update(updatePayload)
            .eq("id", jobId);
        } catch {
          // best-effort
        }
      }

      // Telegram delivery: send directly via Telegram API (server-side, no connector).
      if (hbResult.sendTelegram) {
        try {
          const [{ data: tgConfig }, { data: defaultGroup }] = await Promise.all([
            supabase
              .from("telegram_bot_configs")
              .select("bot_token_encrypted")
              .eq("user_id", actor.userId)
              .maybeSingle(),
            supabase
              .from("telegram_groups")
              .select("telegram_chat_id")
              .eq("user_id", actor.userId)
              .order("registered_at", { ascending: false })
              .limit(1)
              .maybeSingle(),
          ]);
          if (tgConfig?.bot_token_encrypted) {
            const tgChatId = defaultGroup?.telegram_chat_id;
            if (tgChatId) {
              const tgText =
                hbResult.text.length > 4096
                  ? `${hbResult.text.slice(0, 4076).trimEnd()}\n...(truncated)`
                  : hbResult.text;
              await sendTelegramText({
                botToken: decryptTelegramBotToken(tgConfig.bot_token_encrypted),
                chatId: Number(tgChatId),
                text: tgText,
              });
              console.log("[scheduler-run] heartbeat telegram sent", {
                jobId,
                userId: actor.userId,
                chatId: tgChatId,
                textLen: tgText.length,
              });
            }
          }
        } catch (tgErr) {
          console.error("[scheduler-run] heartbeat telegram send error", {
            jobId,
            userId: actor.userId,
            error: tgErr instanceof Error ? tgErr.message : String(tgErr),
          });
        }
      }

      // If WhatsApp delivery requested, ask the connector to send to the default group.
      if (hbResult.sendWhatsApp) {
        // Enforce task-configured max_chars for WhatsApp (and respect connector hard cap).
        let maxChars = 3000;
        try {
          const opt =
            taskObj && typeof taskObj.options === "object" && taskObj.options
              ? (taskObj.options as Record<string, unknown>).max_chars
              : null;
          const n = typeof opt === "number" ? opt : Number(opt);
          if (Number.isFinite(n) && n > 200) maxChars = Math.floor(n);
        } catch {
          // ignore
        }
        maxChars = Math.max(200, Math.min(3500, maxChars));
        const textToSend =
          hbResult.text.length > maxChars
            ? `${hbResult.text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
            : hbResult.text;
        const opensFollowupWindow =
          /\?/.test(textToSend) ||
          /email actions pending|commands:\s*approve|^\s*#\d+/im.test(textToSend);
        const traceId = `hb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        return {
          ok: true,
          kind: "needs_connector",
          traceId,
          partialText: textToSend,
          connectorExecutes: [
            {
              toolCallId: `hb-wa-${Date.now()}`,
              toolName: "whatsapp_send_default_group",
              connectorType: "whatsapp_send_default_group",
              connectorParams: {
                text: textToSend,
                chat_id: incomingWhatsAppThreadKey || undefined,
                open_followup_window: opensFollowupWindow,
                followup_window_sec: 7200,
                followup_source: "heartbeat",
              },
            },
          ],
        };
      }

      console.log("[scheduler-run] heartbeat final without connector send", {
        jobId,
        userId: actor.userId,
        textLen: hbResult.text?.length || 0,
        sendWhatsApp: hbResult.sendWhatsApp,
        sendTelegram: hbResult.sendTelegram,
      });

      return { ok: true, kind: "final", traceId: null, text: hbResult.text };
    });
  }
  // ── End heartbeat branch ──────────────────────────────────────────────

  const healedRuntimeScope = await selfHealScheduledRuntimeScope({
    supabase,
    jobId,
    userId: actor.userId,
    jobName: requireString((job as { name?: unknown }).name),
    jobAgentId: requireString((job as { agent_id?: unknown }).agent_id),
    taskObj,
  });
  taskObj = healedRuntimeScope.taskObj;
  const resolvedTaskAgentId = healedRuntimeScope.agentId;
  const resolvedTaskSessionId = healedRuntimeScope.sessionId;

  const message =
    taskObj && typeof taskObj.message === "string" ? (taskObj.message as string).trim() : "";

  if (!message) {
    return NextResponse.json({ ok: false, error: "job_task_message_missing" }, { status: 400 });
  }

  // IMPORTANT:
  // runOrchestratorRound expects the caller to include the user's message in `history`.
  // The `message` arg is used mainly for routing and file attachment logic, but is NOT
  // automatically appended to the model messages. For scheduled jobs, we treat the job's
  // task message as the single user message.
  const currentTaskOptions =
    taskObj && typeof taskObj.options === "object" && taskObj.options
      ? (taskObj.options as Record<string, unknown>)
      : null;
  const scheduledWhatsAppChatId = requireString(currentTaskOptions?.whatsapp_chat_id);
  const scheduledWhatsAppRecipientQuery = requireString(
    currentTaskOptions?.whatsapp_recipient_query
  );
  const history: ModelMessage[] = [];
  if (requiresWhatsAppDelivery && scheduledWhatsAppChatId) {
    history.push({
      role: "system",
      content:
        `This scheduled task already has an exact WhatsApp delivery target bound to chat ID ${scheduledWhatsAppChatId}` +
        `${scheduledWhatsAppRecipientQuery ? ` (${scheduledWhatsAppRecipientQuery})` : ""}. ` +
        "Do not resolve the recipient by name. Complete and validate the requested task first, then send the final result directly to that exact chat ID.",
    });
  }
  history.push({ role: "user", content: message });

  // Resolve email (best-effort; used only for memory connection selection)
  let userEmail: string | null = null;
  try {
    const { data: u } = await supabase.auth.admin.getUserById(actor.userId);
    userEmail = u.user?.email || null;
  } catch {
    userEmail = null;
  }

  // Tool results from connector continuation rounds
  const toolResults = Array.isArray(body?.toolResults)
    ? body!.toolResults!.filter(
        (x) =>
          x &&
          typeof x.toolCallId === "string" &&
          typeof x.toolName === "string" &&
          typeof x.result === "string"
      )
    : [];

  const incomingTraceId = requireString(body?.traceId) || undefined;

  // Fast-path: once connector tool results are available, avoid re-running the model.
  // This prevents expensive duplicate data_query execution after connector delivery attempts.
  const waToolNames = new Set([
    "whatsapp_send_text",
    "whatsapp_send_media",
    "whatsapp_send_default_group",
  ]);
  const waResults = toolResults.filter((tr) => waToolNames.has(tr.toolName));
  if (waResults.length > 0) {
    const parsed = waResults.map((tr) => {
      const raw = parseJson(tr.result);
      const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      return {
        toolName: tr.toolName,
        ok: obj?.ok === true,
        chatId: typeof obj?.chatId === "string" ? obj.chatId : "",
        name: typeof obj?.name === "string" ? obj.name : "",
        error: typeof obj?.error === "string" ? obj.error : "",
      };
    });

    const primary = parsed.filter(
      (r) => r.toolName === "whatsapp_send_text" || r.toolName === "whatsapp_send_default_group"
    );
    const media = parsed.filter((r) => r.toolName === "whatsapp_send_media");
    const primaryAllOk = primary.length > 0 && primary.every((r) => r.ok === true);
    const allOk = parsed.every((r) => r.ok === true);
    const mediaFailures = media.filter((r) => r.ok !== true);
    const target =
      primary.find((r) => r.name)?.name ||
      primary.find((r) => r.chatId)?.chatId ||
      parsed.find((r) => r.name)?.name ||
      parsed.find((r) => r.chatId)?.chatId ||
      "chat";

    if (primaryAllOk && mediaFailures.length > 0) {
      const firstMediaError =
        mediaFailures.find((r) => r.error)?.error || "whatsapp_media_send_failed";
      return NextResponse.json(
        {
          ok: false,
          error: firstMediaError,
          retryable: false,
          partial: true,
          detail: `Text was sent to ${target}, but one or more attachments failed.`,
        },
        { status: 502 }
      );
    }

    if (primaryAllOk || allOk) {
      return NextResponse.json({
        ok: true,
        kind: "final",
        traceId: incomingTraceId,
        text: `Sent scheduled WhatsApp message to ${target}.`,
      });
    }

    const failed = parsed.filter((r) => r.ok !== true);
    const firstError = failed.find((r) => r.error)?.error || "whatsapp_send_failed";
    const retryable = failed.some((r) => isRetryableWhatsAppSendError(r.error));
    return NextResponse.json(
      {
        ok: false,
        error: firstError,
        retryable,
      },
      { status: retryable ? 503 : 502 }
    );
  }

  // ── Worker-agent branch (Part B) ────────────────────────────────────────
  // When the schedule targets a specific worker agent, execute via the agent
  // task runner (headless claude_run on the worker's device) instead of an
  // orchestrator round. The job stays bound to the TICKING device; execution
  // routes cross-device over the relay internal RPC.
  const targetAgentId =
    typeof (job as { target_agent_id?: unknown }).target_agent_id === "string" &&
    (job as { target_agent_id: string }).target_agent_id.trim()
      ? (job as { target_agent_id: string }).target_agent_id.trim()
      : null;
  if (targetAgentId) {
    // A worker delivery is a two-round exchange: first run the worker and ask
    // the connector to send, then consume that connector result here. Without
    // this continuation guard, a successful WhatsApp send would run through
    // the worker branch again and request the same send on every round.
    const workerToolResults = Array.isArray(body?.toolResults) ? body.toolResults : [];
    const workerWhatsAppResult = workerToolResults.find(
      (result) =>
        result &&
        typeof result === "object" &&
        (result.toolName === "whatsapp_send_default_group" ||
          result.toolName === "whatsapp_send_text")
    );
    if (workerWhatsAppResult) {
      const rawResult = workerWhatsAppResult.result;
      const parsedResult =
        typeof rawResult === "string"
          ? parseJson(rawResult)
          : rawResult && typeof rawResult === "object"
            ? rawResult
            : null;
      const resultObj =
        parsedResult && typeof parsedResult === "object"
          ? (parsedResult as Record<string, unknown>)
          : null;
      if (resultObj?.ok === true) {
        return NextResponse.json({
          ok: true,
          kind: "final",
          traceId: requireString(body?.traceId),
          text: "Scheduled worker result delivered.",
        });
      }
      const deliveryError = requireString(resultObj?.error) || "whatsapp_send_failed";
      const retryable = isRetryableWhatsAppSendError(deliveryError);
      return NextResponse.json(
        { ok: false, error: deliveryError, retryable },
        { status: retryable ? 503 : 502 }
      );
    }

    const explicitDelivery =
      taskObj && typeof taskObj.delivery === "object" && taskObj.delivery
        ? (taskObj.delivery as { dashboard?: boolean; whatsapp?: boolean; telegram?: boolean })
        : null;
    const delivery = {
      dashboard: explicitDelivery?.dashboard !== false,
      whatsapp: explicitDelivery?.whatsapp === true || requiresWhatsAppDelivery,
      telegram: explicitDelivery?.telegram === true,
    };
    const workerTimeoutRaw = taskOptions ? Number(taskOptions.worker_timeout_ms) : NaN;
    const maxCharsRaw = taskOptions ? Number(taskOptions.max_chars) : NaN;
    const incomingWhatsAppThreadKey = requireString(body?.whatsappThreadKey);
    const scheduledWhatsAppChatId = requireString(taskOptions?.whatsapp_chat_id);
    const scheduledWhatsAppRecipientQuery = requireString(
      taskOptions?.whatsapp_recipient_query
    );

    console.log("[scheduler-run] worker-target start", {
      jobId,
      userId: actor.userId,
      targetAgentId,
      deliverWhatsApp: delivery.whatsapp,
    });

    return createKeepaliveJsonResponse(async () => {
      const outcome = await runScheduledWorkerJob({
        jobId,
        jobName: requireString((job as { name?: unknown }).name),
        userId: actor.userId,
        userEmail,
        targetAgentId,
        message,
        delivery,
        maxChars: Number.isFinite(maxCharsRaw) ? maxCharsRaw : null,
        workerTimeoutMs: Number.isFinite(workerTimeoutRaw) ? workerTimeoutRaw : null,
        incomingWhatsAppThreadKey: incomingWhatsAppThreadKey || null,
        scheduledWhatsAppChatId: scheduledWhatsAppChatId || null,
        scheduledWhatsAppRecipientQuery: scheduledWhatsAppRecipientQuery || null,
        scheduledRunId: requireString(body?.runId),
        model: scheduledModel,
        reasoningEffort: scheduledReasoningEffort,
      });

      // Server-side Telegram delivery (same path as heartbeat digests).
      if (outcome.ok && outcome.deliverTelegram && outcome.text) {
        try {
          const [{ data: tgConfig }, { data: defaultGroup }] = await Promise.all([
            supabase
              .from("telegram_bot_configs")
              .select("bot_token_encrypted")
              .eq("user_id", actor.userId)
              .maybeSingle(),
            supabase
              .from("telegram_groups")
              .select("telegram_chat_id")
              .eq("user_id", actor.userId)
              .order("registered_at", { ascending: false })
              .limit(1)
              .maybeSingle(),
          ]);
          if (tgConfig?.bot_token_encrypted && defaultGroup?.telegram_chat_id) {
            const tgText =
              outcome.text.length > 4096
                ? `${outcome.text.slice(0, 4076).trimEnd()}\n...(truncated)`
                : outcome.text;
            await sendTelegramText({
              botToken: decryptTelegramBotToken(tgConfig.bot_token_encrypted),
              chatId: Number(defaultGroup.telegram_chat_id),
              text: tgText,
            });
          }
        } catch (tgErr) {
          console.error("[scheduler-run] worker-target telegram send error", {
            jobId,
            error: tgErr instanceof Error ? tgErr.message : String(tgErr),
          });
        }
      }

      if (!outcome.ok) {
        return { ok: false, error: outcome.error, retryable: outcome.retryable };
      }
      if (outcome.kind === "needs_connector") {
        return {
          ok: true,
          kind: "needs_connector",
          traceId: outcome.traceId,
          partialText: outcome.partialText,
          connectorExecutes: outcome.connectorExecutes,
        };
      }
      return { ok: true, kind: "final", traceId: outcome.traceId, text: outcome.text };
    });
  }
  // ── End worker-agent branch ─────────────────────────────────────────────

  console.log("[scheduler-run] start", {
    jobId,
    userId: actor.userId,
    deviceId: actor.deviceId,
    traceId: incomingTraceId || null,
    toolResultsCount: toolResults.length,
    messagePreview: message.slice(0, 140),
  });

  const jobProfile = jobProfileId
    ? await resolveHarnessProfile(supabase, {
        userId: actor.userId,
        explicitProfileId: jobProfileId,
      })
    : undefined;
  if (jobProfileId && !jobProfile) {
    return NextResponse.json(
      {
        ok: false,
        error: "scheduled_profile_unavailable",
        detail: "The profile pinned to this job no longer exists or is unavailable.",
      },
      { status: 409 },
    );
  }

  // IMPORTANT:
  // For long-running scheduled jobs (e.g. multiple Firecrawl queries), the response body can be
  // silent for minutes. Some HTTP stacks/CDNs enforce idle body timeouts. To keep the connection
  // alive without changing the client contract (still JSON), we stream *whitespace* heartbeats
  // and then emit a single JSON object at the end. Leading whitespace is valid JSON.
  const origin = getAppUrl();
  const encoder = new TextEncoder();
  const KEEPALIVE_MS = 10_000;
  const KEEPALIVE_CHUNK = " ".repeat(1024) + "\n";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let keepalive: ReturnType<typeof setInterval> | null = null;
      try {
        // Send one chunk immediately to establish body activity.
        controller.enqueue(encoder.encode(KEEPALIVE_CHUNK));
        keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(KEEPALIVE_CHUNK));
          } catch {
            // ignore (e.g. stream already closed)
          }
        }, KEEPALIVE_MS);

        // Run a single orchestrator round. Continuations provide toolResults + traceId so the model
        // can continue iterating with local connector tools.
        // NOTE: with cookies undefined, runOrchestratorRound defaults to user-key mode and will use
        // stored user_api_keys if present.
        // Keep each scheduled server round inside the serverless time budget by limiting steps.
        // Continuations still work via traceId + toolResults when connector executes are needed.
        const maxStepsForJob =
          parseIntInRange(taskOptions?.orchestrator_max_steps, 1, 20) ||
          SCHEDULER_ORCH_MAX_STEPS;
        const softBudgetMsForJob =
          parseIntInRange(taskOptions?.orchestrator_round_budget_ms, 60_000, 780_000) ||
          SCHEDULER_ORCH_SOFT_BUDGET_MS;
        const dataQueryTimeoutMsForJob =
          parseIntInRange(taskOptions?.data_query_timeout_ms, 30_000, 10 * 60 * 1000) ||
          SCHEDULER_DATA_QUERY_TIMEOUT_MS;

        const round = await runOrchestratorRound({
          supabase,
          userId: actor.userId,
          userEmail,
          // Job-pinned mind wins; otherwise session-sticky/default resolution
          // happens inside runOrchestratorRound.
          profile: jobProfile,
          orchestratorAgentId: resolvedTaskAgentId,
          orchestratorSessionId: resolvedTaskSessionId,
          appBaseUrl: origin,
          deviceId: cronAuthorized ? null : actor.deviceId,
          connectorPlatform,
          turnId: incomingTraceId,
          history,
          message: "",
          memoryEnabled: false,
          cookies: undefined,
          // Pass device token so internal API calls (data_query -> /api/datagran/chat) can authenticate
          deviceToken: cronAuthorized ? undefined : deviceToken,
          sourceProvider: cronAuthorized ? "scheduler_cloud" : "scheduler",
          traceId: incomingTraceId,
          toolResults: toolResults.length ? toolResults : undefined,
          // Scheduled jobs need all tools, even if task text contains "weekly" or schedule keywords
          bypassDirectAgent: true,
          // Scheduled mode: allow automatic WhatsApp sends without confirmation (user pre-approved)
          scheduledMode: true,
          // Keep each invocation under maxDuration by sharing a soft deadline with tools.
          scheduledHardDeadlineAtMs: Date.now() + softBudgetMsForJob,
          scheduledDataQueryTimeoutMs: dataQueryTimeoutMsForJob || undefined,
          localTimezone: typeof body?.timezone === "string" ? body.timezone : undefined,
          // Explicitly cap steps in scheduled mode to avoid hitting maxDuration.
          maxSteps: maxStepsForJob,
          modelOverride:
            scheduledModel && scheduledProvider
              ? {
                  provider: scheduledProvider,
                  model: scheduledModel,
                  reasoningEffort: scheduledReasoningEffort || null,
                }
              : null,
        });

        console.log("[scheduler-run] done", {
          jobId,
          traceId: round.traceId,
          kind: round.kind,
          textLen:
            round.kind === "final"
              ? (round.text || "").length
              : (round.partialText || "").length,
          toolCallsExecuted: round.toolCallsExecuted?.length || 0,
          connectorExecutes: round.kind === "needs_connector" ? round.connectorExecutes.length : 0,
        });

        let payload: unknown;
        if (round.kind !== "final") {
          if (round.kind === "needs_connector") {
            const resolvedConnectorExecutes = [] as typeof round.connectorExecutes;
            for (const ex of round.connectorExecutes) {
              if (
                ex.connectorType !== "whatsapp_send_media" &&
                ex.toolName !== "whatsapp_send_media"
              ) {
                resolvedConnectorExecutes.push(ex);
                continue;
              }

              const baseParams =
                ex.connectorParams && typeof ex.connectorParams === "object"
                  ? ({ ...ex.connectorParams } as Record<string, unknown>)
                  : ({} as Record<string, unknown>);

              const directUrl = requireString(baseParams.url);
              if (directUrl) {
                resolvedConnectorExecutes.push({
                  ...ex,
                  connectorParams: {
                    ...baseParams,
                    url: directUrl,
                  },
                });
                continue;
              }

              const explicitLocalPath = requireString(baseParams.local_path);
              if (explicitLocalPath && looksLikeConnectorLocalPath(explicitLocalPath)) {
                resolvedConnectorExecutes.push({
                  ...ex,
                  connectorParams: {
                    ...baseParams,
                    local_path: explicitLocalPath,
                  },
                });
                continue;
              }

              let storagePath = requireString(baseParams.storage_path);
              if (storagePath && looksLikeConnectorLocalPath(storagePath)) {
                resolvedConnectorExecutes.push({
                  ...ex,
                  connectorParams: {
                    ...baseParams,
                    local_path: storagePath,
                  },
                });
                continue;
              }
              const fileId = requireString(baseParams.file_id);
              if (!storagePath && fileId) {
                const { data: row, error: rowErr } = await supabase
                  .from("chat_attachments")
                  .select("storage_path, created_at")
                  .eq("user_id", actor.userId)
                  .eq("anthropic_file_id", fileId)
                  .order("created_at", { ascending: false })
                  .limit(1)
                  .maybeSingle();
                if (rowErr) {
                  console.warn("[scheduler-run] media_resolve_file_id_failed", {
                    jobId,
                    traceId: round.traceId,
                    fileId,
                    error: rowErr.message,
                  });
                }
                storagePath = requireString(
                  (row as { storage_path?: unknown } | null)?.storage_path
                );
              }

              if (!storagePath || !storagePath.startsWith(`${actor.userId}/`)) {
                console.warn("[scheduler-run] media_resolve_missing_storage_path", {
                  jobId,
                  traceId: round.traceId,
                  toolCallId: ex.toolCallId,
                  hasStoragePath: !!storagePath,
                  hasFileId: !!fileId,
                });
                resolvedConnectorExecutes.push(ex);
                continue;
              }

              const { data: signedData, error: signErr } = await supabase.storage
                .from("chat_uploads")
                .createSignedUrl(storagePath, 3600);
              if (signErr || !signedData?.signedUrl) {
                console.warn("[scheduler-run] media_sign_failed", {
                  jobId,
                  traceId: round.traceId,
                  toolCallId: ex.toolCallId,
                  storagePath,
                  error: signErr?.message || "unknown",
                });
                resolvedConnectorExecutes.push(ex);
                continue;
              }

              resolvedConnectorExecutes.push({
                ...ex,
                connectorParams: {
                  ...baseParams,
                  storage_path: storagePath,
                  url: signedData.signedUrl,
                },
              });
            }

            payload = {
              ok: true,
              kind: "needs_connector",
              traceId: round.traceId,
              partialText: round.partialText || "",
              connectorExecutes: resolvedConnectorExecutes,
              requiresWhatsAppDelivery,
            };
          } else {
            payload = {
              ok: true,
              kind: "partial",
              traceId: round.traceId,
              text: (round as unknown as { partialText?: string }).partialText || "",
              note: `Scheduled orchestrator task produced kind=${round.kind}; only connector loops are supported in scheduled mode.`,
              requiresWhatsAppDelivery,
            };
          }
        } else {
          payload = {
            ok: true,
            kind: "final",
            traceId: round.traceId,
            text: round.text || "",
            requiresWhatsAppDelivery,
          };
        }

        // Stop heartbeats before sending JSON (trailing whitespace is still OK, but avoid it).
        if (keepalive) clearInterval(keepalive);
        keepalive = null;

        controller.enqueue(encoder.encode(JSON.stringify(payload)));
        controller.close();
      } catch (err) {
        if (keepalive) clearInterval(keepalive);
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[scheduler-run] error", { jobId, traceId: incomingTraceId || null, error: msg });
        try {
          controller.enqueue(
            encoder.encode(JSON.stringify({ ok: false, error: msg || "scheduler_run_failed" }))
          );
        } catch {
          // ignore
        }
        try {
          controller.close();
        } catch {
          // ignore
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Vercel Cron invokes configured paths with GET. Keep the JSON POST
 * `cronTick` path for the self-hosted relay, but expose the same authenticated
 * coordinator through GET for the hosted cron transport.
 */
export async function GET(req: Request) {
  if (!isSchedulerCronAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runCloudSchedulerTick(req));
  } catch (error) {
    console.error("[scheduler-run] cloud GET tick failed", error);
    return NextResponse.json(
      { ok: false, error: "cloud_scheduler_tick_failed" },
      { status: 500 },
    );
  }
}
