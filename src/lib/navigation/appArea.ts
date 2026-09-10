export type AppAreaHref = "/dashboard" | "/chat" | "/email";

export type AppAreaShortcutInput = {
  key?: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
};

export function appAreaHrefForShortcut(
  input: AppAreaShortcutInput,
): AppAreaHref | null {
  if (
    input.defaultPrevented ||
    input.repeat ||
    input.isComposing ||
    input.altKey ||
    input.shiftKey ||
    (!input.metaKey && !input.ctrlKey)
  ) {
    return null;
  }

  const key = (input.key || "").toLowerCase();
  const code = (input.code || "").toLowerCase();
  if (key === "1" || code === "digit1" || code === "numpad1") {
    return "/dashboard";
  }
  if (key === "2" || code === "digit2" || code === "numpad2") {
    return "/chat";
  }
  if (key === "3" || code === "digit3" || code === "numpad3") {
    return "/email";
  }
  return null;
}

export function isAppAreaActive(
  pathname: string,
  href: AppAreaHref,
): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function appAreaNavigationState(args: {
  pathname: string;
  href: AppAreaHref;
  pendingHref: AppAreaHref | null;
}): { active: boolean; pending: boolean } {
  const active = isAppAreaActive(args.pathname, args.href);
  return {
    active,
    pending: !active && args.pendingHref === args.href,
  };
}
