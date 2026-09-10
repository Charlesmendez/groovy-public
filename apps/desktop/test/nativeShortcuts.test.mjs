import assert from "node:assert/strict";
import test from "node:test";
import {
  parseNativeAppAreaShortcut,
  parseNativeComposerShortcut,
  parseNativeEmailShortcut,
} from "../dist/main/nativeShortcuts.js";

test("native app shortcuts normalize Command and Control number input", () => {
  assert.equal(
    parseNativeAppAreaShortcut({ type: "keyDown", key: "1", meta: true }),
    "command-center"
  );
  assert.equal(
    parseNativeAppAreaShortcut({ type: "keyDown", key: "2", control: true }),
    "chat"
  );
  assert.equal(
    parseNativeAppAreaShortcut({
      type: "keyDown",
      key: "Unidentified",
      code: "Digit3",
      meta: true,
    }),
    "email"
  );
});

test("native app shortcuts reject plain or conflicting input", () => {
  assert.equal(
    parseNativeAppAreaShortcut({ type: "keyDown", key: "1" }),
    null
  );
  assert.equal(
    parseNativeAppAreaShortcut({
      type: "keyDown",
      key: "2",
      meta: true,
      shift: true,
    }),
    null
  );
  assert.equal(
    parseNativeAppAreaShortcut({
      type: "keyDown",
      key: "3",
      control: true,
      isAutoRepeat: true,
    }),
    null
  );
});

test("native composer shortcuts normalize Command and Control input", () => {
  assert.equal(
    parseNativeComposerShortcut({
      type: "keyDown",
      key: "Enter",
      meta: true,
    }),
    "mod-enter"
  );
  assert.equal(
    parseNativeComposerShortcut({
      type: "keyDown",
      key: "J",
      control: true,
    }),
    "mod-j"
  );
  assert.equal(
    parseNativeComposerShortcut({
      type: "keyDown",
      key: "Unidentified",
      code: "KeyJ",
      meta: true,
    }),
    "mod-j"
  );
  assert.equal(
    parseNativeComposerShortcut({
      type: "keyDown",
      key: "Unidentified",
      code: "NumpadEnter",
      control: true,
    }),
    "mod-enter"
  );
});

test("native composer shortcuts ignore unrelated and repeated input", () => {
  assert.equal(
    parseNativeComposerShortcut({
      type: "keyDown",
      key: "Enter",
    }),
    null
  );
  assert.equal(
    parseNativeComposerShortcut({
      type: "keyUp",
      key: "Enter",
      meta: true,
    }),
    null
  );
  assert.equal(
    parseNativeComposerShortcut({
      type: "keyDown",
      key: "Enter",
      meta: true,
      isAutoRepeat: true,
    }),
    null
  );
  assert.equal(
    parseNativeComposerShortcut({
      type: "keyDown",
      key: "Enter",
      meta: true,
      isComposing: true,
    }),
    null
  );
  assert.equal(
    parseNativeComposerShortcut({
      type: "keyDown",
      key: "K",
      meta: true,
    }),
    null
  );
});

test("native email shortcuts normalize every workspace command", () => {
  const cases = [
    [{ key: "Escape" }, "escape"],
    [{ key: "?" }, "open-shortcuts"],
    [{ key: "Unidentified", code: "Slash", shift: true }, "open-shortcuts"],
    [{ key: "/" }, "search"],
    [{ key: "Unidentified", code: "Slash" }, "search"],
    [{ key: "C" }, "compose"],
    [{ key: "j" }, "next"],
    [{ key: "ArrowDown" }, "next"],
    [{ key: "k" }, "previous"],
    [{ key: "Unidentified", code: "ArrowUp" }, "previous"],
    [{ key: "Enter" }, "open-reply-all"],
    [{ key: "Unidentified", code: "NumpadEnter" }, "open-reply-all"],
    [{ key: "F" }, "forward"],
    [{ key: "Unidentified", code: "KeyF" }, "forward"],
    [{ key: "d" }, "mark-done"],
    [{ key: "Unidentified", code: "KeyD" }, "mark-done"],
    [{ key: "E" }, "archive"],
    [{ key: "s" }, "toggle-star"],
    [{ key: "U" }, "mark-unread"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(
      parseNativeEmailShortcut({ type: "keyDown", ...input }),
      expected
    );
  }
});

test("native email shortcuts reject modified, composing, repeated, and unrelated input", () => {
  assert.equal(
    parseNativeEmailShortcut({ type: "keyDown", key: "F", meta: true }),
    null
  );
  assert.equal(
    parseNativeEmailShortcut({ type: "keyDown", key: "D", control: true }),
    null
  );
  assert.equal(
    parseNativeEmailShortcut({ type: "keyDown", key: "E", alt: true }),
    null
  );
  assert.equal(
    parseNativeEmailShortcut({
      type: "keyDown",
      key: "S",
      isComposing: true,
    }),
    null
  );
  assert.equal(
    parseNativeEmailShortcut({
      type: "keyDown",
      key: "U",
      isAutoRepeat: true,
    }),
    null
  );
  assert.equal(
    parseNativeEmailShortcut({ type: "keyUp", key: "F" }),
    null
  );
  assert.equal(
    parseNativeEmailShortcut({ type: "keyDown", key: "Q" }),
    null
  );
});
