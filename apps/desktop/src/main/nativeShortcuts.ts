export type NativeComposerShortcut = "mod-enter" | "mod-j";

export type NativeAppAreaShortcut =
  | "command-center"
  | "chat"
  | "email";

export type NativeEmailShortcut =
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

export type NativeKeyboardInput = {
  type?: string;
  key?: string;
  code?: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
  isAutoRepeat?: boolean;
  isComposing?: boolean;
};

/**
 * Normalize the small set of composer shortcuts that the hosted UI cannot
 * always observe reliably through Electron's DOM keyboard events.
 */
export function parseNativeComposerShortcut(
  input: NativeKeyboardInput
): NativeComposerShortcut | null {
  if (
    input.type !== "keyDown" ||
    input.isAutoRepeat ||
    input.isComposing ||
    (!input.meta && !input.control)
  ) {
    return null;
  }

  const key = (input.key || "").toLowerCase();
  const code = (input.code || "").toLowerCase();
  if (
    key === "enter" ||
    key === "return" ||
    code === "enter" ||
    code === "numpadenter"
  ) {
    return "mod-enter";
  }
  if (key === "j" || code === "keyj") return "mod-j";
  return null;
}

/**
 * Normalize global product-area navigation when Electron consumes the
 * Command/Control number key before Chromium dispatches a DOM keydown event.
 */
export function parseNativeAppAreaShortcut(
  input: NativeKeyboardInput
): NativeAppAreaShortcut | null {
  if (
    input.type !== "keyDown" ||
    input.isAutoRepeat ||
    input.isComposing ||
    input.alt ||
    input.shift ||
    (!input.meta && !input.control)
  ) {
    return null;
  }

  const key = (input.key || "").toLowerCase();
  const code = (input.code || "").toLowerCase();
  if (key === "1" || code === "digit1" || code === "numpad1") {
    return "command-center";
  }
  if (key === "2" || code === "digit2" || code === "numpad2") {
    return "chat";
  }
  if (key === "3" || code === "digit3" || code === "numpad3") {
    return "email";
  }
  return null;
}

/**
 * Forward email workspace keys that Electron can consume before the hosted UI
 * receives a DOM keydown event. The renderer still decides whether the active
 * element and current email state allow the command.
 */
export function parseNativeEmailShortcut(
  input: NativeKeyboardInput
): NativeEmailShortcut | null {
  if (
    input.type !== "keyDown" ||
    input.isAutoRepeat ||
    input.isComposing ||
    input.meta ||
    input.control ||
    input.alt
  ) {
    return null;
  }

  const key = (input.key || "").toLowerCase();
  const code = (input.code || "").toLowerCase();
  if (key === "escape" || code === "escape") return "escape";
  if (key === "?" || (code === "slash" && input.shift)) {
    return "open-shortcuts";
  }
  if (key === "/" || code === "slash") return "search";
  if (key === "c" || code === "keyc") return "compose";
  if (
    key === "j" ||
    code === "keyj" ||
    key === "arrowdown" ||
    code === "arrowdown"
  ) {
    return "next";
  }
  if (
    key === "k" ||
    code === "keyk" ||
    key === "arrowup" ||
    code === "arrowup"
  ) {
    return "previous";
  }
  if (
    key === "enter" ||
    key === "return" ||
    code === "enter" ||
    code === "numpadenter"
  ) {
    return "open-reply-all";
  }
  if (key === "f" || code === "keyf") return "forward";
  if (key === "d" || code === "keyd") return "mark-done";
  if (key === "e" || code === "keye") return "archive";
  if (key === "s" || code === "keys") return "toggle-star";
  if (key === "u" || code === "keyu") return "mark-unread";
  return null;
}
