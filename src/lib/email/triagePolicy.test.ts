import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEmailTriageEvidence,
  hasAlignedGmailAuthentication,
  mergeEmailTriageEvidence,
} from "./triagePolicy";

const googleAuth = (domain: string) =>
  `mx.google.com; dkim=pass header.i=@${domain}; spf=pass; dmarc=pass header.from=${domain}`;

test("authenticated operational mail from OpenAI, Mercury, and Cloudflare is protected", () => {
  const cases = [
    {
      senderEmail: "noreply@tm.openai.com",
      senderDomain: "tm.openai.com",
      kind: "account" as const,
    },
    {
      senderEmail: "notifications@mercury.com",
      senderDomain: "mercury.com",
      kind: "financial" as const,
    },
    {
      senderEmail: "noreply@notify.cloudflare.com",
      senderDomain: "notify.cloudflare.com",
      kind: "transactional" as const,
    },
  ];

  for (const item of cases) {
    const decision = applyEmailTriageEvidence({
      senderEmail: item.senderEmail,
      senderDomain: item.senderDomain,
      to: "owner@example.com",
      cc: "",
      authenticationResults: googleAuth(item.senderDomain),
      ownedAddresses: ["owner@example.com"],
      gmailLabelIds: ["INBOX", "IMPORTANT"],
      incomingCount: 3,
    }, item.kind);
    assert.equal(decision?.signal, "authenticated_operational");
    assert.equal(decision?.action, "label_only");
    assert.ok((decision?.pImportant || 0) >= 0.95);
  }
});

test("a display-name spoof or unauthenticated lookalike gets no trusted treatment", () => {
  assert.equal(
    applyEmailTriageEvidence({
      senderEmail: "security@openai.example.net",
      senderDomain: "openai.example.net",
      to: "owner@example.com",
      cc: "",
      authenticationResults: googleAuth("openai.example.net"),
      ownedAddresses: ["owner@example.com"],
      gmailLabelIds: ["IMPORTANT"],
    }, "security"),
    null,
  );
  assert.equal(
    applyEmailTriageEvidence({
      senderEmail: "security@openai.com",
      senderDomain: "openai.com",
      to: "owner@example.com",
      cc: "",
      authenticationResults:
        "mx.google.com; dkim=fail header.i=@openai.com; dmarc=fail header.from=openai.com",
      ownedAddresses: ["owner@example.com"],
      gmailLabelIds: ["IMPORTANT"],
    }, "security"),
    null,
  );
});

test("the operational protection is sender-agnostic", () => {
  const decision = applyEmailTriageEvidence({
    senderEmail: "alerts@accounts.example-bank.test",
    senderDomain: "accounts.example-bank.test",
    to: "owner@example.com",
    cc: "",
    authenticationResults: googleAuth("accounts.example-bank.test"),
    ownedAddresses: ["owner@example.com"],
    senderReputation: "trusted",
  }, "financial");
  assert.equal(decision?.signal, "authenticated_operational");
  assert.equal(decision?.action, "label_only");
});

test("an authenticated product newsletter is not promoted just because it names a service feature", () => {
  assert.equal(
    applyEmailTriageEvidence({
      senderEmail: "news@email.openai.com",
      senderDomain: "email.openai.com",
      to: "owner@example.com",
      cc: "",
      listUnsubscribe: "<https://email.openai.com/unsubscribe>",
      authenticationResults: googleAuth("email.openai.com"),
      ownedAddresses: ["owner@example.com"],
      gmailLabelIds: ["IMPORTANT"],
    }, "bulk")?.signal,
    "obvious_noise",
  );
});

test("promotional lists and repetitive cold outreach are classified as noise", () => {
  const newsletter = applyEmailTriageEvidence({
    senderEmail: "offers@vendor.example",
    senderDomain: "vendor.example",
    to: "owner@example.com",
    cc: "",
    listUnsubscribe: "<https://vendor.example/unsubscribe>",
  }, "bulk");
  assert.equal(newsletter?.signal, "obvious_noise");
  assert.equal(newsletter?.action, "unsubscribe");

  const coldSales = applyEmailTriageEvidence({
    senderEmail: "sales@agency.example",
    senderDomain: "agency.example",
    to: "owner@example.com",
    cc: "",
    senderReputation: "risky",
  }, "cold_outreach");
  assert.equal(coldSales?.signal, "obvious_noise");
});

test("prior correspondence keeps ordinary bulk-looking mail model-routed", () => {
  assert.equal(
    applyEmailTriageEvidence({
      senderEmail: "alex@partner.example",
      senderDomain: "partner.example",
      to: "owner@example.com",
      cc: "",
      listUnsubscribe: "<mailto:alex@partner.example>",
      repliedCount: 2,
    }, "bulk"),
    null,
  );
});

