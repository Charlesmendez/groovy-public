import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runOrchestratorRound } from "@/lib/orchestrator/runOrchestratorRound";
import {
  getOrCreateRuntimeSessionForAgent,
  incrementBranchTurnCount,
  resolveRuntimeScope,
} from "@/lib/orchestrator/runtimeGraph";
import { sendKapsoText } from "@/lib/whatsapp/kapso";
import { resolveUserDeviceId } from "@/lib/devices/resolveUserDeviceId";
import { getAppUrl } from "@/lib/config/appConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The connector loop can drive long local tool runs (claude_run up to 10 min).
export const maxDuration = 800;
import { createHmac, timingSafeEqual } from "crypto";
import { logError, logInfo, logWarn, safeTextPreview } from "@/lib/observability/log";
import { syncWorkspaceAddonSubscriptionBestEffort } from "@/lib/billing/addons";
import { isSelfHosted } from "@/lib/config/edition";

type KapsoWebhookBody = Record<string, unknown>;

function asString(val: unknown): string | null {
  return typeof val === "string" && val.trim() ? val.trim() : null;
}

function getKapsoSignature(req: Request) {
  // Kapso docs: X-Webhook-Signature: <hmac-sha256-hex>
  const sig = (req.headers.get("x-webhook-signature") || "").trim();
  if (!sig) return null;
  // tolerate "sha256=<hex>"
  if (sig.toLowerCase().startsWith("sha256=")) return sig.slice("sha256=".length).trim();
  return sig;
}

