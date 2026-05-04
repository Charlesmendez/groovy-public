"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, FolderOpen, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { RelayMessage, RelayStatus } from "@/hooks/useRelay";

type ClaudeCodeAgent = {
  id: string;
  name: string;
  createdAt?: string;
  codeCliProvider?: "claude" | "codex";
};

type WorkspaceAddedMsg = {
  type: "workspace_added";
  request_id?: string;
  ok?: boolean;
  workspace?: { id?: string; root_path?: string; label?: string };
  error?: string;
};

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

export function ClaudeCodeSessionsPanel({
  deviceId,
  relayStatus,
  relaySend,
  relaySubscribe,
  sessions,
  onRefreshSessions,
  onOpenSession,
  onClose,
  isMobile,
}: {
  deviceId: string | null;
  relayStatus: RelayStatus;
  relaySend: (msg: RelayMessage) => void;
  relaySubscribe: (handler: (msg: RelayMessage) => void) => () => void;
  sessions: ClaudeCodeAgent[];
  onRefreshSessions: () => Promise<void>;
  onOpenSession: (agentId: string) => void;
  onClose: () => void;
  isMobile?: boolean;
}) {
  const supabase = getSupabaseBrowserClient();

  const mobileUi = Boolean(isMobile);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("Code Session");
  const [selectedProvider, setSelectedProvider] = useState<"claude" | "codex">("claude");
  const [pickLoading, setPickLoading] = useState(false);
  const [pickedWorkspace, setPickedWorkspace] = useState<{ id: string; rootPath?: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [savingName, setSavingName] = useState(false);

  const [terminatingId, setTerminatingId] = useState<string | null>(null);

  const pickReqRef = useRef<string | null>(null);

  const canCreate = useMemo(() => {
    return !!deviceId && !!newName.trim();
  }, [deviceId, newName]);

  const pickWorkspace = useCallback(async () => {
    setError(null);
    if (!deviceId) {
      setError("No device online. Start the connector first.");
      return;
    }
    if (relayStatus !== "ready") {
      setError("Relay not connected.");
      return;
    }
    if (pickLoading) return;
    setPickLoading(true);

    const requestId = crypto.randomUUID();
    pickReqRef.current = requestId;

    const unsub = relaySubscribe((msg) => {
      const msgType = (msg as { type?: string }).type;
      
      // Handle success: workspace_added
      if (msgType === "workspace_added") {
        const m = msg as unknown as WorkspaceAddedMsg;
        if (String(m.request_id || "") !== requestId) return;
        pickReqRef.current = null;
        setPickLoading(false);
        unsub();
        if (!m.ok || !m.workspace?.id) {
          setError(m.error || "Failed to add workspace");
          return;
        }
        setPickedWorkspace({
          id: String(m.workspace.id),
          rootPath: m.workspace.root_path ? String(m.workspace.root_path) : undefined,
        });
        return;
      }
      
      // Handle error: workspace_pick_result with ok=false (user cancelled or error)
      if (msgType === "workspace_pick_result") {
        const m = msg as { request_id?: string; ok?: boolean; error?: string };
        if (String(m.request_id || "") !== requestId) return;
        if (m.ok) return; // Success is handled via workspace_added
        pickReqRef.current = null;
        setPickLoading(false);
        unsub();
        setError(m.error === "cancelled" ? "Folder selection cancelled" : (m.error || "Failed to pick folder"));
        return;
      }
      
      // Handle device_not_online error
      if (msgType === "error") {
        const m = msg as { error?: string };
        if (m.error === "device_not_online") {
          pickReqRef.current = null;
          setPickLoading(false);
          unsub();
          setError("Connector not online. Check that the Groovy Connector is running.");
        }
      }
    });

    relaySend({ type: "workspace_pick", request_id: requestId, device_id: deviceId });

    window.setTimeout(() => {
      if (pickReqRef.current !== requestId) return;
      pickReqRef.current = null;
      setPickLoading(false);
      unsub();
      setError("Timed out waiting for folder picker. Check the connector.");
    }, 20000);
  }, [deviceId, pickLoading, relaySend, relayStatus, relaySubscribe]);

  const createSession = useCallback(async () => {
    setError(null);
    if (!canCreate || !deviceId) return;
    setCreating(true);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const name = newName.trim();
      const workspaceId = pickedWorkspace?.id ? String(pickedWorkspace.id) : null;

      const { data: agentRow, error: agentErr } = await supabase
        .from("agents")
        .insert({
          user_id: user.id,
          type: "claude-code",
          name,
          flag_key: null,
          provider: null,
          model: null,
        })
        .select("id")
        .single();
      if (agentErr || !agentRow?.id) throw agentErr || new Error("Failed to create agent");

      const { error: cfgErr } = await supabase.from("claude_code_agent_configs").insert({
        agent_id: agentRow.id,
        user_id: user.id,
        device_id: deviceId,
        workspace_id: workspaceId,
        terminal_id: null,
        code_cli_provider: selectedProvider,
      });
      if (cfgErr) throw cfgErr;

      setPickedWorkspace(null);
      setNewName("Code Session");
      setSelectedProvider("claude");
      await onRefreshSessions();
    } catch (e) {
      setError(getErrorMessage(e) || "Failed to create session");
    } finally {
      setCreating(false);
    }
  }, [canCreate, deviceId, newName, onRefreshSessions, pickedWorkspace?.id, selectedProvider, supabase]);

  const startRename = useCallback((s: ClaudeCodeAgent) => {
    setEditingId(s.id);
    setEditingName(s.name);
    setError(null);
  }, []);

  const saveRename = useCallback(async () => {
    if (!editingId) return;
    const next = editingName.trim();
    if (!next) return;
    setSavingName(true);
    setError(null);
    try {
      const { error: updErr } = await supabase
        .from("agents")
        .update({ name: next, updated_at: new Date().toISOString() })
        .eq("id", editingId);
      if (updErr) throw updErr;
      setEditingId(null);
      setEditingName("");
      await onRefreshSessions();
    } catch (e) {
      setError(getErrorMessage(e) || "Failed to rename");
    } finally {
      setSavingName(false);
    }
  }, [editingId, editingName, onRefreshSessions, supabase]);

  const deleteSession = useCallback(
    async (agentId: string) => {
      if (!confirm("Delete this Code session? This will permanently remove all messages and data.")) return;
      setTerminatingId(agentId);
      setError(null);
      try {
        // First close the terminal if running
        if (deviceId) {
          const { data: cfg } = await supabase
            .from("claude_code_agent_configs")
            .select("terminal_id")
            .eq("agent_id", agentId)
            .single();
          const terminalId = (cfg as { terminal_id?: string | null } | null)?.terminal_id;
          if (terminalId && relayStatus === "ready") {
            relaySend({ type: "terminal_close", terminal_id: terminalId });
          }
        }

        // Delete CLI messages (new chat UI)
        await supabase
          .from("claude_code_cli_messages")
          .delete()
          .eq("claude_code_agent_id", agentId);

        // Delete CLI thread mapping
        await supabase
          .from("claude_code_cli_threads")
          .delete()
          .eq("claude_code_agent_id", agentId);

        // Delete agent config
        await supabase
          .from("claude_code_agent_configs")
          .delete()
          .eq("agent_id", agentId);

        // Delete the agent itself
        await supabase
          .from("agents")
          .delete()
          .eq("id", agentId);

        await onRefreshSessions();
      } catch (e) {
        setError(getErrorMessage(e) || "Failed to delete session");
      } finally {
        setTerminatingId(null);
      }
    },
    [deviceId, onRefreshSessions, relaySend, relayStatus, supabase]
  );

  // Reset picked workspace when device changes
  useEffect(() => {
    setPickedWorkspace(null);
  }, [deviceId]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-white">Code Sessions</div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="rounded-xl border border-white/10 bg-black/30 p-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="flex-1 bg-black/30 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none border border-white/10 focus:border-cyan-500/50"
              placeholder="Session name"
            />
            {!mobileUi && (
              <button
                type="button"
                onClick={pickWorkspace}
                disabled={pickLoading || relayStatus !== "ready" || !deviceId}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 disabled:opacity-50 transition-colors text-sm"
                title="Choose folder (optional)"
              >
                {pickLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <FolderOpen className="w-4 h-4" />
                )}
                Folder
              </button>
            )}
            <button
              type="button"
              onClick={createSession}
              disabled={!canCreate || creating}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-cyan-600 text-black hover:bg-cyan-500 disabled:opacity-50 transition-colors text-sm font-medium"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Create
            </button>
          </div>

          <div className="flex items-center gap-1 mt-1">
            <span className="text-[10px] text-zinc-500 mr-1">Provider:</span>
            {([
              { value: "claude" as const, label: "Claude", active: "bg-orange-500/20 text-orange-400 ring-1 ring-orange-500/40" },
              { value: "codex" as const, label: "Codex", active: "bg-green-500/20 text-green-400 ring-1 ring-green-500/40" },
            ]).map(({ value, label, active }) => (
              <button
                key={value}
                type="button"
                onClick={() => setSelectedProvider(value)}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase transition-colors ${
                  selectedProvider === value
                    ? active
                    : "bg-white/5 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="text-xs text-zinc-500">
            {!deviceId ? (
              <span className="text-amber-400">Connect the Groovy Connector to create sessions.</span>
            ) : pickedWorkspace?.rootPath ? (
              <>
                Selected: <span className="text-zinc-300">{pickedWorkspace.rootPath}</span>
              </>
            ) : (
              <>No folder selected (starts in your computer&apos;s home directory).</>
            )}
          </div>
        </div>
      </div>

      {error && <div className="mt-2 text-xs text-red-400">{error}</div>}

      <div className="mt-4 flex-1 min-h-0 overflow-auto rounded-xl border border-white/10 bg-black/20">
        {sessions.length === 0 ? (
          <div className="p-4 text-xs text-zinc-500">No code sessions yet.</div>
        ) : (
          <div className="divide-y divide-white/5">
            {sessions.map((s) => (
              <div key={s.id} className="p-3 flex items-center gap-2">
                {editingId === s.id ? (
                  <>
                    <input
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className="flex-1 bg-black/30 rounded-lg px-3 py-2 text-sm text-white outline-none border border-white/10 focus:border-cyan-500/50"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveRename();
                        if (e.key === "Escape") {
                          setEditingId(null);
                          setEditingName("");
                        }
                      }}
                    />
                    <button
                      onClick={saveRename}
                      disabled={savingName}
                      className="w-9 h-9 rounded-lg flex items-center justify-center bg-white/5 text-zinc-300 hover:bg-white/10 disabled:opacity-50"
                      title="Save"
                    >
                      {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(null);
                        setEditingName("");
                      }}
                      className="w-9 h-9 rounded-lg flex items-center justify-center bg-white/5 text-zinc-300 hover:bg-white/10"
                      title="Cancel"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => onOpenSession(s.id)}
                      className="flex-1 text-left min-w-0"
                      title="Open session"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="text-sm text-white truncate">{s.name}</div>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                            s.codeCliProvider === "codex"
                              ? "bg-green-500/15 text-green-300"
                              : "bg-orange-500/15 text-orange-300"
                          }`}
                        >
                          {s.codeCliProvider === "codex" ? "Codex" : "Claude"}
                        </span>
                      </div>
                      <div className="text-[10px] text-zinc-600">
                        {s.createdAt ? new Date(s.createdAt).toLocaleDateString() : ""}
                      </div>
                    </button>
                    <button
                      onClick={() => startRename(s)}
                      className="w-9 h-9 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
                      title="Rename"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => deleteSession(s.id)}
                      disabled={terminatingId === s.id}
                      className="w-9 h-9 rounded-lg flex items-center justify-center text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-50"
                      title="Delete session"
                    >
                      {terminatingId === s.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
