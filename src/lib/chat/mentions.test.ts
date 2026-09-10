import assert from "node:assert/strict";
import test from "node:test";
import {
  chatMentionTrigger,
  mentionsHandle,
  teamChatMentionHandle,
} from "./mentions";

test("finds an active mention at the cursor in channel and DM drafts", () => {
  assert.deepEqual(chatMentionTrigger("@dan", 4), {
    query: "dan",
    start: 0,
    end: 4,
  });
  assert.deepEqual(chatMentionTrigger("hello @agent", 12), {
    query: "agent",
    start: 6,
    end: 12,
  });
  assert.equal(chatMentionTrigger("hello@email.com", 15), null);
  assert.equal(chatMentionTrigger("hello @dan later", 16), null);
});

test("detects complete mentions and normalizes handles", () => {
  assert.equal(mentionsHandle("Hello @Groovy!", "groovy"), true);
  assert.equal(mentionsHandle("email@groovy.ai", "groovy"), false);
  assert.equal(
    teamChatMentionHandle("Groovy default", "groovy"),
    "Groovydefault",
  );
  assert.equal(teamChatMentionHandle("@agent-one"), "agent-one");
  assert.equal(teamChatMentionHandle("!!!", "fallback"), "fallback");
});
