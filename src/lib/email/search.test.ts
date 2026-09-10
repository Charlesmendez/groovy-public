import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIndexedEmailSearchFilter,
  buildGmailContactSearchQuery,
  buildGmailExactSearchQuery,
  buildGmailSearchQuery,
  emailRecipientMailboxAddressKey,
  emailRecipientSuggestionCacheKey,
  filterEmailContactSuggestions,
  isEmailAddressSearch,
  rankEmailSearchConversations,
  rankEmailSearchSummaries,
  scoreEmailSearchSummary,
  suggestEmailContacts,
} from "./search";
import type { EmailThreadSummary } from "./types";

test("recipient cache keys are user-scoped and stable across mailbox refreshes", () => {
  assert.equal(
    emailRecipientMailboxAddressKey([
      "Work@Example.com",
      "personal@example.com",
      "work@example.com",
    ]),
    "personal@example.com|work@example.com",
  );
  const first = emailRecipientSuggestionCacheKey({
    scope: "user-a",
    mailboxAddresses: ["work@example.com", "personal@example.com"],
    query: "  Alex  ",
  });
  assert.equal(
    first,
    emailRecipientSuggestionCacheKey({
      scope: "user-a",
      mailboxAddresses: ["PERSONAL@example.com", "work@example.com"],
      query: "alex",
    }),
  );
  assert.notEqual(
    first,
    emailRecipientSuggestionCacheKey({
      scope: "user-b",
      mailboxAddresses: ["work@example.com", "personal@example.com"],
      query: "alex",
    }),
  );
});

const mailbox = {
  connectionId: "gmail-1",
  provider: "gmail" as const,
  address: "owner@example.com",
  displayName: "Work",
  color: "#22d3ee",
  monogram: "WO",
  isDefaultSender: true,
  includedInUnified: true,
  aiInstructions: "",
  status: "connected" as const,
  counts: { inbox: 1, focus: 0, drafts: 0, noise: 0 },
};

function summary(
  overrides: Partial<EmailThreadSummary> = {},
): EmailThreadSummary {
  return {
    key: "gmail-1:message:message-1",
    connectionId: "gmail-1",
    mailbox,
    messageId: "message-1",
    threadId: "thread-1",
    senderName: "Alex Rivera",
    senderEmail: "alex@example.com",
    recipients: ["owner@example.com"],
    subject: "Quarterly launch plan",
    snippet: "The launch checklist is attached for review.",
    receivedAt: "2026-07-27T12:00:00.000Z",
    unread: true,
    starred: false,
    hasAttachments: false,
    direction: "incoming",
    openStatus: null,
    calendarInvite: null,
    action: null,
    draft: null,
    ...overrides,
  };
}

test("Gmail search covers all mail and uses exact address operators", () => {
  assert.equal(isEmailAddressSearch("alex@example.com"), true);
  assert.equal(isEmailAddressSearch("alex"), false);
  const query = buildGmailSearchQuery("alex@example.com");
  assert.match(query, /^in:anywhere /);
  assert.match(query, /from:\(alex@example\.com\)/);
  assert.match(query, /to:\(alex@example\.com\)/);
});

test("contact search asks Gmail for matching participants in every folder", () => {
  assert.equal(
    buildGmailContactSearchQuery("Jessie"),
    "in:anywhere {from:(jessie) to:(jessie) cc:(jessie) bcc:(jessie)}",
  );
  assert.equal(
    buildGmailContactSearchQuery('Jessie") OR from:attacker@example.com'),
    "in:anywhere {from:(jessie or from attacker@example.com) to:(jessie or from attacker@example.com) cc:(jessie or from attacker@example.com) bcc:(jessie or from attacker@example.com)}",
  );
});

test("indexed search filters are bounded to known text columns", () => {
  assert.equal(
    buildIndexedEmailSearchFilter(" Mark (VIP), AccuLynx "),
    "sender_email.ilike.*mark*vip*acculynx*," +
      "sender_name.ilike.*mark*vip*acculynx*," +
      "subject.ilike.*mark*vip*acculynx*," +
      "snippet.ilike.*mark*vip*acculynx*," +
      "reason.ilike.*mark*vip*acculynx*",
  );
  assert.equal(buildIndexedEmailSearchFilter("(){}"), null);
});

test("multi-word content queries keep an exact phrase and partial terms", () => {
  assert.equal(
    buildGmailSearchQuery(' quarterly   "launch" '),
    'in:anywhere {"quarterly launch" quarterly launch}',
  );
  assert.equal(
    buildGmailExactSearchQuery("One listing. That's all it takes"),
    `in:anywhere "One listing. That's all it takes"`,
  );
  assert.equal(buildGmailExactSearchQuery("listing"), null);
  assert.equal(buildGmailExactSearchQuery("alex@example.com"), null);
});

test("user text cannot inject Gmail search operators", () => {
  const query = buildGmailSearchQuery("from:attacker@example.com {trash}");
  assert.equal(
    query,
    'in:anywhere {"from:attacker@example.com trash" from attacker@example.com trash}',
  );
  assert.equal(query.includes(" {trash}"), false);
});

