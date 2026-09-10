const EMAIL_ADDRESS_PATTERN =
  /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi;

export function recipientAddresses(value: string): string[] {
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const match of value.match(EMAIL_ADDRESS_PATTERN) || []) {
    const email = match.toLocaleLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    addresses.push(email);
  }
  return addresses;
}

export function recipientAddress(value: string): string | null {
  return recipientAddresses(value)[0] || null;
}

export function appendRecipientAddresses(
  current: string,
  additions: readonly string[],
): string {
  return recipientAddresses([current, ...additions].join(", ")).join(", ");
}

export function removeRecipientAddress(
  current: string,
  address: string,
): string {
  const normalized = address.trim().toLocaleLowerCase();
  return recipientAddresses(current)
    .filter((item) => item !== normalized)
    .join(", ");
}

export type EmailRecipientFields = {
  to: string[];
  cc: string[];
  bcc: string[];
};

/**
 * Preserve every known alias while always adding the identity verified from
 * the connected Gmail profile. Automatic-recipient safety must not treat
 * partial or legacy metadata as a substitute for the sending mailbox itself.
 */
export function mergeVerifiedOwnedRecipientAddresses(args: {
  knownAddresses?: unknown;
  userAddress?: unknown;
  verifiedMailboxAddress: string;
}): string[] {
  const values: string[] = [];
  const append = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) append(item);
      return;
    }
    if (value !== null && value !== undefined) {
      values.push(String(value));
    }
  };
  append(args.knownAddresses);
  append(args.userAddress);
  append(args.verifiedMailboxAddress);
  return recipientAddresses(values.join(", "));
}

/**
 * Automatic reply drafts must never target an address owned by the sender.
 * Keep this separate from manual compose validation because emailing yourself
 * can be intentional in a user-created message.
 */
export function sanitizeAutomaticRecipientFields(args: {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  ownedAddresses: readonly string[];
}): EmailRecipientFields {
  const owned = new Set(
    recipientAddresses(args.ownedAddresses.join(", ")),
  );
  const seen = new Set<string>();
  const sanitize = (value: unknown): string[] => {
    const serialized = Array.isArray(value)
      ? value.map((item) => String(item || "")).join(", ")
      : String(value || "");
    const result: string[] = [];
    for (const address of recipientAddresses(serialized)) {
      if (owned.has(address) || seen.has(address)) continue;
      seen.add(address);
      result.push(address);
    }
    return result;
  };
  return {
    to: sanitize(args.to),
    cc: sanitize(args.cc),
    bcc: sanitize(args.bcc),
  };
}

export function mergeAutomaticReplyRecipients(args: {
  to?: unknown;
  cc?: unknown;
  senderAddress?: string | null;
  ownedAddresses: readonly string[];
}): Pick<EmailRecipientFields, "to" | "cc"> {
  const preferred = sanitizeAutomaticRecipientFields({
    to: args.to,
    cc: args.cc,
    ownedAddresses: args.ownedAddresses,
  });
  if (preferred.to.length > 0) {
    return { to: preferred.to, cc: preferred.cc };
  }
  const fallback = sanitizeAutomaticRecipientFields({
    to: args.senderAddress ? [args.senderAddress] : [],
    cc: args.cc,
    ownedAddresses: args.ownedAddresses,
  });
  return { to: fallback.to, cc: fallback.cc };
}
