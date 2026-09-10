import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import { loadGmailMailboxes } from "@/lib/email/gmail";
import { supportsProgressiveEmailSnapshot } from "@/lib/email/feedOptimistic";
import { withEmailProviderRequest } from "@/lib/email/providerRuntime";
import { loadEmailFeed } from "@/lib/email/service";
import type { EmailView } from "@/lib/email/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function viewFrom(value: string | null): EmailView {
  return value === "inbox" ||
    value === "sent" ||
    value === "noise" ||
    value === "handled" ||
    value === "all" ||
    value === "focus"
    ? value
    : "focus";
}

function focusActionDelta(url: URL, view: EmailView): {
  actionIds: string[];
  updatedAfter: string | null;
} {
  const sync = url.searchParams.get("sync");
  if (
    view !== "focus" ||
    (sync !== "notification" && sync !== "delta")
  ) {
    return { actionIds: [], updatedAfter: null };
  }
  const maxActionIds = sync === "notification" ? 12 : 50;
  const actionIds = Array.from(
    new Set(
      url.searchParams
        .getAll("actionId")
        .map((value) => value.trim())
        .filter((value) => /^[a-zA-Z0-9_-]{6,128}$/.test(value)),
    ),
  ).slice(0, maxActionIds);
  const rawUpdatedAfter = url.searchParams.get("updatedAfter")?.trim() || "";
  const parsedUpdatedAfter = Date.parse(rawUpdatedAfter);
  const earliestUpdatedAfter = Date.now() - 7 * 24 * 60 * 60_000;
  const updatedAfter =
    sync === "delta" && Number.isFinite(parsedUpdatedAfter)
      ? new Date(Math.max(earliestUpdatedAfter, parsedUpdatedAfter)).toISOString()
      : null;
  return { actionIds, updatedAfter };
}

function feedRequestScope(args: {
  view: EmailView;
  connectionId: string | null;
  limit: number;
  cursor: string | null;
}): string {
  return `feed:${args.view}:${createHash("sha256")
    .update(JSON.stringify(args))
    .digest("hex")
    .slice(0, 32)}`;
}

export async function GET(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") || 24);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(100, Math.max(1, Math.floor(requestedLimit)))
    : 24;
  const view = viewFrom(url.searchParams.get("view"));
  const focusDelta = focusActionDelta(url, view);
  const hasFocusDelta =
    focusDelta.actionIds.length > 0 || Boolean(focusDelta.updatedAfter);
  const snapshot =
    url.searchParams.get("sync") === "snapshot" &&
    supportsProgressiveEmailSnapshot(view) &&
    !url.searchParams.get("cursor");
  try {
    const mailboxes = await loadGmailMailboxes({
      supabase: auth.supabase,
      userId: auth.userId,
      verifyProfile: false,
    });
    const connectionId = url.searchParams.get("connectionId");
    const cursor = url.searchParams.get("cursor");
    const bypassProviderCache = url.searchParams.get("refresh") === "force";
    const liveSync = !(snapshot || hasFocusDelta);
    const load = () =>
      loadEmailFeed({
        supabase: auth.supabase,
        userId: auth.userId,
        mailboxes,
        view,
        connectionId,
        limit,
        cursor,
        liveSync,
        notificationActionIds: focusDelta.actionIds,
        actionUpdatedAfter: focusDelta.updatedAfter,
        signal: request.signal,
      });
    const coordinated = liveSync
      ? await withEmailProviderRequest({
          supabase: auth.supabase,
          userId: auth.userId,
          scope: feedRequestScope({ view, connectionId, limit, cursor }),
          execute: load,
          leaseMs: 60_000,
          // An explicit refresh bypasses the ordinary 10-second snapshot but
          // keeps a one-second window so two simultaneous clicks/windows still
          // share the provider response instead of running back-to-back.
          freshMs: bypassProviderCache ? 1_000 : 10_000,
          staleMs: 30_000,
          waitMs: 4_000,
          retryAfterMsFromValue: (feed) =>
            Math.max(0, feed.providerRetryAfterMs || 0),
        })
      : { value: await load(), disposition: "live" as const };
    const feed = coordinated.value;
    return NextResponse.json(
      { ok: true, ...feed },
      {
        headers: {
          // Lets the service worker isolate its background snapshot by the
          // authenticated account without exposing this value in the payload.
          "X-Groovy-Email-Cache-Scope": auth.userId,
          ...(hasFocusDelta
            ? { "X-Groovy-Email-Snapshot-Kind": "notification" }
            : {}),
          "X-Groovy-Email-Provider-Result": coordinated.disposition,
        },
      },
    );
  } catch (error) {
    return jsonError(error, "Could not load the email workspace.");
  }
}
