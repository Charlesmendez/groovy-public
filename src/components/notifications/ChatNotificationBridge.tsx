"use client";

import { useEffect } from "react";
import {
  advanceDesktopNotificationCursor,
  desktopNotificationForMessage,
  isRoomActivelyVisible,
  type DesktopNotificationCursor,
  type DesktopNotificationChannel,
  type DesktopNotificationMessage,
} from "@/lib/notifications/desktop";
import {
  getDesktopApi,
  desktopShellVersion,
  isDesktopShell,
} from "@/lib/desktop/shell";
import { desktopUsesUnifiedNotificationTone } from "@/lib/notifications/tone";
import {
  isMessageUnreadAtCursor,
  type ChatNotificationMode,
} from "@/lib/notifications/push";
import {
  normalizeNotificationBadgeCount,
  notificationBadgeLabel,
  titleWithNotificationBadge,
  totalNotificationBadgeCount,
} from "@/lib/notifications/badge";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  CHAT_MESSAGE_RECEIVED_EVENT,
  NOTIFICATION_AUDIO_UNLOCK_EVENT,
  NOTIFICATION_TONE_REQUEST_EVENT,
} from "@/lib/chat/events";
import { publishAppAreaAttention } from "@/lib/navigation/appAttention";

const CONFIG_REFRESH_MS = 30_000;
const CHANNEL_BATCH_SIZE = 100;
const PAGE_SIZE = 250;
const MAX_RECONCILED_MESSAGES_PER_BATCH = 2_000;
const MAX_RECENT_IDS = 500;
const PREFERENCE_CHANGED_EVENT = "groovy:notification-preferences-changed";
const CHANNEL_READ_EVENT = "groovy:channel-read";
const CHANNEL_UNREAD_STATE_EVENT = "groovy:channel-unread-state";
const BADGED_FAVICON_ATTRIBUTE = "data-groovy-unread-badge";

type RuntimeConfig = {
  currentUserId: string;
  currentUserEmail: string | null;
  channels: Map<string, DesktopNotificationChannel>;
  preferences: Map<string, ChatNotificationMode>;
  unreadCounts: Map<string, number>;
  agentNames: Map<string, string>;
  profileNames: Map<string, string>;
  memberEmails: Map<string, string>;
  nativeNotificationsSupported: boolean;
  webPushSubscribed: boolean;
};

type BadgeNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function activeChatChannelId(): string | null {
  const match = window.location.pathname.match(
    /^\/chat\/([0-9a-f]{8}-[0-9a-f-]{27,})$/i,
  );
  return match?.[1] || null;
}

function notificationAudioContext(): AudioContext | null {
  try {
    return new AudioContext();
  } catch {
    return null;
  }
}

function playNotificationTone(context: AudioContext): void {
  if (context.state !== "running") return;
  const now = context.currentTime;
  const gain = context.createGain();
  const oscillators: OscillatorNode[] = [];
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
  gain.connect(context.destination);

  for (const [frequency, offset, duration] of [
    [740, 0, 0.16],
    [988, 0.13, 0.19],
  ] as const) {
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, now + offset);
    oscillator.connect(gain);
    oscillator.start(now + offset);
    oscillator.stop(now + offset + duration);
    oscillators.push(oscillator);
  }
  oscillators.at(-1)?.addEventListener(
    "ended",
    () => {
      for (const oscillator of oscillators) oscillator.disconnect();
      gain.disconnect();
    },
    { once: true },
  );
}

async function faviconWithBadge(args: {
  iconUrl: string;
  unreadCount: number;
}): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return args.iconUrl;

  context.clearRect(0, 0, 64, 64);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = args.iconUrl;
    await image.decode();
    context.drawImage(image, 2, 6, 54, 54);
  } catch {
    context.fillStyle = "#09090b";
    context.fillRect(4, 4, 52, 52);
    context.fillStyle = "#22d3ee";
    context.font = "600 30px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("G", 30, 31);
  }

  context.fillStyle = "#ef4444";
  context.beginPath();
  context.arc(48, 16, 16, 0, Math.PI * 2);
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#09090b";
  context.stroke();
  context.fillStyle = "#fff";
  context.font =
    args.unreadCount > 99 ? "700 11px sans-serif" : "700 16px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(notificationBadgeLabel(args.unreadCount), 48, 16.5);
  return canvas.toDataURL("image/png");
}

