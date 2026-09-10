"use client";

import { useEffect, useMemo, useState } from "react";
import { BellRing, Download, Share2, X } from "lucide-react";
import { useWebPushNotifications } from "@/hooks/useWebPushNotifications";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

export function ChatNativeNudge({
  room,
}: {
  room: { id: string; kind: "channel" | "dm"; name: string };
}) {
  const notifications = useWebPushNotifications();
  const [dismissedInstall, setDismissedInstall] = useState(true);
  const [dismissedNotifications, setDismissedNotifications] = useState(true);
  const [standalone, setStandalone] = useState(false);
  const [installPrompt, setInstallPrompt] =
    useState<InstallPromptEvent | null>(null);
  const ios = useMemo(
    () =>
      typeof navigator !== "undefined" &&
      /iPad|iPhone|iPod/.test(navigator.userAgent),
    [],
  );

  useEffect(() => {
    const initialize = () => {
      setStandalone(isStandalone());
      try {
        setDismissedInstall(
          window.localStorage.getItem(
            "groovy-chat-install-nudge-dismissed",
          ) === "1",
        );
        setDismissedNotifications(
          window.localStorage.getItem(
            "groovy-chat-notification-nudge-dismissed",
          ) === "1",
        );
      } catch {
        setDismissedInstall(false);
        setDismissedNotifications(false);
      }
    };
    const initializationFrame = window.requestAnimationFrame(initialize);
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    return () => {
      window.cancelAnimationFrame(initializationFrame);
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
    };
  }, []);

  const canConnect =
    notifications.support === "supported" &&
    notifications.configured &&
    !notifications.migrationPending;
  const showIosInstall = ios && !standalone;
  const showingInstall =
    showIosInstall || Boolean(installPrompt && !standalone);
  const dismissed = showingInstall
    ? dismissedInstall
    : dismissedNotifications;
  if (
    dismissed ||
    notifications.loading ||
    notifications.deviceSubscribed ||
    notifications.permission === "denied"
  ) {
    return null;
  }
  if (!canConnect && !showIosInstall && !installPrompt) return null;

  const dismiss = () => {
    if (showingInstall) setDismissedInstall(true);
    else setDismissedNotifications(true);
    try {
      window.localStorage.setItem(
        showingInstall
          ? "groovy-chat-install-nudge-dismissed"
          : "groovy-chat-notification-nudge-dismissed",
        "1",
      );
    } catch {
      // Dismissal still lasts for this page session.
    }
  };

  return (
    <div className="border-b border-cyan-300/10 bg-cyan-300/[0.035] px-4 py-2.5">
      <div className="mx-auto flex max-w-4xl items-center gap-3">
        <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-cyan-300/15 bg-cyan-300/[0.06] text-cyan-200 sm:flex">
          {showIosInstall ? (
            <Share2 className="h-3.5 w-3.5" />
          ) : installPrompt && !standalone ? (
            <Download className="h-3.5 w-3.5" />
          ) : (
            <BellRing className="h-3.5 w-3.5" />
          )}
        </span>
        <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-zinc-400 sm:text-xs">
          {showIosInstall
            ? "On iPhone and iPad, notifications only work in the Home Screen app—not in a browser tab. In Safari, tap Share → Add to Home Screen, then open Groovy from its icon and enable notifications."
            : installPrompt && !standalone
              ? "Install Groovy for an app-like window, badge counts, and faster return to conversations."
              : `Never miss ${
                  room.kind === "dm" ? "a direct message" : `an @mention in #${room.name}`
                }—connect notifications on this device.`}
        </p>
        {installPrompt && !standalone && !showIosInstall ? (
          <button
            type="button"
            onClick={() => {
              void installPrompt.prompt().then(async () => {
                const choice = await installPrompt.userChoice;
                if (choice.outcome === "accepted") setStandalone(true);
                setInstallPrompt(null);
              });
            }}
            className="shrink-0 rounded-lg bg-cyan-300 px-2.5 py-1.5 text-[11px] font-semibold text-[#071014]"
          >
            Install
          </button>
        ) : canConnect && !showIosInstall ? (
          <button
            type="button"
            disabled={notifications.busy}
            onClick={() =>
              void notifications
                .setRoomMode(
                  room.id,
                  room.kind,
                  room.kind === "dm" ? "all" : "mentions",
                )
                .then((saved) => {
                  if (saved) dismiss();
                })
            }
            className="shrink-0 rounded-lg bg-cyan-300 px-2.5 py-1.5 text-[11px] font-semibold text-[#071014] disabled:opacity-50"
          >
            Turn on
          </button>
        ) : null}
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-full p-1.5 text-zinc-600 hover:bg-white/[0.05] hover:text-white"
          aria-label="Dismiss notification tip"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
