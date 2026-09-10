import { NextResponse } from "next/server";
import { persistEmailWorkspaceActionMutation } from "@/lib/email/actionPersistence";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import {
  removeEmailDraftAttachments,
  resolveEmailDraftAttachments,
} from "@/lib/email/draftAttachmentStorage";
import {
  createGmailDraft,
  deleteGmailDraft,
  fetchGmailDraft,
  findOwnedGmailMailbox,
  GmailApiError,
  hydrateGmailMailboxProfile,
  isMissingGmailEntityError,
  loadGmailMailboxes,
  parseEmailAddresses,
  updateGmailDraft,
} from "@/lib/email/gmail";
import {
  loadSyncedEmailComposerDrafts,
  persistSyncedEmailComposerDraft,
  registerSyncedEmailComposerDraftIfMissing,
  removeSyncedEmailComposerDraft,
} from "@/lib/email/composerDraftSync";
import { normalizeEmailComposerDraftSnapshot } from "@/lib/email/composerDrafts";
import { sanitizeEmailHtml } from "@/lib/email/html";
import {
  mergeVerifiedOwnedRecipientAddresses,
  sanitizeAutomaticRecipientFields,
} from "@/lib/email/recipients";
import {
  EMAIL_DRAFT_BODY_MAX_CHARS,
  EMAIL_DRAFT_HTML_MAX_CHARS,
} from "@/lib/email/payloadLimits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RecordLike = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rawText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordMetadata(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

function gmailDraftRetryResponse(error: GmailApiError): NextResponse {
  const retryAfterMs = Math.max(1_000, error.retryAfterMs || 5_000);
  return NextResponse.json(
    {
      ok: false,
      retryable: true,
      retryAfterMs,
      error: "Gmail is temporarily limiting draft updates. Groovy will retry.",
    },
    {
      status: error.status === 429 ? 429 : 503,
      headers: {
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
      },
    },
  );
}

export async function GET() {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  try {
    const mailboxes = await loadGmailMailboxes({
      supabase: auth.supabase,
      userId: auth.userId,
      verifyProfile: false,
    });
    const drafts = await loadSyncedEmailComposerDrafts({
      supabase: auth.supabase,
      userId: auth.userId,
      connectionIds: mailboxes.map((mailbox) => mailbox.connectionId),
    });
    return NextResponse.json({ ok: true, drafts });
  } catch (error) {
    return jsonError(error, "Could not sync drafts across devices.");
  }
}