function storageKey(config: RuntimeConfig): string {
  return `groovy:desktop-notifications:${config.currentUserId}`;
}

function loadCursor(config: RuntimeConfig): DesktopNotificationCursor {
  const fallback = { createdAt: new Date().toISOString(), recentIds: [] };
  try {
    const raw = window.localStorage.getItem(storageKey(config));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DesktopNotificationCursor>;
    if (
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt))
    ) {
      return fallback;
    }
    return {
      createdAt: parsed.createdAt,
      recentIds: Array.isArray(parsed.recentIds)
        ? parsed.recentIds
            .filter((id): id is string => typeof id === "string")
            .slice(-MAX_RECENT_IDS)
        : [],
    };
  } catch {
    return fallback;
  }
}

function saveCursor(
  config: RuntimeConfig,
  state: DesktopNotificationCursor,
): void {
  try {
    window.localStorage.setItem(storageKey(config), JSON.stringify(state));
  } catch {
    // Notification delivery still works if storage is temporarily unavailable.
  }
}

function stringMap(
  values: unknown,
  idKey: string,
  labelKey: string,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(values)) return result;
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const id = typeof record[idKey] === "string" ? record[idKey] : "";
    const label =
      typeof record[labelKey] === "string" ? record[labelKey].trim() : "";
    if (id && label) result.set(id, label);
  }
  return result;
}

