import assert from "node:assert/strict";
import test from "node:test";
import {
  toPlainChatPreview,
  tokenizeChatInline,
} from "@/lib/chat/messageFormatting";

test("tokenizeChatInline renders common chat formatting without HTML", () => {
  assert.deepEqual(
    tokenizeChatInline(
      "Use **Flow**, run `npm test`, then read [the guide](https://example.com/guide).",
    ),
    [
      { type: "text", value: "Use " },
      { type: "strong", value: "Flow" },
      { type: "text", value: ", run " },
      { type: "code", value: "npm test" },
      { type: "text", value: ", then read " },
      {
        type: "link",
        label: "the guide",
        href: "https://example.com/guide",
      },
      { type: "text", value: "." },
    ],
  );
});

test("tokenizeChatInline supports the composer emphasis controls", () => {
  assert.deepEqual(
    tokenizeChatInline(
      "_italic_, __underlined__, and ~~removed~~ plus *also italic*",
    ),
    [
      { type: "italic", value: "italic" },
      { type: "text", value: ", " },
      { type: "underline", value: "underlined" },
      { type: "text", value: ", and " },
      { type: "strike", value: "removed" },
      { type: "text", value: " plus " },
      { type: "italic", value: "also italic" },
    ],
  );
});

test("tokenizeChatInline linkifies bare pasted and typed http URLs", () => {
  const url = "https://github.com/datagran-auth/datagran-voice-agent";

  assert.deepEqual(tokenizeChatInline(`Repo: ${url}`), [
    { type: "text", value: "Repo: " },
    {
      type: "link",
      label: url,
      href: url,
    },
  ]);
  assert.deepEqual(tokenizeChatInline("Open http://example.com/docs"), [
    { type: "text", value: "Open " },
    {
      type: "link",
      label: "http://example.com/docs",
      href: "http://example.com/docs",
    },
  ]);
});

test("tokenizeChatInline keeps trailing sentence punctuation outside bare links", () => {
  assert.deepEqual(
    tokenizeChatInline("Read (https://example.com/docs?tab=api)."),
    [
      { type: "text", value: "Read (" },
      {
        type: "link",
        label: "https://example.com/docs?tab=api",
        href: "https://example.com/docs?tab=api",
      },
      { type: "text", value: ")." },
    ],
  );
});

test("tokenizeChatInline leaves unsafe link syntax inert", () => {
  assert.deepEqual(tokenizeChatInline("[open](javascript:alert(1))"), [
    { type: "text", value: "[open](javascript:alert(1))" },
  ]);
  assert.deepEqual(tokenizeChatInline("open javascript:alert(1)"), [
    { type: "text", value: "open javascript:alert(1)" },
  ]);
  assert.deepEqual(tokenizeChatInline("open ftp://example.com"), [
    { type: "text", value: "open ftp://example.com" },
  ]);
});

test("tokenizeChatInline does not autolink URLs inside inline code", () => {
  assert.deepEqual(
    tokenizeChatInline("Run `curl https://example.com`."),
    [
      { type: "text", value: "Run " },
      { type: "code", value: "curl https://example.com" },
      { type: "text", value: "." },
    ],
  );
});

test("toPlainChatPreview removes presentation punctuation", () => {
  assert.equal(
    toPlainChatPreview(
      "## Update\n> **Flow** lives at `/workspace` — [open it](https://example.com).",
    ),
    "Update\nFlow lives at /workspace — open it.",
  );
});
