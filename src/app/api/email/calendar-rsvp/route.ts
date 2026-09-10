import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import { emailActionBelongsToConversation } from "@/lib/email/actionState";
import {
  CalendarInvitationAccountNotConnectedError,
  CalendarInvitationPendingError,
  respondToCalendarInvitation,
} from "@/lib/email/calendarRsvp";
import {
  ensureGroovyGmailLabels,
  fetchGmailCalendarInvitation,
  findOwnedGmailMailbox,
  GmailCalendarInvitationPayloadError,
  GROOVY_EMAIL_LABELS,
  hydrateGmailMailboxProfile,
  modifyGmailThreadLabels,
} from "@/lib/email/gmail";
import type { EmailCalendarResponseStatus } from "@/lib/email/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RecordLike = Record<string, unknown>;
type CalendarRsvpStatus = Exclude<
  EmailCalendarResponseStatus,
  "needsAction"
>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

function responseStatus(value: unknown): CalendarRsvpStatus | null {
  const normalized = text(value);
  return normalized === "accepted" ||
    normalized === "tentative" ||
    normalized === "declined"
    ? normalized
    : null;
}

function diagnosticHash(value: string): string {
  return createHash("sha256")
    .update(value.trim().toLowerCase(), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function gmailThreadUrl(email: string, threadId: string): string | null {
  if (!email || !threadId) return null;
  return (
    `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}` +
    `#all/${encodeURIComponent(threadId)}`
  );
}

export async function POST(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => null)) as RecordLike | null;
  const connectionId = text(body?.connectionId);
  const threadId = text(body?.threadId);
  const messageId = text(body?.messageId);
  const actionId = text(body?.actionId);
  const status = responseStatus(body?.responseStatus);
  if (!connectionId || !threadId || !messageId || !status) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "connectionId, threadId, messageId and a valid responseStatus are required.",
      },
      { status: 400 },
    );
  }
  const requestId = randomUUID();
  const connectionIdHash = diagnosticHash(connectionId);
  const messageIdHash = diagnosticHash(messageId);
  let verifiedMailboxAddress = "";

  try {
    const provisionalMailbox = await findOwnedGmailMailbox({
      supabase: auth.supabase,
      userId: auth.userId,
      connectionId,
    });
    if (!provisionalMailbox) {
      return NextResponse.json(
        { ok: false, error: "Mailbox not found." },
        { status: 404 },
      );
    }
    const mailbox = await hydrateGmailMailboxProfile({
      userId: auth.userId,
      mailbox: provisionalMailbox,
    });
    if (mailbox.status !== "connected" || !mailbox.address) {
      return NextResponse.json(
        {
          ok: false,
          error:
            mailbox.status === "reauth_required"
              ? "Reconnect this Gmail mailbox before responding to calendar invitations."
              : "Could not verify the Gmail account that received this invitation. Refresh or reconnect the mailbox, then retry.",
        },
        { status: 409 },
      );
    }
    verifiedMailboxAddress = mailbox.address.trim().toLowerCase();

    let action: RecordLike | null = null;
    if (actionId) {
      const result = await auth.supabase
        .from("inbox_actions")
        .select("id,metadata,gmail_thread_id,gmail_message_id")
        .eq("id", actionId)
        .eq("user_id", auth.userId)
        .eq("connection_id", connectionId)
        .maybeSingle();
      if (result.error) throw new Error(result.error.message);
      if (!result.data) {
        return NextResponse.json(
          { ok: false, error: "Email action not found." },
          { status: 404 },
        );
      }
      if (
        !emailActionBelongsToConversation({
          storedThreadId: text(result.data.gmail_thread_id),
          storedMessageId: text(result.data.gmail_message_id),
          requestedThreadId: threadId,
          requestedMessageId: messageId,
        })
      ) {
        return NextResponse.json(
          { ok: false, error: "This action belongs to another conversation." },
          { status: 409 },
        );
      }
      action = result.data as RecordLike;
    }

    const invitation = await fetchGmailCalendarInvitation({
      mailbox,
      messageId,
      threadId,
    });
    const invite = await respondToCalendarInvitation({
      supabase: auth.supabase,
      userId: auth.userId,
      iCalUid: invitation.uid,
      attendeeEmail: mailbox.address,
      responseStatus: status,
      onDiagnostic: (diagnostic) => {
        console.info("[email/calendar-rsvp] lookup", {
          requestId,
          connectionIdHash,
          messageIdHash,
          ...diagnostic,
        });
      },
    });
    const now = new Date().toISOString();
    const receivedAt = text(body?.receivedAt);
    const safeReceivedAt = Number.isFinite(Date.parse(receivedAt))
      ? new Date(receivedAt).toISOString()
      : null;
    const metadata = {
      ...record(action?.metadata),
      calendar_invite_detected: true,
      calendar_invite_verified: true,
      calendar_invite: invite,
      calendar_rsvp_status: invite.responseStatus,
      calendar_rsvp_responded_at: now,
      calendar_rsvp_source: "email_workspace",
      email_workspace_override_view: "handled",
      email_workspace_corrected_at: now,
      email_workspace_user_action: "calendar_rsvp",
    };

    if (action) {
      const updated = await auth.supabase
        .from("inbox_actions")
        .update({
          status: "done",
          executed_at: now,
          metadata,
          updated_at: now,
        })
        .eq("id", text(action.id))
        .eq("user_id", auth.userId)
        .eq("connection_id", connectionId);
      if (updated.error) throw new Error(updated.error.message);
    } else {
      const stored = await auth.supabase.from("inbox_actions").upsert(
        {
          user_id: auth.userId,
          provider: "gmail",
          connection_id: connectionId,
          mailbox_label: mailbox.displayName || mailbox.address,
          gmail_message_id: messageId,
          gmail_thread_id: threadId,
          subject: text(body?.subject) || invitation.title,
          snippet: text(body?.snippet) || null,
          received_at: safeReceivedAt,
          recommended_action: "label_only",
          status: "done",
          confidence: 1,
          p_important: 1,
          p_spam: 0,
          p_actionable: 1,
          reason: "Calendar invitation response completed.",
          metadata,
          executed_at: now,
          updated_at: now,
        },
        {
          onConflict:
            "user_id,provider,connection_id,gmail_message_id,recommended_action",
        },
      );
      if (stored.error) throw new Error(stored.error.message);
    }

    let warning: string | null = null;
    try {
      const labels = await ensureGroovyGmailLabels({
        mailbox,
        requiredLabels: [GROOVY_EMAIL_LABELS.processed],
      });
      await modifyGmailThreadLabels({
        mailbox,
        threadId,
        addLabelIds: [labels[GROOVY_EMAIL_LABELS.processed]].filter(Boolean),
        removeLabelIds: ["INBOX", "SPAM", "TRASH", "UNREAD"],
      });
    } catch (error) {
      warning =
        "Your calendar response was saved, but Gmail could not move the invitation to Done.";
      console.warn("[email/calendar-rsvp] Gmail cleanup failed", {
        requestId,
        connectionIdHash,
        messageIdHash,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }

    return NextResponse.json({
      ok: true,
      invite,
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    const openInGmailUrl = gmailThreadUrl(
      verifiedMailboxAddress,
      threadId,
    );
    if (error instanceof GmailCalendarInvitationPayloadError) {
      return NextResponse.json(
        {
          ok: false,
          retryable: false,
          error: error.message,
        },
        { status: 422 },
      );
    }
    if (error instanceof CalendarInvitationAccountNotConnectedError) {
      return NextResponse.json(
        {
          ok: false,
          retryable: false,
          code: error.code,
          requiredCalendarEmail: error.requiredEmail,
          ...(openInGmailUrl ? { openInGmailUrl } : {}),
          error:
            `This invitation was sent to ${error.requiredEmail}, but that ` +
            "Google Calendar account is not connected. Connect it, then retry, " +
            "or open the invitation in Gmail and respond there.",
        },
        { status: 409 },
      );
    }
    if (error instanceof CalendarInvitationPendingError) {
      return NextResponse.json(
        {
          ok: false,
          retryable: false,
          code: "calendar_invitation_not_available",
          ...(openInGmailUrl ? { openInGmailUrl } : {}),
          error:
            "Google Calendar has not made this invitation available through " +
            "the connected account. Open it in Gmail to respond, or retry later.",
        },
        { status: 409 },
      );
    }
    console.error("[email/calendar-rsvp] failed", {
      requestId,
      connectionIdHash,
      messageIdHash,
      responseStatus: status,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return jsonError(error, "Could not respond to this calendar invitation.", 502);
  }
}
