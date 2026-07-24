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
  isDesktopShell,
} from "@/lib/desktop/shell";
import {
  isMessageUnreadAtCursor,
  type ChatNotificationMode,
} from "@/lib/notifications/push";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

const CONFIG_REFRESH_MS = 60_000;
const CHANNEL_BATCH_SIZE = 100;
const PAGE_SIZE = 250;
const MAX_RECONCILED_MESSAGES_PER_BATCH = 2_000;
const MAX_RECENT_IDS = 500;
const PREFERENCE_CHANGED_EVENT = "groovy:notification-preferences-changed";

type RuntimeConfig = {
  currentUserId: string;
  currentUserEmail: string | null;
  channels: Map<string, DesktopNotificationChannel>;
  preferences: Map<string, ChatNotificationMode>;
  agentNames: Map<string, string>;
  profileNames: Map<string, string>;
  memberEmails: Map<string, string>;
};

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

export function DesktopChatNotificationBridge() {
  useEffect(() => {
    if (!isDesktopShell()) return;

    const desktop = getDesktopApi();
    const supabase = getSupabaseBrowserClient();
    let disposed = false;
    let config: RuntimeConfig | null = null;
    let cursor: DesktopNotificationCursor | null = null;
    let reconcileInFlight: Promise<void> | null = null;

    const refreshConfig = async (): Promise<RuntimeConfig | null> => {
      const [channelsResponse, preferencesResponse, nativeStatus] =
        await Promise.all([
          fetch("/api/chat/channels", { cache: "no-store" }),
          fetch("/api/notifications/push", { cache: "no-store" }),
          desktop.getNativeNotificationStatus(),
        ]);
      if (
        disposed ||
        !channelsResponse.ok ||
        !preferencesResponse.ok ||
        !nativeStatus.supported
      ) {
        config = null;
        cursor = null;
        return null;
      }
      const [channelsPayload, preferencesPayload] = await Promise.all([
        channelsResponse.json() as Promise<Record<string, unknown>>,
        preferencesResponse.json() as Promise<Record<string, unknown>>,
      ]);
      const workspace =
        channelsPayload.workspace &&
        typeof channelsPayload.workspace === "object"
          ? (channelsPayload.workspace as Record<string, unknown>)
          : null;
      const currentUserId =
        typeof workspace?.currentUserId === "string"
          ? workspace.currentUserId
          : "";
      if (!currentUserId) return null;

      const activeWorkspaceChannels =
        Array.isArray(channelsPayload.channels)
          ? channelsPayload.channels
          : [];
      const channels = new Map<string, DesktopNotificationChannel>();
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
            name: channel.name,
            kind: channel.kind,
            profile_id:
              typeof channel.profile_id === "string"
                ? channel.profile_id
                : null,
          });
        }
      }
      const preferences = new Map<string, ChatNotificationMode>();
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
      const optedInChannelIds = Array.from(preferences.entries())
        .filter(([, mode]) => mode !== "off")
        .map(([channelId]) => channelId);
      for (
        let channelOffset = 0;
        channelOffset < optedInChannelIds.length;
        channelOffset += CHANNEL_BATCH_SIZE
      ) {
        const channelBatch = optedInChannelIds.slice(
          channelOffset,
          channelOffset + CHANNEL_BATCH_SIZE,
        );
        const { data: optedInChannels, error } = await supabase
          .from("chat_channels")
          .select("id,kind,name,profile_id")
          .in("id", channelBatch);
        if (error || disposed) return null;
        for (const value of optedInChannels || []) {
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
        }
      }
      const memberEmails = stringMap(workspace?.members, "user_id", "email");
      const nextConfig: RuntimeConfig = {
        currentUserId,
        currentUserEmail: memberEmails.get(currentUserId) || null,
        channels,
        preferences,
        agentNames: stringMap(channelsPayload.agents, "id", "name"),
        profileNames: stringMap(channelsPayload.profiles, "id", "name"),
        memberEmails,
      };
      if (!config || config.currentUserId !== currentUserId) {
        cursor = loadCursor(nextConfig);
      }
      config = nextConfig;
      return nextConfig;
    };

    const notificationFor = (
      runtime: RuntimeConfig,
      message: DesktopNotificationMessage,
      messageAlreadyRead = false,
    ) => {
      const channel = runtime.channels.get(message.channel_id);
      if (!channel) return null;
      return desktopNotificationForMessage({
        message,
        channel,
        mode: runtime.preferences.get(channel.id) || "off",
        currentUserId: runtime.currentUserId,
        currentUserEmail: runtime.currentUserEmail,
        activeRoomVisible: isRoomActivelyVisible(channel.id),
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
      const runtime = config || (await refreshConfig());
      if (!runtime || disposed) return;
      if (!runtime.channels.has(message.channel_id)) return;
      cursor ||= loadCursor(runtime);
      if (cursor.recentIds.includes(message.id)) return;
      let notification = notificationFor(runtime, message);
      if (notification) {
        const readCursors = await loadReadCursors([message.channel_id]);
        if (
          readCursors &&
          !isMessageUnreadAtCursor({
            messageCreatedAt: message.created_at,
            lastReadAt: readCursors.get(message.channel_id),
          })
        ) {
          notification = null;
        }
      }
      cursor = advanceDesktopNotificationCursor(
        cursor,
        message,
        MAX_RECENT_IDS,
      );
      saveCursor(runtime, cursor);
      if (notification) await desktop.showChatNotification(notification);
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
                "id,channel_id,author_type,author_user_id,author_agent_id,profile_id,content,metadata,created_at",
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
        for (const notification of latestByChannel.values()) {
          if (notification) {
            await desktop.showChatNotification(notification);
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
    window.addEventListener("focus", refreshAndReconcile);
    window.addEventListener("online", refreshAndReconcile);
    window.addEventListener(PREFERENCE_CHANGED_EVENT, refreshAndReconcile);
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
      window.removeEventListener("focus", refreshAndReconcile);
      window.removeEventListener("online", refreshAndReconcile);
      window.removeEventListener(PREFERENCE_CHANGED_EVENT, refreshAndReconcile);
      document.removeEventListener("visibilitychange", onForeground);
      void supabase.removeChannel(realtime);
    };
  }, []);

  return null;
}
