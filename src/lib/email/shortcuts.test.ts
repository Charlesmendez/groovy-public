import assert from "node:assert/strict";
import test from "node:test";
import {
  canRunEmailWorkspaceShortcut,
  isPlainEmailShortcut,
  type EmailShortcutFocusContext,
} from "./shortcuts";

function shortcutEvent(
  overrides: Partial<Parameters<typeof isPlainEmailShortcut>[0]> = {},
) {
  return {
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    metaKey: false,
    repeat: false,
    ...overrides,
  };
}

test("plain email shortcuts remain available", () => {
  assert.equal(isPlainEmailShortcut(shortcutEvent()), true);
});

test("native command, control, and option combinations do not become email shortcuts", () => {
  assert.equal(isPlainEmailShortcut(shortcutEvent({ metaKey: true })), false);
  assert.equal(isPlainEmailShortcut(shortcutEvent({ ctrlKey: true })), false);
  assert.equal(isPlainEmailShortcut(shortcutEvent({ altKey: true })), false);
});

test("already handled and composing keyboard events are ignored", () => {
  assert.equal(
    isPlainEmailShortcut(shortcutEvent({ defaultPrevented: true })),
    false,
  );
  assert.equal(
    isPlainEmailShortcut(shortcutEvent({ isComposing: true })),
    false,
  );
  assert.equal(
    isPlainEmailShortcut(shortcutEvent({ repeat: true })),
    false,
  );
});

function focusContext(
  overrides: Partial<EmailShortcutFocusContext> = {},
): EmailShortcutFocusContext {
  return {
    shortcut: "forward",
    typing: false,
    overlayOpen: false,
    inDialog: false,
    enterControlFocused: false,
    navigationControlFocused: false,
    ...overrides,
  };
}

test("email letter shortcuts remain active when an email row button owns focus", () => {
  assert.equal(
    canRunEmailWorkspaceShortcut(focusContext({ shortcut: "forward" })),
    true,
  );
  assert.equal(
    canRunEmailWorkspaceShortcut(focusContext({ shortcut: "mark-done" })),
    true,
  );
});

test("returning focus to the neutral email list keeps every thread command active", () => {
  const shortcuts = [
    "next",
    "previous",
    "open-reply-all",
    "forward",
    "mark-done",
    "archive",
    "toggle-star",
    "mark-unread",
  ] as const;

  for (const shortcut of shortcuts) {
    assert.equal(
      canRunEmailWorkspaceShortcut(focusContext({ shortcut })),
      true,
      `${shortcut} should remain available after closing an email`,
    );
  }
});

test("email shortcuts stay out of typing fields, dialogs, and native control keys", () => {
  assert.equal(
    canRunEmailWorkspaceShortcut(focusContext({ typing: true })),
    false,
  );
  assert.equal(
    canRunEmailWorkspaceShortcut(focusContext({ inDialog: true })),
    false,
  );
  assert.equal(
    canRunEmailWorkspaceShortcut(
      focusContext({
        shortcut: "open-reply-all",
        enterControlFocused: true,
      }),
    ),
    false,
  );
  assert.equal(
    canRunEmailWorkspaceShortcut(
      focusContext({ shortcut: "next", navigationControlFocused: true }),
    ),
    false,
  );
  assert.equal(
    canRunEmailWorkspaceShortcut(
      focusContext({ shortcut: "escape", typing: true, inDialog: true }),
    ),
    true,
  );
});
