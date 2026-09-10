import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  decryptLlmApiKey,
  encryptLlmApiKey,
} from "@/lib/crypto/llmKey";
import {
  jsonError,
  requireEmailUserOrInternal,
} from "@/lib/email/auth";
import { persistEmailWorkspaceActionMutation } from "@/lib/email/actionPersistence";
import { ensureGroovyAiEmailDisclosure } from "@/lib/email/disclosure";
import {
  removeEmailDraftAttachments,
  resolveEmailDraftAttachments,
} from "@/lib/email/draftAttachmentStorage";
import { removeSyncedEmailComposerDraft } from "@/lib/email/composerDraftSync";
import {
  fetchGmailDraft,
  findGmailSentMessageIds,
  findOwnedGmailMailbox,
  GmailApiError,
  hydrateGmailMailboxProfile,
  buildRawMessage,
  deleteGmailDraft,
  insertGmailSentMessage,
  isMissingGmailEntityError,
  publicMailbox,
  sendGmailDraft,
  trashGmailSmtpSentCopies,
  updateGmailDraft,
} from "@/lib/email/gmail";
import { sanitizeEmailHtml } from "@/lib/email/html";
import {
  createEmailTrackingToken,
  emailTrackingRecipientDeliveries,
  emailTrackingPixelUrl,
  EMAIL_TRACKING_METADATA_KEY,
  EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY,
  EMAIL_TRACKING_RECIPIENT_HASHES_KEY,
  EMAIL_TRACKING_RECIPIENT_RECORD_KEY,
  hashEmailTrackingToken,
  type EmailTrackingRecipientDelivery,
} from "@/lib/email/openTracking";
import {
  canSendPersonalizedEmailFrom,
  personalizedEmailRequestFits,
  sendPersonalizedEmailVariants,
} from "@/lib/email/personalizedDelivery";
import {
  mergeVerifiedOwnedRecipientAddresses,
  sanitizeAutomaticRecipientFields,
} from "@/lib/email/recipients";
import { summaryFromTrackingRow } from "@/lib/email/service";
import { recipientTrackingRolloutEnabledForUser } from "@/lib/email/recipientTrackingRollout";
import {
  SENT_EMAIL_ACTION_DRAFT_CLEAR,
  sentEmailActionMetadataPatch,
} from "@/lib/email/sendCompletion";
import { scheduleAfterResponse } from "@/lib/runtime/afterResponse";
import { EMAIL_DRAFT_SEND_INTERNAL_SCOPE } from "@/lib/email/internalScopes";
import { EMAIL_DRAFT_HTML_MAX_CHARS } from "@/lib/email/payloadLimits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RecordLike = Record<string, unknown>;
const PERSONALIZED_SEND_CLAIM_LEASE_MS = 10 * 60_000;
const PERSONALIZED_SEND_RECOVERY_MIN_AGE_MS = 60_000;

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

