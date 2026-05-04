import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { randomUUID } from "crypto";
import { resolveWorkspaceTokenBillingPolicy } from "@/lib/billing/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function requireEnv(name: string) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function stripeCreateMeterEvent(args: {
  stripeSecretKey: string;
  eventName: string;
  stripeCustomerId: string;
  value: number;
  identifier: string;
  timestamp: number; // seconds
  idempotencyKey: string;
}): Promise<{ ok: true; identifier: string } | { ok: false; status: number; error: string }> {
  const params = new URLSearchParams();
  params.set("event_name", args.eventName);
  params.set("payload[value]", String(args.value));
  params.set("payload[stripe_customer_id]", args.stripeCustomerId);
  params.set("identifier", args.identifier);
  params.set("timestamp", String(args.timestamp));

  const res = await fetch("https://api.stripe.com/v1/billing/meter_events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": args.idempotencyKey,
    },
    body: params,
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: text.slice(0, 2000) };
  }

  try {
    const json = JSON.parse(text) as { identifier?: unknown };
    const identifier = typeof json.identifier === "string" && json.identifier ? json.identifier : args.identifier;
    return { ok: true, identifier };
  } catch {
    return { ok: true, identifier: args.identifier };
  }
}

async function handle(req: Request) {
  if (process.env.BILLING_STRIPE_METER_FLUSH_ENABLED !== "1") {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "meter_flush_disabled",
    });
  }

  const secret = requireEnv("BILLING_FLUSH_SECRET");
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "missing_billing_flush_secret" },
      { status: 500 }
    );
  }

  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const stripeSecretKey = requireEnv("STRIPE_SECRET_KEY");
  const eventName =
    requireEnv("STRIPE_METER_EVENT_NAME_TOKENS") ||
    requireEnv("STRIPE_METER_EVENT_NAME") ||
    null;
  if (!stripeSecretKey || !eventName) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_stripe_env",
        missing: {
          STRIPE_SECRET_KEY: !stripeSecretKey,
          STRIPE_METER_EVENT_NAME_TOKENS: !requireEnv("STRIPE_METER_EVENT_NAME_TOKENS") && !requireEnv("STRIPE_METER_EVENT_NAME"),
        },
      },
      { status: 500 }
    );
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const maxWorkspaces = Math.max(1, Math.min(50, Number(url.searchParams.get("maxWorkspaces") || "10")));
  const maxEventsPerWorkspace = Math.max(
    100,
    Math.min(20_000, Number(url.searchParams.get("maxEventsPerWorkspace") || "5000"))
  );
  const scanLimit = Math.max(100, Math.min(50_000, Number(url.searchParams.get("scanLimit") || "5000")));

  const supabase = createSupabaseAdminClient();
  const cutoffIso = new Date(Date.now() - 15_000).toISOString(); // safety buffer (avoid racing very-new inserts)

  const { data: scanRows, error: scanErr } = await supabase
    .from("billing_usage_events")
    .select("workspace_id")
    .eq("billable", true)
    .eq("charge_type", "groovy_key")
    .is("stripe_sent_at", null)
    .not("total_tokens", "is", null)
    .gt("total_tokens", 0)
    .lte("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(scanLimit);

  if (scanErr) {
    return NextResponse.json({ ok: false, error: scanErr.message }, { status: 500 });
  }

  const workspaceIds: string[] = [];
  const seen = new Set<string>();
  for (const r of scanRows || []) {
    const wsId = (r as unknown as { workspace_id?: unknown }).workspace_id;
    if (typeof wsId !== "string" || !wsId) continue;
    if (seen.has(wsId)) continue;
    seen.add(wsId);
    workspaceIds.push(wsId);
    if (workspaceIds.length >= maxWorkspaces) break;
  }

  const results: Array<{
    workspaceId: string;
    status: "sent" | "skipped" | "error" | "dry_run";
    tokens?: number;
    stripeCustomerId?: string;
    stripeIdentifier?: string;
    window?: { start: string; end: string };
    error?: string;
  }> = [];

  for (const workspaceId of workspaceIds) {
    const tokenBillingPolicy = await resolveWorkspaceTokenBillingPolicy({
      workspaceId,
      admin: supabase,
    });
    if (!tokenBillingPolicy.tokenConsumptionBillingEnabled) {
      results.push({
        workspaceId,
        status: "skipped",
        error: tokenBillingPolicy.reason,
      });
      continue;
    }

    // Prefer retrying an existing pending/error window first.
    const { data: pendingWindow } = await supabase
      .from("billing_stripe_flush_windows")
      .select("id, window_start, window_end, total_tokens, stripe_idempotency_key, usage_event_ids, status")
      .eq("workspace_id", workspaceId)
      .in("status", ["pending", "error"])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    const pending =
      pendingWindow && typeof pendingWindow === "object" ? (pendingWindow as Record<string, unknown>) : null;
    const windowStart =
      pending && typeof pending.window_start === "string" ? pending.window_start : null;
    const windowEnd =
      pending && typeof pending.window_end === "string" ? pending.window_end : null;
    const pendingWindowId =
      pending && typeof pending.id === "string" ? pending.id : null;
    const pendingEventIds =
      pending && Array.isArray(pending.usage_event_ids)
        ? pending.usage_event_ids
            .filter((v): v is string => typeof v === "string" && !!v.trim())
            .map((v) => v.trim())
        : [];
    const windowTokensRaw = pending ? Number(pending.total_tokens) : NaN;
    const windowTokens = Number.isFinite(windowTokensRaw) ? windowTokensRaw : null;
    const idempotencyKey =
      pending && typeof pending.stripe_idempotency_key === "string"
        ? pending.stripe_idempotency_key
        : null;

    // Resolve Stripe customer for this workspace
    const { data: wsRow, error: wsErr } = await supabase
      .from("workspaces")
      .select("stripe_customer_id")
      .eq("id", workspaceId)
      .maybeSingle();
    if (wsErr) {
      results.push({ workspaceId, status: "error", error: wsErr.message });
      continue;
    }
    const wsRec = wsRow && typeof wsRow === "object" ? (wsRow as Record<string, unknown>) : null;
    const stripeCustomerId =
      wsRec && typeof wsRec.stripe_customer_id === "string" ? wsRec.stripe_customer_id.trim() : "";
    if (!stripeCustomerId) {
      results.push({ workspaceId, status: "skipped", error: "missing_stripe_customer_id" });
      continue;
    }

    // If no pending window, create a new one from unsent rows.
    let eventIds: string[] = pendingEventIds;
    let totalTokens = windowTokens;
    let startIso = windowStart;
    let endIso = windowEnd;
    let idem = idempotencyKey;

    if (!pendingWindow) {
      const { data: rows, error: rowsErr } = await supabase
        .from("billing_usage_events")
        .select("id, created_at, total_tokens")
        .eq("workspace_id", workspaceId)
        .eq("billable", true)
        .eq("charge_type", "groovy_key")
        .is("stripe_sent_at", null)
        .not("total_tokens", "is", null)
        .gt("total_tokens", 0)
        .lte("created_at", cutoffIso)
        .order("created_at", { ascending: true })
        .limit(maxEventsPerWorkspace);

      if (rowsErr) {
        results.push({ workspaceId, status: "error", error: rowsErr.message });
        continue;
      }

      const cleaned = (rows || []).filter((r) => {
        if (!r || typeof r !== "object") return false;
        const rec = r as Record<string, unknown>;
        return typeof rec.id === "string" && typeof rec.created_at === "string";
      });
      if (cleaned.length === 0) {
        results.push({ workspaceId, status: "skipped" });
        continue;
      }

      eventIds = cleaned.map((r) => String((r as Record<string, unknown>).id));
      startIso = String((cleaned[0] as Record<string, unknown>).created_at);
      endIso = String((cleaned[cleaned.length - 1] as Record<string, unknown>).created_at);
      totalTokens = cleaned.reduce((sum, r) => {
        const n = Number((r as Record<string, unknown>).total_tokens);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0);

      idem = `bm_${randomUUID()}`;

      const { error: insErr } = await supabase
        .from("billing_stripe_flush_windows")
        .insert({
          workspace_id: workspaceId,
          window_start: startIso,
          window_end: endIso,
          total_tokens: totalTokens,
          usage_event_ids: eventIds,
          stripe_idempotency_key: idem,
          status: "pending",
        });

      if (insErr) {
        results.push({ workspaceId, status: "error", error: insErr.message });
        continue;
      }
    }

    // Legacy/backfill path: if pending window has no stored event IDs,
    // reconstruct from unsent rows in the same window and pin IDs now.
    if (pendingWindow && eventIds.length === 0 && startIso && endIso) {
      const { data: reconstructedRows, error: reconstructedErr } = await supabase
        .from("billing_usage_events")
        .select("id, total_tokens")
        .eq("workspace_id", workspaceId)
        .eq("billable", true)
        .eq("charge_type", "groovy_key")
        .is("stripe_sent_at", null)
        .gte("created_at", startIso)
        .lte("created_at", endIso)
        .order("created_at", { ascending: true })
        .limit(maxEventsPerWorkspace);

      if (reconstructedErr) {
        results.push({ workspaceId, status: "error", error: reconstructedErr.message });
        continue;
      }

      const reconstructed = (reconstructedRows || []).filter((r) => {
        if (!r || typeof r !== "object") return false;
        const rec = r as Record<string, unknown>;
        return typeof rec.id === "string";
      });

      eventIds = reconstructed.map((r) => String((r as Record<string, unknown>).id));
      const reconstructedTotal = reconstructed.reduce((sum, r) => {
        const n = Number((r as Record<string, unknown>).total_tokens);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0);

      if (typeof totalTokens !== "number" || totalTokens <= 0) {
        totalTokens = reconstructedTotal;
      } else if (reconstructedTotal > 0 && reconstructedTotal !== totalTokens) {
        results.push({
          workspaceId,
          status: "error",
          error: `pending_window_token_mismatch:expected=${totalTokens};reconstructed=${reconstructedTotal}`,
        });
        continue;
      }

      if (pendingWindowId && eventIds.length > 0) {
        await supabase
          .from("billing_stripe_flush_windows")
          .update({ usage_event_ids: eventIds })
          .eq("id", pendingWindowId);
      }
    }

    if (!startIso || !endIso || typeof totalTokens !== "number" || totalTokens <= 0 || !idem) {
      results.push({ workspaceId, status: "skipped", error: "no_tokens_to_flush" });
      continue;
    }
    if (eventIds.length === 0) {
      if (pendingWindowId) {
        await supabase
          .from("billing_stripe_flush_windows")
          .update({ status: "error", error: "missing_usage_event_ids" })
          .eq("id", pendingWindowId);
      }
      results.push({ workspaceId, status: "error", error: "missing_usage_event_ids" });
      continue;
    }

    if (dryRun) {
      results.push({
        workspaceId,
        status: "dry_run",
        tokens: totalTokens,
        stripeCustomerId,
        stripeIdentifier: idem,
        window: { start: startIso, end: endIso },
      });
      continue;
    }

    const ts = Math.floor(new Date(endIso).getTime() / 1000) || Math.floor(Date.now() / 1000);
    const stripeRes = await stripeCreateMeterEvent({
      stripeSecretKey,
      eventName,
      stripeCustomerId,
      value: Math.trunc(totalTokens),
      identifier: idem,
      timestamp: ts,
      idempotencyKey: idem,
    });

    if (!stripeRes.ok) {
      await supabase
        .from("billing_stripe_flush_windows")
        .update({
          status: "error",
          error: `stripe:${stripeRes.status}:${stripeRes.error.slice(0, 1000)}`,
        })
        .eq("stripe_idempotency_key", idem);
      results.push({
        workspaceId,
        status: "error",
        tokens: totalTokens,
        stripeCustomerId,
        stripeIdentifier: idem,
        window: { start: startIso, end: endIso },
        error: `stripe:${stripeRes.status}`,
      });
      continue;
    }

    // Mark window as sent
    await supabase
      .from("billing_stripe_flush_windows")
      .update({
        status: "sent",
        stripe_event_id: stripeRes.identifier,
        sent_at: new Date().toISOString(),
        error: null,
      })
      .eq("stripe_idempotency_key", idem);

    // Mark usage events as sent (prefer explicit ids when available)
    const nowIso = new Date().toISOString();
    await supabase
      .from("billing_usage_events")
      .update({
        stripe_sent_at: nowIso,
        stripe_event_id: stripeRes.identifier,
        stripe_error: null,
      })
      .in("id", eventIds);

    results.push({
      workspaceId,
      status: "sent",
      tokens: totalTokens,
      stripeCustomerId,
      stripeIdentifier: stripeRes.identifier,
      window: { start: startIso, end: endIso },
    });
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    cutoffIso,
    workspacesScanned: workspaceIds.length,
    results,
  });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
