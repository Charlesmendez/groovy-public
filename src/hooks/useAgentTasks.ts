"use client";

/**
 * Live agent-task feed for the harness dashboard.
 * Initial load over /api/agents/tasks, then supabase realtime keeps it fresh.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export function useAgentTasks(args?: { userId?: string | null; limit?: number }) {
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
        setTasks(json.tasks as AgentTask[]);
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
            next.unshift({ ...(prev.find((t) => t.id === row.id) || {}), ...row } as AgentTask);
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
