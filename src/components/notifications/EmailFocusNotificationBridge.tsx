"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import {
  emailFocusNotificationCopy,
  emailFocusNotificationUrl,
  focusArrivalFromAction,
  type EmailFocusArrival,
} from "@/lib/email/focusNotifications";
import {
  desktopShellVersion,
  getDesktopApi,
  isDesktopShell,
} from "@/lib/desktop/shell";
import { NOTIFICATION_TONE_REQUEST_EVENT } from "@/lib/chat/events";
import { desktopUsesUnifiedNotificationTone } from "@/lib/notifications/tone";
import { publishAppAreaAttention } from "@/lib/navigation/appAttention";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  emailWorkspaceCorrectionFromRow,
  emailWorkspacePlacementAppliesToThread,
  emailWorkspaceReadStateAppliesToThread,
  publishEmailWorkspaceCorrection,
} from "@/lib/email/workspaceSync";

const RECENT_LIMIT = 200;
const RECONCILE_LIMIT = 100;
const RESUME_RECONCILE_COOLDOWN_MS = 2_000;

type CursorState = {
  createdAt: string;
  recentIds: string[];
};

type ActionRow = {
  id: string;
  user_id: string;
  provider: string;
  sender_name: string | null;
  sender_email: string | null;
  subject: string | null;
  mailbox_label: string | null;
  connection_id: string | null;
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  recommended_action: string;
  status: string;
  confidence: number | null;
  metadata: Record<string, unknown> | null;
  received_at: string | null;
  created_at: string;
  updated_at: string;
};

function storageKey(userId: string): string {
  return `groovy:email-focus-notifications:${userId}`;
}

function attentionStorageKey(userId: string): string {
  return `groovy:email-area-attention:${userId}`;
}

function loadAttentionIds(userId: string): Set<string> {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(attentionStorageKey(userId)) || "[]",
    );
    return new Set(
      Array.isArray(value)
        ? value
            .filter((id): id is string => typeof id === "string")
            .slice(-RECENT_LIMIT)
        : [],
    );
  } catch {
    return new Set();
  }
}

function saveAttentionIds(userId: string, ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(
      attentionStorageKey(userId),
      JSON.stringify(Array.from(ids).slice(-RECENT_LIMIT)),
    );
  } catch {
    // The in-memory dot still works when local storage is unavailable.
  }
}

function emailAreaIsActive(): boolean {
  return (
    document.visibilityState === "visible" &&
    (window.location.pathname === "/email" ||
      window.location.pathname.startsWith("/email/"))
  );
}

function loadCursor(userId: string): CursorState {
  const fallback = {
    createdAt: new Date().toISOString(),
    recentIds: [],
  };
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(storageKey(userId)) || "",
    ) as Partial<CursorState>;
    return typeof parsed.createdAt === "string" &&
      Number.isFinite(Date.parse(parsed.createdAt))
      ? {
          createdAt: parsed.createdAt,
          recentIds: Array.isArray(parsed.recentIds)
            ? parsed.recentIds
                .filter((id): id is string => typeof id === "string")
                .slice(-RECENT_LIMIT)
            : [],
        }
      : fallback;
  } catch {
    return fallback;
  }
}

function saveCursor(userId: string, cursor: CursorState): void {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(cursor));
  } catch {
    // Realtime delivery still works when local storage is unavailable.
  }
}

