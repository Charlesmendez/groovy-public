import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureGroovyAiEmailDisclosure,
  GROOVY_AI_EMAIL_DISCLOSURE,
  stripGroovyAiEmailDisclosure,
} from "./disclosure";

test("adds the Groovy AI disclosure as a clear footnote", () => {
  assert.equal(
    ensureGroovyAiEmailDisclosure("Thanks for the update."),
    `Thanks for the update.\n\n—\n${GROOVY_AI_EMAIL_DISCLOSURE}`,
  );
});

test("never duplicates the disclosure", () => {
  const once = ensureGroovyAiEmailDisclosure("Thanks.");
  assert.equal(ensureGroovyAiEmailDisclosure(once), once);
  assert.equal(
    ensureGroovyAiEmailDisclosure(`${once}\n\n${GROOVY_AI_EMAIL_DISCLOSURE}`),
    once,
  );
});

test("upgrades legacy Groovy notices to the canonical disclosure", () => {
  assert.equal(
    ensureGroovyAiEmailDisclosure(
      "Thanks.\n\nSent with Groovy AI assistant. I apologize for any unintended messages.",
    ),
    `Thanks.\n\n—\n${GROOVY_AI_EMAIL_DISCLOSURE}`,
  );
});

test("removes only a trailing Groovy disclosure from the editable body", () => {
  assert.equal(
    stripGroovyAiEmailDisclosure(
      `Please keep this sentence.\n\n—\n${GROOVY_AI_EMAIL_DISCLOSURE}`,
    ),
    "Please keep this sentence.",
  );
  assert.equal(
    stripGroovyAiEmailDisclosure(
      `${GROOVY_AI_EMAIL_DISCLOSURE}\n\nThis is quoted context.`,
    ),
    `${GROOVY_AI_EMAIL_DISCLOSURE}\n\nThis is quoted context.`,
  );
});
