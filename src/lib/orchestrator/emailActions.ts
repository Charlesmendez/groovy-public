import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createGmailDraft,
  fetchGmailThread,
  hydrateGmailMailboxProfile,
  loadGmailMailboxes,
  parseEmailAddresses,
  type EmailMailboxConnection,
} from "@/lib/email/gmail";
import { buildInternalRouteAuthHeaders } from "@/lib/internalRouteAuth";
import { EMAIL_DRAFT_SEND_INTERNAL_SCOPE } from "@/lib/email/internalScopes";

type EmailActionDependencies = {
  loadMailboxes: typeof loadGmailMailboxes;
  createDraft: typeof createGmailDraft;
  fetchThread: typeof fetchGmailThread;
  hydrateMailbox: typeof hydrateGmailMailboxProfile;
};

const DEFAULT_DEPENDENCIES: EmailActionDependencies = {
  loadMailboxes: loadGmailMailboxes,
  createDraft: createGmailDraft,
  fetchThread: fetchGmailThread,
  hydrateMailbox: hydrateGmailMailboxProfile,
};

function mailboxLabel(mailbox: EmailMailboxConnection): string {
  return mailbox.address
    ? `${mailbox.displayName} (${mailbox.address})`
    : mailbox.displayName;
}

function matchesMailboxHint(
  mailbox: EmailMailboxConnection,
  rawHint: string,
): boolean {
  const hint = rawHint.trim().toLowerCase();
  if (!hint) return false;
  return [mailbox.connectionId, mailbox.address, mailbox.displayName].some(
    (value) => value.trim().toLowerCase() === hint,
  );
}

async function resolveSenderMailbox(args: {
  supabase: SupabaseClient;
  userId: string;
  mailbox?: string | null;
  dependencies: EmailActionDependencies;
}): Promise<{ mailbox: EmailMailboxConnection; all: EmailMailboxConnection[] }> {
  const all = await args.dependencies.loadMailboxes({
    supabase: args.supabase,
    userId: args.userId,
    verifyProfile: false,
  });
  if (all.length === 0) {
    throw new Error("No Gmail mailbox is connected to Groovy.");
  }

  const hint = args.mailbox?.trim() || "";
  let selected: EmailMailboxConnection;
  if (hint) {
    const matched = all.filter((mailbox) => matchesMailboxHint(mailbox, hint));
    if (matched.length !== 1) {
      throw new Error(
        `Sender mailbox "${hint.slice(0, 200)}" was not found. Available mailboxes: ${all
          .map(mailboxLabel)
          .join(", ")}.`,
      );
    }
    selected = matched[0];
  } else {
    const defaults = all.filter((mailbox) => mailbox.isDefaultSender);
    if (defaults.length === 1) selected = defaults[0];
    else if (all.length === 1) selected = all[0];
    else {
      throw new Error(
        `Choose a sender mailbox before creating the draft: ${all
          .map(mailboxLabel)
          .join(", ")}.`,
      );
    }
  }
  const mailbox = await args.dependencies.hydrateMailbox({
    userId: args.userId,
    mailbox: selected,
    priority: "interactive",
  });
  if (mailbox.status !== "connected" || !mailbox.address) {
    throw new Error("Groovy could not verify the selected Gmail sender identity.");
  }
  return {
    mailbox,
    all: all.map((candidate) =>
      candidate.connectionId === mailbox.connectionId ? mailbox : candidate,
    ),
  };
}

export type CreateConnectedGmailDraftArgs = {
  supabase: SupabaseClient;
  userId: string;
  mailbox?: string | null;
  mode: "new" | "reply";
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  threadId?: string | null;
  replyAll?: boolean;
};

