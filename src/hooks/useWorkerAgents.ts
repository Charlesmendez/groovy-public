"use client";

/**
 * Worker-agent roster hook (agents.type='claude-code').
 *
 * Extracted from src/app/dashboard/page.tsx:
 * - roster load (~lines 4392-4425 and refreshCodeAgents ~line 4555; the
 *   /api/claude-code/sessions route does not return device_id/model/emoji/color,
 *   so this hook queries supabase directly with the extended column set)
 * - createCodeAgentFromMultiView (~line 2934): agents insert + claude_code_agent_configs
 *   insert with rollback
 * - pickCodeWorkspaceForMultiView (~line 3009): relay `workspace_pick` flow with
 *   `workspace_added` / `workspace_pick_result` responses
 * - rename/delete go through /api/agents (PATCH/DELETE); the DELETE route runs
 *   rehomeScheduledJobsForDeletedAgent server-side before removing the row.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { useRelay } from "@/hooks/useRelay";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { workerHarnessFromProvider, type WorkerHarness } from "@/lib/agents/types";

export type WorkerAgentInfo = {
  id: string;
  name: string;
  harness: "claude" | "codex";
  model: string | null;
  reasoningEffort: string | null;
  deviceId: string | null;
  workspaceId: string | null;
  workspaceRootPath: string | null;
  emoji: string | null;
  color: string | null;
  createdAt: string | null;
};

type WorkspaceAddedMsg = {
  type: "workspace_added";
  request_id?: string;
  ok?: boolean;
  workspace?: { id?: string; root_path?: string; label?: string };
  error?: string;
};

type ConfigRow = {
  agent_id: string | null;
  device_id: string | null;
  workspace_id: string | null;
  code_cli_provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  emoji: string | null;
  color: string | null;
  agents: unknown;
  device_workspaces: unknown;
};

const WORKSPACE_PICK_TIMEOUT_MS = 20000;

export function useWorkerAgents(args: {
  relay: ReturnType<typeof useRelay>;
  activeDeviceId: string | null;
}): {
  agents: WorkerAgentInfo[];
  isLoading: boolean;
  refresh(): Promise<void>;
  createAgent(input: {
    name: string;
    harness: "claude" | "codex";
    model?: string | null;
    reasoningEffort?: string | null;
    workspace?: { id: string; rootPath?: string } | null;
  }): Promise<WorkerAgentInfo | null>;
  renameAgent(id: string, name: string): Promise<boolean>;
  deleteAgent(id: string): Promise<boolean>;
  updateAgent(
    id: string,
    patch: {
      harness?: "claude" | "codex";
      model?: string | null;
      reasoningEffort?: string | null;
      emoji?: string | null;
      color?: string | null;
    }
  ): Promise<boolean>;
  pickWorkspace(): Promise<{ id: string; rootPath: string } | null>;
} {
  const { relay, activeDeviceId } = args;
  const supabase = getSupabaseBrowserClient();

  const [agents, setAgents] = useState<WorkerAgentInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const agentsRef = useRef<WorkerAgentInfo[]>([]);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  const refresh = useCallback(async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setAgents([]);
        return;
      }
      // Same join as dashboard/page.tsx (~line 4393) plus the worker-agent
      // config columns (device_id, model, emoji, color).
      const { data, error } = await supabase
        .from("claude_code_agent_configs")
        .select(
          "agent_id, device_id, workspace_id, code_cli_provider, model, reasoning_effort, emoji, color, agents!inner(id, name, created_at), device_workspaces(root_path)"
        )
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error || !data) return;

      const mapped = (data as unknown as ConfigRow[])
        .map((row): WorkerAgentInfo | null => {
          const agent = row.agents as { id: string; name: string; created_at: string } | null;
          if (!agent) return null;
          const ws = row.device_workspaces as { root_path?: string } | null;
          return {
            id: String(agent.id),
            name: String(agent.name || ""),
            harness: workerHarnessFromProvider(row.code_cli_provider),
            model: row.model ? String(row.model) : null,
            reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : null,
            deviceId: row.device_id ? String(row.device_id) : null,
            workspaceId: row.workspace_id ? String(row.workspace_id) : null,
            workspaceRootPath: ws?.root_path ? String(ws.root_path) : null,
            emoji: row.emoji ? String(row.emoji) : null,
            color: row.color ? String(row.color) : null,
            createdAt: agent.created_at ? String(agent.created_at) : null,
          };
        })
        .filter((a): a is WorkerAgentInfo => !!a && !!a.id && !!a.name);
      setAgents(mapped);
    } catch {
      // ignore
    }
  }, [supabase]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (!cancelled) setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Mirrors createCodeAgentFromMultiView (dashboard/page.tsx ~line 2934).
  const createAgent = useCallback(
    async (input: {
      name: string;
      harness: "claude" | "codex";
      model?: string | null;
      reasoningEffort?: string | null;
      workspace?: { id: string; rootPath?: string } | null;
    }): Promise<WorkerAgentInfo | null> => {
      if (!activeDeviceId) return null;

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;

      const baseName = input.name.trim() || "Code Session";
      const existingNames = new Set(
        agentsRef.current.map((agent) => agent.name.trim()).filter(Boolean)
      );
      let nextName = baseName;
      let suffix = 2;
      while (existingNames.has(nextName)) {
        nextName = `${baseName} ${suffix}`;
        suffix += 1;
      }

      const { data: agentRow, error: agentErr } = await supabase
        .from("agents")
        .insert({
          user_id: user.id,
          type: "claude-code",
          name: nextName,
          flag_key: null,
          provider: null,
          model: null,
        })
        .select("id")
        .single();
      if (agentErr || !agentRow?.id) return null;

      const { error: cfgErr } = await supabase.from("claude_code_agent_configs").insert({
        agent_id: agentRow.id,
        user_id: user.id,
        device_id: activeDeviceId,
        workspace_id: input.workspace?.id || null,
        terminal_id: null,
        code_cli_provider: input.harness,
        model: input.model?.trim() || null,
        reasoning_effort: input.reasoningEffort?.trim() || null,
      });
      if (cfgErr) {
        await supabase.from("agents").delete().eq("id", agentRow.id);
        return null;
      }

      const created: WorkerAgentInfo = {
        id: String(agentRow.id),
        name: nextName,
        harness: input.harness,
        model: input.model?.trim() || null,
        reasoningEffort: input.reasoningEffort?.trim() || null,
        deviceId: activeDeviceId,
        workspaceId: input.workspace?.id || null,
        workspaceRootPath: input.workspace?.rootPath || null,
        emoji: null,
        color: null,
        createdAt: new Date().toISOString(),
      };
      setAgents((prev) => [created, ...prev.filter((agent) => agent.id !== created.id)]);
      return created;
    },
    [activeDeviceId, supabase]
  );

  // Renames go through PATCH /api/agents (same route the old page's agent
  // management uses; updates agents.name + updated_at server-side).
  const renameAgent = useCallback(async (id: string, name: string): Promise<boolean> => {
    const trimmed = name.trim();
    if (!id || !trimmed) return false;
    try {
      const res = await fetch("/api/agents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: trimmed }),
      });
      if (!res.ok) return false;
      setAgents((prev) =>
        prev.map((agent) => (agent.id === id ? { ...agent, name: trimmed } : agent))
      );
      return true;
    } catch {
      return false;
    }
  }, []);

  // Deletes go through DELETE /api/agents?id= so the server can run
  // rehomeScheduledJobsForDeletedAgent before removing the row (configs and
  // chat sessions cascade).
  const deleteAgent = useCallback(async (id: string): Promise<boolean> => {
    if (!id) return false;
    try {
      const res = await fetch(`/api/agents?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) return false;
      setAgents((prev) => prev.filter((agent) => agent.id !== id));
      return true;
    } catch {
      return false;
    }
  }, []);

  // Updates the claude_code_agent_configs row directly (RLS: own rows).
  const updateAgent = useCallback(
    async (
      id: string,
      patch: {
        harness?: WorkerHarness;
        model?: string | null;
        reasoningEffort?: string | null;
        emoji?: string | null;
        color?: string | null;
      }
    ): Promise<boolean> => {
      if (!id) return false;
      const update: Record<string, unknown> = {};
      if (patch.harness !== undefined) update.code_cli_provider = patch.harness;
      if (patch.model !== undefined) update.model = patch.model;
      if (patch.reasoningEffort !== undefined) update.reasoning_effort = patch.reasoningEffort;
      if (patch.emoji !== undefined) update.emoji = patch.emoji;
      if (patch.color !== undefined) update.color = patch.color;
      if (Object.keys(update).length === 0) return true;
      update.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from("claude_code_agent_configs")
        .update(update)
        .eq("agent_id", id)
        .select("code_cli_provider,model,reasoning_effort,emoji,color")
        .maybeSingle();
      if (error || !data) return false;

      setAgents((prev) =>
        prev.map((agent) =>
          agent.id === id
            ? {
                ...agent,
                harness: data.code_cli_provider === "codex" ? "codex" : "claude",
                model: typeof data.model === "string" && data.model.trim() ? data.model : null,
                reasoningEffort:
                  typeof data.reasoning_effort === "string" && data.reasoning_effort.trim()
                    ? data.reasoning_effort
                    : null,
                emoji: typeof data.emoji === "string" && data.emoji.trim() ? data.emoji : null,
                color: typeof data.color === "string" && data.color.trim() ? data.color : null,
              }
            : agent
        )
      );
      return true;
    },
    [supabase]
  );

  // Mirrors pickCodeWorkspaceForMultiView (dashboard/page.tsx ~line 3009).
  // Resolves null when the user cancels the picker; rejects on other failures.
  const pickWorkspace = useCallback(async (): Promise<{ id: string; rootPath: string } | null> => {
    if (!activeDeviceId) {
      throw new Error("No device online. Start the connector first.");
    }
    if (relay.status !== "ready") {
      throw new Error("Relay not connected.");
    }

    const requestId = crypto.randomUUID();

    return await new Promise<{ id: string; rootPath: string } | null>((resolve, reject) => {
      let settled = false;
      let unsub: (() => void) | null = null;
      const timer = window.setTimeout(() => {
        finish(() =>
          reject(new Error("Timed out waiting for folder picker. Check the connector."))
        );
      }, WORKSPACE_PICK_TIMEOUT_MS);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (unsub) unsub();
        fn();
      };

      unsub = relay.subscribe((msg) => {
        const msgType = (msg as { type?: string }).type;

        if (msgType === "workspace_added") {
          const m = msg as unknown as WorkspaceAddedMsg;
          if (String(m.request_id || "") !== requestId) return;
          if (!m.ok || !m.workspace?.id) {
            finish(() => reject(new Error(m.error || "Failed to add workspace")));
            return;
          }
          finish(() =>
            resolve({
              id: String(m.workspace?.id || ""),
              rootPath: m.workspace?.root_path ? String(m.workspace.root_path) : "",
            })
          );
          return;
        }

        if (msgType === "workspace_pick_result") {
          const m = msg as { request_id?: string; ok?: boolean; error?: string };
          if (String(m.request_id || "") !== requestId) return;
          if (m.ok) return;
          if (m.error === "cancelled") {
            finish(() => resolve(null));
            return;
          }
          finish(() => reject(new Error(m.error || "Failed to pick folder")));
          return;
        }

        if (msgType === "error") {
          const m = msg as { error?: string };
          if (m.error === "device_not_online") {
            finish(() =>
              reject(
                new Error("Connector not online. Check that the Groovy Connector is running.")
              )
            );
          }
        }
      });

      relay.send({ type: "workspace_pick", request_id: requestId, device_id: activeDeviceId });
    });
  }, [activeDeviceId, relay]);

  return {
    agents,
    isLoading,
    refresh,
    createAgent,
    renameAgent,
    deleteAgent,
    updateAgent,
    pickWorkspace,
  };
}
