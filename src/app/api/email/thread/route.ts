import { NextResponse } from "next/server";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import {
  fetchGmailThread,
  gmailItemDirection,
  hydrateGmailMailboxProfile,
  loadGmailMailboxes,
  parseEmailAddresses,
  publicMailbox,
  resolveGmailThreadSummaryAnchor,
} from "@/lib/email/gmail";
import {
  draftFromRow,
  loadEmailOpenStatusForThread,
  summaryFromGmail,
} from "@/lib/email/service";
import { compactEmailThreadDetailForTransport } from "@/lib/email/payloadLimits";
import type { EmailThreadDetail } from "@/lib/email/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId")?.trim() || "";
  const threadId = url.searchParams.get("threadId")?.trim() || "";
  const actionId = url.searchParams.get("actionId")?.trim() || "";
  const messageId = url.searchParams.get("messageId")?.trim() || "";
  const mailboxAddress =
    parseEmailAddresses(url.searchParams.get("mailboxAddress") || "")[0] || "";
  const ownedAddressHints = Array.from(
    new Set(
      url.searchParams
        .getAll("ownedAddress")
        .flatMap((value) => parseEmailAddresses(value)),
    ),
  );
  const sentView =
    url.searchParams.get("view") === "sent" ||
    (url.searchParams.get("direction") === "outgoing" && !actionId);
  if (!connectionId || !threadId) {
    return NextResponse.json(
      { ok: false, error: "connectionId and threadId are required." },
      { status: 400 },
    );
  }
  try {
    const mailboxesPromise = loadGmailMailboxes({
      supabase: auth.supabase,
      userId: auth.userId,
      verifyProfile: false,
    });
    const actionResultPromise = sentView
      ? Promise.resolve({ data: null, error: null })
      : actionId
        ? auth.supabase
            .from("inbox_actions")
            .select("*")
            .eq("id", actionId)
            .eq("user_id", auth.userId)
            .eq("connection_id", connectionId)
            .maybeSingle()
        : messageId
          ? auth.supabase
              .from("inbox_actions")
              .select("*")
              .eq("user_id", auth.userId)
              .eq("connection_id", connectionId)
              .eq("gmail_message_id", messageId)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle()
          : auth.supabase
            .from("inbox_actions")
            .select("*")
            .eq("user_id", auth.userId)
            .eq("connection_id", connectionId)
            .eq("gmail_thread_id", threadId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
    const openStatusPromise = sentView
      ? loadEmailOpenStatusForThread({
          supabase: auth.supabase,
          userId: auth.userId,
          connectionId,
          threadId,
          messageId,
        })
      : Promise.resolve(null);
    const mailboxes = await mailboxesPromise;
    const ownedMailbox =
      mailboxes.find((item) => item.connectionId === connectionId) || null;
    if (!ownedMailbox) {
      return NextResponse.json(
        { ok: false, error: "Mailbox not found." },
        { status: 404 },
      );
    }
    const provisionalMailbox = mailboxAddress
      ? { ...ownedMailbox, address: mailboxAddress }
      : ownedMailbox;
    const mailbox = provisionalMailbox.address
      ? provisionalMailbox
      : await hydrateGmailMailboxProfile({
          userId: auth.userId,
          mailbox: provisionalMailbox,
          priority: "interactive",
        });
    if (mailbox.status !== "connected") {
      return NextResponse.json(
        {
          ok: false,
          error:
            mailbox.status === "reauth_required"
              ? "Reconnect this mailbox to open its messages."
              : "This mailbox is temporarily unavailable.",
        },
        { status: 409 },
      );
    }
    const threadPromise = fetchGmailThread({
      mailbox,
      threadId,
      ownedAddresses: Array.from(
        new Set([mailbox.address, ...ownedAddressHints].filter(Boolean)),
      ),
      // Opening a conversation is always a person waiting on the result, so it
      // must not queue behind background feed hydration or be shed by the
      // shared rate-limit guard.
      priority: "interactive",
    });
    const actionResult = await actionResultPromise;
    if (actionResult.error) throw new Error(actionResult.error.message);
    const actionRow =
      actionResult.data &&
      typeof actionResult.data === "object" &&
      !Array.isArray(actionResult.data)
        ? (actionResult.data as Record<string, unknown>)
        : undefined;
    const ownedAddresses = Array.from(
      new Set(
        [
          auth.email,
          mailbox.address,
          ...ownedAddressHints,
        ].filter(Boolean),
      ),
    );
    const draft = actionRow
      ? draftFromRow(actionRow, { ownedAddresses })
      : null;
    const [thread, openStatus] = await Promise.all([
      threadPromise,
      openStatusPromise,
    ]);
    if (actionRow && actionId) {
      const actionThreadId =
        typeof actionRow.gmail_thread_id === "string"
          ? actionRow.gmail_thread_id.trim()
          : "";
      const actionMessageId =
        typeof actionRow.gmail_message_id === "string"
          ? actionRow.gmail_message_id.trim()
          : "";
      const belongsToThread =
        actionThreadId
          ? actionThreadId === threadId
          : !actionMessageId ||
            !messageId ||
            actionMessageId === messageId;
      if (!belongsToThread) {
        return NextResponse.json(
          { ok: false, error: "This action belongs to another conversation." },
          { status: 409 },
        );
      }
    }
    const summaryAnchor = resolveGmailThreadSummaryAnchor({
      items: thread.items,
      latest: thread.latest,
      requestedMessageId: messageId,
    });
    if (!summaryAnchor) {
      return NextResponse.json(
        { ok: false, error: "This message is no longer in the conversation." },
        { status: 409 },
      );
    }
    const summary = summaryFromGmail(
      summaryAnchor,
      publicMailbox(mailbox),
      actionRow,
      {
        // A Sent search can return a conversation whose newest message is a
        // later inbound reply. Preserve the anchor's real direction instead
        // of presenting that reply as something the user sent.
        direction: gmailItemDirection(summaryAnchor, [
          mailbox.address,
          ...ownedAddressHints,
        ]),
        openStatus,
      },
    );
    const detail: EmailThreadDetail = {
      summary: { ...summary, draft: draft || summary.draft },
      messages: thread.messages,
      replyAll: thread.replyAll,
      draft: draft || summary.draft,
    };
    return NextResponse.json(
      {
        ok: true,
        thread: compactEmailThreadDetailForTransport(detail, messageId),
      },
      {
        headers: {
          // Lets the service worker key its background body prefetch by the
          // authenticated account without exposing the id in the payload.
          "X-Groovy-Email-Cache-Scope": auth.userId,
        },
      },
    );
  } catch (error) {
    return jsonError(error, "Could not load this conversation.");
  }
}
