"use client";

import { useEffect, useRef, useState } from "react";
import {
  AtSign,
  Bell,
  BellOff,
  BellRing,
  Check,
  Loader2,
  Smartphone,
} from "lucide-react";
import { useWebPushNotifications } from "@/hooks/useWebPushNotifications";
import type { ChatNotificationMode } from "@/lib/notifications/push";

type Room = {
  id: string;
  kind: "channel" | "dm";
  name: string;
};

const modeCopy: Record<
  ChatNotificationMode,
  { channel: string; dm: string }
> = {
  off: { channel: "Muted", dm: "Muted" },
  mentions: { channel: "Mentions only", dm: "Mentions only" },
  all: { channel: "All new messages", dm: "New messages" },
};

function ModeIcon({
  mode,
  className = "h-4 w-4",
}: {
  mode: ChatNotificationMode;
  className?: string;
}) {
  if (mode === "off") return <BellOff className={className} />;
  if (mode === "mentions") return <AtSign className={className} />;
  return <BellRing className={className} />;
}

function roomModes(kind: Room["kind"]): ChatNotificationMode[] {
  return kind === "dm" ? ["all", "off"] : ["all", "mentions", "off"];
}

export function RoomNotificationMenu({ room }: { room: Room }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const notifications = useWebPushNotifications();
  const mode = notifications.preferenceMap.get(room.id) || "off";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const active =
    mode !== "off" &&
    notifications.deviceSubscribed &&
    notifications.permission === "granted";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          notifications.setError(null);
          setOpen((current) => !current);
        }}
        className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition ${
          active
            ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
            : "border-[var(--glass-border)] text-[var(--text-secondary)] hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
        }`}
        aria-label={`Notifications for ${room.name}: ${modeCopy[mode][room.kind]}`}
        aria-expanded={open}
        title={`Notifications: ${modeCopy[mode][room.kind]}`}
      >
        {notifications.loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ModeIcon mode={mode} />
        )}
        {active ? (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-cyan-300 ring-2 ring-[#0d0f13]" />
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-11 z-50 w-[min(21rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-white/10 bg-[#111319] shadow-2xl shadow-black/60">
          <div className="border-b border-white/[0.07] px-4 py-3.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Bell className="h-4 w-4 text-cyan-300" />
              Notifications
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              Choose what reaches this device from{" "}
              {room.kind === "channel" ? `#${room.name}` : room.name}.
            </p>
          </div>

          <div className="space-y-1 p-2">
            {roomModes(room.kind).map((option) => {
              const selected = mode === option;
              return (
                <button
                  key={option}
                  type="button"
                  disabled={
                    notifications.busy ||
                    notifications.loading ||
                    (option !== "off" &&
                      (notifications.support !== "supported" ||
                        !notifications.configured ||
                        notifications.migrationPending))
                  }
                  onClick={() => {
                    void notifications
                      .setRoomMode(room.id, room.kind, option)
                      .then((saved) => {
                        if (saved) setOpen(false);
                      });
                  }}
                  className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${
                    selected
                      ? "border-cyan-400/25 bg-cyan-400/[0.07]"
                      : "border-transparent hover:border-white/[0.07] hover:bg-white/[0.025]"
                  } disabled:cursor-not-allowed disabled:opacity-45`}
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      selected
                        ? "bg-cyan-300/10 text-cyan-200"
                        : "bg-white/[0.04] text-zinc-500"
                    }`}
                  >
                    <ModeIcon mode={option} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-zinc-200">
                      {modeCopy[option][room.kind]}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-zinc-600">
                      {option === "all"
                        ? room.kind === "dm"
                          ? "Notify for messages in this conversation."
                          : "Notify for every new message in this channel."
                        : option === "mentions"
                          ? "Notify only when someone @mentions you."
                          : "Nothing from this room will notify you."}
                    </span>
                  </span>
                  {selected ? (
                    <Check className="h-4 w-4 shrink-0 text-cyan-300" />
                  ) : null}
                </button>
              );
            })}
          </div>

          {notifications.error ? (
            <div
              role="alert"
              className="mx-3 mb-3 rounded-xl border border-red-400/20 bg-red-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-red-200"
            >
              {notifications.error}
            </div>
          ) : notifications.support !== "supported" ? (
            <div className="mx-3 mb-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-100">
              {notifications.transport === "desktop-native"
                ? "Update Groovy Desktop to enable native notifications."
                : "On iPhone or iPad, add Groovy to your Home Screen and open it there to enable background notifications."}
            </div>
          ) : notifications.migrationPending ? (
            <div className="mx-3 mb-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-100">
              Notification storage is still being activated.
            </div>
          ) : !notifications.configured ? (
            <div className="mx-3 mb-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-100">
              {notifications.transport === "desktop-native"
                ? "Update Groovy Desktop to enable native notifications."
                : "This deployment still needs its Web Push keys."}
            </div>
          ) : null}

          <div className="flex items-center gap-2 border-t border-white/[0.07] px-4 py-3 text-[10px] text-zinc-600">
            <Smartphone className="h-3.5 w-3.5" />
            {notifications.deviceSubscribed
              ? notifications.transport === "desktop-native"
                ? "Groovy Desktop native alerts"
                : "This device is connected"
              : "Permission is requested only when you opt in"}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function RoomNotificationPanel({ room }: { room: Room }) {
  const notifications = useWebPushNotifications();
  const mode = notifications.preferenceMap.get(room.id) || "off";

  return (
    <div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold">Notifications</h3>
        <p className="mt-1 text-sm leading-relaxed text-zinc-500">
          Personal alerts for this channel. Your choice does not affect anyone
          else in the workspace.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {roomModes(room.kind).map((option) => {
          const selected = mode === option;
          return (
            <button
              key={option}
              type="button"
              disabled={
                notifications.busy ||
                notifications.loading ||
                (option !== "off" &&
                  (notifications.support !== "supported" ||
                    !notifications.configured ||
                    notifications.migrationPending))
              }
              onClick={() =>
                void notifications.setRoomMode(room.id, room.kind, option)
              }
              className={`rounded-xl border p-3 text-left transition ${
                selected
                  ? "border-cyan-400/35 bg-cyan-400/[0.07]"
                  : "border-white/10 bg-black/15 hover:border-white/20"
              } disabled:cursor-not-allowed disabled:opacity-45`}
            >
              <div className="flex items-center justify-between gap-2">
                <ModeIcon
                  mode={option}
                  className={
                    selected
                      ? "h-4 w-4 text-cyan-300"
                      : "h-4 w-4 text-zinc-500"
                  }
                />
                {selected ? (
                  <Check className="h-4 w-4 text-cyan-300" />
                ) : null}
              </div>
              <span className="mt-3 block text-sm text-zinc-200">
                {modeCopy[option][room.kind]}
              </span>
              <span className="mt-1 block text-[10px] leading-relaxed text-zinc-500">
                {option === "all"
                  ? "Every new message."
                  : option === "mentions"
                    ? "Only direct @mentions."
                    : "No alerts from this channel."}
              </span>
            </button>
          );
        })}
      </div>

      {notifications.error ? (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-red-400/20 bg-red-400/[0.06] px-3 py-2.5 text-xs leading-relaxed text-red-200"
        >
          {notifications.error}
        </div>
      ) : null}
      <div className="mt-4 flex gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3">
        <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
        <p className="text-[11px] leading-relaxed text-zinc-500">
          {notifications.transport === "desktop-native"
            ? notifications.deviceSubscribed
              ? "Groovy Desktop can deliver native alerts while the window is hidden and reconcile missed messages after your Mac wakes."
              : "Update Groovy Desktop to enable native alerts on this Mac."
            : notifications.deviceSubscribed
              ? "This device can receive alerts. Preferences sync across your devices; each browser or Home Screen app must be connected once."
              : "Choose an alert option to connect this browser or Home Screen app. The permission prompt appears only after your choice."}
        </p>
      </div>
    </div>
  );
}