export function EmailFocusNotificationBridge() {
  const pathname = usePathname();
  const clearAttentionRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const emailRoute =
      pathname === "/email" || pathname.startsWith("/email/");
    if (!emailRoute) return;
    const clearWhenVisible = () => {
      if (document.visibilityState === "visible") {
        clearAttentionRef.current();
      }
    };
    clearWhenVisible();
    window.addEventListener("focus", clearWhenVisible);
    document.addEventListener("visibilitychange", clearWhenVisible);
    return () => {
      window.removeEventListener("focus", clearWhenVisible);
      document.removeEventListener("visibilitychange", clearWhenVisible);
    };
  }, [pathname]);

  useEffect(() => {
    const desktopShell = isDesktopShell();
    const unifiedDesktopTone =
      desktopShell &&
      desktopUsesUnifiedNotificationTone(desktopShellVersion());
    const desktop = getDesktopApi();
    const supabase = getSupabaseBrowserClient();
    let disposed = false;
    let userId = "";
    let cursor: CursorState | null = null;
    let flushTimer: number | null = null;
    let realtime: ReturnType<typeof supabase.channel> | null = null;
    let reconcileInFlight: Promise<void> | null = null;
    let lastReconcileStartedAt = 0;
    const queued = new Map<string, EmailFocusArrival>();
    let attentionIds = new Set<string>();
    const attentionRows = new Map<string, ActionRow>();

    const publishAttention = () => {
      publishAppAreaAttention("email", attentionIds.size);
    };

    const clearAttention = () => {
      if (attentionIds.size === 0) {
        publishAttention();
        return;
      }
      attentionIds = new Set();
      attentionRows.clear();
      if (userId) saveAttentionIds(userId, attentionIds);
      publishAttention();
    };
    clearAttentionRef.current = clearAttention;

    const conversationIdentity = (row: ActionRow) => {
      const connectionId = row.connection_id?.trim() || "";
      const threadId =
        row.gmail_thread_id?.trim() || row.gmail_message_id?.trim() || "";
      return connectionId && threadId ? `${connectionId}:${threadId}` : "";
    };

    const rememberAttentionRow = (row: ActionRow) => {
      attentionRows.delete(row.id);
      attentionRows.set(row.id, row);
      while (attentionRows.size > RECENT_LIMIT * 2) {
        const removable = Array.from(attentionRows.keys()).find(
          (id) => !attentionIds.has(id),
        );
        if (!removable) break;
        attentionRows.delete(removable);
      }
    };

    const applyConversationCorrectionToAttention = (
      row: ActionRow,
    ): boolean => {
      const correction = emailWorkspaceCorrectionFromRow(row);
      const identity = conversationIdentity(row);
      if (!correction || !identity) return false;
      let changed = false;
      for (const [id, candidate] of attentionRows) {
        if (conversationIdentity(candidate) !== identity) continue;
        const receivedAt = candidate.received_at || candidate.created_at;
        const placementRemoves =
          Boolean(correction.targetView) &&
          correction.targetView !== "focus" &&
          emailWorkspacePlacementAppliesToThread(correction, { receivedAt });
        const readRemoves =
          correction.unread === false &&
          emailWorkspaceReadStateAppliesToThread(correction, { receivedAt });
        if (!placementRemoves && !readRemoves) continue;
        queued.delete(id);
        if (attentionIds.delete(id)) changed = true;
      }
      return changed;
    };

    const flush = async () => {
      flushTimer = null;
      if (disposed || queued.size === 0) return;
      const arrivals = Array.from(queued.values());
      queued.clear();
      if (emailAreaIsActive()) {
        clearAttention();
        return;
      }
      if (!desktopShell) return;
      const status = await desktop.getNativeNotificationStatus();
      if (!status.supported || status.permission === "denied") return;
      const copy = emailFocusNotificationCopy(arrivals);
      if (unifiedDesktopTone) {
        window.dispatchEvent(new Event(NOTIFICATION_TONE_REQUEST_EVENT));
      }
      await desktop.showChatNotification({
        messageId: arrivals[0].actionId,
        channelId: "email-focus",
        title: copy.title,
        body: copy.body,
        url: emailFocusNotificationUrl(arrivals),
        silent: unifiedDesktopTone,
      });
    };

    const queue = (row: ActionRow) => {
      if (!cursor || row.provider !== "gmail") return;
      rememberAttentionRow(row);
      const arrival = focusArrivalFromAction(row);
      let attentionChanged = false;
      if (!arrival && attentionIds.delete(row.id)) {
        queued.delete(row.id);
        attentionChanged = true;
      }
      if (applyConversationCorrectionToAttention(row)) {
        attentionChanged = true;
      }
      if (attentionChanged) {
        saveAttentionIds(userId, attentionIds);
        publishAttention();
      }
      if (cursor.recentIds.includes(row.id)) {
        return;
      }
      cursor = {
        createdAt:
          row.created_at > cursor.createdAt
            ? row.created_at
            : cursor.createdAt,
        recentIds: [...cursor.recentIds, row.id].slice(-RECENT_LIMIT),
      };
      saveCursor(userId, cursor);
      if (!arrival) return;
      if (emailAreaIsActive()) {
        clearAttention();
        return;
      }
      attentionIds.add(arrival.actionId);
      saveAttentionIds(userId, attentionIds);
      publishAttention();
      queued.set(arrival.actionId, arrival);
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      flushTimer = window.setTimeout(() => void flush(), 650);
    };

    const publishWorkspaceCorrection = (row: unknown) => {
      const correction = emailWorkspaceCorrectionFromRow(row);
      if (!correction) return;
      publishEmailWorkspaceCorrection(correction);
    };

    const reconcileOnce = async () => {
      if (!userId || !cursor || disposed) return;
      const { data, error } = await supabase
        .from("inbox_actions")
        .select(
          "id,user_id,provider,sender_name,sender_email,subject,mailbox_label,connection_id,gmail_thread_id,gmail_message_id,recommended_action,status,confidence,metadata,received_at,created_at,updated_at",
        )
        .eq("user_id", userId)
        .eq("provider", "gmail")
        .gte("created_at", cursor.createdAt)
        .order("created_at", { ascending: true })
        .limit(RECONCILE_LIMIT);
      if (!error && !disposed) {
        for (const row of (data || []) as ActionRow[]) queue(row);
      }
      if (disposed) return;

      // Realtime does not replay UPDATE events that happened while an iOS
      // Home Screen app was suspended. Read/unread and queue changes update
      // older action rows, so replay the most recently updated rows as a fast
      // persisted-state delta before the slower Gmail feed refresh finishes.
      const { data: changedRows, error: changedRowsError } = await supabase
        .from("inbox_actions")
        .select(
          "id,user_id,provider,sender_name,sender_email,subject,mailbox_label,connection_id,gmail_thread_id,gmail_message_id,recommended_action,status,confidence,metadata,received_at,created_at,updated_at",
        )
        .eq("user_id", userId)
        .eq("provider", "gmail")
        .order("updated_at", { ascending: false })
        .limit(RECONCILE_LIMIT);
      if (!changedRowsError && !disposed) {
        let attentionChanged = false;
        for (const row of ([...(changedRows || [])] as ActionRow[]).reverse()) {
          rememberAttentionRow(row);
          if (applyConversationCorrectionToAttention(row)) {
            attentionChanged = true;
          }
          publishWorkspaceCorrection(row);
        }
        if (attentionChanged) {
          saveAttentionIds(userId, attentionIds);
          publishAttention();
        }
      }

      // A Focus arrival can be reclassified or completed while this client is
      // asleep. Revalidate persisted attention IDs so a missed UPDATE cannot
      // leave a false dot until the user opens Email.
      if (attentionIds.size === 0) return;
      const persistedIds = Array.from(attentionIds);
      const { data: persistedAttentionRows, error: attentionError } =
        await supabase
        .from("inbox_actions")
        .select(
          "id,user_id,provider,sender_name,sender_email,subject,mailbox_label,connection_id,gmail_thread_id,gmail_message_id,recommended_action,status,confidence,metadata,received_at,created_at,updated_at",
        )
        .eq("user_id", userId)
        .eq("provider", "gmail")
        .in("id", persistedIds);
      if (attentionError || disposed) return;
      for (const row of (persistedAttentionRows || []) as ActionRow[]) {
        rememberAttentionRow(row);
      }
      const validIds = new Set(
        ((persistedAttentionRows || []) as ActionRow[])
          .filter((row) => focusArrivalFromAction(row) !== null)
          .map((row) => row.id),
      );
      const nextAttentionIds = new Set(
        persistedIds.filter((id) => validIds.has(id)),
      );
      attentionIds = nextAttentionIds;
      for (const row of attentionRows.values()) {
        applyConversationCorrectionToAttention(row);
      }
      if (
        attentionIds.size !== persistedIds.length ||
        persistedIds.some((id) => !attentionIds.has(id))
      ) {
        saveAttentionIds(userId, attentionIds);
        publishAttention();
      }
    };

    const reconcile = (force = false): Promise<void> => {
      if (reconcileInFlight) return reconcileInFlight;
      if (
        !force &&
        Date.now() - lastReconcileStartedAt <
          RESUME_RECONCILE_COOLDOWN_MS
      ) {
        return Promise.resolve();
      }
      lastReconcileStartedAt = Date.now();
      const task = reconcileOnce().finally(() => {
        if (reconcileInFlight === task) reconcileInFlight = null;
      });
      reconcileInFlight = task;
      return task;
    };

    const start = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || disposed) return;
      userId = user.id;
      cursor = loadCursor(user.id);
      attentionIds = loadAttentionIds(user.id);
      if (emailAreaIsActive()) clearAttention();
      else publishAttention();
      realtime = supabase
        .channel(`email-focus-notifications-${user.id}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "inbox_actions",
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            queue(payload.new as ActionRow);
            publishWorkspaceCorrection(payload.new);
          },
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "inbox_actions",
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            queue(payload.new as ActionRow);
            publishWorkspaceCorrection(payload.new);
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void reconcile(true);
        });
      await reconcile(true);
    };

    const onReconnect = () => void reconcile(true);
    const onFocus = () => void reconcile();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void reconcile();
    };
    const onPageShow = () => void reconcile();
    const unsubscribeResume = desktopShell
      ? desktop.onSystemResume(onReconnect)
      : () => undefined;
    window.addEventListener("online", onReconnect);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void start();

    return () => {
      disposed = true;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      clearAttentionRef.current = () => undefined;
      unsubscribeResume();
      window.removeEventListener("online", onReconnect);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (realtime) void supabase.removeChannel(realtime);
    };
  }, []);

  return null;
}