export async function PUT(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as RecordLike | null;
  const draft = normalizeEmailComposerDraftSnapshot(body?.draft);
  if (!draft?.draftId) {
    return NextResponse.json(
      { ok: false, error: "A saved Gmail draft is required." },
      { status: 400 },
    );
  }
  try {
    const mailbox = await findOwnedGmailMailbox({
      supabase: auth.supabase,
      userId: auth.userId,
      connectionId: draft.connectionId,
    });
    if (!mailbox) {
      return NextResponse.json(
        { ok: false, error: "Mailbox not found." },
        { status: 404 },
      );
    }
    await registerSyncedEmailComposerDraftIfMissing({
      supabase: auth.supabase,
      userId: auth.userId,
      draft: {
        ...draft,
        draftId: draft.draftId,
        bodyHtml: draft.bodyHtml ? sanitizeEmailHtml(draft.bodyHtml) : null,
      },
      updatedAt: new Date(draft.updatedAt).toISOString(),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, "Could not register this draft for device sync.");
  }
}

export async function POST(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as RecordLike | null;
  const connectionId = text(body?.connectionId);
  const actionId = text(body?.actionId);
  const draftId = text(body?.draftId);
  const requestedThreadId = text(body?.threadId);
  const requestedSourceMessageId = text(body?.sourceMessageId);
  if (!connectionId) {
    return NextResponse.json(
      { ok: false, error: "Choose a sender mailbox." },
      { status: 400 },
    );
  }
  try {
    const mailbox = await findOwnedGmailMailbox({
      supabase: auth.supabase,
      userId: auth.userId,
      connectionId,
    });
    if (!mailbox) {
      return NextResponse.json(
        { ok: false, error: "Mailbox not found." },
        { status: 404 },
      );
    }
    const attachmentPayload = await resolveEmailDraftAttachments({
      supabase: auth.supabase,
      userId: auth.userId,
      value: body?.attachments,
    });
    const bodyHtml = sanitizeEmailHtml(
      rawText(body?.bodyHtml).slice(0, EMAIL_DRAFT_HTML_MAX_CHARS),
    );
    let actionThreadId = "";
    let actionSourceMessageId = "";
    let actionMetadata: RecordLike = {};
    let automaticDraft = false;
    let automaticOwnedAddresses: string[] = [];
    if (actionId) {
      const { data } = await auth.supabase
        .from("inbox_actions")
        .select(
          "id,gmail_thread_id,gmail_message_id,gmail_draft_id,recommended_action,metadata",
        )
        .eq("id", actionId)
        .eq("user_id", auth.userId)
        .eq("connection_id", connectionId)
        .maybeSingle();
      if (!data) {
        return NextResponse.json(
          { ok: false, error: "Draft action not found." },
          { status: 404 },
        );
      }
      actionThreadId = text(data.gmail_thread_id);
      actionSourceMessageId = text(data.gmail_message_id);
      actionMetadata = recordMetadata(data.metadata);
      automaticDraft = data.recommended_action === "draft_reply";
      if (automaticDraft) {
        const hydratedMailbox = await hydrateGmailMailboxProfile({
          userId: auth.userId,
          mailbox,
          priority: "interactive",
        });
        if (
          hydratedMailbox.status !== "connected" ||
          !hydratedMailbox.address
        ) {
          return NextResponse.json(
            {
              ok: false,
              error:
                "Could not verify the connected Gmail identity. The automatic draft was not changed.",
            },
            { status: 409 },
          );
        }
        automaticOwnedAddresses = mergeVerifiedOwnedRecipientAddresses({
          knownAddresses: actionMetadata.owned_addresses,
          userAddress: auth.email,
          verifiedMailboxAddress: hydratedMailbox.address,
        });
      }
      const actionDraftId = text(data.gmail_draft_id);
      if (
        (actionThreadId &&
          requestedThreadId &&
          actionThreadId !== requestedThreadId) ||
        (actionSourceMessageId &&
          requestedSourceMessageId &&
          actionSourceMessageId !== requestedSourceMessageId)
      ) {
        return NextResponse.json(
          { ok: false, error: "This draft belongs to another conversation." },
          { status: 409 },
        );
      }
      if (draftId && actionDraftId && actionDraftId !== draftId) {
        return NextResponse.json(
          { ok: false, error: "This Gmail draft is linked to another action." },
          { status: 409 },
        );
      }
      if (draftId && !actionDraftId && actionThreadId) {
        const existingDraft = await fetchGmailDraft({ mailbox, draftId });
        if (!existingDraft || existingDraft.threadId !== actionThreadId) {
          return NextResponse.json(
            { ok: false, error: "This Gmail draft belongs to another conversation." },
            { status: 409 },
          );
        }
      }
    }
    const requestedRecipients = {
      to: parseEmailAddresses(body?.to),
      cc: parseEmailAddresses(body?.cc),
      bcc: parseEmailAddresses(body?.bcc),
    };
    const recipients = automaticDraft
      ? sanitizeAutomaticRecipientFields({
          ...requestedRecipients,
          ownedAddresses: automaticOwnedAddresses,
        })
      : requestedRecipients;
    const draftArgs = {
      mailbox,
      threadId: requestedThreadId || actionThreadId || null,
      sourceMessageId:
        requestedSourceMessageId || actionSourceMessageId || null,
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject: rawText(body?.subject).slice(0, 998),
      body: rawText(body?.body).slice(0, EMAIL_DRAFT_BODY_MAX_CHARS),
      bodyHtml,
      attachments: attachmentPayload.resolved,
      inReplyTo: text(body?.inReplyTo) || null,
      references: text(body?.references) || null,
    };
    if (automaticDraft && draftArgs.to.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "This automatic draft has no external recipient. Review the conversation and choose a recipient.",
        },
        { status: 400 },
      );
    }
    let draft;
    if (draftId) {
      try {
        draft = await updateGmailDraft({ ...draftArgs, draftId });
      } catch (error) {
        if (!isMissingGmailEntityError(error)) throw error;
        // Gmail drafts can be removed by another client while Groovy still
        // has the old ID in its action row. Recreate and relink atomically
        // instead of trapping the composer on "Requested entity not found."
        draft = await createGmailDraft(draftArgs);
      }
    } else {
      draft = await createGmailDraft(draftArgs);
    }
    const savedDraftId = text(draft.draftId);
    if (!savedDraftId) throw new Error("Gmail did not return a draft ID.");
    const linkedDraft = {
      ...draft,
      bodyHtml,
      attachments: attachmentPayload.attachments,
      actionId: actionId || null,
      aiGenerated: body?.aiGenerated === true,
      untouched: body?.untouched === true,
    };
    let syncWarning: string | null = null;
    const localId =
      rawText(body?.localId).trim().slice(0, 180) ||
      `gmail:${connectionId}:${savedDraftId}`.slice(0, 180);
    try {
      await persistSyncedEmailComposerDraft({
        supabase: auth.supabase,
        userId: auth.userId,
        draft: {
          localId,
          actionId: actionId || null,
          draftId: savedDraftId,
          connectionId,
          threadId: draft.threadId,
          sourceMessageId:
            requestedSourceMessageId || actionSourceMessageId || null,
          to: draft.to.join(", "),
          cc: draft.cc.join(", "),
          bcc: draft.bcc.join(", "),
          subject: draft.subject,
          body: draftArgs.body,
          bodyHtml,
          attachments: attachmentPayload.attachments,
          inReplyTo: draftArgs.inReplyTo,
          references: draftArgs.references,
          aiGenerated: body?.aiGenerated === true,
          untouched: body?.untouched === true,
        },
        updatedAt: draft.updatedAt || undefined,
      });
      if (draftId && draftId !== savedDraftId) {
        await removeSyncedEmailComposerDraft({
          supabase: auth.supabase,
          userId: auth.userId,
          connectionId,
          draftId,
        });
      }
    } catch (error) {
      console.warn(
        "[email/draft] Gmail draft saved but cross-device state did not update:",
        error instanceof Error ? error.message : error,
      );
      syncWarning =
        "Saved in Gmail, but Groovy could not sync this draft to your other devices yet.";
    }
    if (actionId) {
      const savedAt = new Date().toISOString();
      const { error } = await auth.supabase
        .from("inbox_actions")
        .update({
          gmail_draft_id: draft.draftId,
          gmail_thread_id: draft.threadId,
          draft_to: draft.to,
          draft_cc: draft.cc,
          draft_bcc: draft.bcc,
          draft_subject: draft.subject,
          draft_body: draft.body,
          updated_at: savedAt,
        })
        .eq("id", actionId)
        .eq("user_id", auth.userId)
        .eq("connection_id", connectionId);
      let metadataError: unknown = null;
      try {
        await persistEmailWorkspaceActionMutation({
          supabase: auth.supabase,
          userId: auth.userId,
          actionId,
          changedAt: savedAt,
          metadataPatch: {
            ...(automaticDraft
              ? { owned_addresses: automaticOwnedAddresses }
              : {}),
            email_draft_body_html: bodyHtml,
            email_draft_attachments: attachmentPayload.attachments,
            user_edited: body?.untouched !== true,
            send_confirmation_pending: false,
          },
        });
      } catch (reason) {
        metadataError = reason;
      }
      if (error || metadataError) {
        console.warn(
          "[email/draft] Gmail draft saved but action metadata did not update:",
          error?.message ||
            (metadataError instanceof Error
              ? metadataError.message
              : "Unknown persistence error."),
        );
      }
    }
    return NextResponse.json({
      ok: true,
      draft: linkedDraft,
      ...(syncWarning ? { warning: syncWarning } : {}),
    });
  } catch (error) {
    if (error instanceof GmailApiError && error.retryable) {
      return gmailDraftRetryResponse(error);
    }
    return jsonError(error, "Could not save the Gmail draft.");
  }
}

