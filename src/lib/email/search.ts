import type {
  EmailContactSuggestion,
  EmailSearchMatchField,
  EmailSearchResult,
  EmailThreadSummary,
} from "@/lib/email/types";

export type EmailSearchSuggestion = {
  email: string;
  name: string;
  receivedAt: string;
};

const MAX_SEARCH_QUERY_LENGTH = 320;
const MAX_SEARCH_TOKENS = 8;
const EMAIL_ADDRESS_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function normalizeComparable(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function gmailSafeValue(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f"{}()\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTokens(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of normalizeComparable(query).split(/[^\p{L}\p{N}@._+-]+/u)) {
    if (token.length < 2 || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= MAX_SEARCH_TOKENS) break;
  }
  return tokens;
}

function tokenCoverage(value: string, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  const normalized = normalizeComparable(value);
  if (!normalized) return 0;
  const matched = tokens.filter((token) => normalized.includes(token)).length;
  return matched / tokens.length;
}

function recencyBoost(receivedAt: string, now: number): number {
  const timestamp = Date.parse(receivedAt);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
  return Math.max(0, 18 - Math.log2(ageDays + 1) * 3);
}

export function normalizeEmailSearchQuery(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SEARCH_QUERY_LENGTH);
}

export function emailRecipientMailboxAddressKey(
  addresses: readonly string[],
): string {
  return Array.from(
    new Set(addresses.map(normalizeComparable).filter(Boolean)),
  )
    .sort()
    .join("|");
}

export function emailRecipientSuggestionCacheKey(args: {
  scope: string;
  mailboxAddresses: readonly string[];
  query: string;
}): string {
  return JSON.stringify([
    args.scope,
    emailRecipientMailboxAddressKey(args.mailboxAddresses),
    normalizeComparable(normalizeEmailSearchQuery(args.query)),
  ]);
}

export function isEmailAddressSearch(query: string): boolean {
  return EMAIL_ADDRESS_PATTERN.test(normalizeEmailSearchQuery(query));
}

/**
 * Gmail performs the body search. Exact phrases are included alongside a
 * bounded set of individual terms so typeahead still finds useful partial
 * matches while the user is composing a longer query.
 */
export function buildGmailSearchQuery(value: string): string {
  const query = normalizeEmailSearchQuery(value);
  const safe = gmailSafeValue(query);
  if (!safe) return "in:anywhere";
  if (isEmailAddressSearch(safe)) {
    return (
      "in:anywhere " +
      `{from:(${safe}) to:(${safe}) cc:(${safe}) bcc:(${safe}) "${safe}"}`
    );
  }
  const tokens = searchTokens(safe).map(gmailSafeValue).filter(Boolean);
  if (tokens.length <= 1) {
    return `in:anywhere "${safe}"`;
  }
  return `in:anywhere {"${safe}" ${tokens.join(" ")}}`;
}

/**
 * A strict companion query prevents broad typeahead terms such as "all" or
 * "it" from crowding an exact subject/content match out of Gmail's bounded
 * result page. The API merges this small exact pass with the broader pass.
 */
export function buildGmailExactSearchQuery(value: string): string | null {
  const query = normalizeEmailSearchQuery(value);
  const safe = gmailSafeValue(query);
  if (!safe || isEmailAddressSearch(safe) || searchTokens(safe).length <= 1) {
    return null;
  }
  return `in:anywhere "${safe}"`;
}

export function buildGmailContactSearchQuery(value: string): string {
  const safe = gmailSafeValue(normalizeEmailSearchQuery(value))
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}@._+\-\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!safe) return "in:anywhere";
  return (
    "in:anywhere " +
    `{from:(${safe}) to:(${safe}) cc:(${safe}) bcc:(${safe})}`
  );
}

/**
 * Builds a constrained PostgREST OR filter for Groovy's user-scoped message
 * index. Provider search remains authoritative for full message bodies; this
 * filter gives the UI an immediate first paint from indexed envelope data.
 */
