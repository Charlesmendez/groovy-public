"use client";

/**
 * Live agent-task feed for the harness dashboard.
 * Initial load over /api/agents/tasks, then supabase realtime keeps it fresh.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { useRelay } from "@/hooks/useRelay";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export type AgentTaskStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "canceled";

export type AgentTask = {
  id: string;
  agent_id: string;
  status: AgentTaskStatus;
  title: string | null;
  prompt: string;
  result_text: string | null;
  result_meta: Record<string, unknown> | null;
  error: string | null;
  source: string;
  requested_channel: string | null;
  orchestrator_session_id: string | null;
  scheduled_job_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

const OPEN_STATUSES: AgentTaskStatus[] = ["queued", "running", "awaiting_approval"];
const LIVE_TEXT_MAX_CHARS = 60_000;
const LIVE_TOOLS_MAX = 24;
const LIVE_EVENTS_MAX = 250;
const LIVE_EVENTS_MAX_CHARS = 60_000;

type LiveProgressEvent =
  | {
      seq: number;
      type: "assistant";
      content: string;
      at?: string;
      content_truncated?: boolean;
    }
  | {
      seq: number;
      type: "tool_use";
      name: string;
      input?: string;
      at?: string;
    };

const LIVE_PROGRESS_META_KEYS = [
  "relay_request_id",
  "live_status",
  "live_text",
  "live_text_truncated",
  "live_tools",
  "live_events",
  "live_event_count",
  "live_events_truncated",
  "progress_updated_at",
] as const;

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function progressCount(meta: Record<string, unknown>): number {
  const explicit = Number(meta.live_event_count);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  return Array.isArray(meta.live_events) ? meta.live_events.length : 0;
}

function mergeTaskRow(previous: AgentTask | undefined, incoming: AgentTask): AgentTask {
  if (!previous) return incoming;

  const previousMeta = recordValue(previous.result_meta);
  const incomingMeta = recordValue(incoming.result_meta);
  const previousRequestId =
    typeof previousMeta.relay_request_id === "string" ? previousMeta.relay_request_id : "";
  const incomingRequestId =
    typeof incomingMeta.relay_request_id === "string" ? incomingMeta.relay_request_id : "";

  if (
    incomingRequestId &&
    previousRequestId &&
    incomingRequestId !== previousRequestId
  ) {
    return { ...previous, ...incoming };
  }
  if (progressCount(incomingMeta) >= progressCount(previousMeta)) {
    return { ...previous, ...incoming };
  }

  const mergedMeta = { ...incomingMeta };
  for (const key of LIVE_PROGRESS_META_KEYS) {
    if (key in previousMeta) mergedMeta[key] = previousMeta[key];
  }
  return {
    ...previous,
    ...incoming,
    result_meta: mergedMeta,
  };
}

function parseLiveProgressEvent(value: unknown): LiveProgressEvent | null {
  const event = recordValue(value);
  const seq = Number(event.seq);
  if (!Number.isFinite(seq) || seq < 1) return null;

  if (event.type === "assistant" && typeof event.content === "string") {
    return {
      seq,
      type: "assistant",
      content: event.content,
      ...(typeof event.at === "string" ? { at: event.at } : {}),
      ...(event.content_truncated === true ? { content_truncated: true } : {}),
    };
  }
  if (event.type === "tool_use" && typeof event.name === "string") {
    return {
      seq,
      type: "tool_use",
      name: event.name,
      ...(typeof event.input === "string" ? { input: event.input } : {}),
      ...(typeof event.at === "string" ? { at: event.at } : {}),
    };
  }
  return null;
}

function applyRelayProgress(task: AgentTask, message: Record<string, unknown>): AgentTask {
  const event = parseLiveProgressEvent(message.event);
  if (!event) return task;

  const meta = recordValue(task.result_meta);
  const requestId = typeof message.request_id === "string" ? message.request_id : "";
  const currentRequestId =
    typeof meta.relay_request_id === "string" ? meta.relay_request_id : "";
  if (requestId && currentRequestId && requestId !== currentRequestId) return task;

  const existingEvents = Array.isArray(meta.live_events)
    ? meta.live_events
        .map(parseLiveProgressEvent)
        .filter((item): item is LiveProgressEvent => item !== null)
    : [];
  if (existingEvents.some((item) => item.seq === event.seq)) return task;

  const unboundedEvents = [...existingEvents, event]
    .sort((left, right) => left.seq - right.seq)
    .slice(-LIVE_EVENTS_MAX);
  const nextEvents = [...unboundedEvents];
  let eventChars = nextEvents.reduce(
    (total, item) =>
      total +
      (item.type === "assistant"
        ? item.content.length
        : (item.input || "").length),
    0
  );
  while (nextEvents.length > 1 && eventChars > LIVE_EVENTS_MAX_CHARS) {
    const removed = nextEvents.shift();
    if (!removed) break;
    eventChars -=
      removed.type === "assistant"
        ? removed.content.length
        : (removed.input || "").length;
  }
  const nextMeta: Record<string, unknown> = {
    ...meta,
    ...(requestId ? { relay_request_id: requestId } : {}),
    live_status: "running",
    live_events: nextEvents,
    live_event_count: Math.max(
      progressCount(meta),
      Number(message.live_event_count) || 0,
      event.seq
    ),
    live_events_truncated:
      meta.live_events_truncated === true ||
      existingEvents.length + 1 > LIVE_EVENTS_MAX ||
      nextEvents.length < unboundedEvents.length ||
      eventChars > LIVE_EVENTS_MAX_CHARS ||
      undefined,
    progress_updated_at:
      typeof message.progress_updated_at === "string"
        ? message.progress_updated_at
        : event.at || new Date().toISOString(),
  };

  if (event.type === "assistant") {
    const combined = `${typeof meta.live_text === "string" ? meta.live_text : ""}${
      event.content
    }`;
    nextMeta.live_text =
      combined.length > LIVE_TEXT_MAX_CHARS
        ? combined.slice(-LIVE_TEXT_MAX_CHARS)
        : combined;
    nextMeta.live_text_truncated =
      meta.live_text_truncated === true ||
      combined.length > LIVE_TEXT_MAX_CHARS ||
      undefined;
  } else {
    const existingTools = Array.isArray(meta.live_tools) ? meta.live_tools : [];
    const lastTool = recordValue(existingTools[existingTools.length - 1]);
    if (lastTool.name !== event.name || lastTool.input !== (event.input || "")) {
      nextMeta.live_tools = [
        ...existingTools.slice(-(LIVE_TOOLS_MAX - 1)),
        {
          name: event.name,
          input: event.input || "",
          ...(event.at ? { at: event.at } : {}),
        },
      ];
    }
  }

  return { ...task, result_meta: nextMeta };
}

export function useAgentTasks(args?: {
  userId?: string | null;
  limit?: number;
  relay?: Pick<ReturnType<typeof useRelay>, "subscribe">;
}) {
  const supabase = getSupabaseBrowserClient();
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const limit = args?.limit ?? 80;
  const userId = args?.userId || null;
  const tasksRef = useRef<AgentTask[]>([]);
  tasksRef.current = tasks;

  const refresh = useCallback(async () => {
    if (!userId) {
      setTasks([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch(`/api/agents/tasks?limit=${limit}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(json?.tasks)) {
        setTasks((previous) => {
          const previousById = new Map(previous.map((task) => [task.id, task]));
          return (json.tasks as AgentTask[]).map((task) =>
            mergeTaskRow(previousById.get(task.id), task)
          );
        });
      }
    } catch {
      // keep prior state
    } finally {
      setIsLoading(false);
    }
  }, [limit, userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Realtime: merge row-level changes. Channel topic must be unique per hook
  // instance — supabase-js returns the SAME channel object for duplicate
  // topics, so two mounts (dashboard + onboarding) would tear each other down.
  const instanceIdRef = useRef(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`agent_tasks_feed:${instanceIdRef.current}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_tasks",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const row = (payload.new || payload.old) as AgentTask | null;
          if (!row?.id) return;
          setTasks((prev) => {
            if (payload.eventType === "DELETE") {
              return prev.filter((t) => t.id !== row.id);
            }
            const next = prev.filter((t) => t.id !== row.id);
            next.unshift(mergeTaskRow(prev.find((t) => t.id === row.id), row));
            next.sort(
              (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            );
            return next.slice(0, Math.max(limit, 40));
          });
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, userId, limit]);

  // The relay is the token-level fast path used by the direct multi-agent
  // panes. Merge those same ordered events immediately for orchestrator-
  // delegated runs; the database snapshot remains the reconnect/fallback path.
  useEffect(() => {
    if (!args?.relay) return;
    return args.relay.subscribe((message) => {
      if (message.type !== "agent_task_progress") return;
      const taskId = typeof message.task_id === "string" ? message.task_id : "";
      if (!taskId) return;
      setTasks((previous) =>
        previous.map((task) =>
          task.id === taskId
            ? applyRelayProgress(task, message)
            : task
        )
      );
    });
  }, [args?.relay]);

  const openTasks = useMemo(
    () => tasks.filter((t) => OPEN_STATUSES.includes(t.status)),
    [tasks]
  );

  // Realtime is the fast path, but some local/self-hosted Supabase projects
  // do not publish this table (or briefly lose the subscription). Poll only
  // while work is open so a completed run cannot remain visually stuck in
  // Queued/Running indefinitely.
  useEffect(() => {
    if (!userId || openTasks.length === 0) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [userId, openTasks.length, refresh]);

  const openByAgent = useMemo(() => {
    const map = new Map<string, AgentTask[]>();
    for (const task of openTasks) {
      const list = map.get(task.agent_id) || [];
      list.push(task);
      map.set(task.agent_id, list);
    }
    return map;
  }, [openTasks]);

  const act = useCallback(
    async (taskId: string, action: "approve" | "reject" | "cancel") => {
      const res = await fetch(`/api/agents/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) void refresh();
      return res.ok;
    },
    [refresh]
  );

  return { tasks, openTasks, openByAgent, isLoading, refresh, act };
}