export function ChatNotificationBridge() {
  useEffect(() => {
    const desktopShell = isDesktopShell();
    const unifiedDesktopTone =
      desktopShell &&
      desktopUsesUnifiedNotificationTone(desktopShellVersion());
    const desktop = getDesktopApi();
    const supabase = getSupabaseBrowserClient();
    let disposed = false;
    let config: RuntimeConfig | null = null;
    let cursor: DesktopNotificationCursor | null = null;
    let reconcileInFlight: Promise<void> | null = null;
    // Browsers create this suspended before a gesture. Keeping the same
    // context ready lets the very first notification opt-in click unlock it.
    let audioContext: AudioContext | null = notificationAudioContext();
    let faviconRender = 0;
    let refreshGeneration = 0;
    let deliveredNotificationReconcileGeneration = 0;
    let signedOut = false;
    const sourceFavicon =
      document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href ||
      "/Sloth_no_bg2.png";
    const badgedFavicon = document.createElement("link");
    badgedFavicon.rel = "icon";
    badgedFavicon.setAttribute(BADGED_FAVICON_ATTRIBUTE, "true");

    if (!desktopShell && "serviceWorker" in navigator) {
      void navigator.serviceWorker
        .getRegistration("/")
        .then((registration) => registration?.update())
        .catch(() => undefined);
    }

    const unlockAudio = () => {
      audioContext ||= notificationAudioContext();
      if (audioContext?.state === "suspended") {
        void audioContext.resume().catch(() => undefined);
      }
    };

    const playTone = async () => {
      audioContext ||= notificationAudioContext();
      if (audioContext?.state === "suspended") {
        await audioContext.resume().catch(() => undefined);
      }
      if (audioContext) playNotificationTone(audioContext);
    };

    const syncBadgeCount = (countValue: unknown) => {
      const count = normalizeNotificationBadgeCount(countValue);
      document.title = titleWithNotificationBadge(document.title, count);
      const currentRender = ++faviconRender;
      if (count > 0) {
        if (!badgedFavicon.isConnected) document.head.appendChild(badgedFavicon);
        void faviconWithBadge({
          iconUrl: sourceFavicon,
          unreadCount: count,
        })
          .then((href) => {
            if (!disposed && currentRender === faviconRender) {
              badgedFavicon.href = href;
            }
          })
          .catch(() => {
            if (!disposed && currentRender === faviconRender) {
              badgedFavicon.href = sourceFavicon;
            }
          });
      } else {
        badgedFavicon.remove();
      }

      const badgeNavigator = navigator as BadgeNavigator;
      if (count > 0 && badgeNavigator.setAppBadge) {
        void badgeNavigator.setAppBadge(count).catch(() => undefined);
      } else if (count === 0 && badgeNavigator.clearAppBadge) {
        void badgeNavigator.clearAppBadge().catch(() => undefined);
      }
      if (desktopShell) {
        void desktop.setChatBadgeCount(count).catch(() => undefined);
      }
    };

    const reconcileDeliveredNotifications = (
      runtime: RuntimeConfig,
    ): void => {
      if (desktopShell || !("serviceWorker" in navigator)) return;
      const generation = ++deliveredNotificationReconcileGeneration;
      const unreadChannels = new Set(
        Array.from(runtime.unreadCounts.entries())
          .filter(
            ([channelId, count]) =>
              normalizeNotificationBadgeCount(count) > 0 &&
              (runtime.preferences.get(channelId) || "off") !== "off",
          )
          .map(([channelId]) => channelId),
      );
      void navigator.serviceWorker
        .getRegistration("/")
        .then(async (registration) => {
          if (
            !registration ||
            disposed ||
            generation !== deliveredNotificationReconcileGeneration
          ) {
            return;
          }
          const notifications = await registration.getNotifications();
          if (
            disposed ||
            generation !== deliveredNotificationReconcileGeneration
          ) {
            return;
          }
          for (const notification of notifications) {
            const channelId = notification.data?.channelId;
            if (
              typeof channelId === "string" &&
              !unreadChannels.has(channelId)
            ) {
              notification.close();
            }
          }
          const worker =
            navigator.serviceWorker.controller || registration.active;
          worker?.postMessage({
            type: "groovy-reconcile-notifications",
          });
        })
        .catch(() => undefined);
    };

    const clearBrowserNotificationState = (): void => {
      if (desktopShell || !("serviceWorker" in navigator)) return;
      deliveredNotificationReconcileGeneration += 1;
      void navigator.serviceWorker
        .getRegistration("/")
        .then(async (registration) => {
          const notifications = await registration?.getNotifications();
          for (const notification of notifications || []) {
            notification.close();
          }
          const subscription = registration
            ? await registration.pushManager.getSubscription()
            : null;
          await subscription?.unsubscribe();
        })
        .catch(() => undefined);
    };

    const publishUnreadState = (
      unreadCounts: ReadonlyMap<string, number>,
    ) => {
      window.dispatchEvent(
        new CustomEvent(CHANNEL_UNREAD_STATE_EVENT, {
          detail: {
            unreadCounts: Array.from(unreadCounts.entries()),
          },
        }),
      );
      publishAppAreaAttention(
        "chat",
        totalNotificationBadgeCount(unreadCounts.values()),
      );
    };

    const clearRuntimeBadges = () => {
      publishUnreadState(new Map());
      syncBadgeCount(0);
    };

    const syncRuntimeBadges = (runtime: RuntimeConfig) => {
      publishUnreadState(runtime.unreadCounts);
      syncBadgeCount(
        totalNotificationBadgeCount(
          Array.from(runtime.unreadCounts.entries())
            .filter(
              ([channelId]) =>
                (runtime.preferences.get(channelId) || "off") !== "off",
            )
            .map(([, count]) => count),
        ),
      );
      reconcileDeliveredNotifications(runtime);
    };

    const refreshConfig = async (): Promise<RuntimeConfig | null> => {
      if (signedOut) return null;
      const generation = ++refreshGeneration;
      const [
        channelsResponse,
        preferencesResponse,
        nativeStatus,
        webPushSubscription,
      ] =
        await Promise.all([
          fetch("/api/chat/channels", { cache: "no-store" }),
          fetch("/api/notifications/push", { cache: "no-store" }),
          desktopShell
            ? desktop.getNativeNotificationStatus().catch(() => null)
            : Promise.resolve({
                supported: false,
                permission: "unsupported" as const,
              }),
          !desktopShell &&
          "serviceWorker" in navigator &&
          "PushManager" in window
            ? navigator.serviceWorker
                .getRegistration("/")
                .then((registration) =>
                  registration?.pushManager.getSubscription(),
                )
                .catch(() => null)
            : Promise.resolve(null),
        ]);
      if (disposed || generation !== refreshGeneration) return config;
      if (!channelsResponse.ok) {
        const unauthorized = channelsResponse.status === 401;
        if (!unauthorized) return config;
        signedOut = true;
        config = null;
        cursor = null;
        clearRuntimeBadges();
        clearBrowserNotificationState();
        return null;
      }
      const channelsPayload =
        (await channelsResponse.json()) as Record<string, unknown>;
      const preferencesPayload = preferencesResponse.ok
        ? ((await preferencesResponse.json()) as Record<string, unknown>)
        : {};
      if (!preferencesResponse.ok && !config) return null;
      const workspace =
        channelsPayload.workspace &&
        typeof channelsPayload.workspace === "object"
          ? (channelsPayload.workspace as Record<string, unknown>)
          : null;
      const currentUserId =
        typeof workspace?.currentUserId === "string"
          ? workspace.currentUserId
          : "";
      if (!currentUserId) {
        config = null;
        cursor = null;
        clearRuntimeBadges();
        clearBrowserNotificationState();
        return null;
      }

      const activeWorkspaceChannels =
        Array.isArray(channelsPayload.channels)
          ? channelsPayload.channels
          : [];
      const channels = new Map<string, DesktopNotificationChannel>();
      const unreadCounts = new Map<string, number>();
      if (activeWorkspaceChannels.length > 0) {
        for (const value of activeWorkspaceChannels) {
          if (!value || typeof value !== "object") continue;
          const channel = value as Record<string, unknown>;
          if (
            typeof channel.id !== "string" ||
            typeof channel.name !== "string" ||
            (channel.kind !== "channel" && channel.kind !== "dm")
          ) {
            continue;
          }
          channels.set(channel.id, {
            id: channel.id,
            name:
              typeof channel.display_name === "string" &&
              channel.display_name.trim()
                ? channel.display_name
                : channel.name,
            kind: channel.kind,
            profile_id:
              typeof channel.profile_id === "string"
                ? channel.profile_id
                : null,
          });
          unreadCounts.set(
            channel.id,
            normalizeNotificationBadgeCount(channel.unread_count),
          );
        }
      }
      const preferences = preferencesResponse.ok
        ? new Map<string, ChatNotificationMode>()
        : new Map(config?.preferences || []);
      if (Array.isArray(preferencesPayload.preferences)) {
        for (const value of preferencesPayload.preferences) {
          if (!value || typeof value !== "object") continue;
          const preference = value as Record<string, unknown>;
          if (
            typeof preference.channel_id === "string" &&
            (preference.mode === "off" ||
              preference.mode === "mentions" ||
              preference.mode === "all")
          ) {
            preferences.set(preference.channel_id, preference.mode);
          }
        }
      }
      // The current-workspace endpoint supplies rich labels. A direct RLS
      // query adds rooms from every other workspace the user can access so the
      // browser tab and Desktop Dock badge represent the whole account.
      const { data: accessibleChannels, error: accessibleChannelsError } =
        await supabase
          .from("chat_channels")
          .select("id,kind,name,profile_id")
          .eq("is_archived", false);
      if (!accessibleChannelsError && !disposed) {
        for (const value of accessibleChannels || []) {
          if (
            typeof value.id !== "string" ||
            typeof value.name !== "string" ||
            (value.kind !== "channel" && value.kind !== "dm")
          ) {
            continue;
          }
          channels.set(value.id, {
            id: value.id,
            name: value.name,
            kind: value.kind,
            profile_id:
              typeof value.profile_id === "string" ? value.profile_id : null,
          });
          if (!unreadCounts.has(value.id)) unreadCounts.set(value.id, 0);
        }
      }
      const allChannelIds = Array.from(channels.keys());
      if (allChannelIds.length > 0) {
        const { data: allUnreadRows, error: allUnreadError } =
          await supabase.rpc("chat_channel_unread_counts", {
            p_channel_ids: allChannelIds,
          });
        if (!allUnreadError && !disposed) {
          for (const row of (allUnreadRows || []) as Array<{
            channel_id?: unknown;
            unread_count?: unknown;
          }>) {
            if (typeof row.channel_id !== "string") continue;
            unreadCounts.set(
              row.channel_id,
              normalizeNotificationBadgeCount(row.unread_count),
            );
          }
        }
      }
      const memberEmails = stringMap(workspace?.members, "user_id", "email");
      if (disposed || generation !== refreshGeneration) return config;
      const nextConfig: RuntimeConfig = {
        currentUserId,
        currentUserEmail: memberEmails.get(currentUserId) || null,
        channels,
        preferences,
        unreadCounts,
        agentNames: stringMap(channelsPayload.agents, "id", "name"),
        profileNames: stringMap(channelsPayload.profiles, "id", "name"),
        memberEmails,
        nativeNotificationsSupported:
          nativeStatus?.supported ??
          config?.nativeNotificationsSupported ??
          false,
        webPushSubscribed: Boolean(webPushSubscription),
      };
      if (!config || config.currentUserId !== currentUserId) {
        cursor = loadCursor(nextConfig);
      }
      config = nextConfig;
      syncRuntimeBadges(nextConfig);
      return nextConfig;
    };

    const notificationFor = (
      runtime: RuntimeConfig,
      message: DesktopNotificationMessage,
      messageAlreadyRead = false,
      activeRoomVisible = isRoomActivelyVisible(message.channel_id),
    ) => {
      const channel = runtime.channels.get(message.channel_id);
      if (!channel) return null;
      return desktopNotificationForMessage({
        message,
        channel,
        mode: runtime.preferences.get(channel.id) || "off",
        currentUserId: runtime.currentUserId,
        currentUserEmail: runtime.currentUserEmail,
        activeRoomVisible,
        messageAlreadyRead,
        agentNames: runtime.agentNames,
        profileNames: runtime.profileNames,
        memberEmails: runtime.memberEmails,
      });
    };

    const loadReadCursors = async (
      channelIds: string[],
    ): Promise<Map<string, string> | null> => {
      const result = new Map<string, string>();
      for (
        let offset = 0;
        offset < channelIds.length;
        offset += CHANNEL_BATCH_SIZE
      ) {
        const channelBatch = channelIds.slice(
          offset,
          offset + CHANNEL_BATCH_SIZE,
        );
        const { data, error } = await supabase
          .from("chat_channel_read_states")
          .select("channel_id,last_read_at")
          .in("channel_id", channelBatch);
        if (error || disposed) return null;
        for (const row of data || []) {
          if (
            typeof row.channel_id === "string" &&
            typeof row.last_read_at === "string"
          ) {
            result.set(row.channel_id, row.last_read_at);
          }
        }
      }
      return result;
    };

    const handleLiveMessage = async (message: DesktopNotificationMessage) => {
      window.dispatchEvent(
        new CustomEvent(CHAT_MESSAGE_RECEIVED_EVENT, {
          detail: { message },
        }),
      );
      let runtime = config || (await refreshConfig());
      if (!runtime || disposed) return;
      if (!runtime.channels.has(message.channel_id)) {
        // A membership or channel insert can commit immediately before its
        // first message. Refresh once so that first alert is not postponed
        // until the periodic reconciliation window.
        runtime = await refreshConfig();
        if (!runtime?.channels.has(message.channel_id) || disposed) return;
      }
      cursor ||= loadCursor(runtime);
      if (cursor.recentIds.includes(message.id)) return;

      const ownMessage =
        message.author_type === "user" &&
        message.author_user_id === runtime.currentUserId;
      const activeRoom = isRoomActivelyVisible(message.channel_id);
      if (!ownMessage) {
        runtime.unreadCounts.set(
          message.channel_id,
          activeRoom
            ? 0
            : (runtime.unreadCounts.get(message.channel_id) || 0) + 1,
        );
        syncRuntimeBadges(runtime);
      }
      const notification = notificationFor(runtime, message);
      const audibleInForeground = notificationFor(
        runtime,
        message,
        false,
        false,
      );
      cursor = advanceDesktopNotificationCursor(
        cursor,
        message,
        MAX_RECENT_IDS,
      );
      saveCursor(runtime, cursor);
      if (
        audibleInForeground &&
        (unifiedDesktopTone ||
          (document.visibilityState === "visible" &&
            document.hasFocus() &&
            (activeRoom ||
              (!runtime.webPushSubscribed &&
                !(desktopShell && runtime.nativeNotificationsSupported)))))
      ) {
        await playTone();
      }
      if (!notification) return;

      // A Realtime INSERT is already a fresh, committed event. Showing it must
      // not wait for a second read-cursor query; stale events are handled by
      // the reconnect reconciliation path below.
      if (desktopShell && runtime.nativeNotificationsSupported) {
        await desktop.showChatNotification({
          ...notification,
          silent: unifiedDesktopTone,
        });
        return;
      }
      // Background and subscribed-browser sound is owned by the system
      // notification to avoid playing two alerts for one message.
    };

    const reconcile = async () => {
      if (reconcileInFlight) return reconcileInFlight;
      reconcileInFlight = (async () => {
        const runtime = config || (await refreshConfig());
        if (!runtime || disposed || runtime.channels.size === 0) return;
        cursor ||= loadCursor(runtime);
        const initialCursor = cursor.createdAt;
        const channelIds = Array.from(runtime.channels.keys());
        const messages: DesktopNotificationMessage[] = [];
        for (
          let channelOffset = 0;
          channelOffset < channelIds.length;
          channelOffset += CHANNEL_BATCH_SIZE
        ) {
          const channelBatch = channelIds.slice(
            channelOffset,
            channelOffset + CHANNEL_BATCH_SIZE,
          );
          for (
            let messageOffset = 0;
            messageOffset < MAX_RECONCILED_MESSAGES_PER_BATCH;
            messageOffset += PAGE_SIZE
          ) {
            const { data, error } = await supabase
              .from("chat_messages")
              .select(
                "id,channel_id,author_type,author_user_id,author_agent_id,profile_id,content,metadata,thread_root_message_id,created_at",
              )
              .in("channel_id", channelBatch)
              .gte("created_at", initialCursor)
              .order("created_at", { ascending: true })
              .range(messageOffset, messageOffset + PAGE_SIZE - 1);
            if (error || disposed) return;
            const page = (data || []) as DesktopNotificationMessage[];
            messages.push(...page);
            if (page.length < PAGE_SIZE) break;
          }
        }
        messages.sort(
          (left, right) =>
            left.created_at.localeCompare(right.created_at) ||
            left.id.localeCompare(right.id),
        );
        const readCursors = await loadReadCursors(channelIds);
        if (disposed) return;
        const recentIds = new Set(cursor.recentIds);
        const latestByChannel = new Map<
          string,
          ReturnType<typeof notificationFor>
        >();
        for (const message of messages) {
          if (recentIds.has(message.id)) continue;
          // Reconciliation also repairs visible chat state after a suspended
          // or briefly disconnected Realtime stream. Thread replies need the
          // root id so an already-open thread can accept the recovered row.
          window.dispatchEvent(
            new CustomEvent(CHAT_MESSAGE_RECEIVED_EVENT, {
              detail: { message },
            }),
          );
          const notification = notificationFor(
            runtime,
            message,
            Boolean(
              readCursors &&
                !isMessageUnreadAtCursor({
                  messageCreatedAt: message.created_at,
                  lastReadAt: readCursors.get(message.channel_id),
                }),
            ),
          );
          cursor = advanceDesktopNotificationCursor(
            cursor,
            message,
            MAX_RECENT_IDS,
          );
          recentIds.add(message.id);
          if (notification) {
            latestByChannel.set(message.channel_id, notification);
          }
        }
        saveCursor(runtime, cursor);
        if (unifiedDesktopTone && latestByChannel.size > 0) {
          await playTone();
        }
        for (const notification of latestByChannel.values()) {
          if (notification) {
            await desktop.showChatNotification({
              ...notification,
              silent: unifiedDesktopTone,
            });
          }
        }
      })().finally(() => {
        reconcileInFlight = null;
      });
      return reconcileInFlight;
    };

    const refreshAndReconcile = () => {
      void refreshConfig().then(() => reconcile()).catch(() => undefined);
    };
    const onForeground = () => {
      if (document.visibilityState === "visible") refreshAndReconcile();
    };
    const unsubscribeResume = desktop.onSystemResume(refreshAndReconcile);
    const {
      data: { subscription: authSubscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      signedOut = !session?.user;
      if (signedOut) {
        refreshGeneration += 1;
        config = null;
        cursor = null;
        clearRuntimeBadges();
        clearBrowserNotificationState();
        return;
      }
      window.setTimeout(refreshAndReconcile, 0);
    });
    const onChannelRead = (event: Event) => {
      const channelId =
        event instanceof CustomEvent &&
        typeof event.detail?.channelId === "string"
          ? event.detail.channelId
          : activeChatChannelId();
      if (!channelId || !config) return;
      config.unreadCounts.set(channelId, 0);
      syncRuntimeBadges(config);
    };
    window.addEventListener("focus", refreshAndReconcile);
    window.addEventListener("online", refreshAndReconcile);
    window.addEventListener(PREFERENCE_CHANGED_EVENT, refreshAndReconcile);
    window.addEventListener(CHANNEL_READ_EVENT, onChannelRead);
    window.addEventListener("pointerdown", unlockAudio, {
      capture: true,
      passive: true,
    });
    window.addEventListener("keydown", unlockAudio, { capture: true });
    window.addEventListener(NOTIFICATION_AUDIO_UNLOCK_EVENT, unlockAudio);
    const onToneRequest = () => {
      if (unifiedDesktopTone) void playTone();
    };
    window.addEventListener(NOTIFICATION_TONE_REQUEST_EVENT, onToneRequest);
    document.addEventListener("visibilitychange", onForeground);
    const refreshTimer = window.setInterval(
      refreshAndReconcile,
      CONFIG_REFRESH_MS,
    );
    const realtime = supabase
      .channel("desktop-native-chat-notifications")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
        },
        (payload) => {
          void handleLiveMessage(
            payload.new as DesktopNotificationMessage,
          ).catch(() => undefined);
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") refreshAndReconcile();
      });
    refreshAndReconcile();

    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      unsubscribeResume();
      authSubscription.unsubscribe();
      window.removeEventListener("focus", refreshAndReconcile);
      window.removeEventListener("online", refreshAndReconcile);
      window.removeEventListener(PREFERENCE_CHANGED_EVENT, refreshAndReconcile);
      window.removeEventListener(CHANNEL_READ_EVENT, onChannelRead);
      window.removeEventListener("pointerdown", unlockAudio, {
        capture: true,
      });
      window.removeEventListener("keydown", unlockAudio, { capture: true });
      window.removeEventListener(NOTIFICATION_AUDIO_UNLOCK_EVENT, unlockAudio);
      window.removeEventListener(
        NOTIFICATION_TONE_REQUEST_EVENT,
        onToneRequest,
      );
      document.removeEventListener("visibilitychange", onForeground);
      void supabase.removeChannel(realtime);
      faviconRender += 1;
      badgedFavicon.remove();
      document.title = titleWithNotificationBadge(document.title, 0);
      if (desktopShell) {
        void desktop.setChatBadgeCount(0).catch(() => undefined);
      }
      if (audioContext) void audioContext.close().catch(() => undefined);
    };
  }, []);

  return null;
}
