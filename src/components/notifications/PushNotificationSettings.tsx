"use client";

import { useMemo, useState } from "react";
import {
  Bell,
  BellOff,
  BellRing,
  Hash,
  Lock,
  MessageCircle,
  Search,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useWebPushNotifications } from "@/hooks/useWebPushNotifications";
import type { ChatNotificationMode } from "@/lib/notifications/push";

export type NotificationRoom = {
  id: string;
  kind: "channel" | "dm";
  name: string;
  topic: string | null;
  visibility: "workspace" | "private";
};

function modeOptions(kind: NotificationRoom["kind"]) {
  const shared = [
    {
      value: "all",
      label: kind === "dm" ? "New messages" : "All new messages",
      description:
        kind === "dm"
          ? "Alert for messages in this conversation."
          : "Alert for every message in this channel.",
    },
  ];
  if (kind === "channel") {
    shared.push({
      value: "mentions",
      label: "Mentions only",
      description: "Alert only when someone @mentions you.",
    });
  }
  shared.push({
    value: "off",
    label: "Muted",
    description: "Do not alert for this room.",
  });
  return shared;
}

function DeviceState({
  subscribed,
  permission,
}: {
  subscribed: boolean;
  permission: NotificationPermission | "unsupported";
}) {
  if (subscribed && permission === "granted") {
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
        Connected
      </span>
    );
  }
  if (permission === "denied") {
    return (
      <span className="inline-flex items-center gap-1.5 text-red-300">
        <span className="h-1.5 w-1.5 rounded-full bg-red-300" />
        Blocked by device
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-zinc-500">
      <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
      Not connected
    </span>
  );
}

