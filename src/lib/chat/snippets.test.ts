import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatSnippetValidationError,
  messageTextSnippet,
  textSnippetMessage,
  validateChatTextSnippet,
} from "./snippets";

test("normalizes a valid snippet and preserves long-form whitespace", () => {
  const snippet = validateChatTextSnippet({
    title: "  Release\tnotes ",
    content: "line one\n\nline two",
    language: "markdown",
  });
  assert.deepEqual(snippet, {
    title: "Release notes",
    content: "line one\n\nline two",
    language: "markdown",
    sizeBytes: 18,
    kind: "snippet",
  });
  assert.equal(textSnippetMessage(snippet!), "Shared a text snippet: Release notes");
});

test("supports long-form canvas presentation", () => {
  const canvas = validateChatTextSnippet({
    kind: "canvas",
    title: "Launch brief",
    content: "Goals\nRisks",
  });
  assert.equal(canvas?.kind, "canvas");
  assert.equal(textSnippetMessage(canvas!), "Shared a canvas: Launch brief");
});

test("rejects empty or oversized snippets", () => {
  assert.throws(
    () => validateChatTextSnippet({ content: "   " }),
    ChatSnippetValidationError,
  );
  assert.throws(
    () => validateChatTextSnippet({ content: "x".repeat(200_001) }),
    /200 KB/,
  );
});

test("reads only valid snippets from message metadata", () => {
  assert.equal(messageTextSnippet({ snippet: { content: "" } }), null);
  assert.equal(
    messageTextSnippet({ snippet: { content: "hello", title: "Greeting" } })
      ?.title,
    "Greeting",
  );
});