test("a direct human reply from an established correspondent is protected", () => {
  const decision = applyEmailTriageEvidence({
    senderEmail: "connor@partner.example",
    senderDomain: "partner.example",
    to: "owner@example.com",
    cc: "",
    ownedAddresses: ["owner@example.com"],
    repliedCount: 23,
  }, "human");

  assert.equal(decision?.signal, "prior_correspondent");
  assert.equal(decision?.action, "label_only");
  assert.equal(decision?.autoExecute, false);
  assert.ok((decision?.confidence || 0) >= 0.9);
});

test("prior-correspondent protection does not promote bulk or indirect mail", () => {
  assert.equal(
    applyEmailTriageEvidence({
      senderEmail: "news@partner.example",
      senderDomain: "partner.example",
      to: "owner@example.com",
      cc: "",
      ownedAddresses: ["owner@example.com"],
      listUnsubscribe: "<https://partner.example/unsubscribe>",
      repliedCount: 3,
    }, "human")?.signal,
    undefined,
  );
  assert.equal(
    applyEmailTriageEvidence({
      senderEmail: "alex@partner.example",
      senderDomain: "partner.example",
      to: "someone-else@example.com",
      cc: "",
      ownedAddresses: ["owner@example.com"],
      repliedCount: 3,
    }, "human"),
    null,
  );
});

test("prior-correspondent evidence preserves a generated reply draft", () => {
  const merged = mergeEmailTriageEvidence({
    messageKind: "human",
    action: "draft_reply",
    confidence: 0.9,
    pImportant: 0.92,
    pSpam: 0.01,
    pActionable: 0.96,
    reason: "The sender asked a direct question.",
    critical: false,
    autoExecute: false,
    draftReply: "Thanks, Connor. I will review this today.",
    targetThreadId: "thread-1",
    targetMessageIdHeader: "<message-1@example.com>",
  }, {
    action: "label_only",
    confidence: 0.97,
    pImportant: 0.97,
    pSpam: 0.01,
    pActionable: 0.85,
    reason: "Established correspondent.",
    critical: false,
    autoExecute: false,
    signal: "prior_correspondent",
  });

  assert.equal(merged.action, "draft_reply");
  assert.equal(
    merged.draftReply,
    "Thanks, Connor. I will review this today.",
  );
});

test("authentication must be Google's aligned pass result", () => {
  assert.equal(
    hasAlignedGmailAuthentication({
      authenticationResults: googleAuth("notify.cloudflare.com"),
      senderDomain: "notify.cloudflare.com",
    }),
    true,
  );
  assert.equal(
    hasAlignedGmailAuthentication({
      authenticationResults:
        "attacker.example; dmarc=pass header.from=cloudflare.com",
      senderDomain: "cloudflare.com",
    }),
    false,
  );
});

test("operational evidence preserves a safe model-generated draft", () => {
  const modelDecision = {
    messageKind: "financial" as const,
    action: "draft_reply" as const,
    confidence: 0.84,
    pImportant: 0.86,
    pSpam: 0.02,
    pActionable: 0.92,
    reason: "The sender asked for confirmation.",
    critical: false,
    autoExecute: false,
    draftReply: "Confirmed, thank you.",
    targetThreadId: "thread-1",
    targetMessageIdHeader: "<message-1@example.com>",
  };
  const merged = mergeEmailTriageEvidence(modelDecision, {
    action: "label_only",
    confidence: 0.97,
    pImportant: 0.97,
    pSpam: 0.01,
    pActionable: 0.9,
    reason: "Authenticated operational notice.",
    critical: false,
    autoExecute: false,
    signal: "authenticated_operational",
  });
  assert.equal(merged.action, "draft_reply");
  assert.equal(merged.draftReply, "Confirmed, thank you.");
  assert.equal(merged.targetThreadId, "thread-1");
  assert.equal(merged.pImportant, 0.97);
  assert.equal(merged.pActionable, 0.92);
});

test("noise evidence removes an unsafe draft recommendation", () => {
  const merged = mergeEmailTriageEvidence(
    {
      messageKind: "spam" as const,
      action: "draft_reply" as const,
      confidence: 0.8,
      pImportant: 0.5,
      pSpam: 0.8,
      pActionable: 0.5,
      reason: "Model draft.",
      critical: false,
      autoExecute: false,
      draftReply: "Please remove me.",
      targetThreadId: "thread-1",
    },
    {
      action: "mark_spam",
      confidence: 0.96,
      pImportant: 0.04,
      pSpam: 0.98,
      pActionable: 0.05,
      reason: "Spam evidence.",
      critical: false,
      autoExecute: false,
      signal: "obvious_noise",
    },
  );
  assert.equal(merged.action, "mark_spam");
  assert.equal(merged.draftReply, "");
  assert.equal(merged.targetThreadId, undefined);
});