export function PushNotificationSettings({
  rooms,
}: {
  rooms: NotificationRoom[];
}) {
  const notifications = useWebPushNotifications();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredRooms = useMemo(
    () =>
      rooms.filter((room) =>
        [room.name, room.topic]
          .filter(Boolean)
          .some((value) =>
            String(value).toLowerCase().includes(normalizedQuery),
          ),
      ),
    [normalizedQuery, rooms],
  );
  const channelRooms = filteredRooms.filter((room) => room.kind === "channel");
  const dmRooms = filteredRooms.filter((room) => room.kind === "dm");
  const enabledRoomCount = rooms.filter(
    (room) => (notifications.preferenceMap.get(room.id) || "off") !== "off",
  ).length;
  const canEnable =
    notifications.support === "supported" &&
    notifications.configured &&
    !notifications.migrationPending;
  const desktopNative = notifications.transport === "desktop-native";

  return (
    <main className="mx-auto max-w-6xl px-4 py-7 sm:px-6 sm:py-9">
      <div className="max-w-2xl">
        <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-cyan-300/70">
          Personal notifications
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">
          Stay reachable without the noise
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          {desktopNative
            ? "Choose exactly which channels and direct messages may send native Groovy Desktop alerts."
            : "Connect each browser or Home Screen app once, then choose exactly which channels and direct messages are allowed to alert you."}
        </p>
      </div>

      <section className="mt-7 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
        <div className="grid gap-5 p-5 sm:grid-cols-[auto_1fr_auto] sm:items-center sm:p-6">
          <span
            className={`flex h-12 w-12 items-center justify-center rounded-2xl border ${
              notifications.deviceSubscribed
                ? "border-cyan-400/25 bg-cyan-400/[0.08] text-cyan-200"
                : "border-white/10 bg-black/20 text-zinc-500"
            }`}
          >
            {notifications.deviceSubscribed ? (
              <BellRing className="h-5 w-5" />
            ) : (
              <Smartphone className="h-5 w-5" />
            )}
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="text-sm font-medium">This device</h3>
              <span className="text-[10px]">
                <DeviceState
                  subscribed={notifications.deviceSubscribed}
                  permission={notifications.permission}
                />
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              {notifications.deviceSubscribed
                ? `${enabledRoomCount} ${
                    enabledRoomCount === 1 ? "room is" : "rooms are"
                  } allowed to notify you.`
                : desktopNative
                  ? "Update Groovy Desktop or allow it in macOS notification settings."
                  : "Select an alert option below to request permission and connect this device."}
              {!desktopNative && notifications.subscriptionCount > 1
                ? ` ${notifications.subscriptionCount} devices are connected to your account.`
                : ""}
            </p>
          </div>
          {notifications.deviceSubscribed && notifications.canDisableDevice ? (
            <button
              type="button"
              disabled={notifications.busy}
              onClick={() => void notifications.disableThisDevice()}
              className="w-fit rounded-xl border border-white/10 px-3.5 py-2.5 text-xs text-zinc-400 transition hover:border-red-400/25 hover:bg-red-400/[0.05] hover:text-red-200 disabled:opacity-50"
            >
              Turn off this device
            </button>
          ) : notifications.deviceSubscribed ? (
            <span className="flex w-fit items-center gap-1.5 rounded-full border border-cyan-400/15 bg-cyan-400/[0.04] px-2.5 py-1.5 text-[10px] text-cyan-200/80">
              <ShieldCheck className="h-3.5 w-3.5" />
              Native desktop
            </span>
          ) : (
            <span className="flex w-fit items-center gap-1.5 rounded-full border border-white/[0.08] px-2.5 py-1.5 text-[10px] text-zinc-500">
              <ShieldCheck className="h-3.5 w-3.5" />
              Opt-in only
            </span>
          )}
        </div>

        {notifications.error ? (
          <div
            role="alert"
            className="border-t border-red-400/15 bg-red-400/[0.05] px-5 py-3 text-xs leading-relaxed text-red-200 sm:px-6"
          >
            {notifications.error}
          </div>
        ) : notifications.support !== "checking" &&
          notifications.support !== "supported" ? (
          <div className="border-t border-amber-400/15 bg-amber-400/[0.05] px-5 py-3 text-xs leading-relaxed text-amber-100 sm:px-6">
            {desktopNative
              ? "This version of Groovy Desktop does not support native notifications yet. Update the app and try again."
              : "This browser cannot receive background notifications. On iPhone or iPad, add Groovy to your Home Screen and open it there first."}
          </div>
        ) : notifications.permission === "denied" ? (
          <div className="border-t border-amber-400/15 bg-amber-400/[0.05] px-5 py-3 text-xs leading-relaxed text-amber-100 sm:px-6">
            {desktopNative
              ? "Groovy is blocked in macOS System Settings. Open Notifications, allow Groovy, then return here."
              : "Groovy is blocked in your browser or device notification settings. Allow notifications there, then reload this page."}
          </div>
        ) : notifications.migrationPending ? (
          <div className="border-t border-amber-400/15 bg-amber-400/[0.05] px-5 py-3 text-xs leading-relaxed text-amber-100 sm:px-6">
            Notification storage is still being activated. Existing Chat
            behavior is unaffected.
          </div>
        ) : !notifications.configured && !notifications.loading ? (
          <div className="border-t border-amber-400/15 bg-amber-400/[0.05] px-5 py-3 text-xs leading-relaxed text-amber-100 sm:px-6">
            {desktopNative
              ? "Update Groovy Desktop to connect native notifications."
              : "This deployment needs its Web Push keys before a device can connect."}
          </div>
        ) : null}
      </section>

      <div className="relative mt-7 max-w-md">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search channels and direct messages"
          className="w-full rounded-xl border border-white/10 bg-black/20 py-3 pl-10 pr-4 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-cyan-400/35 focus:ring-2 focus:ring-cyan-400/10"
        />
      </div>

      {[
        {
          key: "channels",
          title: "Channels",
          description: "All messages, mentions only, or muted.",
          rooms: channelRooms,
        },
        {
          key: "direct",
          title: "Direct messages",
          description: "Choose which conversations may alert you.",
          rooms: dmRooms,
        },
      ].map((group) =>
        group.rooms.length > 0 ? (
          <section key={group.key} className="mt-8">
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <h3 className="text-sm font-medium">{group.title}</h3>
                <p className="mt-1 text-[11px] text-zinc-600">
                  {group.description}
                </p>
              </div>
              <span className="text-[10px] tabular-nums text-zinc-600">
                {group.rooms.length}
              </span>
            </div>
            <div className="space-y-2">
              {group.rooms.map((room) => {
                const mode =
                  notifications.preferenceMap.get(room.id) || "off";
                const Icon =
                  room.kind === "dm"
                    ? MessageCircle
                    : room.visibility === "private"
                      ? Lock
                      : Hash;
                return (
                  <div
                    key={room.id}
                    className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:flex-row sm:items-center"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-black/15 text-zinc-500">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="truncate text-sm text-zinc-200">
                          {room.name}
                        </h4>
                        {mode !== "off" ? (
                          <Bell className="h-3.5 w-3.5 shrink-0 text-cyan-300/80" />
                        ) : (
                          <BellOff className="h-3.5 w-3.5 shrink-0 text-zinc-700" />
                        )}
                      </div>
                      <p className="mt-1 truncate text-[10px] text-zinc-600">
                        {room.topic ||
                          (room.kind === "dm"
                            ? "Private conversation"
                            : room.visibility === "private"
                              ? "Private channel"
                              : "Workspace channel")}
                      </p>
                    </div>
                    <div className="w-full sm:w-64">
                      <CustomSelect
                        value={mode}
                        onChange={(value) =>
                          void notifications.setRoomMode(
                            room.id,
                            room.kind,
                            value as ChatNotificationMode,
                          )
                        }
                        options={modeOptions(room.kind)}
                        disabled={
                          notifications.busy ||
                          notifications.loading ||
                          (!canEnable && mode === "off")
                        }
                        size="sm"
                        ariaLabel={`Notifications for ${room.name}`}
                        triggerClassName="bg-black/20"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null,
      )}

      {filteredRooms.length === 0 ? (
        <div className="mt-8 flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.015] px-6 text-center">
          <BellOff className="h-5 w-5 text-zinc-600" />
          <h3 className="mt-3 text-sm font-medium">
            {rooms.length === 0 ? "No conversations yet" : "No matching rooms"}
          </h3>
          <p className="mt-1 text-xs text-zinc-600">
            {rooms.length === 0
              ? "Create a channel or start a direct message in Chat."
              : "Try another channel or person name."}
          </p>
        </div>
      ) : null}
    </main>
  );
}