export async function createConnectedGmailDraft(
  args: CreateConnectedGmailDraftArgs,
  dependencies: EmailActionDependencies = DEFAULT_DEPENDENCIES,
) {
  const resolved = await resolveSenderMailbox({
    supabase: args.supabase,
    userId: args.userId,
    mailbox: args.mailbox,
    dependencies,
  });
  const body = args.body.slice(0, 100_000);
  if (!body.trim()) throw new Error("The email body is empty.");

  let draftArgs: Parameters<typeof createGmailDraft>[0];
  if (args.mode === "reply") {
    const threadId = args.threadId?.trim() || "";
    if (!threadId) throw new Error("A Gmail thread is required to draft a reply.");
    const thread = await dependencies.fetchThread({
      mailbox: resolved.mailbox,
      threadId,
      ownedAddresses: resolved.all.map((mailbox) => mailbox.address).filter(Boolean),
      priority: "interactive",
    });
    const latestMessage = thread.messages.at(-1);
    if (!latestMessage) throw new Error("That Gmail conversation has no replyable message.");
    const target = args.replyAll ? thread.replyAll : latestMessage.reply;
    if (target.to.length === 0) {
      throw new Error("Groovy could not determine a safe recipient for that reply.");
    }
    draftArgs = {
      mailbox: resolved.mailbox,
      threadId,
      sourceMessageId: latestMessage.id,
      to: target.to,
      cc: target.cc,
      bcc: [],
      subject: target.subject.slice(0, 998),
      body,
      inReplyTo: target.inReplyTo,
      references: target.references,
    };
  } else {
    const to = parseEmailAddresses(args.to || []);
    if (to.length === 0) {
      throw new Error("Add at least one complete recipient email address.");
    }
    draftArgs = {
      mailbox: resolved.mailbox,
      to,
      cc: parseEmailAddresses(args.cc || []),
      bcc: parseEmailAddresses(args.bcc || []),
      subject: (args.subject || "").slice(0, 998),
      body,
    };
  }

  const draft = await dependencies.createDraft(draftArgs);
  return {
    ok: true,
    status: "draft_created" as const,
    mailbox: {
      connectionId: resolved.mailbox.connectionId,
      displayName: resolved.mailbox.displayName,
      address: resolved.mailbox.address,
    },
    draft: {
      draftId: draft.draftId,
      connectionId: draft.connectionId,
      threadId: draft.threadId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      bodyPreview: draft.body.slice(0, 1_000),
    },
    nextAction: "Sending this Gmail draft requires explicit user confirmation.",
  };
}

type SendDraftDependencies = {
  fetch: typeof fetch;
  buildInternalHeaders: typeof buildInternalRouteAuthHeaders;
};

const DEFAULT_SEND_DEPENDENCIES: SendDraftDependencies = {
  fetch,
  buildInternalHeaders: buildInternalRouteAuthHeaders,
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function sendConnectedGmailDraft(args: {
  userId: string;
  appBaseUrl: string;
  connectionId: string;
  draftId: string;
}, dependencies: SendDraftDependencies = DEFAULT_SEND_DEPENDENCIES) {
  const connectionId = args.connectionId.trim().slice(0, 200);
  const draftId = args.draftId.trim().slice(0, 300);
  if (!connectionId || !draftId) {
    throw new Error("A Gmail connection ID and draft ID are required.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL("/api/email/draft/send", args.appBaseUrl);
  } catch {
    throw new Error("Groovy's email send service is not configured.");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("Groovy's email send service is not configured.");
  }
  const internalHeaders = dependencies.buildInternalHeaders({
    userId: args.userId,
    scope: EMAIL_DRAFT_SEND_INTERNAL_SCOPE,
  });
  if (Object.keys(internalHeaders).length === 0) {
    throw new Error("Groovy's secure email send authorization is not configured.");
  }
  const response = await dependencies.fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...internalHeaders,
    },
    // Deliberately send only owned identifiers. The route loads and verifies
    // recipients, content, attachments, and its stable idempotency key.
    body: JSON.stringify({ connectionId, draftId }),
  });
  const payload = record(await response.json().catch(() => ({})));
  if (!response.ok || payload.ok !== true) {
    const message =
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error.trim().slice(0, 500)
        : "Groovy could not safely send that Gmail draft.";
    throw new Error(message);
  }
  return {
    ok: true,
    status: payload.alreadySent === true ? "already_sent" : "sent",
    alreadySent: payload.alreadySent === true,
    sentThread: record(payload.sentThread),
    warning:
      typeof payload.warning === "string"
        ? payload.warning.trim().slice(0, 500)
        : "",
  };
}