function verifyKapsoSignature(args: { rawBody: string; signatureHex: string; secret: string }) {
  const expectedHex = createHmac("sha256", args.secret)
    .update(args.rawBody, "utf8")
    .digest("hex");

  // Compare as bytes (hex-decoded). Reject invalid hex.
  try {
    const a = Buffer.from(args.signatureHex, "hex");
    const b = Buffer.from(expectedHex, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function isSafeKapsoId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function extractKapsoPayload(body: KapsoWebhookBody) {
  const phoneNumberId =
    asString(body.phoneNumberId) ||
    asString((body as { phone_number_id?: unknown }).phone_number_id) ||
    asString((body as { phone_number_id?: unknown }).phone_number_id);
  const from =
    asString((body as { from?: unknown }).from) ||
    asString((body as { sender?: unknown }).sender) ||
    asString((body as { contact?: { phone?: unknown } }).contact?.phone);
  const text =
    asString((body as { text?: unknown }).text) ||
    asString((body as { message?: { text?: unknown } }).message?.text) ||
    asString((body as { body?: unknown }).body);
  const messageId =
    asString((body as { message_id?: unknown }).message_id) ||
    asString((body as { message?: { id?: unknown } }).message?.id);
  return { phoneNumberId, from, text, messageId };
}

async function getOrCreateSessionId(supabase: ReturnType<typeof createSupabaseAdminClient>, args: {
  userId: string;
  provider: string;
  threadKey: string;
}) {
  let existing: Array<Record<string, unknown>> = [];
  const { data: selected, error: selectErr } = await supabase
    .from("orchestrator_external_threads")
    .select("orchestrator_session_id,orchestrator_agent_id")
    .eq("user_id", args.userId)
    .eq("provider", args.provider)
    .eq("thread_key", args.threadKey)
    .limit(1);
  existing = Array.isArray(selected) ? (selected as Array<Record<string, unknown>>) : [];
  if (selectErr && /orchestrator_agent_id/i.test(selectErr.message || "")) {
    const { data: legacy } = await supabase
      .from("orchestrator_external_threads")
      .select("orchestrator_session_id")
      .eq("user_id", args.userId)
      .eq("provider", args.provider)
      .eq("thread_key", args.threadKey)
      .limit(1);
    existing = Array.isArray(legacy) ? (legacy as Array<Record<string, unknown>>) : [];
  }
  if (existing.length > 0) {
    const first = existing[0];
    const aid = asString(first.orchestrator_agent_id);
    if (aid) {
      const fromAgent = await getOrCreateRuntimeSessionForAgent({
        supabase,
        userId: args.userId,
        agentId: aid,
        title: "WhatsApp (Kapso)",
      });
      if (fromAgent) return fromAgent;
    }
    const sid = asString(first.orchestrator_session_id);
    if (sid) return sid;
  }
  const { data: session, error: sessionErr } = await supabase
    .from("orchestrator_sessions")
    .insert({
      user_id: args.userId,
      title: "WhatsApp (Kapso)",
    })
    .select("id")
    .single();
  if (sessionErr || !session?.id) {
    throw new Error("Failed to create session");
  }
  await supabase
    .from("orchestrator_external_threads")
    .insert({
      user_id: args.userId,
      provider: args.provider,
      thread_key: args.threadKey,
      orchestrator_session_id: session.id,
      updated_at: new Date().toISOString(),
    });
  return session.id as string;
}

export async function POST(req: Request) {
  if (isSelfHosted()) {
    return NextResponse.json(
      { error: "Kapso webhooks are unavailable in the self-hosted edition" },
      { status: 404 },
    );
  }
  const startedAt = Date.now();
  const webhookEvent = (req.headers.get("x-webhook-event") || "").trim() || null;
  const idempotencyKey = (req.headers.get("x-idempotency-key") || "").trim() || null;
  const payloadVersion = (req.headers.get("x-webhook-payload-version") || "").trim() || null;
  try {
    const rawBody = await req.text();
    const signatureHex = getKapsoSignature(req);
    if (!signatureHex) {
      logWarn("kapso.inbound.missing_signature", { webhook_event: webhookEvent, idempotency_key: idempotencyKey });
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }

    const body = (JSON.parse(rawBody || "null") as KapsoWebhookBody | null) || null;
    if (!body) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

    const { phoneNumberId, from, text } = extractKapsoPayload(body);
    if (!phoneNumberId || !from || !text || !isSafeKapsoId(phoneNumberId)) {
      logWarn("kapso.inbound.missing_fields", {
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
        payload_version: payloadVersion,
        phone_number_id_present: !!phoneNumberId,
        from_present: !!from,
        text_present: !!text,
      });
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    logInfo("kapso.inbound.received", {
      webhook_event: webhookEvent,
      idempotency_key: idempotencyKey,
      payload_version: payloadVersion,
      phone_number_id: phoneNumberId,
      from,
      text_len: text.length,
      text_preview: safeTextPreview(text, 120),
    });

    const supabase = createSupabaseAdminClient();
    const { data: kapsoMatches } = await supabase
      .from("workspace_company_whatsapp")
      .select("workspace_id, kapso_phone_number_id, phone_number_id, webhook_secret")
      .eq("kapso_phone_number_id", phoneNumberId)
      .limit(2);
    let company =
      Array.isArray(kapsoMatches) && kapsoMatches.length === 1 ? kapsoMatches[0] : null;
    if (!company) {
      const { data: phoneMatches } = await supabase
        .from("workspace_company_whatsapp")
        .select("workspace_id, kapso_phone_number_id, phone_number_id, webhook_secret")
        .eq("phone_number_id", phoneNumberId)
        .limit(2);
      company =
        Array.isArray(phoneMatches) && phoneMatches.length === 1 ? phoneMatches[0] : null;
    }
    if (!company) {
      logWarn("kapso.inbound.unknown_company_number", {
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
        phone_number_id: phoneNumberId,
      });
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const secret =
      typeof company.webhook_secret === "string" && company.webhook_secret.trim()
        ? company.webhook_secret.trim()
        : "";
    if (!secret) {
      logError("kapso.inbound.misconfigured_missing_secret", {
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
        workspace_id: company.workspace_id,
      });
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    const valid = verifyKapsoSignature({ rawBody, signatureHex, secret });
    if (!valid) {
      logWarn("kapso.inbound.invalid_signature", {
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
        workspace_id: company.workspace_id,
        phone_number_id: phoneNumberId,
      });
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Check if this is a phone verification message
    const verifyMatch = text.match(/^\s*verify\s+(\d{4,8})\s*$/i);
    if (verifyMatch) {
      const code = verifyMatch[1];
      logInfo("kapso.inbound.verify.attempt", {
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
        workspace_id: company.workspace_id,
        from,
        code_len: code.length,
      });
      const { data: phoneRow } = await supabase
        .from("workspace_member_phones")
        .select("user_id, phone_e164, verification_code")
        .eq("workspace_id", company.workspace_id)
        .eq("phone_e164", from)
        .single();
      if (phoneRow && phoneRow.verification_code === code) {
        await supabase
          .from("workspace_member_phones")
          .update({ verified_at: new Date().toISOString(), verification_code: null })
          .eq("workspace_id", company.workspace_id)
          .eq("user_id", phoneRow.user_id);

        await supabase
          .from("workspace_whatsapp_allowlist")
          .upsert({
            workspace_id: company.workspace_id,
            phone_e164: from,
            user_id: phoneRow.user_id,
            created_by_user_id: phoneRow.user_id,
          }, { onConflict: "workspace_id,phone_e164" });
        await syncWorkspaceAddonSubscriptionBestEffort({
          workspaceId: String(company.workspace_id),
          userId: String(phoneRow.user_id),
          userEmail: null,
          admin: supabase,
          context: "kapso_verify_allowlist_upsert",
        });

        await sendKapsoText({
          phoneNumberId,
          to: from,
          body: "✅ Verified. You can now DM Groovy.",
        });
        logInfo("kapso.inbound.verify.ok", {
          webhook_event: webhookEvent,
          idempotency_key: idempotencyKey,
          workspace_id: company.workspace_id,
          from,
          user_id: phoneRow.user_id,
        });
        return NextResponse.json({ ok: true });
      }
      try {
        await sendKapsoText({
          phoneNumberId,
          to: from,
          body: "❌ Invalid code. Please try again.",
        });
      } catch (e) {
        logWarn("kapso.inbound.verify.reply_failed", {
          webhook_event: webhookEvent,
          idempotency_key: idempotencyKey,
          workspace_id: company.workspace_id,
          from,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      logInfo("kapso.inbound.verify.invalid", {
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
        workspace_id: company.workspace_id,
        from,
      });
      return NextResponse.json({ ok: true });
    }

    const { data: allow } = await supabase
      .from("workspace_whatsapp_allowlist")
      .select("user_id")
      .eq("workspace_id", company.workspace_id)
      .eq("phone_e164", from)
      .single();
    if (!allow?.user_id) {
      logInfo("kapso.inbound.not_allowlisted", {
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
        workspace_id: company.workspace_id,
        from,
      });
      try {
        await sendKapsoText({
          phoneNumberId,
          to: from,
          body: "You are not authorized to message this Groovy workspace.",
        });
      } catch (e) {
        logWarn("kapso.inbound.not_allowlisted.reply_failed", {
          webhook_event: webhookEvent,
          idempotency_key: idempotencyKey,
          workspace_id: company.workspace_id,
          from,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return NextResponse.json({ ok: true, ignored: true });
    }

    // Agent-task approval commands ("approve <task-id-prefix>") short-circuit
    // before an orchestrator round.
    {
      const { executeAgentTaskCommand } = await import("@/lib/orchestrator/agentTasks");
      const command = await executeAgentTaskCommand({
        userId: allow.user_id,
        text,
        decidedBy: "whatsapp_kapso",
      }).catch(() => ({ handled: false as const }));
      if (command.handled) {
        if (command.reply) {
          await sendKapsoText({ phoneNumberId, to: from, body: command.reply }).catch(() => {});
        }
        return NextResponse.json({ ok: true, taskCommand: true });
      }
    }

    const threadKey = `${allow.user_id}:${from}`;
    const sessionId = await getOrCreateSessionId(supabase, {
      userId: allow.user_id,
      provider: "whatsapp_kapso",
      threadKey,
    });
    const runtimeScope = await resolveRuntimeScope({
      supabase,
      userId: allow.user_id,
      sessionId,
      agentId: null,
    });
    if (runtimeScope?.agentId) {
      await supabase
        .from("orchestrator_external_threads")
        .upsert(
          {
            user_id: allow.user_id,
            provider: "whatsapp_kapso",
            thread_key: threadKey,
            orchestrator_session_id: sessionId,
            orchestrator_agent_id: runtimeScope.agentId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,provider,thread_key" }
        );
    }
    logInfo("kapso.inbound.session.resolved", {
      webhook_event: webhookEvent,
      idempotency_key: idempotencyKey,
      workspace_id: company.workspace_id,
      user_id: allow.user_id,
      session_id: sessionId,
      thread_key: threadKey,
    });

    let historyQuery = supabase
      .from("orchestrator_messages")
      .select("role, content")
      .eq("session_id", sessionId);
    if (runtimeScope?.epochId) historyQuery = historyQuery.eq("epoch_id", runtimeScope.epochId);
    const { data: historyRows } = await historyQuery.order("created_at", { ascending: true }).limit(50);
    const history = Array.isArray(historyRows)
      ? historyRows.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
      : [];

    await supabase.from("orchestrator_messages").insert({
      session_id: sessionId,
      user_id: allow.user_id,
      agent_id: runtimeScope?.agentId || null,
      epoch_id: runtimeScope?.epochId || null,
      branch_id: runtimeScope?.branchId || null,
      role: "user",
      content: text,
      metadata: { provider: "whatsapp_kapso", threadKey },
    });
    if (runtimeScope?.branchId) {
      await incrementBranchTurnCount({
        supabase,
        userId: allow.user_id,
        branchId: runtimeScope.branchId,
      }).catch(() => undefined);
    }

    logInfo("kapso.inbound.orchestrator_round.start", {
      webhook_event: webhookEvent,
      idempotency_key: idempotencyKey,
      workspace_id: company.workspace_id,
      user_id: allow.user_id,
      session_id: sessionId,
    });
    // Resolve the user's connector device so local tools work from WhatsApp
    // (full remote control): preferred device from onboarding prefs, else the
    // most recently seen device.
    const deviceId = await resolveUserDeviceId(supabase, allow.user_id);

    const roundArgs = {
      supabase,
      userId: allow.user_id,
      appBaseUrl: getAppUrl(),
      orchestratorAgentId: runtimeScope?.agentId || null,
      orchestratorSessionId: sessionId,
      sourceProvider: "whatsapp_kapso",
      sourceThreadKey: threadKey,
      branchCurrentTurnCount: runtimeScope?.branchTurnCount ?? null,
      branchActiveCount: runtimeScope?.activeBranchCount ?? null,
      deviceId: deviceId || undefined,
      taskNotifyTargets: {
        whatsapp_kapso: { phoneNumberId, to: from },
      },
      taskRequestedChannel: "whatsapp_kapso",
    };

    let round = await runOrchestratorRound({
      ...roundArgs,
      history: [...history, { role: "user", content: text }],
      message: text,
    });

    // Bounded connector loop: previously `needs_connector` rounds were dropped
    // (Kapso replies could never drive local tools). Execute them over the
    // relay internal RPC and continue the round with the tool results.
    const MAX_CONNECTOR_ROUNDS = 6;
    let loopHistory = [...history, { role: "user" as const, content: text }];
    for (
      let i = 0;
      round.kind === "needs_connector" && deviceId && i < MAX_CONNECTOR_ROUNDS;
      i++
    ) {
      const { callConnectorRpcViaRelay } = await import("@/lib/relay/connectorRpc");
      const toolResults: Array<{ toolCallId: string; toolName: string; result: string }> = [];
      for (const execute of round.connectorExecutes) {
        let rpcResult: Record<string, unknown>;
        try {
          rpcResult = await callConnectorRpcViaRelay({
            userId: allow.user_id,
            deviceId,
            rpcType: execute.connectorType,
            payload: execute.connectorParams,
            timeoutMs: execute.connectorType === "claude_run" ? 10 * 60 * 1000 : 3 * 60 * 1000,
          });
        } catch (error) {
          rpcResult = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        toolResults.push({
          toolCallId: execute.toolCallId,
          toolName: execute.toolName,
          result: JSON.stringify(rpcResult),
        });
      }
      const resultsMessage = {
        role: "user" as const,
        content: `[SYSTEM: Tool execution results from the local connector]\n\n${toolResults
          .map((tr) => `<tool_result name="${tr.toolName}" tool_call_id="${tr.toolCallId}">\n${tr.result.slice(0, 8000)}\n</tool_result>`)
          .join("\n\n")}`,
      };
      loopHistory = [...loopHistory, resultsMessage];
      round = await runOrchestratorRound({
        ...roundArgs,
        history: loopHistory,
        message: "",
        toolResults,
        traceId: round.traceId,
      });
    }
    const runtimeScopeAfterRound = await resolveRuntimeScope({
      supabase,
      userId: allow.user_id,
      sessionId,
      agentId: runtimeScope?.agentId || null,
    }).catch(() => runtimeScope);
    logInfo("kapso.inbound.orchestrator_round.done", {
      webhook_event: webhookEvent,
      idempotency_key: idempotencyKey,
      workspace_id: company.workspace_id,
      user_id: allow.user_id,
      session_id: sessionId,
      kind: round.kind,
      duration_ms: Date.now() - startedAt,
    });

    if (round.kind === "final") {
      await supabase.from("orchestrator_messages").insert({
        session_id: sessionId,
        user_id: allow.user_id,
        agent_id: runtimeScopeAfterRound?.agentId || runtimeScope?.agentId || null,
        epoch_id: runtimeScopeAfterRound?.epochId || runtimeScope?.epochId || null,
        branch_id: runtimeScopeAfterRound?.branchId || runtimeScope?.branchId || null,
        role: "assistant",
        content: round.text || "",
        metadata: { provider: "whatsapp_kapso", threadKey },
      });
      await sendKapsoText({
        phoneNumberId,
        to: from,
        body: round.text || "",
      });
    } else {
      // Never leave the user in silence: the round still needs local tools we
      // couldn't reach (no device / offline / round budget exhausted).
      const fallback =
        (round.kind === "needs_connector" && round.partialText?.trim()) ||
        (deviceId
          ? "I started working on this but couldn't finish with your machine's tools right now — I'll need you to try again in a moment."
          : "This needs your machine, but no connector device is online. Open Groovy Desktop (or start the connector) and try again.");
      await supabase.from("orchestrator_messages").insert({
        session_id: sessionId,
        user_id: allow.user_id,
        agent_id: runtimeScopeAfterRound?.agentId || runtimeScope?.agentId || null,
        epoch_id: runtimeScopeAfterRound?.epochId || runtimeScope?.epochId || null,
        branch_id: runtimeScopeAfterRound?.branchId || runtimeScope?.branchId || null,
        role: "assistant",
        content: fallback,
        metadata: { provider: "whatsapp_kapso", threadKey, kind: "connector_fallback" },
      });
      await sendKapsoText({ phoneNumberId, to: from, body: fallback }).catch(() => {});
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook error";
    logError("kapso.inbound.error", {
      webhook_event: webhookEvent,
      idempotency_key: idempotencyKey,
      payload_version: payloadVersion,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