test("exact sender matches outrank content-only provider matches", () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z");
  const senderMatch = scoreEmailSearchSummary(
    "alex@example.com",
    summary(),
    { providerMatched: true, now },
  );
  const bodyOnlyMatch = scoreEmailSearchSummary(
    "alex@example.com",
    summary({
      key: "gmail-1:message:message-2",
      messageId: "message-2",
      threadId: "thread-2",
      senderName: "Taylor",
      senderEmail: "taylor@example.net",
      recipients: ["owner@example.com"],
      subject: "Hello",
      snippet: "A match exists deeper in the message body.",
    }),
    { providerMatched: true, now },
  );
  assert.ok(senderMatch);
  assert.ok(bodyOnlyMatch);
  assert.ok(senderMatch.searchScore > bodyOnlyMatch.searchScore);
  assert.deepEqual(senderMatch.matchedFields, ["sender"]);
  assert.deepEqual(bodyOnlyMatch.matchedFields, ["content"]);
});

test("local ranking excludes loaded messages with no visible match", () => {
  const results = rankEmailSearchSummaries("invoice", [
    summary(),
    summary({
      key: "gmail-1:message:message-2",
      messageId: "message-2",
      threadId: "thread-2",
      subject: "Invoice 1042",
    }),
  ]);
  assert.deepEqual(
    results.map((result) => result.messageId),
    ["message-2"],
  );
});

test("conversation search ranks the matching email but displays the true latest reply", () => {
  const matched = summary({
    senderName: "Adriana Becerra",
    senderEmail: "adriana@compensar.com",
    snippet: "An older message that matched the query.",
    receivedAt: "2026-07-02T12:00:00.000Z",
  });
  const latest = summary({
    key: "gmail-1:message:message-latest",
    messageId: "message-latest",
    senderName: "Ivonne Granados",
    senderEmail: "ivonne@example.com",
    snippet: "This is the actual latest reply shown on the card.",
    receivedAt: "2026-07-27T12:00:00.000Z",
  });
  const [result] = rankEmailSearchConversations(
    "adriana@compensar.com",
    [{ display: latest, match: matched }],
    {
      providerMatched: true,
      now: Date.parse("2026-07-28T12:00:00.000Z"),
    },
  );
  assert.equal(result.messageId, "message-latest");
  assert.equal(result.senderName, "Ivonne Granados");
  assert.equal(
    result.snippet,
    "This is the actual latest reply shown on the card.",
  );
  assert.deepEqual(result.matchedFields, ["sender"]);
});

test("contact suggestions rank prefixes, deduplicate, and exclude the owner", () => {
  const suggestions = suggestEmailContacts(
    "ale",
    [
      summary(),
      summary({
        key: "gmail-1:message:message-2",
        messageId: "message-2",
        threadId: "thread-2",
        senderName: "Alex Rivera",
        senderEmail: "ALEX@example.com",
        recipients: ["owner@example.com", "alexa@vendor.test"],
        receivedAt: "2026-07-28T12:00:00.000Z",
      }),
      summary({
        key: "gmail-1:message:message-3",
        messageId: "message-3",
        threadId: "thread-3",
        senderName: "Taylor Aleman",
        senderEmail: "taylor@example.net",
      }),
    ],
    { excludeEmails: ["owner@example.com"] },
  );
  assert.deepEqual(
    suggestions.map(({ email }) => email.toLowerCase()),
    ["alex@example.com", "alexa@vendor.test", "taylor@example.net"],
  );
});

test("a complete email address is immediately selectable before contact indexing", () => {
  assert.deepEqual(
    suggestEmailContacts("NEW.PERSON@Example.com", []).map(
      ({ email, name }) => ({ email, name }),
    ),
    [
      {
        email: "new.person@example.com",
        name: "new.person@example.com",
      },
    ],
  );
});

test("remote contact suggestions are filtered against the current query and all exclusions", () => {
  const suggestions = [
    {
      email: "Alex@example.com",
      name: "Alex Rivera",
      lastContactAt: "2026-07-28T12:00:00.000Z",
      mailboxAddress: "",
      mailboxDisplayName: "Work",
    },
    {
      email: "owner@example.com",
      name: "Owner",
      lastContactAt: "2026-07-28T11:00:00.000Z",
      mailboxAddress: "",
      mailboxDisplayName: "Work",
    },
    {
      email: "Taylor@example.com",
      name: "Taylor",
      lastContactAt: "2026-07-28T10:00:00.000Z",
      mailboxAddress: "",
      mailboxDisplayName: "Work",
    },
    {
      email: "alex@EXAMPLE.com",
      name: "Duplicate",
      lastContactAt: "2026-07-27T10:00:00.000Z",
      mailboxAddress: "",
      mailboxDisplayName: "Work",
    },
  ];
  assert.deepEqual(
    filterEmailContactSuggestions("ale", suggestions, {
      excludeEmails: ["owner@example.com"],
    }).map((suggestion) => suggestion.email),
    ["Alex@example.com"],
  );
  assert.deepEqual(
    filterEmailContactSuggestions("tay", suggestions).map(
      (suggestion) => suggestion.email,
    ),
    ["Taylor@example.com"],
  );
});
