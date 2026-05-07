"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  Settings,
  Download,
  Wifi,
  WifiOff,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useOrchestrator } from "@/hooks/useOrchestrator";
import { useRelay } from "@/hooks/useRelay";
// #disabled - voice hook removed because of major implementation change (realtime voice)
// import { useVoiceControl, type VoiceCommand } from "@/hooks/useVoiceControl";
import { UnifiedInput } from "@/components/command-center/UnifiedInput";
import { AgentTile, type AgentStatus, type AgentActivity } from "@/components/command-center/AgentTile";
import { ActivityFeed, type FeedItem } from "@/components/command-center/ActivityFeed";
import { SettingsModal } from "@/components/command-center/SettingsModal";
import { DiffViewer, looksLikeDiff } from "@/components/code/DiffViewer";
import type { AgentType } from "@/lib/orchestrator/router";
import { useConnectorInstallGuide } from "@/lib/connector/installGuide";

type Provider = "anthropic" | "openai" | "google" | "xai" | "claude_cli";
type KeyModes = Partial<Record<Provider, "groovy" | "user">>;

const PANEL_AGENT_SET = new Set<AgentType>([
  "browser",
  "files",
  "pages",
  "obsidian",
  "data",
  "chat",
  "schedule",
  "code",
]);

function isPanelAgent(agent: string): agent is AgentType {
  return PANEL_AGENT_SET.has(agent as AgentType);
}

