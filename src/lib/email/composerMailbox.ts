import type { EmailMailbox } from "@/lib/email/types";

export function defaultComposerMailbox(
  mailboxes: EmailMailbox[],
  preferredConnectionId?: string | null,
): EmailMailbox | undefined {
  const connected = mailboxes.filter(
    (mailbox) => mailbox.status === "connected",
  );
  return (
    connected.find(
      (mailbox) => mailbox.connectionId === preferredConnectionId,
    ) ||
    connected.find((mailbox) => mailbox.isDefaultSender) ||
    connected.find((mailbox) => mailbox.includedInUnified) ||
    connected[0] ||
    mailboxes.find(
      (mailbox) => mailbox.connectionId === preferredConnectionId,
    ) ||
    mailboxes.find((mailbox) => mailbox.isDefaultSender) ||
    mailboxes[0]
  );
}
