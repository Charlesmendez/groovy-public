"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Loader2, PlugZap, RefreshCcw, Terminal as TerminalIcon, Trash2, X } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useRelay, type RelayMessage } from "@/hooks/useRelay";
import { TerminalView } from "@/components/terminal/TerminalView";

type ClaudeCodeConfigRow = {
  device_id: string;
  workspace_id: string | null;
  terminal_id?: string | null;
};

type DeviceRow = {
  id: string;
  name: string;
};

type WorkspaceRow = {
  id: string;
  device_id: string;
  label: string;
  root_path: string;
};

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

export function ClaudeCodePanel({
  agentId,
  onUpdate,
}: {
  agentId: string;
  onUpdate?: (data: { 
    status?: "running" | "ready" | "error"; 
    output?: string[];
    terminalId?: string;
    sendInput?: (input: string) => void;
  }) => void;
}) {
  const relay = useRelay({ enabled: true });

  const [config, setConfig] = useState<ClaudeCodeConfigRow | null>(null);
  const [device, setDevice] = useState<DeviceRow | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [terminalIdLoaded, setTerminalIdLoaded] = useState(false);
  const [opening, setOpening] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [showTroubleshoot, setShowTroubleshoot] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Track which devices are currently online via relay events
  const [onlineDeviceIds, setOnlineDeviceIds] = useState<Set<string>>(new Set());

  const openReqRef = useRef<string | null>(null);
  const connectorTimeoutRetryRef = useRef(0);
  const terminalIdRef = useRef<string | null>(null);
  const statusRef = useRef<"running" | "ready" | "error">("ready");
  const outputTailRef = useRef<string>("");
  const outputLinesRef = useRef<string[]>([]);
  const idleReadyTimerRef = useRef<number | null>(null);
  const onUpdateRef = useRef(onUpdate);
  const relayRef = useRef(relay);
  // Accumulate typed input between Enter keys so we can capture full prompts for memory traces.
  // TerminalView batches input every 16ms, so Enter key event often arrives separately from text.
  const inputAccumulatorRef = useRef<string>("");

  const terminalStorageKey = useMemo(() => {
    return `groovy:claude-code:terminal:${agentId}`;
  }, [agentId]);

  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    relayRef.current = relay;
  }, [relay]);

  // Track online devices via relay events
  useEffect(() => {
    const unsub = relay.subscribe((msg: RelayMessage) => {
      if (msg.type === "device_online") {
        const deviceId = String(msg.device_id || "");
        if (deviceId) {
          setOnlineDeviceIds((prev) => new Set([...prev, deviceId]));
        }
      } else if (msg.type === "device_offline") {
        const deviceId = String(msg.device_id || "");
        if (deviceId) {
          setOnlineDeviceIds((prev) => {
            const next = new Set(prev);
            next.delete(deviceId);
            return next;
          });
        }
      }
    });
    return () => unsub();
  }, [relay]);

  const sendInputStable = useCallback((input: string) => {
    const id = terminalIdRef.current;
    if (!id) return;
    // Send text, then "Enter" as a separate write to better mimic real typing.
    relayRef.current.send({ type: "terminal_input", terminal_id: id, data: input });
    // Small delay helps with readline-ish apps and avoids edge cases with batched writes.
    window.setTimeout(() => {
      relayRef.current.send({ type: "terminal_input", terminal_id: id, data: "\r" });
    }, 10);
  }, []);

  useEffect(() => {
    terminalIdRef.current = terminalId;
    // Report terminalId and sendInput when terminal is available
    if (terminalId && relay.status === "ready") {
      onUpdateRef.current?.({
        terminalId,
        sendInput: sendInputStable,
      });
    }
  }, [terminalId, relay.status, sendInputStable]);

  // Load a previously-open terminal id for this agent (if any), so closing/reopening
  // the card doesn't create a brand-new PTY session.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(terminalStorageKey);
      if (stored) setTerminalId(stored);
    } catch {
      // ignore
    } finally {
      setTerminalIdLoaded(true);
    }
  }, [terminalStorageKey]);

  // Prefer server-stored terminal_id (survives browser refresh and reconnects).
  useEffect(() => {
    const cfgTerminalId = config?.terminal_id;
    if (!cfgTerminalId) return;
    if (terminalIdRef.current === cfgTerminalId) return;
    setTerminalId(cfgTerminalId);
    try {
      window.localStorage.setItem(terminalStorageKey, cfgTerminalId);
    } catch {
      // ignore
    }
  }, [config?.terminal_id, terminalStorageKey]);

  const stripAnsi = useCallback((input: string) => {
    return input
      // Standard CSI sequences: ESC [ ... letter
      .replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "")
      // OSC sequences: ESC ] ... BEL
      .replace(/\u001B\][^\u0007]*\u0007/g, "")
      // OSC sequences: ESC ] ... ESC \
      .replace(/\u001B\][^\u001B]*\u001B\\/g, "")
      // Charset sequences: ESC ( or ESC ) or ESC #
      .replace(/\u001B[()#][0-9A-Za-z]/g, "")
      // DEC private modes and other ESC sequences
      .replace(/\u001B[=>]/g, "")
      // Strip remaining escape + single char
      .replace(/\u001B./g, "")
      // Carriage returns
      .replace(/\r/g, "\n")
      // Multiple newlines to single
      .replace(/\n{3,}/g, "\n\n")
      // Leading/trailing whitespace per line
      .split("\n")
      .map((l) => l.trim())
      .join("\n");
  }, []);

  const updateStatus = useCallback(
    (next: "running" | "ready" | "error") => {
      const prevStatus = statusRef.current;
      if (prevStatus === next) return;
      statusRef.current = next;
      try {
        onUpdateRef.current?.({ status: next });
      } catch {
        // ignore
      }
    },
    []
  );

  const clearIdleReadyTimer = useCallback(() => {
    if (idleReadyTimerRef.current) {
      window.clearTimeout(idleReadyTimerRef.current);
      idleReadyTimerRef.current = null;
    }
  }, []);

  const maybeUpdateStatusFromPrompt = useCallback(
    (rawOutputChunk: string) => {
      const stripped = stripAnsi(rawOutputChunk || "");
      if (!stripped) return;

      outputTailRef.current = (outputTailRef.current + stripped).slice(-400);
      const tail = outputTailRef.current;

      // Only set "ready" when we detect a prompt - don't set "running" on output
      // (running is set on user input/Enter key, not on output)
      const isClaudePrompt = /(^|\n)@(?:zsh|bash|sh|fish)(?:\s*\(\d+-\d+\))?\s*$/.test(tail);
      const isSimplePrompt = /(^|\n)>\s*$/.test(tail);

      if (isClaudePrompt || isSimplePrompt) {
        updateStatus("ready");
      }
      // Don't set "running" here - it causes flickering
    },
    [stripAnsi, updateStatus]
  );

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setPanelError(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("claude_code_agent_configs")
        .select("device_id,workspace_id,terminal_id")
        .eq("agent_id", agentId)
        .single();

      if (error || !data) {
        setConfig(null);
        return;
      }
      setConfig(data as ClaudeCodeConfigRow);
    } catch (e) {
      setPanelError(getErrorMessage(e) || "Failed to load agent config");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    loadConfig().catch(() => {});
  }, [loadConfig]);

  useEffect(() => {
    const run = async () => {
      if (!config) return;
      try {
        const supabase = getSupabaseBrowserClient();
        const [{ data: d }, wRes] = await Promise.all([
          supabase.from("devices").select("id,name").eq("id", config.device_id).single(),
          config.workspace_id
            ? supabase
                .from("device_workspaces")
                .select("id,device_id,label,root_path")
                .eq("id", config.workspace_id)
                .single()
            : Promise.resolve({ data: null }),
        ]);
        setDevice(d ? (d as unknown as DeviceRow) : null);
        setWorkspace(wRes?.data ? (wRes.data as unknown as WorkspaceRow) : null);
      } catch {
        // ignore
      }
    };
    run().catch(() => {});
  }, [config]);

  // Derived: is the configured device currently online?
  const configuredDeviceOnline = config?.device_id
    ? onlineDeviceIds.has(config.device_id)
    : false;

  const openTerminal = useCallback(() => {
    if (!config) return;
    if (relay.status !== "ready") {
      setPanelError(relay.error || "Relay not connected");
      return;
    }
    // Check if the configured device is online BEFORE attempting to open
    if (!onlineDeviceIds.has(config.device_id)) {
      setPanelError(
        "Configured device is not online. The connector may be disconnected or you may need to re-create this agent with the currently connected device."
      );
      setShowTroubleshoot(true);
      updateStatus("error");
      return;
    }
    if (opening) return;
    setOpening(true);
    setPanelError(null);
    updateStatus("running");
    clearIdleReadyTimer();

    const requestId = crypto.randomUUID();
    const nextTerminalId = crypto.randomUUID();
    openReqRef.current = requestId;
    setTerminalId(null);
    outputLinesRef.current = [];
    outputTailRef.current = "";
    outputTailRef.current = "";

    relay.send({
      type: "terminal_open",
      request_id: requestId,
      terminal_id: nextTerminalId,
      device_id: config.device_id,
      ...(config.workspace_id ? { workspace_id: config.workspace_id } : {}),
      start_claude: true,
      persist: true,
    });

    setTimeout(() => {
      if (openReqRef.current !== requestId) return;
      openReqRef.current = null;
      setOpening(false);
      setPanelError("Timed out starting local terminal. Check the connector logs.");
      setShowTroubleshoot(true);
      updateStatus("error");
    }, 15000);
  }, [clearIdleReadyTimer, config, onlineDeviceIds, opening, relay, updateStatus]);

  const resetDevice = useCallback(async () => {
    if (!config?.device_id) return;
    setResetting(true);
    try {
      const res = await fetch(`/api/devices/reset?device_id=${config.device_id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setPanelError(null);
        setShowTroubleshoot(false);
        // Reload to reflect changes
        window.location.reload();
      } else {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const data = await res.json();
          setPanelError(`Reset failed: ${data.error || "Unknown error"}`);
        } else {
          const text = await res.text();
          setPanelError(`Reset failed: ${text || `HTTP ${res.status}`}`);
        }
      }
    } catch (err) {
      setPanelError(`Reset failed: ${getErrorMessage(err)}`);
    } finally {
      setResetting(false);
    }
  }, [config?.device_id]);

  useEffect(() => {
    const unsub = relay.subscribe((msg: RelayMessage) => {
      if (msg.type === "terminal_opened") {
        const req = String(msg.request_id || "");
        const expected = openReqRef.current;
        if (!expected || req !== expected) return;
        const id = String(msg.terminal_id || "");
        if (!id) return;
        openReqRef.current = null;
        connectorTimeoutRetryRef.current = 0;
        setTerminalId(id);
        try {
          window.localStorage.setItem(terminalStorageKey, id);
        } catch {
          // ignore
        }
        // Persist terminalId server-side so we can reattach after refresh/reconnect.
        try {
          const supabase = getSupabaseBrowserClient();
          void supabase
            .from("claude_code_agent_configs")
            .update({ terminal_id: id, updated_at: new Date().toISOString() })
            .eq("agent_id", agentId);
        } catch {
          // ignore
        }
        setOpening(false);
        updateStatus("ready");
        // Report terminalId and sendInput function
        onUpdateRef.current?.({
          terminalId: id,
          sendInput: (input: string) => {
            relay.send({ type: "terminal_input", terminal_id: id, data: input + "\r" });
          },
        });
        return;
      }
      if (msg.type === "terminal_open_failed") {
        const req = String(msg.request_id || "");
        const expected = openReqRef.current;
        if (!expected || req !== expected) return;
        openReqRef.current = null;
        setOpening(false);
        const errorStr = String(msg.error || "unknown error");
        // If the connector was asleep, the relay may have to kill a stuck socket so it can reconnect.
        // Auto-retry once to make sleep/wake recovery seamless.
        if (
          errorStr === "connector_timeout" &&
          connectorTimeoutRetryRef.current < 1 &&
          relay.status === "ready"
        ) {
          connectorTimeoutRetryRef.current++;
          setPanelError("Connector was asleep; reconnecting and retrying…");
          window.setTimeout(() => {
            // Only retry if we're still idle and not in the middle of a new request.
            if (openReqRef.current) return;
            if (relayRef.current.status !== "ready") return;
            setPanelError(null);
            openTerminal();
          }, 1200);
          return;
        }
        setPanelError(`Failed to start local terminal: ${errorStr}`);
        if (errorStr.includes("posix_spawnp") || errorStr.includes("spawn")) {
          setShowTroubleshoot(true);
        }
        updateStatus("error");
        return;
      }
      if (msg.type === "error") {
        const errorStr = String(msg.error || "Relay error");
        setPanelError(errorStr);
        setOpening(false);
        // Show troubleshoot for connection issues
        if (errorStr.includes("device_not_online") || errorStr.includes("not_online")) {
          setShowTroubleshoot(true);
        }
        updateStatus("error");
      }
    });
    return () => unsub();
  }, [openTerminal, relay, terminalStorageKey, updateStatus]);

  useEffect(() => {
    if (
      terminalIdLoaded &&
      !terminalId &&
      !panelError &&
      config &&
      relay.status === "ready" &&
      !opening &&
      configuredDeviceOnline // Only auto-open if configured device is online
    ) {
      openTerminal();
    }
  }, [config, configuredDeviceOnline, opening, openTerminal, panelError, relay.status, terminalId, terminalIdLoaded]);

  const handleTerminalActivity = useCallback(
    (evt: { type: "input" | "output" | "closed"; data?: string }) => {
      if (evt.type === "closed") {
        try {
          window.localStorage.removeItem(terminalStorageKey);
        } catch {
          // ignore
        }
        setTerminalId(null);
        // Best-effort: clear server terminal_id so next open can create a fresh PTY if needed.
        try {
          const supabase = getSupabaseBrowserClient();
          void supabase
            .from("claude_code_agent_configs")
            .update({ terminal_id: null, updated_at: new Date().toISOString() })
            .eq("agent_id", agentId);
        } catch {
          // ignore
        }
        updateStatus("error");
        return;
      }

      if (evt.type === "input") {
        const d = String(evt.data || "");
        const hasEnter = d.includes("\r") || d.includes("\n");

        // Accumulate all input (TerminalView batches text separately from Enter key)
        inputAccumulatorRef.current += d;

        if (hasEnter) {
          updateStatus("running");

          // Best-effort: persist Claude Code "prompt" as a trace for memory search.
          // Extract the line before Enter from the accumulator.
          const accumulated = inputAccumulatorRef.current;
          inputAccumulatorRef.current = ""; // Reset for next prompt

          // Strip ANSI escape codes (cursor movement, colors, etc.) from the accumulated input
          const strippedAccumulated = stripAnsi(accumulated);
          const cleaned = strippedAccumulated.replace(/\r/g, "\n").trim();
          const lastLine = cleaned.split("\n").filter(Boolean).slice(-1)[0] || "";
          if (lastLine.length >= 3) {
            fetch("/api/memory/trace", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                agentId,
                prompt: lastLine,
              }),
            }).catch(() => {});
          }
        }
        return;
      }

      if (evt.type === "output") {
        if (!terminalIdRef.current) return;
        const data = String(evt.data || "");
        maybeUpdateStatusFromPrompt(data);
        clearIdleReadyTimer();
        idleReadyTimerRef.current = window.setTimeout(() => {
          updateStatus("ready");
        }, 1200);

        // Capture meaningful content for the card preview
        const stripped = stripAnsi(data);
        const lines = stripped.split("\n").map((l) => l.trim());
        
        for (const line of lines) {
          // Need substantial text content
          if (!line || line.length < 15) continue;
          
          // Skip lines that are mostly non-alphanumeric (separators, boxes, etc.)
          const alphaCount = (line.match(/[a-zA-Z]/g) || []).length;
          if (alphaCount < 10) continue;
          
          // Skip status bar and UI chrome
          if (/\? for shortcuts/i.test(line)) continue;
          if (/Auto-update failed/i.test(line)) continue;
          if (/esc to interrupt/i.test(line)) continue;
          if (/\bthinking\b/i.test(line)) continue;
          if (/update @anthropic-ai/i.test(line)) continue;
          if (/claude doctor/i.test(line)) continue;
          if (/npm update/i.test(line)) continue;
          if (/^Claude Code v[\d.]+/i.test(line)) continue;
          if (/Sonnet.*Claude Pro/i.test(line)) continue;
          if (/^~\/[a-z]+$/i.test(line)) continue;
          
          // This looks like actual content - capture it
          // Remove leading bullets/markers
          const content = line.replace(/^[●•❯>]\s*/, "").trim();
          if (content.length > 15) {
            outputLinesRef.current = [content.slice(0, 150)]; // Truncate for preview
            try {
              onUpdateRef.current?.({ output: outputLinesRef.current });
            } catch {
              // ignore
            }
          }
        }
      }
    },
    [agentId, clearIdleReadyTimer, maybeUpdateStatusFromPrompt, stripAnsi, terminalStorageKey, updateStatus]
  );

  useEffect(() => {
    return () => {
      clearIdleReadyTimer();
    };
  }, [clearIdleReadyTimer]);

  const headerSubtitle = useMemo(() => {
    const parts: string[] = [];
    if (device?.name) parts.push(device.name);
    if (workspace?.label) parts.push(workspace.label);
    return parts.join(" • ") || "Local terminal";
  }, [device?.name, workspace?.label]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading Claude Code…
      </div>
    );
  }

  if (!config) {
    return (
      <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
        <div className="flex items-center gap-2 text-sm text-zinc-300">
          <PlugZap className="w-4 h-4 text-violet-400" />
          This Claude Code agent isn&apos;t authorized yet.
        </div>
        <div className="mt-1 text-xs text-zinc-500">
          Bind it to a device (and optionally a workspace) in &quot;New Agent&quot;.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            Claude Code
          </h4>
          <div className="text-sm text-white truncate flex items-center gap-2">
            <TerminalIcon className="w-4 h-4 text-cyan-400" />
            <span className="truncate">{headerSubtitle}</span>
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">
            Relay: {relay.status}
            {relay.error ? ` (${relay.error})` : ""}
            {config && relay.status === "ready" && (
              <span className={configuredDeviceOnline ? "text-emerald-400" : "text-amber-400"}>
                {" • "}Device: {configuredDeviceOnline ? "online" : "offline"}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setTerminalId(null);
              setOpening(false);
              setPanelError(null);
              try {
                window.localStorage.removeItem(terminalStorageKey);
              } catch {
                // ignore
              }
              openTerminal();
            }}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors text-xs"
          >
            <RefreshCcw className="w-3.5 h-3.5" />
            Restart
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {terminalId && relay.status === "ready" ? (
          <TerminalView
            terminalId={terminalId}
            send={relay.send}
            subscribe={relay.subscribe}
            onActivity={handleTerminalActivity}
          />
        ) : (
          <div className="h-full rounded-2xl border border-white/10 bg-black/50 flex items-center justify-center text-sm text-zinc-400">
            {opening || (terminalId && relay.status !== "ready") ? (
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {relay.status === "connecting" ? "Connecting to relay…" : "Starting local terminal…"}
              </div>
            ) : relay.status === "ready" && config && !configuredDeviceOnline && !panelError ? (
              <div className="flex flex-col items-center gap-2 px-4 text-center">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Waiting for connector device to come online…</span>
                <span className="text-xs text-zinc-500">Device ID: {config.device_id.slice(0, 8)}…</span>
              </div>
            ) : (
              <div>Terminal not started.</div>
            )}
          </div>
        )}
      </div>

      {panelError && (
        <div className="mt-2 text-xs text-red-400 flex items-center gap-2">
          <span>{panelError}</span>
          {!showTroubleshoot && (
            <button
              onClick={() => setShowTroubleshoot(true)}
              className="text-zinc-400 hover:text-white underline"
            >
              Troubleshoot
            </button>
          )}
        </div>
      )}

      {/* Troubleshooting Modal */}
      {showTroubleshoot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="relative w-full max-w-lg mx-4 bg-zinc-900 border border-white/10 rounded-2xl p-6 shadow-2xl">
            <button
              onClick={() => setShowTroubleshoot(false)}
              className="absolute top-4 right-4 text-zinc-500 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <AlertTriangle className="w-6 h-6 text-amber-400" />
              <h3 className="text-lg font-semibold text-white">Connection Troubleshooting</h3>
            </div>

            <p className="text-sm text-zinc-400 mb-4">
              Your connector may have stopped or the app was moved. Follow these steps to fix:
            </p>

            <div className="space-y-4 text-sm">
              <div className="bg-black/40 rounded-xl p-4 border border-white/5">
                <div className="font-medium text-white mb-2">1. Move app to Applications</div>
                <p className="text-zinc-400 text-xs mb-2">
                  If you ran the app from Downloads, move it to /Applications first.
                </p>
                <code className="block bg-black/60 text-green-400 text-xs p-2 rounded font-mono overflow-x-auto">
                  mv ~/Downloads/&quot;Groovy Connector.app&quot; /Applications/
                </code>
              </div>

              <div className="bg-black/40 rounded-xl p-4 border border-white/5">
                <div className="font-medium text-white mb-2">2. Clear local state</div>
                <p className="text-zinc-400 text-xs mb-2">
                  Run these commands in Terminal to reset the connector:
                </p>
                <code className="block bg-black/60 text-green-400 text-xs p-2 rounded font-mono overflow-x-auto whitespace-pre-wrap">
{`rm -rf ~/.groovy ~/.flow
launchctl unload ~/Library/LaunchAgents/ai.gogroovy.connector.plist 2>/dev/null
rm ~/Library/LaunchAgents/ai.gogroovy.connector.plist 2>/dev/null
security delete-generic-password -s "groovy-connector" 2>/dev/null`}
                </code>
              </div>

              <div className="bg-black/40 rounded-xl p-4 border border-white/5">
                <div className="font-medium text-white mb-2">3. Download latest connector</div>
                <p className="text-zinc-400 text-xs mb-3">
                  If you installed before Jan 2026, please reinstall the latest DMG.
                </p>
                <a
                  href="https://github.com/Charlesmendez/groovy-releases/releases/latest/download/Groovy-Connector-macOS.dmg"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download latest connector
                </a>
              </div>

              <div className="bg-black/40 rounded-xl p-4 border border-white/5">
                <div className="font-medium text-white mb-2">4. Reset device in database</div>
                <p className="text-zinc-400 text-xs mb-2">
                  Click below to remove this device from our database so you can re-pair.
                </p>
                <button
                  onClick={resetDevice}
                  disabled={resetting}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-red-600/20 border border-red-500/30 text-red-400 rounded-lg hover:bg-red-600/30 disabled:opacity-50 transition-colors"
                >
                  {resetting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  {resetting ? "Resetting..." : "Reset Device"}
                </button>
              </div>

              <div className="bg-black/40 rounded-xl p-4 border border-white/5">
                <div className="font-medium text-white mb-2">5. Re-pair the connector</div>
                <p className="text-zinc-400 text-xs">
                  Open the Groovy Connector app from /Applications, enter a new pairing code, 
                  then set up a new Claude Code agent.
                </p>
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setShowTroubleshoot(false)}
                className="px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