function senderHeader(displayName: string, address: string): string {
  const cleanName = displayName
    .replace(/[\r\n"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleanName ? `"${cleanName}" <${address}>` : address;
}

function trackingAttribution(metadata: RecordLike): string {
  const recipients = Array.isArray(metadata.email_tracking_recipients)
    ? metadata.email_tracking_recipients
    : [];
  if (recipients.length === 1) return "single_recipient";
  return emailTrackingRecipientDeliveries(
    metadata[EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY],
  ).length > 0
    ? "recipient_specific"
    : "group";
}

function confirmedSentThread(args: {
  operationId: string;
  connectionId: string;
  mailbox: Parameters<typeof publicMailbox>[0];
  metadata: RecordLike;
  messageId?: string | null;
  threadId?: string | null;
  snippet?: string;
}) {
  const messageId =
    text(args.messageId) ||
    text(args.metadata.email_tracking_sent_message_id);
  const threadId =
    text(args.threadId) ||
    text(args.metadata.email_tracking_sent_thread_id) ||
    messageId;
  if (!args.operationId || !messageId || !threadId) return null;
  return summaryFromTrackingRow(
    {
      id: args.operationId,
      connection_id: args.connectionId,
      gmail_message_id: messageId,
      gmail_thread_id: threadId,
      snippet: args.snippet || "",
      metadata: args.metadata,
    },
    publicMailbox(args.mailbox),
  );
}

function gmailRetryResponse(error: GmailApiError): NextResponse {
  const retryAfterMs = Math.max(1_000, error.retryAfterMs || 5_000);
  return NextResponse.json(
    {
      ok: false,
      retryable: true,
      retryAfterMs,
      error:
        error.status === 429
          ? "Gmail is temporarily limiting sends. Groovy will retry without sending a duplicate."
          : "Gmail did not confirm the send. Groovy will safely check and retry.",
    },
    {
      status: error.status === 429 ? 429 : 503,
      headers: {
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
      },
    },
  );
}

export async function POST(request: Request) {
  const auth = await requireEmailUserOrInternal(
    request,
    EMAIL_DRAFT_SEND_INTERNAL_SCOPE,
  );
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as RecordLike | null;
  const connectionId = text(body?.connectionId);
  const draftId = text(body?.draftId);
  const actionId = text(body?.actionId);
  const threadId = text(body?.threadId);
  const requestId = (
    text(body?.requestId) || `draft:${connectionId}:${draftId}`
  ).slice(0, 200);
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
    const existingOperation = await auth.supabase
      .from("inbox_actions")
      .select("id,metadata,gmail_message_id,gmail_thread_id")
      .eq("user_id", auth.userId)
      .eq("provider", "gmail")
      .eq("connection_id", connectionId)
      .contains("metadata", { email_send_request_id: requestId })
      .limit(1)
      .maybeSingle();
    if (existingOperation.error) throw new Error(existingOperation.error.message);
    const existingOperationMetadata = recordMetadata(
      existingOperation.data?.metadata,
    );
    const existingOperationDraftId = text(
      existingOperationMetadata.email_tracking_draft_id,
    );
    if (
      existingOperation.data?.id &&
      existingOperationDraftId &&
      existingOperationDraftId !== draftId
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "This send request belongs to another Gmail draft.",
        },
        { status: 409 },
      );
    }
    // Profile identity and draft contents are independent Gmail reads. Start
    // them after idempotency ownership is validated so the confirmed Sent card
    // has a usable address without spending a Gmail request on a rejected
    // request-id collision.
    const hydratedMailboxPromise = hydrateGmailMailboxProfile({
      userId: auth.userId,
      mailbox,
      priority: "interactive",
    });
    const cleanupPersonalizedSentCopies = async (args: {
      cleanupMailbox: typeof mailbox;
      trackingRecordId: string;
      messageIdHeader: string;
      expectedCopyCount: number;
      canonicalMessageId: string;
    }) => {
      try {
        const replacedCopies = await trashGmailSmtpSentCopies({
          mailbox: args.cleanupMailbox,
          messageIdHeader: args.messageIdHeader,
          expectedCopyCount: args.expectedCopyCount,
          excludeMessageIds: [args.canonicalMessageId],
        });
        const current = await auth.supabase
          .from("inbox_actions")
          .select("metadata")
          .eq("id", args.trackingRecordId)
          .eq("user_id", auth.userId)
          .maybeSingle();
        if (current.error || !current.data) {
          throw new Error(
            current.error?.message ||
              "Could not record Gmail sent-copy cleanup.",
          );
        }
        const metadata = recordMetadata(current.data.metadata);
        const completedAt = new Date().toISOString();
        const updated = await auth.supabase
          .from("inbox_actions")
          .update({
            metadata: {
              ...metadata,
              email_tracking_smtp_copies_trashed_at: completedAt,
              email_tracking_smtp_copy_count:
                replacedCopies.messageIds.length,
              email_tracking_smtp_copies_already_trashed:
                replacedCopies.alreadyTrashed,
              email_tracking_smtp_cleanup_pending: false,
              email_tracking_smtp_cleanup_last_error: null,
              email_tracking_smtp_cleanup_last_error_at: null,
            },
            updated_at: completedAt,
          })
          .eq("id", args.trackingRecordId)
          .eq("user_id", auth.userId);
        if (updated.error) throw new Error(updated.error.message);
      } catch (error) {
        const current = await auth.supabase
          .from("inbox_actions")
          .select("metadata")
          .eq("id", args.trackingRecordId)
          .eq("user_id", auth.userId)
          .maybeSingle();
        if (current.data) {
          const failedAt = new Date().toISOString();
          await auth.supabase
            .from("inbox_actions")
            .update({
              metadata: {
                ...recordMetadata(current.data.metadata),
                email_tracking_smtp_cleanup_pending: true,
                email_tracking_smtp_cleanup_last_error:
                  error instanceof Error
                    ? error.message.slice(0, 500)
                    : "Gmail sent-copy cleanup is still pending.",
                email_tracking_smtp_cleanup_last_error_at: failedAt,
              },
              updated_at: failedAt,
            })
            .eq("id", args.trackingRecordId)
            .eq("user_id", auth.userId);
        }
        throw error;
      }
    };
    const keepSentActionInWorkspace = async (args: {
      actionId: string;
      sentAt: string;
      attachmentNames?: readonly string[];
    }): Promise<string | null> => {
      const cleared = await auth.supabase
        .from("inbox_actions")
        .update({
          ...SENT_EMAIL_ACTION_DRAFT_CLEAR,
          updated_at: args.sentAt,
        })
        .eq("id", args.actionId)
        .eq("user_id", auth.userId)
        .eq("connection_id", connectionId);
      let metadataError: unknown = null;
      try {
        await persistEmailWorkspaceActionMutation({
          supabase: auth.supabase,
          userId: auth.userId,
          actionId: args.actionId,
          changedAt: args.sentAt,
          metadataPatch: sentEmailActionMetadataPatch(args),
        });
      } catch (reason) {
        metadataError = reason;
      }
      if (!cleared.error && !metadataError) return null;
      console.warn(
        "[email/draft/send] Gmail sent the message but the workspace draft did not clear:",
        cleared.error?.message ||
          (metadataError instanceof Error
            ? metadataError.message
            : "Unknown persistence error."),
      );
      return "The email was sent, but its workspace card needs a refresh.";
    };
    const completeRecordedSend = async (
      operationMetadata: RecordLike,
    ): Promise<string | null> => {
      const sentAt =
        text(operationMetadata.email_tracking_sent_at) ||
        new Date().toISOString();
      let warning: string | null = null;
      let attachmentCleanupValue = body?.attachments;
      if (actionId) {
        const currentAction = await auth.supabase
          .from("inbox_actions")
          .select("metadata")
          .eq("id", actionId)
          .eq("user_id", auth.userId)
          .eq("connection_id", connectionId)
          .maybeSingle();
        if (currentAction.error || !currentAction.data) {
          warning =
            warning || "The sent workspace card could not be updated.";
        } else {
          const actionMetadata = recordMetadata(currentAction.data.metadata);
          if (
            !Array.isArray(attachmentCleanupValue) ||
            attachmentCleanupValue.length === 0
          ) {
            attachmentCleanupValue =
              actionMetadata.email_draft_attachments;
          }
          warning =
            warning ||
            (await keepSentActionInWorkspace({ actionId, sentAt }));
        }
      }
      await scheduleAfterResponse(async () => {
        const cleanupTasks: Promise<void>[] = [
          removeEmailDraftAttachments({
            supabase: auth.supabase,
            userId: auth.userId,
            value: attachmentCleanupValue,
          }),
          removeSyncedEmailComposerDraft({
            supabase: auth.supabase,
            userId: auth.userId,
            connectionId,
            draftId,
          }),
        ];
        const recipientDeliveries = emailTrackingRecipientDeliveries(
          operationMetadata[EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY],
        );
        const canonicalMessageId = text(
          operationMetadata.email_tracking_sent_message_id,
        );
        const messageIdHeader = text(
          operationMetadata.email_tracking_message_id_header,
        );
        if (
          operationMetadata.email_tracking_smtp_cleanup_pending === true &&
          existingOperation.data?.id &&
          recipientDeliveries.length > 0 &&
          canonicalMessageId &&
          messageIdHeader
        ) {
          cleanupTasks.push(
            cleanupPersonalizedSentCopies({
              cleanupMailbox: mailbox,
              trackingRecordId: existingOperation.data.id,
              messageIdHeader,
              expectedCopyCount: recipientDeliveries.length,
              canonicalMessageId,
            }),
          );
        }
        const settled = await Promise.allSettled(cleanupTasks);
        if (settled.some((result) => result.status === "rejected")) {
          throw new Error("Recorded email cleanup did not complete.");
        }
      }, `recorded email cleanup ${existingOperation.data?.id || draftId}`);
      return warning;
    };
    if (existingOperationMetadata.email_send_state === "sent") {
      const sentMailbox = await hydratedMailboxPromise;
      const completionWarning = await completeRecordedSend(
        existingOperationMetadata,
      );
      return NextResponse.json({
        ok: true,
        alreadySent: true,
        actionHandled: !actionId || completionWarning === null,
        sentThread: confirmedSentThread({
          operationId: text(existingOperation.data?.id),
          connectionId,
          mailbox: sentMailbox,
          metadata: existingOperationMetadata,
          messageId: text(existingOperation.data?.gmail_message_id),
          threadId: text(existingOperation.data?.gmail_thread_id),
        }),
        ...(completionWarning ? { warning: completionWarning } : {}),
        tracking: {
          enabled:
            existingOperationMetadata.email_tracking_disabled !== true,
          attribution: trackingAttribution(existingOperationMetadata),
        },
      });
    }
    let draftForSend = await fetchGmailDraft({
      mailbox,
      draftId,
      priority: "interactive",
    });
    if (!draftForSend) {
      const recoveryDeliveries = emailTrackingRecipientDeliveries(
        existingOperationMetadata[EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY],
      );
      const personalizedRecoveryComplete =
        recoveryDeliveries.length === 0 ||
        (recoveryDeliveries.every(
          (delivery) => delivery.state === "sent",
        ) &&
          Boolean(
            text(
              existingOperationMetadata.email_tracking_sent_message_id,
            ),
          ));
      if (
        existingOperation.data?.id &&
        existingOperationMetadata.email_send_state === "sending" &&
        personalizedRecoveryComplete
      ) {
        const sentMailbox = await hydratedMailboxPromise;
        const recoveredAt = new Date().toISOString();
        await auth.supabase
          .from("inbox_actions")
          .update({
            metadata: {
              ...existingOperationMetadata,
              email_send_state: "sent",
              email_send_recovered_at: recoveredAt,
              email_tracking_sent_at:
                text(existingOperationMetadata.email_tracking_sent_at) ||
                recoveredAt,
            },
            updated_at: recoveredAt,
          })
          .eq("id", existingOperation.data.id)
          .eq("user_id", auth.userId);
        const completionWarning = await completeRecordedSend(
          {
            ...existingOperationMetadata,
            email_tracking_sent_at:
              text(existingOperationMetadata.email_tracking_sent_at) ||
              recoveredAt,
          },
        );
        return NextResponse.json({
          ok: true,
          alreadySent: true,
          actionHandled: !actionId || completionWarning === null,
          sentThread: confirmedSentThread({
            operationId: text(existingOperation.data.id),
            connectionId,
            mailbox: sentMailbox,
            metadata: {
              ...existingOperationMetadata,
              email_tracking_sent_at:
                text(existingOperationMetadata.email_tracking_sent_at) ||
                recoveredAt,
            },
            messageId: text(existingOperation.data.gmail_message_id),
            threadId:
              text(existingOperation.data.gmail_thread_id) || threadId,
          }),
          warning: [
            "Gmail accepted the email before the connection was interrupted. Groovy verified that the draft was consumed and did not send it twice.",
            completionWarning,
          ]
            .filter(Boolean)
            .join(" "),
          tracking: {
            enabled:
              existingOperationMetadata.email_tracking_disabled !== true,
            attribution: trackingAttribution(existingOperationMetadata),
          },
        });
      }
      if (
        existingOperation.data?.id &&
        recoveryDeliveries.length > 0
      ) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "This personalized send is incomplete and its Gmail draft is no longer available. Groovy will not guess or duplicate recipients.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { ok: false, error: "Gmail draft not found." },
        { status: 404 },
      );
    }
    let action: {
      id: string;
      metadata: RecordLike;
      threadId: string;
      recommendedAction: string;
    } | null = null;
    if (actionId) {
      const { data } = await auth.supabase
        .from("inbox_actions")
        .select(
          "id,metadata,gmail_draft_id,gmail_thread_id,recommended_action",
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
      const metadata = recordMetadata(data.metadata);
      const actionDraftId = text(data.gmail_draft_id);
      const actionThreadId = text(data.gmail_thread_id);
      if (actionDraftId && actionDraftId !== draftId) {
        return NextResponse.json(
          { ok: false, error: "This Gmail draft is linked to another action." },
          { status: 409 },
        );
      }
      if (actionThreadId && threadId && actionThreadId !== threadId) {
        return NextResponse.json(
          { ok: false, error: "This draft belongs to another conversation." },
          { status: 409 },
        );
      }
      if (!actionDraftId && actionThreadId) {
        if (draftForSend.threadId !== actionThreadId) {
          return NextResponse.json(
            { ok: false, error: "This Gmail draft belongs to another conversation." },
            { status: 409 },
          );
        }
      }
      action = {
        id: data.id as string,
        metadata,
        threadId: actionThreadId,
        recommendedAction: text(data.recommended_action),
      };
      if (
        metadata.user_edited !== true &&
        body?.confirmAiDraft !== true
      ) {
        return NextResponse.json(
          {
            ok: false,
            needsConfirmation: true,
            error: "Review and confirm this untouched AI draft before sending.",
          },
          { status: 409 },
        );
      }
    }
    if (action?.recommendedAction === "draft_reply") {
      const hydratedMailbox = await hydratedMailboxPromise;
      if (
        hydratedMailbox.status !== "connected" ||
        !hydratedMailbox.address
      ) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Could not verify the connected Gmail identity. The automatic draft was not sent.",
          },
          { status: 409 },
        );
      }
      const ownedAddresses = mergeVerifiedOwnedRecipientAddresses({
        knownAddresses: action.metadata.owned_addresses,
        userAddress: auth.email,
        verifiedMailboxAddress: hydratedMailbox.address,
      });
      const safeRecipients = sanitizeAutomaticRecipientFields({
        to: draftForSend.to,
        cc: draftForSend.cc,
        bcc: draftForSend.bcc,
        ownedAddresses,
      });
      if (safeRecipients.to.length === 0) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "This automatic draft has no external recipient. Review the conversation and choose a recipient.",
          },
          { status: 409 },
        );
      }
      draftForSend = {
        ...draftForSend,
        ...safeRecipients,
      };
      action.metadata = {
        ...action.metadata,
        owned_addresses: ownedAddresses,
      };
    }
    if (draftForSend.to.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Add at least one recipient before sending." },
        { status: 400 },
      );
    }
    const attachmentValue =
      Array.isArray(body?.attachments) && body.attachments.length > 0
        ? body.attachments
        : action?.metadata.email_draft_attachments;
    const attachmentPayload = await resolveEmailDraftAttachments({
      supabase: auth.supabase,
      userId: auth.userId,
      value: attachmentValue,
    });
    const bodyHtml =
      sanitizeEmailHtml(
        rawText(body?.bodyHtml).slice(0, EMAIL_DRAFT_HTML_MAX_CHARS),
      ) ||
      sanitizeEmailHtml(
        rawText(draftForSend.bodyHtml).slice(0, EMAIL_DRAFT_HTML_MAX_CHARS),
      ) ||
      sanitizeEmailHtml(
        rawText(action?.metadata.email_draft_body_html).slice(
          0,
          EMAIL_DRAFT_HTML_MAX_CHARS,
        ),
      );
    const recipients = Array.from(
      new Set(
        [
          ...draftForSend.to,
          ...draftForSend.cc,
          ...draftForSend.bcc,
        ]
          .map((recipient) => recipient.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    const hydratedMailbox = await hydratedMailboxPromise;
    const verifiedSenderAddress =
      hydratedMailbox.status === "connected"
        ? hydratedMailbox.address.trim().toLowerCase()
        : "";
    let existingRecipientDeliveries =
      emailTrackingRecipientDeliveries(
        existingOperationMetadata[EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY],
      );
    const recipientTrackingRollout =
      recipientTrackingRolloutEnabledForUser(
        auth.userId,
        undefined,
        auth.email,
      );
    const existingDeliveryRecipients = existingRecipientDeliveries
      .map((delivery) => delivery.recipient)
      .sort();
    const currentRecipients = [...recipients].sort();
    if (
      existingRecipientDeliveries.length > 0 &&
      (existingDeliveryRecipients.length !== currentRecipients.length ||
        existingDeliveryRecipients.some(
          (recipient, index) => recipient !== currentRecipients[index],
        ))
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "The recipients changed after individual delivery was prepared. Create a new draft so Groovy cannot duplicate anyone.",
        },
        { status: 409 },
      );
    }
    const personalizedCapability =
      recipients.length > 1 &&
      Boolean(verifiedSenderAddress) &&
      (recipientTrackingRollout ||
        existingRecipientDeliveries.length > 0) &&
      (await canSendPersonalizedEmailFrom({
        mailbox: hydratedMailbox,
        sender: verifiedSenderAddress,
      }));
    const messageDate =
      text(existingOperationMetadata.email_tracking_message_date) ||
      new Date().toUTCString();
    const messageIdHeader =
      text(existingOperationMetadata.email_tracking_message_id_header) ||
      `<${randomUUID()}@${verifiedSenderAddress.split("@")[1] || "gogroovy.ai"}>`;
    const from = senderHeader(
      hydratedMailbox.displayName,
      verifiedSenderAddress,
    );
    const disclosedBody = ensureGroovyAiEmailDisclosure(
      draftForSend.body,
    );
    const personalizedCandidate =
      recipients.length > 1 &&
      Boolean(verifiedSenderAddress) &&
      (personalizedCapability || existingRecipientDeliveries.length > 0);
    const personalizedProbeRecipient =
      [...draftForSend.bcc].sort((left, right) => right.length - left.length)[0] ||
      [...recipients].sort((left, right) => right.length - left.length)[0] ||
      "";
    const personalizedTransportFits = personalizedCandidate
      ? personalizedEmailRequestFits({
          connectionId,
          envelopeFrom: verifiedSenderAddress,
          recipient: personalizedProbeRecipient,
          raw: buildRawMessage({
            from,
            to: draftForSend.to,
            cc: draftForSend.cc,
            bcc: draftForSend.bcc.includes(personalizedProbeRecipient)
              ? [personalizedProbeRecipient]
              : [],
            subject: draftForSend.subject,
            body: disclosedBody,
            bodyHtml,
            attachments: attachmentPayload.resolved,
            inReplyTo: draftForSend.inReplyTo,
            references: draftForSend.references,
            trackingPixelUrl: emailTrackingPixelUrl(
              new URL(request.url).origin,
              createEmailTrackingToken(),
            ),
            date: messageDate,
            messageId: messageIdHeader,
          }),
        })
      : true;
    let recoveredOversizedPersonalizedSend = false;
    if (
      personalizedCandidate &&
      !personalizedTransportFits &&
      existingRecipientDeliveries.some(
        (delivery) => delivery.state === "sending",
      ) &&
      existingRecipientDeliveries.every(
        (delivery) => delivery.state !== "sent" && !delivery.sentAt,
      )
    ) {
      const lastFailureAt = Date.parse(
        text(existingOperationMetadata.email_send_last_error_at),
      );
      const failureIsOldEnough =
        Number.isFinite(lastFailureAt) &&
        Date.now() - lastFailureAt >= PERSONALIZED_SEND_RECOVERY_MIN_AGE_MS;
      if (
        failureIsOldEnough &&
        text(existingOperationMetadata.email_send_last_error) &&
        text(existingOperationMetadata.email_tracking_message_id_header)
      ) {
        try {
          const sentMessageIds = await findGmailSentMessageIds({
            mailbox: hydratedMailbox,
            messageIdHeader,
            priority: "interactive",
          });
          if (sentMessageIds.length === 0) {
            existingRecipientDeliveries = [];
            recoveredOversizedPersonalizedSend = true;
          }
        } catch {
          // Keep the duplicate guard in place unless Gmail positively verifies
          // that no copy with this Message-ID exists in Sent.
        }
      }
    }
    if (
      recipients.length > 1 &&
      recipientTrackingRollout &&
      existingRecipientDeliveries.length === 0 &&
      !personalizedCapability &&
      personalizedTransportFits &&
      body?.allowSharedGroupTracking !== true
    ) {
      return NextResponse.json(
        {
          ok: false,
          needsGmailTrackingPermission: true,
          error:
            "Reconnect Gmail once to enable individual read receipts for group email. This draft has not been sent.",
        },
        { status: 409 },
      );
    }
    if (
      existingRecipientDeliveries.length > 0 &&
      !personalizedTransportFits
    ) {
      return NextResponse.json(
        {
          ok: false,
          retryable: false,
          error:
            "Groovy could not verify every recipient of this large email. It will not risk sending anyone twice.",
        },
        { status: 409 },
      );
    }
    // Once a send has recipient-specific delivery records, never fall back to
    // a shared Gmail send. That could resend recipients already accepted.
    const personalizedTracking =
      recipients.length > 1 &&
      Boolean(verifiedSenderAddress) &&
      personalizedTransportFits &&
      (personalizedCapability || existingRecipientDeliveries.length > 0);
    const priorClaimedAt = Date.parse(
      text(existingOperationMetadata.email_send_claimed_at),
    );
    const priorClaimIsFresh =
      Number.isFinite(priorClaimedAt) &&
      Date.now() - priorClaimedAt < PERSONALIZED_SEND_CLAIM_LEASE_MS;
    if (
      personalizedTracking &&
      existingRecipientDeliveries.some(
        (delivery) => delivery.state === "sending",
      )
    ) {
      return NextResponse.json(
        {
          ok: false,
          retryable: false,
          error:
            "Gmail accepted the delivery request, but Groovy could not verify its final result. Groovy will not risk sending that recipient twice.",
        },
        { status: 409 },
      );
    }
    if (
      personalizedTracking &&
      existingOperationMetadata.email_send_state === "sending" &&
      priorClaimIsFresh
    ) {
      return NextResponse.json(
        {
          ok: false,
          retryable: true,
          retryAfterMs: Math.max(
            1_000,
            PERSONALIZED_SEND_CLAIM_LEASE_MS -
              (Date.now() - priorClaimedAt),
          ),
          error:
            "This email is still being delivered. Groovy will not send it twice.",
        },
        { status: 409 },
      );
    }
    const canReuseRecipientDeliveries =
      personalizedTracking &&
      existingRecipientDeliveries.length === recipients.length &&
      recipients.every((recipient) =>
        existingRecipientDeliveries.some(
          (delivery) =>
            delivery.recipient === recipient &&
            (delivery.state === "sent" ||
              Boolean(delivery.tokenEncrypted)),
        ),
      );
    const recipientDeliveries: EmailTrackingRecipientDelivery[] =
      personalizedTracking
        ? canReuseRecipientDeliveries
          ? existingRecipientDeliveries
          : recipients.map((recipient) => {
              const token = createEmailTrackingToken();
              return {
                recipient,
                tokenHash: hashEmailTrackingToken(token),
                tokenEncrypted: encryptLlmApiKey(token),
                state: "prepared",
                sentAt: null,
                firstOpenedAt: null,
                lastOpenedAt: null,
                openCount: 0,
              };
            })
        : [];
    const trackingToken = personalizedTracking
      ? null
      : createEmailTrackingToken();
    const trackingTokenHash = trackingToken
      ? hashEmailTrackingToken(trackingToken)
      : null;
    const trackingStartedAt = new Date().toISOString();
    let operationMetadata: RecordLike = {
      ...existingOperationMetadata,
      email_tracking_record: true,
      email_tracking_token_hash: trackingTokenHash,
      [EMAIL_TRACKING_RECIPIENT_HASHES_KEY]: personalizedTracking
        ? recipientDeliveries.map((delivery) => delivery.tokenHash)
        : [],
      [EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY]:
        personalizedTracking ? recipientDeliveries : [],
      email_tracking_mode: personalizedTracking
        ? "recipient_specific"
        : "shared",
      email_tracking_recipients: recipients,
      email_tracking_subject: draftForSend.subject,
      email_tracking_sent_at:
        text(existingOperationMetadata.email_tracking_sent_at) ||
        trackingStartedAt,
      email_tracking_message_date: messageDate,
      email_tracking_message_id_header: messageIdHeader,
      email_tracking_open_count:
        Number(existingOperationMetadata.email_tracking_open_count) || 0,
      email_tracking_draft_id: draftId,
      email_workspace_override_view: "sent",
      email_send_request_id: requestId,
      email_send_state: "prepared",
      email_send_prepared_at:
        text(existingOperationMetadata.email_send_prepared_at) ||
        trackingStartedAt,
      ...(recoveredOversizedPersonalizedSend
        ? {
            email_send_claim_id: null,
            email_send_claimed_at: null,
            email_send_last_error: null,
            email_send_last_error_at: null,
            email_send_recovered_oversized_at: trackingStartedAt,
          }
        : {}),
      email_tracking_disabled: false,
    };
    const operationWrite =
      existingOperation.data?.id && personalizedTracking
        ? {
            data: {
              id: existingOperation.data.id,
              metadata: existingOperationMetadata,
            },
            error: null,
          }
        : existingOperation.data?.id
      ? await auth.supabase
          .from("inbox_actions")
          .update({
            gmail_thread_id: draftForSend.threadId || threadId || null,
            subject: draftForSend.subject || null,
            snippet: draftForSend.body.slice(0, 500) || null,
            draft_to: recipients,
            metadata: operationMetadata,
            updated_at: trackingStartedAt,
          })
          .eq("id", existingOperation.data.id)
          .eq("user_id", auth.userId)
          .select("id,metadata")
          .maybeSingle()
        : await auth.supabase
          .from("inbox_actions")
          .insert({
            user_id: auth.userId,
            provider: "gmail",
            connection_id: connectionId,
            mailbox_label: mailbox.displayName || mailbox.address,
            gmail_message_id: `tracking:${draftId}`,
            gmail_thread_id: draftForSend.threadId || threadId || null,
            sender_email: mailbox.address,
            sender_name: mailbox.displayName,
            subject: draftForSend.subject || null,
            snippet: draftForSend.body.slice(0, 500) || null,
            // Keep synthetic tracking records out of the ordinary action window.
            received_at: "1970-01-01T00:00:00.000Z",
            recommended_action: "label_only",
            status: "done",
            confidence: 1,
            reason: "Private open tracking for a message sent from Groovy.",
            draft_to: recipients,
            executed_at: trackingStartedAt,
            metadata: operationMetadata,
          })
          .select("id,metadata")
          .maybeSingle();
    let operationRecord = operationWrite.data;
    if (operationWrite.error || !operationRecord?.id) {
      const concurrentOperation = await auth.supabase
        .from("inbox_actions")
        .select("id,metadata")
        .eq("user_id", auth.userId)
        .eq("provider", "gmail")
        .eq("connection_id", connectionId)
        .eq("gmail_message_id", `tracking:${draftId}`)
        .eq("recommended_action", "label_only")
        .maybeSingle();
      const concurrentMetadata = recordMetadata(
        concurrentOperation.data?.metadata,
      );
      if (
        concurrentOperation.error ||
        !concurrentOperation.data?.id ||
        (text(concurrentMetadata.email_send_request_id) !== requestId &&
          concurrentMetadata.email_send_state === "sent")
      ) {
        throw new Error(
          operationWrite.error?.message ||
            "Could not prepare a safe, duplicate-proof send.",
        );
      }
      operationRecord = concurrentOperation.data;
    }
    const trackingRecordId =
      typeof operationRecord?.id === "string"
        ? operationRecord.id
        : null;
    if (!trackingRecordId) {
      throw new Error("Could not prepare a safe, duplicate-proof send.");
    }
    if (recoveredOversizedPersonalizedSend) {
      const clearedRecipientRecords = await auth.supabase
        .from("inbox_actions")
        .delete()
        .eq("user_id", auth.userId)
        .eq("provider", "gmail")
        .eq("connection_id", connectionId)
        .contains("metadata", {
          [EMAIL_TRACKING_RECIPIENT_RECORD_KEY]: true,
          email_tracking_parent_record_id: trackingRecordId,
        });
      if (clearedRecipientRecords.error) {
        throw new Error(
          "Could not safely reset recipient tracking for this unsent email.",
        );
      }
    }
    if (personalizedTracking) {
      const sendClaimId = randomUUID();
      const priorSendState =
        text(existingOperationMetadata.email_send_state) || "prepared";
      const priorClaimId = text(
        existingOperationMetadata.email_send_claim_id,
      );
      const claimedMetadata: RecordLike = {
        ...operationMetadata,
        email_send_state: "sending",
        email_send_claim_id: sendClaimId,
        email_send_claimed_at: new Date().toISOString(),
      };
      let claimQuery = auth.supabase
        .from("inbox_actions")
        .update({
          gmail_thread_id:
            draftForSend.threadId || threadId || null,
          subject: draftForSend.subject || null,
          snippet: draftForSend.body.slice(0, 500) || null,
          draft_to: recipients,
          metadata: claimedMetadata,
          updated_at: new Date().toISOString(),
        })
        .eq("id", trackingRecordId)
        .eq("user_id", auth.userId)
        .eq("metadata->>email_send_state", priorSendState);
      if (priorSendState === "sending" && priorClaimId) {
        claimQuery = claimQuery.eq(
          "metadata->>email_send_claim_id",
          priorClaimId,
        );
      }
      const claim = await claimQuery
        .select("id")
        .maybeSingle();
      if (claim.error || !claim.data?.id) {
        return NextResponse.json(
          {
            ok: false,
            retryable: false,
            error:
              "This email is already being delivered. Groovy will not send it twice.",
          },
          { status: 409 },
        );
      }
      operationMetadata = claimedMetadata;
      const existingRecipientRows = await auth.supabase
        .from("inbox_actions")
        .select("gmail_message_id,metadata")
        .eq("user_id", auth.userId)
        .eq("provider", "gmail")
        .eq("connection_id", connectionId)
        .contains("metadata", {
          [EMAIL_TRACKING_RECIPIENT_RECORD_KEY]: true,
          email_tracking_parent_record_id: trackingRecordId,
        })
        .limit(500);
      if (existingRecipientRows.error) {
        throw new Error(
          "Could not prepare private recipient tracking. The email was not sent.",
        );
      }
      const existingHashes = new Set(
        (existingRecipientRows.data || [])
          .map((row) =>
            text(recordMetadata(row.metadata).email_tracking_token_hash),
          )
          .filter(Boolean),
      );
      const missingRecipientRows = recipientDeliveries
        .filter((delivery) => !existingHashes.has(delivery.tokenHash))
        .map((delivery) => ({
          user_id: auth.userId,
          provider: "gmail",
          connection_id: connectionId,
          mailbox_label:
            hydratedMailbox.displayName || verifiedSenderAddress,
          gmail_message_id:
            `tracking-recipient:${draftId}:${delivery.tokenHash}`,
          gmail_thread_id:
            draftForSend.threadId || threadId || null,
          sender_email: verifiedSenderAddress,
          sender_name: hydratedMailbox.displayName,
          subject: draftForSend.subject || null,
          snippet: draftForSend.body.slice(0, 500) || null,
          received_at: "1970-01-01T00:00:00.000Z",
          recommended_action: "label_only",
          status: "done",
          confidence: 1,
          reason:
            "Private recipient open tracking for a message sent from Groovy.",
          draft_to: [delivery.recipient],
          executed_at: trackingStartedAt,
          metadata: {
            [EMAIL_TRACKING_METADATA_KEY]: true,
            [EMAIL_TRACKING_RECIPIENT_RECORD_KEY]: true,
            email_tracking_parent_record_id: trackingRecordId,
            email_tracking_token_hash: delivery.tokenHash,
            email_tracking_recipients: [delivery.recipient],
            email_tracking_subject: draftForSend.subject,
            email_tracking_sent_at: trackingStartedAt,
            email_tracking_open_count: 0,
            email_tracking_disabled: false,
          },
        }));
      if (missingRecipientRows.length > 0) {
        const recipientInsert = await auth.supabase
          .from("inbox_actions")
          .insert(missingRecipientRows);
        if (recipientInsert.error) {
          throw new Error(
            "Could not prepare private recipient tracking. The email was not sent.",
          );
        }
      }
    }
    let trackingWarning: string | null = null;
    const deliveryWarning =
      personalizedCandidate && !personalizedTransportFits
        ? "This large group email was sent with one shared open receipt instead of individual recipient receipts."
        : null;
    const persistOperationMetadata = async (
      metadata: RecordLike,
      updates?: RecordLike,
    ) => {
      const now = new Date().toISOString();
      const result = await auth.supabase
        .from("inbox_actions")
        .update({
          ...(updates || {}),
          metadata,
          updated_at: now,
        })
        .eq("id", trackingRecordId)
        .eq("user_id", auth.userId);
      if (result.error) {
        throw new Error(
          "Could not record the send safely. The email was not sent.",
        );
      }
    };
    const draftUpdate = {
      mailbox,
      draftId,
      threadId: draftForSend.threadId || threadId || null,
      sourceMessageId: draftForSend.sourceMessageId,
      to: draftForSend.to,
      cc: draftForSend.cc,
      bcc: draftForSend.bcc,
      subject: draftForSend.subject,
      body: draftForSend.body,
      bodyHtml,
      attachments: attachmentPayload.resolved,
      inReplyTo: draftForSend.inReplyTo,
      references: draftForSend.references,
    };
    let sent: { messageId: string | null; threadId: string | null };
    let personalizedSentCopyCleanup: {
      mailbox: typeof hydratedMailbox;
      messageIdHeader: string;
      expectedCopyCount: number;
      canonicalMessageId: string;
    } | null = null;
    if (personalizedTracking) {
      const activeDeliveries = emailTrackingRecipientDeliveries(
        operationMetadata[EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY],
      );
      const pendingDeliveryIndexes = activeDeliveries.flatMap(
        (delivery, index) =>
          delivery.state === "sent" ? [] : [index],
      );
      const variants = pendingDeliveryIndexes.map((index) => {
        const delivery = activeDeliveries[index];
        if (!delivery.tokenEncrypted) {
          throw new Error(
            `Could not safely resume delivery to ${delivery.recipient}.`,
          );
        }
        return {
          recipient: delivery.recipient,
          raw: buildRawMessage({
            from,
            to: draftForSend.to,
            cc: draftForSend.cc,
            bcc: draftForSend.bcc.includes(delivery.recipient)
              ? [delivery.recipient]
              : [],
            subject: draftForSend.subject,
            body: disclosedBody,
            bodyHtml,
            attachments: attachmentPayload.resolved,
            inReplyTo: draftForSend.inReplyTo,
            references: draftForSend.references,
            trackingPixelUrl: emailTrackingPixelUrl(
              new URL(request.url).origin,
              decryptLlmApiKey(delivery.tokenEncrypted),
            ),
            date: messageDate,
            messageId: messageIdHeader,
          }),
        };
      });
      if (pendingDeliveryIndexes.length > 0) {
        const batchStartedAt = new Date().toISOString();
        for (const index of pendingDeliveryIndexes) {
          const delivery = activeDeliveries[index];
          activeDeliveries[index] = {
            ...delivery,
            state: "sending",
          };
        }
        operationMetadata = {
          ...operationMetadata,
          [EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY]: activeDeliveries,
          email_send_state: "sending",
          email_send_started_at: batchStartedAt,
        };
        await persistOperationMetadata(operationMetadata);
        const results = await sendPersonalizedEmailVariants({
          mailbox: hydratedMailbox,
          envelopeFrom: verifiedSenderAddress,
          variants,
          maxConcurrency: 3,
        });
        let firstFailure: string | null = null;
        let hasUnverifiedFailure = false;
        for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
          const result = results[resultIndex];
          const deliveryIndex = pendingDeliveryIndexes[resultIndex];
          const delivery = activeDeliveries[deliveryIndex];
          if (result.ok) {
            activeDeliveries[deliveryIndex] = {
              ...delivery,
              tokenEncrypted: undefined,
              state: "sent",
              sentAt: new Date().toISOString(),
            };
          } else {
            if (result.definitelyNotSent) {
              activeDeliveries[deliveryIndex] = {
                ...delivery,
                state: "prepared",
              };
            } else {
              hasUnverifiedFailure = true;
            }
            if (!firstFailure) firstFailure = result.error;
          }
        }
        operationMetadata = {
          ...operationMetadata,
          [EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY]: activeDeliveries,
          ...(firstFailure
            ? {
                email_send_state: hasUnverifiedFailure
                  ? "sending"
                  : "failed",
                email_send_last_error: firstFailure.slice(0, 500),
                email_send_last_error_at: new Date().toISOString(),
              }
            : {
                email_send_last_error: null,
                email_send_last_error_at: null,
              }),
        };
        await persistOperationMetadata(operationMetadata);
        if (firstFailure) {
          throw new Error(
            "Gmail did not confirm every recipient. Groovy stopped instead of risking a duplicate.",
          );
        }
      }

      const recordedSentMessageId = text(
        operationMetadata.email_tracking_sent_message_id,
      );
      const recordedSentThreadId = text(
        operationMetadata.email_tracking_sent_thread_id,
      );
      if (recordedSentMessageId) {
        sent = {
          messageId: recordedSentMessageId,
          threadId:
            recordedSentThreadId ||
            draftForSend.threadId ||
            threadId ||
            null,
        };
      } else {
        const sentCopyRaw = buildRawMessage({
          from,
          to: draftForSend.to,
          cc: draftForSend.cc,
          bcc: draftForSend.bcc,
          subject: draftForSend.subject,
          body: disclosedBody,
          bodyHtml,
          attachments: attachmentPayload.resolved,
          inReplyTo: draftForSend.inReplyTo,
          references: draftForSend.references,
          date: messageDate,
          messageId: messageIdHeader,
        });
        sent = await insertGmailSentMessage({
          mailbox,
          raw: sentCopyRaw,
          threadId: draftForSend.threadId || threadId || null,
          priority: "interactive",
        });
        operationMetadata = {
          ...operationMetadata,
          email_tracking_sent_message_id: sent.messageId,
          email_tracking_sent_thread_id: sent.threadId,
          email_send_delivery_completed_at: new Date().toISOString(),
          email_tracking_smtp_cleanup_pending: !text(
            operationMetadata.email_tracking_smtp_copies_trashed_at,
          ),
        };
        await persistOperationMetadata(operationMetadata, {
          ...(sent.messageId ? { gmail_message_id: sent.messageId } : {}),
          ...(sent.threadId ? { gmail_thread_id: sent.threadId } : {}),
        });
      }
      if (
        !text(operationMetadata.email_tracking_smtp_copies_trashed_at) &&
        sent.messageId
      ) {
        personalizedSentCopyCleanup = {
          mailbox: hydratedMailbox,
          messageIdHeader,
          expectedCopyCount: activeDeliveries.length,
          canonicalMessageId: sent.messageId,
        };
      }
      await deleteGmailDraft({
        mailbox,
        draftId,
        priority: "interactive",
      });
    } else {
      try {
        await updateGmailDraft({
          ...draftUpdate,
          priority: "interactive",
          ...(trackingToken
            ? {
                trackingPixelUrl: emailTrackingPixelUrl(
                  new URL(request.url).origin,
                  trackingToken,
                ),
              }
            : {}),
        });
      } catch (trackingError) {
        if (
          trackingError instanceof GmailApiError &&
          trackingError.retryable
        ) {
          throw trackingError;
        }
        trackingWarning = "This message was sent without open tracking.";
        await auth.supabase
          .from("inbox_actions")
          .update({
            metadata: {
              ...operationMetadata,
              email_tracking_disabled: true,
              email_send_state: "prepared",
            },
            updated_at: new Date().toISOString(),
          })
          .eq("id", trackingRecordId)
          .eq("user_id", auth.userId);
        await updateGmailDraft({
          ...draftUpdate,
          priority: "interactive",
        });
      }
      const sendingAt = new Date().toISOString();
      operationMetadata = {
        ...operationMetadata,
        ...(trackingWarning ? { email_tracking_disabled: true } : {}),
        email_send_state: "sending",
        email_send_started_at: sendingAt,
      };
      await persistOperationMetadata(operationMetadata);
      try {
        sent = await sendGmailDraft({
          mailbox,
          draftId,
          priority: "interactive",
        });
      } catch (sendError) {
        if (isMissingGmailEntityError(sendError)) {
          const remainingDraft = await fetchGmailDraft({
            mailbox,
            draftId,
            priority: "interactive",
          });
          if (!remainingDraft) {
            sent = {
              messageId: null,
              threadId: draftForSend.threadId || threadId || null,
            };
            trackingWarning =
              trackingWarning ||
              "Gmail accepted the email while another retry was finishing.";
          } else {
            throw sendError;
          }
        } else {
          const retryable =
            sendError instanceof GmailApiError && sendError.retryable;
          operationMetadata = {
            ...operationMetadata,
            ...(trackingWarning
              ? { email_tracking_disabled: true }
              : {}),
            // A proxy timeout or 5xx can happen after Gmail accepted the
            // draft. Keep the operation in its recoverable state so the
            // next request checks whether the draft still exists before
            // attempting another send.
            email_send_state: retryable ? "sending" : "failed",
            email_send_last_error:
              sendError instanceof Error
                ? sendError.message.slice(0, 500)
                : "Gmail send failed.",
            email_send_last_error_at: new Date().toISOString(),
          };
          await persistOperationMetadata(operationMetadata);
          throw sendError;
        }
      }
    }
    const confirmedSentAt = new Date().toISOString();
    const resolvedThreadId =
      sent.threadId || threadId || action?.threadId || "";
    const finalOperationMetadata: RecordLike = {
      ...operationMetadata,
      email_tracking_sent_at: confirmedSentAt,
      email_tracking_sent_message_id: sent.messageId,
      email_tracking_sent_thread_id: resolvedThreadId,
      email_send_state: "sent",
      email_send_completed_at: confirmedSentAt,
      ...(trackingWarning ? { email_tracking_disabled: true } : {}),
    };
    if (trackingRecordId) {
      const trackingUpdate = await auth.supabase
        .from("inbox_actions")
        .update({
          ...(sent.messageId ? { gmail_message_id: sent.messageId } : {}),
          ...(sent.threadId ? { gmail_thread_id: sent.threadId } : {}),
          metadata: finalOperationMetadata,
          updated_at: confirmedSentAt,
        })
        .eq("id", trackingRecordId)
        .eq("user_id", auth.userId);
      if (trackingUpdate.error) {
        trackingWarning = "The email was sent, but open status may be delayed.";
      }
    }
    let cleanupWarning: string | null = null;
    if (action) {
      const sentAt = new Date().toISOString();
      cleanupWarning = await keepSentActionInWorkspace({
        actionId: action.id,
        sentAt,
        attachmentNames: attachmentPayload.attachments.map(
          (attachment) => attachment.filename,
        ),
      });
    }
    await scheduleAfterResponse(async () => {
      const cleanupTasks: Promise<void>[] = [];
      cleanupTasks.push(
        removeEmailDraftAttachments({
          supabase: auth.supabase,
          userId: auth.userId,
          value: attachmentPayload.attachments,
        }),
      );
      cleanupTasks.push(
        removeSyncedEmailComposerDraft({
          supabase: auth.supabase,
          userId: auth.userId,
          connectionId,
          draftId,
        }),
      );
      if (personalizedSentCopyCleanup && trackingRecordId) {
        cleanupTasks.push(
          cleanupPersonalizedSentCopies({
            cleanupMailbox: personalizedSentCopyCleanup.mailbox,
            trackingRecordId,
            messageIdHeader:
              personalizedSentCopyCleanup.messageIdHeader,
            expectedCopyCount:
              personalizedSentCopyCleanup.expectedCopyCount,
            canonicalMessageId:
              personalizedSentCopyCleanup.canonicalMessageId,
          }),
        );
      }
      const settled = await Promise.allSettled(cleanupTasks);
      const failures = settled.filter(
        (result) => result.status === "rejected",
      );
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} post-send cleanup operation(s) failed.`,
        );
      }
    }, `email send cleanup ${trackingRecordId || draftId}`);
    return NextResponse.json({
      ok: true,
      actionHandled: !action || cleanupWarning === null,
      sentThread: confirmedSentThread({
        operationId: trackingRecordId,
        connectionId,
        mailbox: hydratedMailbox,
        metadata: finalOperationMetadata,
        messageId: sent.messageId,
        threadId: resolvedThreadId,
        snippet: draftForSend.body.replace(/\s+/g, " ").trim().slice(0, 500),
      }),
      ...(cleanupWarning || trackingWarning || deliveryWarning
        ? {
            warning: [deliveryWarning, trackingWarning, cleanupWarning]
              .filter(Boolean)
              .join(" "),
          }
        : {}),
      tracking: {
        enabled: Boolean(trackingRecordId) && trackingWarning === null,
        attribution: trackingAttribution(operationMetadata),
      },
    });
  } catch (error) {
    if (error instanceof GmailApiError && error.retryable) {
      return gmailRetryResponse(error);
    }
    return jsonError(error, "Could not send this email.");
  }
}
