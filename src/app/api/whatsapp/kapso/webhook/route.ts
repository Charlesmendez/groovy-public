import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runOrchestratorRound } from "@/lib/orchestrator/runOrchestratorRound";
import {
  getOrCreateRuntimeSessionForAgent,
  incrementBranchTurnCount,
  resolveRuntimeScope,
} from "@/lib/orchestrator/runtimeGraph";
import { sendKapsoText } from "@/lib/whatsapp/kapso";
import { createHmac, timingSafeEqual } from "crypto";
import { logError, logInfo, logWarn, safeTextPreview } from "@/lib/observability/log";
import { syncWorkspaceAddonSubscriptionBestEffort } from "@/lib/billing/addons";

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
    if (!phoneNumberId || !from || !text) {
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
    const { data: company } = await supabase
      .from("workspace_company_whatsapp")
      .select("workspace_id, kapso_phone_number_id, phone_number_id, webhook_secret")
      .or(`kapso_phone_number_id.eq.${phoneNumberId},phone_number_id.eq.${phoneNumberId}`)
      .single();
    if (!company) {
      logWarn("kapso.inbound.unknown_company_number", {
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
        phone_number_id: phoneNumberId,
      });
      return NextResponse.json({ error: "Unknown company number" }, { status: 404 });
    }

    const secret =
      (typeof company.webhook_secret === "string" && company.webhook_secret.trim()
        ? company.webhook_secret.trim()
        : "") ||
      (process.env.KAPSO_WEBHOOK_SECRET || "").trim();
    if (!secret) {
      logError("kapso.inbound.misconfigured_missing_secret", {
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
        workspace_id: company.workspace_id,
      });
      return NextResponse.json(
        { error: "Missing KAPSO_WEBHOOK_SECRET" },
        { status: 500 }
      );
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
    const round = await runOrchestratorRound({
      supabase,
      userId: allow.user_id,
      // Keep delegated internal calls on the live request origin for this webhook hit.
      appBaseUrl: new URL(req.url).origin,
      history: [...history, { role: "user", content: text }],
      message: text,
      orchestratorAgentId: runtimeScope?.agentId || null,
      orchestratorSessionId: sessionId,
      branchCurrentTurnCount: runtimeScope?.branchTurnCount ?? null,
      branchActiveCount: runtimeScope?.activeBranchCount ?? null,
    });
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
