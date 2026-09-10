"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  LayoutDashboard,
  LoaderCircle,
  Mail,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { getBrandName } from "@/lib/config/appConfig";
import {
  getDesktopApi,
  type DesktopNativeAppAreaShortcut,
} from "@/lib/desktop/shell";
import {
  appAreaHrefForShortcut,
  appAreaNavigationState,
  isAppAreaActive,
  type AppAreaHref,
} from "@/lib/navigation/appArea";
import {
  APP_AREA_ATTENTION_EVENT,
  appAreaAttentionDetail,
  appAttentionAreaForHref,
  readAppAreaAttention,
  type AppAttentionArea,
} from "@/lib/navigation/appAttention";

const APP_AREA_SHORTCUT_HREFS: Record<
  DesktopNativeAppAreaShortcut,
  AppAreaHref
> = {
  "command-center": "/dashboard",
  chat: "/chat",
  email: "/email",
};

export function AppNav({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const [pendingNavigation, setPendingNavigation] = useState<{
    href: AppAreaHref;
    fromPathname: string;
  } | null>(null);
  const [attention, setAttention] = useState<Record<AppAttentionArea, number>>(
    () => readAppAreaAttention(),
  );
  const lastAreaShortcutRef = useRef<{
    href: AppAreaHref;
    source: "dom" | "native";
    at: number;
  } | null>(null);
  const pendingHref =
    pendingNavigation?.fromPathname === pathname
      ? pendingNavigation.href
      : null;
  const items: Array<{
    href: AppAreaHref;
    label: string;
    shortLabel: string;
    icon: LucideIcon;
    shortcutDigit: "1" | "2" | "3";
  }> = [
    {
      href: "/dashboard",
      label: "Command Center",
      shortLabel: "Command",
      icon: LayoutDashboard,
      shortcutDigit: "1",
    },
    {
      href: "/chat",
      label: "Chat",
      shortLabel: "Chat",
      icon: MessageSquare,
      shortcutDigit: "2",
    },
    {
      href: "/email",
      label: "Email",
      shortLabel: "Email",
      icon: Mail,
      shortcutDigit: "3",
    },
  ];

  useEffect(() => {
    if (!pendingNavigation) return;
    const timeout = window.setTimeout(
      () => setPendingNavigation(null),
      10_000,
    );
    return () => window.clearTimeout(timeout);
  }, [pendingNavigation]);

  useEffect(() => {
    const onAttention = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = appAreaAttentionDetail(event.detail);
      if (!detail) return;
      setAttention((current) =>
        current[detail.area] === detail.count
          ? current
          : { ...current, [detail.area]: detail.count },
      );
    };
    window.addEventListener(APP_AREA_ATTENTION_EVENT, onAttention);
    return () =>
      window.removeEventListener(APP_AREA_ATTENTION_EVENT, onAttention);
  }, []);

  const navigateWithShortcut = useCallback(
    (href: AppAreaHref, source: "dom" | "native") => {
      const now = Date.now();
      const previous = lastAreaShortcutRef.current;
      if (
        previous?.href === href &&
        previous.source !== source &&
        now - previous.at < 250
      ) {
        return;
      }
      lastAreaShortcutRef.current = { href, source, at: now };
      if (isAppAreaActive(pathname, href)) return;
      setPendingNavigation({ href, fromPathname: pathname });
      router.push(href);
    },
    [pathname, router],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const href = appAreaHrefForShortcut(event);
      if (!href) return;
      event.preventDefault();
      navigateWithShortcut(href, "dom");
    };
    document.addEventListener("keydown", onKeyDown, true);
    const unsubscribeNative = getDesktopApi().onNativeAppAreaShortcut(
      (shortcut) => {
        navigateWithShortcut(APP_AREA_SHORTCUT_HREFS[shortcut], "native");
      },
    );
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      unsubscribeNative();
    };
  }, [navigateWithShortcut]);

  const onNavigate = (
    event: ReactMouseEvent<HTMLAnchorElement>,
    href: AppAreaHref,
    active: boolean,
  ) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    // Explicitly own primary app-area navigation. In iOS Home Screen mode,
    // allowing the anchor fallback to win can create a full document load and
    // discard the warm Chat/Email trees that normal browser navigation keeps.
    event.preventDefault();
    if (active) return;
    navigateWithShortcut(href, "dom");
  };

  return (
    <nav
      aria-label={`${getBrandName()} areas`}
      className="flex shrink-0 items-center rounded-xl border border-white/10 bg-black/20 p-0.5"
    >
      {items.map((item) => {
        const state = appAreaNavigationState({
          pathname,
          href: item.href,
          pendingHref,
        });
        const Icon = state.pending ? LoaderCircle : item.icon;
        const attentionArea = appAttentionAreaForHref(item.href);
        const attentionCount = attentionArea ? attention[attentionArea] : 0;
        const showAttention = attentionCount > 0 && !state.active;
        const attentionLabel =
          attentionArea === "chat"
            ? `${attentionCount} unread ${attentionCount === 1 ? "message" : "messages"}`
            : `${attentionCount} new ${attentionCount === 1 ? "email" : "emails"}`;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={(event) => onNavigate(event, item.href, state.active)}
            className={`relative flex h-8 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-lg text-xs transition-all active:scale-[0.97] ${
              state.active
                ? "bg-cyan-400/[0.13] text-cyan-50 shadow-[inset_0_0_0_1px_rgba(103,232,249,0.16)]"
                : state.pending
                  ? "bg-cyan-400/[0.08] text-cyan-200 shadow-[inset_0_0_0_1px_rgba(103,232,249,0.10)]"
                  : "text-zinc-500 hover:bg-white/[0.045] hover:text-zinc-200"
            } ${compact ? "w-8 justify-center px-0" : "px-2.5"}`}
            aria-label={
              showAttention ? `${item.label}, ${attentionLabel}` : item.label
            }
            aria-current={state.active ? "page" : undefined}
            aria-busy={state.pending || undefined}
            aria-keyshortcuts={`Meta+${item.shortcutDigit} Control+${item.shortcutDigit}`}
            data-state={
              state.active ? "active" : state.pending ? "pending" : "idle"
            }
            title={`${item.label} (⌘${item.shortcutDigit} / Ctrl+${item.shortcutDigit})`}
          >
            <Icon
              className={`h-3.5 w-3.5 shrink-0 ${
                state.pending ? "animate-spin" : ""
              }`}
              aria-hidden="true"
            />
            <span
              className={
                compact
                  ? "sr-only"
                  : "hidden min-[1040px]:inline min-[1320px]:hidden"
              }
            >
              {item.shortLabel}
            </span>
            <span
              className={
                compact ? "sr-only" : "hidden min-[1320px]:inline"
              }
            >
              {item.label}
            </span>
            {state.active || state.pending ? (
              <span
                className={`absolute inset-x-2 bottom-0 h-px rounded-full ${
                  state.pending
                    ? "animate-pulse bg-cyan-300/60"
                    : "bg-cyan-300"
                }`}
                aria-hidden="true"
              />
            ) : null}
            {showAttention ? (
              <span
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_7px_rgba(103,232,249,0.95)] ring-1 ring-zinc-950"
                aria-hidden="true"
                data-app-attention={attentionArea || undefined}
              />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