export function buildIndexedEmailSearchFilter(value: string): string | null {
  const safe = normalizeEmailSearchQuery(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}@._+\-\s]/gu, " ")
    .trim()
    .replace(/\s+/g, "*");
  if (!safe) return null;
  const pattern = `*${safe}*`;
  return [
    "sender_email",
    "sender_name",
    "subject",
    "snippet",
    "reason",
  ]
    .map((column) => `${column}.ilike.${pattern}`)
    .join(",");
}

export function scoreEmailSearchSummary(
  value: string,
  summary: EmailThreadSummary,
  options?: {
    providerMatched?: boolean;
    now?: number;
  },
): EmailSearchResult | null {
  const query = normalizeComparable(normalizeEmailSearchQuery(value));
  if (!query) return null;

  const tokens = searchTokens(query);
  const sender = normalizeComparable(
    `${summary.senderName} ${summary.senderEmail}`,
  );
  const recipients = normalizeComparable(summary.recipients.join(" "));
  const subject = normalizeComparable(summary.subject);
  const content = normalizeComparable(
    `${summary.snippet} ${summary.action?.summary || ""}`,
  );
  const mailbox = normalizeComparable(
    `${summary.mailbox.displayName} ${summary.mailbox.address}`,
  );
  const matchedFields: EmailSearchMatchField[] = [];
  let score = 0;

  const addField = (
    field: EmailSearchMatchField,
    valueToSearch: string,
    phraseWeight: number,
    tokenWeight: number,
  ) => {
    const phraseMatch = valueToSearch.includes(query);
    const coverage = tokenCoverage(valueToSearch, tokens);
    if (!phraseMatch && coverage === 0) return;
    matchedFields.push(field);
    if (phraseMatch) score += phraseWeight;
    score += coverage * tokenWeight;
  };

  addField("sender", sender, 210, 95);
  addField("recipient", recipients, 190, 85);
  addField("subject", subject, 175, 105);
  addField("content", content, 125, 70);
  addField("mailbox", mailbox, 70, 35);

  if (isEmailAddressSearch(query)) {
    if (normalizeComparable(summary.senderEmail) === query) score += 120;
    if (
      summary.recipients.some(
        (recipient) => normalizeComparable(recipient) === query,
      )
    ) {
      score += 110;
    }
  }

  if (matchedFields.length === 0) {
    if (!options?.providerMatched) return null;
    // Gmail matched text outside the compact list preview, normally in the
    // message body. Keep it, but below matches we can explain locally.
    matchedFields.push("content");
    score = 45;
  }

  score += recencyBoost(summary.receivedAt, options?.now ?? Date.now());
  if (summary.unread) score += 5;
  if (summary.starred) score += 3;

  return {
    ...summary,
    searchScore: Math.round(score * 100) / 100,
    matchedFields,
  };
}

export function rankEmailSearchSummaries(
  query: string,
  summaries: readonly EmailThreadSummary[],
  options?: {
    providerMatched?: boolean;
    now?: number;
  },
): EmailSearchResult[] {
  return summaries
    .map((summary) => scoreEmailSearchSummary(query, summary, options))
    .filter((result): result is EmailSearchResult => result !== null)
    .sort((a, b) => {
      const score = b.searchScore - a.searchScore;
      if (score !== 0) return score;
      const received =
        (Number.isFinite(Date.parse(b.receivedAt))
          ? Date.parse(b.receivedAt)
          : 0) -
        (Number.isFinite(Date.parse(a.receivedAt))
          ? Date.parse(a.receivedAt)
          : 0);
      if (received !== 0) return received;
      return a.key.localeCompare(b.key);
    });
}

