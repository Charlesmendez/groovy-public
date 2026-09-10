import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isSchedulerCronAuthorized } from "@/lib/scheduler/cronAuth";
import { HomeInboxError } from "@/lib/homeInbox/contracts";
import { bindingResponseError } from "@/lib/homeInbox/http";
import { consumerEnabled, createDecisionWorker } from "@/lib/homeInbox/runtime";
import {
  bindingFromRow,
  pendingReceipt,
  reconcileAbandonedDecisions,
  type BindingRow,
} from "@/lib/homeInbox/store";
import { consumeDecision, deliverSavedDecision } from "@/lib/homeInbox/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

// Not registered in deployment cron until the release/readiness checklist is
// complete. This drains Inbox's already-due work; it creates no schedules.
export async function POST(req: Request) {
  if (!isSchedulerCronAuthorized(req))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!consumerEnabled())
    return NextResponse.json({ enabled: false, processed: 0 });
  try {
    const admin = createSupabaseAdminClient();
    await reconcileAbandonedDecisions(admin);
    const loaded = await admin
      .from("home_inbox_bindings")
      .select("*")
      .eq("status", "active")
      .order("last_polled_at", { nullsFirst: true })
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (loaded.error)
      throw new HomeInboxError(
        "binding_load_failed",
        "Could not select a Home connection.",
        503,
      );
    if (!loaded.data) return NextResponse.json({ enabled: true, processed: 0 });
    const binding = bindingFromRow(loaded.data as BindingRow);
    const polled = await admin
      .from("home_inbox_bindings")
      .update({ last_polled_at: new Date().toISOString() })
      .eq("id", binding.id)
      .eq("status", "active");
    if (polled.error)
      throw new HomeInboxError(
        "poll_not_persisted",
        "Could not record the connection poll.",
        503,
      );
    const deps = createDecisionWorker(admin, binding);
    await deps.authorize();
    const receipt = await pendingReceipt(admin, binding);
    if (receipt)
      return NextResponse.json({
        enabled: true,
        processed: 1,
        state: await deliverSavedDecision(receipt, deps),
      });
    const items = await deps.home.list(10);
    for (const item of items) {
      const state = await consumeDecision(item, deps);
      if (state !== "already_reserved" && state !== "expired")
        return NextResponse.json({ enabled: true, processed: 1, state });
    }
    return NextResponse.json({ enabled: true, processed: 0, state: "idle" });
  } catch (error) {
    return bindingResponseError(error);
  }
}