export default function CommandCenterDashboard() {
  const connectorGuide = useConnectorInstallGuide();
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();

  // Auth state
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  // UI state
  const [showSettings, setShowSettings] = useState(false);
  const [expandedAgent, setExpandedAgent] = useState<AgentType | null>(null);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [apiKeys, setApiKeys] = useState<
    Partial<Record<Provider, { configured: boolean; lastUpdated?: string }>>
  >({});
  const [llmKeyMode, setLlmKeyMode] = useState<"groovy" | "user">("groovy");
  const [llmKeyModes, setLlmKeyModes] = useState<KeyModes>({});

  // Orchestrator hook
  // IMPORTANT: wire ui-open-code so "@code <session>" can switch to the coding agent UI.
  // dashboard-v2 doesn't render the Claude Code UI yet, so we redirect to /dashboard#code,
  // which already supports Claude Code sessions.
  const orchestrator = useOrchestrator({
    onOpenCodeSession: (agentId: string) => {
      try {
        window.localStorage.setItem("groovy:code:lastAgentId", agentId);
      } catch {
        // ignore
      }
      router.push("/dashboard#code");
    },
  });

  // Activity feed derived from orchestrator activities
  const activityFeed = useMemo((): FeedItem[] => {
    const items: FeedItem[] = [];
    for (const activity of orchestrator.agentActivities) {
      items.push({
        id: activity.id,
        agent: activity.agent,
        action: activity.action,
        detail: activity.detail,
        timestamp: activity.timestamp,
        status: activity.status === "error" ? "error" as const 
          : activity.status === "complete" ? "complete" as const 
          : "running" as const,
        metadata: activity.metadata,
        summary: activity.summary,
      });
    }
    return items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }, [orchestrator.agentActivities]);

  // Derive agent activities and statuses from orchestrator (no setState in effect)
  const derivedAgentActivities = useMemo(() => {
    const activities = orchestrator.agentActivities;
    const grouped: Record<AgentType, AgentActivity[]> = {
      browser: [],
      files: [],
      pages: [],
      obsidian: [],
      data: [],
      chat: [],
      schedule: [],
      code: [],
    };
    
    for (const activity of activities) {
      const agent = activity.agent;
      if (isPanelAgent(agent) && grouped[agent]) {
        // Convert hook's AgentActivity to component's AgentActivity
        grouped[agent].push({
          id: activity.id,
          action: activity.action,
          status: activity.status,
          result: typeof activity.result === "string" ? activity.result : undefined,
          timestamp: activity.timestamp,
        });
      }
    }
    
    return grouped;
  }, [orchestrator.agentActivities]);

  const derivedAgentStatuses = useMemo(() => {
    const activities = orchestrator.agentActivities;
    const statuses: Record<AgentType, AgentStatus> = {
      browser: "idle",
      files: "idle",
      pages: "idle",
      obsidian: "idle",
      data: "idle",
      chat: "idle",
      schedule: "idle",
      code: "idle",
    };
    
    for (const activity of activities) {
      const agent = activity.agent;
      if (isPanelAgent(agent) && activity.status === "running" && statuses[agent]) {
        statuses[agent] = "running";
      }
    }
    
    return statuses;
  }, [orchestrator.agentActivities]);

  // Relay connection for connector
  const relay = useRelay();
  const isConnected = relay.status === "ready";
  const [localConnectorOnline, setLocalConnectorOnline] = useState(false);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [connectorVersion, setConnectorVersion] = useState<string | null>(null);
  const [claudeCliInstalled, setClaudeCliInstalled] = useState<boolean | null>(null);
  const [prefersHostedConnector, setPrefersHostedConnector] = useState(false);
  const [hostedPreferredDeviceId, setHostedPreferredDeviceId] = useState<string | null>(null);
  const onlineDevicesRef = useRef<Map<string, { deviceId: string; version?: string; claudeCliInstalled?: boolean }>>(
    new Map()
  );

  // Soft-warn minimum connector version (don't block tools, just nag)
  const MIN_CONNECTOR_VERSION = "0.22.83";
  const isVersionOutdated = useCallback((version: string | null, minVersion: string) => {
    if (!version) return true;
    const v = version.split(".").map(Number);
    const min = minVersion.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((v[i] || 0) < (min[i] || 0)) return true;
      if ((v[i] || 0) > (min[i] || 0)) return false;
    }
    return false;
  }, []);
  const connectorOutdated = localConnectorOnline && isVersionOutdated(connectorVersion, MIN_CONNECTOR_VERSION);
  const refreshConnectorStatus = useCallback(() => {
    relay.reconnect?.();
  }, [relay]);
  const restartConnector = useCallback(() => {
    if (!activeDeviceId) return;
    try {
      relay.send({ type: "connector_restart", device_id: activeDeviceId });
    } catch {
      // ignore
    }
  }, [relay, activeDeviceId]);

  const updateConnector = useCallback(() => {
    if (!activeDeviceId) return;
    try {
      relay.send({ type: "connector_update", device_id: activeDeviceId });
    } catch {
      // ignore
    }
  }, [relay, activeDeviceId]);

  const handleConnectorModeChanged = useCallback(async (next: "local" | "groovy") => {
    if (next === "groovy") {
      setPrefersHostedConnector(true);
      try {
        const hmRes = await fetch("/api/hosted-macs/request", { cache: "no-store" });
        const hmJson = await hmRes.json().catch(() => ({}));
        if (hmRes.ok && hmJson?.device?.device_id) {
          setHostedPreferredDeviceId(String(hmJson.device.device_id));
        } else {
          setHostedPreferredDeviceId(null);
        }
      } catch {
        setHostedPreferredDeviceId(null);
      }
      return;
    }
    setPrefersHostedConnector(false);
    setHostedPreferredDeviceId(null);
  }, []);

  const handleConnectorStatusClick = useCallback(() => {
    // Always try to refresh the browser<->relay connection first.
    refreshConnectorStatus();
    // Then open settings so the user can Restart (if online) or Download (if offline).
    setShowSettings(true);
  }, [refreshConnectorStatus]);

  // Track local connector status + active device ID from relay events
  useEffect(() => {
    const unsub = relay.subscribe((msg) => {
      const msgType = (msg as { type?: string }).type;
      if (msgType === "device_online") {
        const deviceId = String((msg as { device_id?: string }).device_id || "");
        const version = String((msg as { version?: string }).version || "0.0.0");
        const capabilities = (msg as { capabilities?: { claudeCliInstalled?: boolean } }).capabilities;
        if (deviceId) {
          onlineDevicesRef.current.set(deviceId, { deviceId, version, claudeCliInstalled: capabilities?.claudeCliInstalled });
        }
        const desired: string | null =
          prefersHostedConnector &&
          hostedPreferredDeviceId &&
          onlineDevicesRef.current.has(hostedPreferredDeviceId)
            ? hostedPreferredDeviceId
            : activeDeviceId && onlineDevicesRef.current.has(activeDeviceId)
              ? activeDeviceId
              : (Array.from(onlineDevicesRef.current.keys())[0] ?? null);
        setActiveDeviceId(desired);
        setLocalConnectorOnline(!!desired);
        const desiredDevice = desired ? onlineDevicesRef.current.get(desired) : null;
        setConnectorVersion(desiredDevice?.version || null);
        setClaudeCliInstalled(desiredDevice?.claudeCliInstalled ?? null);
      } else if (msgType === "device_offline") {
        const deviceId = String((msg as { device_id?: string }).device_id || "");
        if (deviceId) onlineDevicesRef.current.delete(deviceId);
        const desired: string | null =
          prefersHostedConnector &&
          hostedPreferredDeviceId &&
          onlineDevicesRef.current.has(hostedPreferredDeviceId)
            ? hostedPreferredDeviceId
            : activeDeviceId && onlineDevicesRef.current.has(activeDeviceId)
              ? activeDeviceId
              : (Array.from(onlineDevicesRef.current.keys())[0] ?? null);
        setActiveDeviceId(desired);
        setLocalConnectorOnline(!!desired);
        const desiredDevice = desired ? onlineDevicesRef.current.get(desired) : null;
        setConnectorVersion(desiredDevice?.version || null);
        setClaudeCliInstalled(desiredDevice?.claudeCliInstalled ?? null);
      }
    });
    return unsub;
  }, [relay, activeDeviceId, prefersHostedConnector, hostedPreferredDeviceId]);

  // Prefer Groovy Mac connector if user selected it in onboarding preferences.
  useEffect(() => {
    (async () => {
      try {
        const prefsRes = await fetch("/api/user-preferences", { cache: "no-store" });
        const prefsJson = await prefsRes.json().catch(() => ({}));
        const connectorMode = prefsJson?.onboardingData?.connectorMode;
        if (connectorMode === "groovy") {
          setPrefersHostedConnector(true);
          const hmRes = await fetch("/api/hosted-macs/request", { cache: "no-store" });
          const hmJson = await hmRes.json().catch(() => ({}));
          if (hmRes.ok && hmJson?.device?.device_id) {
            setHostedPreferredDeviceId(String(hmJson.device.device_id));
          }
        } else {
          setPrefersHostedConnector(false);
          setHostedPreferredDeviceId(null);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  // #disabled - Voice control removed because of major implementation change (realtime voice)
  // const handleVoiceCommand = useCallback((command: VoiceCommand) => {
  //   console.log("[voice] Command:", command);
  //   // Handle voice commands - for now just type the text
  //   if (command.type === "type_text" && command.text) {
  //     // The orchestrator.sendMessage will be called by UnifiedInput
  //   }
  // }, []);

  // const voice = useVoiceControl({
  //   onCommand: handleVoiceCommand,
  //   onTranscript: (text, isFinal) => {
  //     if (isFinal && text.trim()) {
  //       orchestrator.sendMessage(text, {
  //         memoryEnabled,
  //         deviceId: localConnectorOnline ? activeDeviceId || undefined : undefined,
  //       });
  //     }
  //   },
  // });

  // Load user and check auth
  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();

      if (error || !user) {
        router.push("/login");
        return;
      }

      setUser({ id: user.id, email: user.email || undefined });

      // Load API key status
      const { data: keys } = await supabase
        .from("user_api_keys")
        .select("provider, created_at")
        .eq("user_id", user.id);

      if (keys) {
        const keyStatus: typeof apiKeys = {};
        for (const key of keys) {
          keyStatus[key.provider as Provider] = {
            configured: true,
            lastUpdated: key.created_at,
          };
        }
        setApiKeys(keyStatus);
      }

      // Load LLM key mode (groovy vs user) + per-provider modes
      try {
        const res = await fetch("/api/user-api-keys");
        const json = await res.json().catch(() => ({}));
        const mode = json?.mode;
        if (mode === "groovy" || mode === "user") setLlmKeyMode(mode);
        if (json?.keyModes && typeof json.keyModes === "object") {
          setLlmKeyModes(json.keyModes);
        }
      } catch {
        // ignore
      }

      setLoading(false);
    };

    checkAuth();
  }, [supabase, router]);

  // Handle sign out
  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  // Handle sending a message
  const handleSend = useCallback(
    (message: string) => {
      orchestrator.sendMessage(message, {
        memoryEnabled,
        deviceId: localConnectorOnline ? activeDeviceId || undefined : undefined,
      });
    },
    [orchestrator, memoryEnabled, localConnectorOnline, activeDeviceId]
  );

  // Handle saving API keys + per-provider modes
  const handleSaveKeys = async (
    keys: Partial<Record<Provider, string>>,
    mode: "groovy" | "user",
    keyModes?: KeyModes
  ) => {
    const response = await fetch("/api/user-api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keys: Object.keys(keys).length ? keys : undefined,
        mode,
        keyModes,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Failed to save keys");
    }

    // Update local state
    const newKeyStatus = { ...apiKeys };
    if (Object.keys(keys).length > 0) {
      for (const provider of Object.keys(keys) as Provider[]) {
        newKeyStatus[provider] = {
          configured: true,
          lastUpdated: new Date().toISOString(),
        };
      }
    }
    setApiKeys(newKeyStatus);
    setLlmKeyMode(mode);
    if (keyModes) setLlmKeyModes(keyModes);
  };

  // Handle activity feed item click
  const handleFeedItemClick = useCallback((item: FeedItem) => {
    if (!isPanelAgent(item.agent)) return;
    setExpandedAgent(item.agent);
  }, []);

  // Toggle agent expansion
  const toggleAgentExpand = useCallback((agent: AgentType) => {
    setExpandedAgent((prev) => (prev === agent ? null : agent));
  }, []);

  // Show settings only if a user-key is required but missing
  useEffect(() => {
    if (loading) return;
    const providers: Provider[] = ["anthropic", "openai", "google", "xai", "claude_cli"];
    const hasPerProvider = Object.keys(llmKeyModes).length > 0;
    const needsUserKey = (p: Provider) => (hasPerProvider ? llmKeyModes[p] : llmKeyMode) === "user";
    const anyMissing = providers.some((p) => needsUserKey(p) && !apiKeys[p]?.configured);
    if (anyMissing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowSettings(true);
    }
  }, [loading, apiKeys, llmKeyMode, llmKeyModes]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-zinc-500">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] flex flex-col">
      {/* Noise overlay */}
      <div className="noise-overlay" />

      {/* Background effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-cyan-500/5 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-violet-500/5 rounded-full blur-[150px]" />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-white/5 bg-[var(--bg-primary)]/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Image
              src="/Groovy_no_bg.png"
              alt="Groovy"
              width={280}
              height={80}
              className="h-20 w-auto"
              unoptimized
              priority
            />

            {/* Connector status */}
            <button
              type="button"
              onClick={handleConnectorStatusClick}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-all hover:opacity-90 ${
                localConnectorOnline
                  ? "bg-emerald-500/10 text-emerald-400"
                  : isConnected
                    ? "bg-zinc-800 text-zinc-300"
                    : "bg-zinc-800 text-zinc-500"
              }`}
              title={
                localConnectorOnline
                  ? "Local connector is online (click to open connector controls)"
                  : isConnected
                    ? "Relay is connected but no local connector device is online (click for help)"
                    : "Relay is disconnected (click to reconnect)"
              }
            >
              {localConnectorOnline ? (
                <Wifi className="w-3 h-3" />
              ) : (
                <WifiOff className="w-3 h-3" />
              )}
              <span>
                {localConnectorOnline ? "Connector Online" : isConnected ? "Connector Offline" : "Relay Offline"}
              </span>
              {localConnectorOnline && connectorVersion && (
                <span className="ml-1 text-[10px] text-emerald-300/80">v{connectorVersion}</span>
              )}
            </button>
            {connectorOutdated && (
              <a
                href={connectorGuide.downloadUrl}
                className="ml-2 inline-flex items-center px-2 py-1 rounded-full text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/15 transition-all"
                title={`Update available: v${MIN_CONNECTOR_VERSION}`}
              >
                Update v{MIN_CONNECTOR_VERSION}
              </a>
            )}
            {localConnectorOnline && claudeCliInstalled === true && (
              <span
                className="ml-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                title="Claude CLI is installed on the connector machine"
              >
                <Wifi className="w-2.5 h-2.5" />
                Claude CLI
              </span>
            )}
            {localConnectorOnline && claudeCliInstalled === false && (
              <a
                href="https://code.claude.com/docs/en/overview"
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] bg-red-500/10 text-red-300 border border-red-500/20 hover:bg-red-500/15 transition-all"
                title="Claude CLI is required for Code Agent and Browser Agent — click to learn how to install"
              >
                <AlertTriangle className="w-3 h-3" />
                Claude CLI missing
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Download connector */}
            {!localConnectorOnline && !prefersHostedConnector && (
              <a
                href={connectorGuide.downloadUrl}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 text-zinc-400 hover:text-white hover:bg-white/10 text-sm transition-all"
                title={`Download ${connectorGuide.downloadFileLabel}`}
              >
                <Download className="w-4 h-4" />
                <span>Download Connector</span>
              </a>
            )}

            {/* Settings */}
            <button
              onClick={() => setShowSettings(true)}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="relative z-10 flex-1 max-w-7xl mx-auto w-full px-6 py-6 flex flex-col gap-6">
        {/* Agent tiles grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {(["browser", "files", "pages", "obsidian", "data", "code", "chat", "schedule"] as AgentType[]).map(
            (agent) => (
              <AgentTile
                key={agent}
                agent={agent}
                status={derivedAgentStatuses[agent]}
                activities={derivedAgentActivities[agent]}
                isExpanded={expandedAgent === agent}
                onToggleExpand={() => toggleAgentExpand(agent)}
                onOpenSettings={() => setShowSettings(true)}
              />
            )
          )}
        </div>

        {/* Conversation + Activity area */}
        <div className="flex-1 grid lg:grid-cols-3 gap-4 min-h-0">
          {/* Conversation view */}
          <div className="lg:col-span-2 bg-zinc-900/40 border border-white/5 rounded-2xl flex flex-col overflow-hidden">
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {orchestrator.messages.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center max-w-md">
                    <div className="text-4xl mb-4">👋</div>
                    <h2 className="text-xl font-semibold text-white mb-2">
                      Welcome to Groovy
                    </h2>
                    <p className="text-sm text-zinc-500 mb-4">
                      I can help you browse the web, manage files, search your
                      Obsidian notes, and analyze your marketing data.
                    </p>
                    <p className="text-xs text-zinc-600">
                      Try: &quot;Search my notes for meeting ideas&quot; or &quot;@browser go to google.com&quot;
                    </p>
                  </div>
                </div>
              ) : (
                orchestrator.messages.map((msg) => {
                  const generatedFiles =
                    msg.role === "assistant" &&
                    msg.metadata &&
                    Array.isArray((msg.metadata as { generated_files?: unknown }).generated_files)
                      ? (
                          msg.metadata as {
                            generated_files: Array<{
                              name: string;
                              filename?: string;
                              url?: string;
                              mediaType?: string;
                              mime_type?: string;
                              storage_path?: string;
                              file_id?: string;
                            }>;
                          }
                        ).generated_files
                      : [];
                  return (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex flex-col ${
                      msg.role === "user" ? "items-end" : "items-start"
                    }`}
                  >
                    <div
                      className={`max-w-[95%] sm:max-w-[80%] rounded-2xl px-4 py-3 ${
                        msg.role === "user"
                          ? "bg-cyan-500/10 border border-cyan-500/20 text-white"
                          : "bg-white/5 border border-white/10 text-zinc-300"
                      }`}
                    >
                      {/* Render diffs with syntax highlighting */}
                      {(() => {
                        // Strip tool-stream artifacts like "[Saving foo.png...]" from displayed text
                        const displayContent = msg.role === "assistant"
                          ? msg.content.replace(/\[Saving [^\]]+\.\.\.\]\s*/gi, "").trim()
                          : msg.content;
                        if (msg.role === "assistant" && looksLikeDiff(displayContent)) {
                          return (
                            <div className="space-y-3">
                              {displayContent.split(/(```diff[\s\S]*?```|@@[\s\S]*?(?=\n\n|$))/g).map((part, idx) => {
                                if (part.startsWith("```diff") || (part.includes("@@") && (part.includes("---") || part.includes("+++") || part.match(/^[+-]/m)))) {
                                  const diffContent = part.replace(/^```diff\n?/, "").replace(/\n?```$/, "");
                                  return <DiffViewer key={idx} content={diffContent} maxHeight="300px" />;
                                }
                                return part.trim() ? (
                                  <p key={idx} className="text-sm whitespace-pre-wrap">{part}</p>
                                ) : null;
                              })}
                            </div>
                          );
                        }
                        return <p className="text-sm whitespace-pre-wrap">{displayContent}</p>;
                      })()}
                      {/* Heartbeat reauth buttons */}
                      {msg.role === "assistant" && msg.metadata &&
                        (() => {
                          const meta = msg.metadata as Record<string, unknown>;
                          if (meta.kind !== "heartbeat_reauth") return null;
                          const reauth = meta.reauth as Array<{ provider: string; label: string; url: string }> | undefined;
                          if (!reauth || reauth.length === 0) return null;
                          return (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {reauth.map((r) => (
                                <a
                                  key={r.provider}
                                  href={r.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/30 text-xs text-white hover:bg-amber-500/30 transition-colors"
                                >
                                  Reconnect {r.label}
                                </a>
                              ))}
                            </div>
                          );
                        })()}
                      <p className="text-[10px] text-zinc-600 mt-1">
                        {msg.timestamp.toLocaleTimeString()}
                      </p>
                    </div>
                    {msg.role === "assistant" && generatedFiles.length > 0 && (
                      <div className="mt-2 w-full">
                        <div className="text-[10px] text-emerald-400 mb-1">
                          {generatedFiles.length} file(s) attached
                        </div>
                        <div className="space-y-2">
                            {generatedFiles.map((f, idx) => {
                              const extractChatUploadsStoragePathFromUrl = (rawUrl: string): string | null => {
                                try {
                                  const u = new URL(rawUrl);
                                  const m = u.pathname.match(
                                    /\/storage\/v1\/object\/(?:sign|public|authenticated)\/chat_uploads\/(.+)$/
                                  );
                                  if (!m?.[1]) return null;
                                  try {
                                    return decodeURIComponent(m[1]);
                                  } catch {
                                    return m[1];
                                  }
                                } catch {
                                  return null;
                                }
                              };

                              const fileName = f.filename || f.name || "file";
                              const mimeType = f.mime_type || f.mediaType || "application/octet-stream";
                              const isImage = typeof mimeType === "string" && mimeType.startsWith("image/");

                              // Prefer stable same-origin proxy URLs over expiring Supabase signed URLs.
                              const proxyFromStoragePath = (storagePath: string) =>
                                `/api/datagran/files?storagePath=${encodeURIComponent(storagePath)}&agentId=generated`;
                              const proxyFromFileId = (fileId: string) =>
                                `/api/datagran/files?fileId=${encodeURIComponent(fileId)}&agentId=generated`;

                              const extractedStoragePath =
                                !f.storage_path && typeof f.url === "string" && f.url
                                  ? extractChatUploadsStoragePathFromUrl(f.url)
                                  : null;

                              const fileUrl =
                                (typeof f.storage_path === "string" && f.storage_path
                                  ? proxyFromStoragePath(f.storage_path)
                                  : null) ||
                                (typeof f.file_id === "string" && f.file_id
                                  ? proxyFromFileId(f.file_id)
                                  : null) ||
                                (extractedStoragePath ? proxyFromStoragePath(extractedStoragePath) : null) ||
                                (typeof f.url === "string" && f.url ? f.url : null);
                              return (
                                <div
                                  key={`${msg.id}-genfile-${idx}`}
                                  className="rounded-xl border border-white/10 bg-black/20 overflow-hidden"
                                >
                                  {isImage && fileUrl ? (
                                    <Image
                                      src={fileUrl}
                                      alt={fileName}
                                      width={1200}
                                      height={800}
                                      sizes="100vw"
                                      unoptimized
                                      className="w-full max-h-[420px] object-contain bg-black/30"
                                    />
                                  ) : null}
                                  <a
                                    href={fileUrl || "#"}
                                    target={fileUrl ? "_blank" : undefined}
                                    rel={fileUrl ? "noreferrer" : undefined}
                                    className={`flex items-center justify-between gap-3 px-3 py-2 border-t border-white/10 ${
                                      fileUrl
                                        ? "hover:bg-white/5"
                                        : "opacity-60 cursor-not-allowed"
                                    }`}
                                    onClick={(e) => {
                                      if (!fileUrl) e.preventDefault();
                                    }}
                                  >
                                    <div className="min-w-0">
                                      <div className="text-xs text-white truncate">
                                        {fileName}
                                      </div>
                                      <div className="text-[10px] text-zinc-500 truncate">
                                        {mimeType || "file"}
                                      </div>
                                    </div>
                                    <Download className="w-4 h-4 text-zinc-400 shrink-0" />
                                  </a>
                                </div>
                              );
                            })}
                          </div>
                      </div>
                    )}
                  </motion.div>
                );
              })
              )}

              {/* Streaming content */}
              {orchestrator.isStreaming && orchestrator.streamingContent && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex justify-start"
                >
                  <div className="max-w-[95%] sm:max-w-[80%] rounded-2xl px-4 py-3 bg-white/5 border border-white/10">
                    <p className="text-sm text-zinc-300 whitespace-pre-wrap">
                      {orchestrator.streamingContent
                        .replace(/\[Saving [^\]]+\.\.\.\]\s*/gi, "")
                        .trim()}
                      <span className="inline-block w-2 h-4 bg-cyan-400 ml-1 animate-pulse" />
                    </p>
                  </div>
                </motion.div>
              )}
            </div>
          </div>

          {/* Activity feed */}
          <div className="bg-zinc-900/40 border border-white/5 rounded-2xl flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-white/5">
              <h3 className="text-sm font-semibold text-white">Activity</h3>
            </div>
            <div className="flex-1 min-h-0">
              <ActivityFeed
                items={activityFeed}
                onItemClick={handleFeedItemClick}
              />
            </div>
          </div>
        </div>
      </main>

      {/* Unified input (fixed at bottom) */}
      <div className="relative z-10 border-t border-white/5 bg-[var(--bg-primary)]/80 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <UnifiedInput
            onSend={handleSend}
            isStreaming={orchestrator.isStreaming}
            onCancel={orchestrator.cancelStream}
            memoryEnabled={memoryEnabled}
            onMemoryToggle={() => setMemoryEnabled((prev) => !prev)}
            // #disabled - voice props removed because of major implementation change (realtime voice)
          />
        </div>
      </div>

      {/* Settings modal */}
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        onSave={handleSaveKeys}
        currentKeys={apiKeys}
        currentKeyMode={llmKeyMode}
        currentKeyModes={llmKeyModes}
        currentUserEmail={user?.email || null}
        onSignOut={handleSignOut}
        onConnectorModeChanged={handleConnectorModeChanged}
        activeDeviceId={activeDeviceId}
        connectorOnline={localConnectorOnline}
        connectorVersion={connectorVersion}
        minConnectorVersion={MIN_CONNECTOR_VERSION}
        connectorDownloadUrl={connectorGuide.downloadUrl}
        onRefreshConnector={refreshConnectorStatus}
        onRestartConnector={restartConnector}
        onUpdateConnector={updateConnector}
      />
    </div>
  );
}