export function rankEmailSearchConversations(
  query: string,
  conversations: readonly {
    display: EmailThreadSummary;
    match: EmailThreadSummary;
  }[],
  options?: {
    providerMatched?: boolean;
    now?: number;
  },
): EmailSearchResult[] {
  const displayByConversation = new Map(
    conversations.map(({ display }) => [
      `${display.connectionId}:${display.threadId}`,
      display,
    ]),
  );
  return rankEmailSearchSummaries(
    query,
    conversations.map(({ match }) => match),
    options,
  ).map((match) => {
    const display = displayByConversation.get(
      `${match.connectionId}:${match.threadId}`,
    );
    return display
      ? {
          ...display,
          searchScore: match.searchScore,
          matchedFields: match.matchedFields,
        }
      : match;
  });
}

export function suggestEmailContacts(
  value: string,
  summaries: readonly EmailThreadSummary[],
  options?: {
    excludeEmails?: readonly string[];
    limit?: number;
  },
): EmailSearchSuggestion[] {
  const query = normalizeComparable(value);
  if (!query) return [];
  const excluded = new Set(
    (options?.excludeEmails || []).map(normalizeComparable),
  );
  const candidates = new Map<
    string,
    EmailSearchSuggestion & { score: number; timestamp: number }
  >();

  const addCandidate = (
    emailValue: string,
    nameValue: string,
    receivedAt: string,
  ) => {
    const email = emailValue.trim();
    const normalizedEmail = normalizeComparable(email);
    if (!normalizedEmail || excluded.has(normalizedEmail)) return;
    const name = nameValue.trim();
    const normalizedName = normalizeComparable(name);
    const localPart = normalizedEmail.split("@")[0] || "";
    let score = 0;
    if (normalizedEmail === query) score = 1_000;
    else if (normalizedEmail.startsWith(query)) score = 800;
    else if (localPart.startsWith(query)) score = 760;
    else if (normalizedName.startsWith(query)) score = 720;
    else if (normalizedEmail.includes(query)) score = 520;
    else if (normalizedName.includes(query)) score = 480;
    else return;
    const timestamp = Number.isFinite(Date.parse(receivedAt))
      ? Date.parse(receivedAt)
      : 0;
    const existing = candidates.get(normalizedEmail);
    if (
      !existing ||
      score > existing.score ||
      (score === existing.score && timestamp > existing.timestamp)
    ) {
      candidates.set(normalizedEmail, {
        email,
        name: name || email,
        receivedAt,
        score,
        timestamp,
      });
    }
  };

  // A complete address is already a valid, exact search target. Show it
  // immediately even when this person has not reached the recent-contact
  // cache yet; provider search can fill in their display name afterward.
  if (isEmailAddressSearch(value)) {
    const email = normalizeEmailSearchQuery(value).toLocaleLowerCase();
    addCandidate(email, email, new Date(0).toISOString());
  }

  for (const summary of summaries) {
    addCandidate(
      summary.senderEmail,
      summary.senderName,
      summary.receivedAt,
    );
    for (const recipient of summary.recipients) {
      addCandidate(recipient, recipient, summary.receivedAt);
    }
  }

  return [...candidates.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.timestamp - a.timestamp ||
        a.email.localeCompare(b.email),
    )
    .slice(0, Math.max(1, options?.limit || 6))
    .map(({ email, name, receivedAt }) => ({ email, name, receivedAt }));
}

export function filterEmailContactSuggestions<T extends EmailContactSuggestion>(
  value: string,
  suggestions: readonly T[],
  options?: {
    excludeEmails?: readonly string[];
    limit?: number;
  },
): T[] {
  const query = normalizeComparable(value);
  if (!query) return [];
  const excluded = new Set(
    (options?.excludeEmails || []).map(normalizeComparable),
  );
  const seen = new Set<string>();
  const result: T[] = [];
  for (const suggestion of suggestions) {
    const email = normalizeComparable(suggestion.email);
    const name = normalizeComparable(suggestion.name);
    const localPart = email.split("@")[0] || "";
    if (
      !email ||
      excluded.has(email) ||
      seen.has(email) ||
      (!email.includes(query) &&
        !localPart.includes(query) &&
        !name.includes(query))
    ) {
      continue;
    }
    seen.add(email);
    result.push(suggestion);
    if (result.length >= Math.max(1, options?.limit || 10)) break;
  }
  return result;
}
