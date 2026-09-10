type EmailShortcutEvent = {
  altKey: boolean;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  isComposing: boolean;
  metaKey: boolean;
  repeat: boolean;
};

export type EmailWorkspaceShortcut =
  | "escape"
  | "open-shortcuts"
  | "search"
  | "compose"
  | "next"
  | "previous"
  | "open-reply-all"
  | "forward"
  | "mark-done"
  | "archive"
  | "toggle-star"
  | "mark-unread";

export type EmailShortcutFocusContext = {
  shortcut: EmailWorkspaceShortcut;
  typing: boolean;
  overlayOpen: boolean;
  inDialog: boolean;
  enterControlFocused: boolean;
  navigationControlFocused: boolean;
};

export function isPlainEmailShortcut(event: EmailShortcutEvent): boolean {
  return (
    !event.defaultPrevented &&
    !event.isComposing &&
    !event.repeat &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}

export function canRunEmailWorkspaceShortcut(
  context: EmailShortcutFocusContext
): boolean {
  if (context.shortcut === "escape") return true;
  if (context.typing || context.overlayOpen || context.inDialog) return false;
  if (context.shortcut === "open-reply-all" && context.enterControlFocused) {
    return false;
  }
  if (
    (context.shortcut === "next" || context.shortcut === "previous") &&
    context.navigationControlFocused
  ) {
    return false;
  }
  return true;
}