export async function DELETE(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as RecordLike | null;
  const connectionId = text(body?.connectionId);
  const actionId = text(body?.actionId);
  const draftId = text(body?.draftId);
  const preserveAttachments = body?.preserveAttachments === true;
  if (!connectionId || !draftId) {
    return NextResponse.json(
      { ok: false, error: "connectionId and draftId are required." },
      { status: 400 },
    );
  }
  try {
    const mailbox = await findOwnedGmailMailbox({
      supabase: auth.supabase,
      userId: auth.userId,
      connectionId,
    });
    if (!mailbox) {
      return NextResponse.json(
        { ok: false, error: "Mailbox not found." },
        { status: 404 },
      );
    }
    let actionMetadata: RecordLike = {};
    if (actionId) {
      const { data, error } = await auth.supabase
        .from("inbox_actions")
        .select("id,gmail_draft_id,metadata")
        .eq("id", actionId)
        .eq("user_id", auth.userId)
        .eq("connection_id", connectionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) {
        return NextResponse.json(
          { ok: false, error: "Draft action not found." },
          { status: 404 },
        );
      }
      const storedDraftId = text(data.gmail_draft_id);
      if (storedDraftId && storedDraftId !== draftId) {
        return NextResponse.json(
          { ok: false, error: "This Gmail draft is linked to another action." },
          { status: 409 },
        );
      }
      actionMetadata =
        data.metadata &&
        typeof data.metadata === "object" &&
        !Array.isArray(data.metadata)
          ? (data.metadata as RecordLike)
          : {};
    }
    await deleteGmailDraft({ mailbox, draftId });
    let syncCleanupError: unknown = null;
    try {
      await removeSyncedEmailComposerDraft({
        supabase: auth.supabase,
        userId: auth.userId,
        connectionId,
        draftId,
      });
    } catch (error) {
      syncCleanupError = error;
    }
    if (!preserveAttachments) {
      await removeEmailDraftAttachments({
        supabase: auth.supabase,
        userId: auth.userId,
        value:
          Array.isArray(body?.attachments) && body.attachments.length > 0
            ? body.attachments
            : actionMetadata.email_draft_attachments,
      });
    }
    let warning: string | null = syncCleanupError
      ? "The Gmail draft was discarded, but another device may show it until the workspace refreshes."
      : null;
    if (actionId) {
      const discardedAt = new Date().toISOString();
      const cleared = await auth.supabase
        .from("inbox_actions")
        .update({
          gmail_draft_id: null,
          draft_to: null,
          draft_cc: null,
          draft_bcc: null,
          draft_subject: null,
          draft_body: null,
          updated_at: discardedAt,
        })
        .eq("id", actionId)
        .eq("user_id", auth.userId)
        .eq("connection_id", connectionId);
      let metadataError: unknown = null;
      try {
        await persistEmailWorkspaceActionMutation({
          supabase: auth.supabase,
          userId: auth.userId,
          actionId,
          changedAt: discardedAt,
          metadataPatch: {
            email_draft_body_html: null,
            email_draft_attachments: [],
            user_edited: false,
            send_confirmation_pending: false,
            email_workspace_draft_discarded_at: discardedAt,
          },
        });
      } catch (reason) {
        metadataError = reason;
      }
      if (cleared.error || metadataError) {
        console.warn(
          "[email/draft] Gmail draft discarded but action metadata did not clear:",
          cleared.error?.message ||
            (metadataError instanceof Error
              ? metadataError.message
              : "Unknown persistence error."),
        );
        warning = "The Gmail draft was discarded, but the workspace needs a refresh.";
      }
    }
    return NextResponse.json({
      ok: true,
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    if (error instanceof GmailApiError && error.retryable) {
      return gmailDraftRetryResponse(error);
    }
    return jsonError(error, "Could not discard the Gmail draft.");
  }
}
