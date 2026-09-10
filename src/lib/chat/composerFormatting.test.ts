import assert from "node:assert/strict";
import test from "node:test";
import { applyChatComposerFormat } from "./composerFormatting";

test("wraps selected text and keeps the content selected", () => {
  assert.deepEqual(
    applyChatComposerFormat(
      { value: "make this clear", selectionStart: 5, selectionEnd: 9 },
      "bold",
    ),
    {
      value: "make **this** clear",
      selectionStart: 7,
      selectionEnd: 11,
    },
  );
});

test("formats links with an explicit safe authoring target", () => {
  assert.deepEqual(
    applyChatComposerFormat(
      { value: "Read docs", selectionStart: 5, selectionEnd: 9 },
      "link",
      { href: "https://example.com" },
    ).value,
    "Read [docs](https://example.com)",
  );
});

test("prefixes every selected line for lists and quotes", () => {
  assert.equal(
    applyChatComposerFormat(
      { value: "one\ntwo", selectionStart: 0, selectionEnd: 7 },
      "ordered-list",
    ).value,
    "1. one\n2. two",
  );
  assert.equal(
    applyChatComposerFormat(
      { value: "important", selectionStart: 0, selectionEnd: 9 },
      "quote",
    ).value,
    "> important",
  );
});
