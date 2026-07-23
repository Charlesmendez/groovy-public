"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  Code2,
  Database,
  ExternalLink,
  Loader2,
  Plug,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  DataIntegrationsPanel,
  getDatagranProvider,
  type DataConnection,
  type PlatformType,
  type WebPixel,
} from "@/components/command-center/DataIntegrationsPanel";
import IntegrationsPanel from "@/components/command-center/IntegrationsPanel";

type CatalogIntegration = {
  id: string;
  name: string;
  provider: string;
  connected: boolean;
};

type WorkerTarget = { id: string; name: string };

type Assignments = {
  version: 1;
  orchestrator: string[];
  workers: Record<string, string[]>;
};

type Props = {
  currentSessionId?: string | null;
  currentOrchestratorAgentId?: string | null;
};

function prettyProvider(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function IntegrationSettingsSection({
  currentSessionId,
  currentOrchestratorAgentId,
}: Props) {
  const [activeTab, setActiveTab] = useState<"data" | "custom">("data");
  const [showDataPanel, setShowDataPanel] = useState(false);
  const [showCustomPanel, setShowCustomPanel] = useState(false);
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const [pixels, setPixels] = useState<WebPixel[]>([]);
  const [integrations, setIntegrations] = useState<CatalogIntegration[]>([]);
  const [workers, setWorkers] = useState<WorkerTarget[]>([]);
  const [assignments, setAssignments] = useState<Assignments>({
    version: 1,
    orchestrator: [],
    workers: {},
  });
  const [resolvedOrchestratorAgentId, setResolvedOrchestratorAgentId] = useState(
    currentOrchestratorAgentId || ""
  );
  const [loading, setLoading] = useState(true);
  const [canManage, setCanManage] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAssignment, setBusyAssignment] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [datagranScriptLoaded, setDatagranScriptLoaded] = useState(false);

  useEffect(() => {
    if (currentOrchestratorAgentId) {
      setResolvedOrchestratorAgentId(currentOrchestratorAgentId);
      return;
    }
    if (!currentSessionId) return;
    void (async () => {
      try {
        const res = await fetch("/api/orchestrator/agents", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        const sessions = Array.isArray(json?.sessions) ? json.sessions : [];
        const match = sessions.find(
          (session: { id?: unknown }) => String(session.id || "") === currentSessionId
        );
        if (match?.agentId) setResolvedOrchestratorAgentId(String(match.agentId));
      } catch {
        // Creation remains disabled until the runtime agent is available.
      }
    })();
  }, [currentOrchestratorAgentId, currentSessionId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.DatagranLink) {
      setDatagranScriptLoaded(true);
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.datagran.io/embed/link.js"]'
    );
    const script = existing || document.createElement("script");
    const onLoad = () => setDatagranScriptLoaded(true);
    script.addEventListener("load", onLoad);
    if (!existing) {
      script.src = "https://www.datagran.io/embed/link.js";
      script.async = true;
      document.head.appendChild(script);
    }
    return () => script.removeEventListener("load", onLoad);
  }, []);

  const loadConnections = useCallback(async () => {
    const res = await fetch("/api/datagran/connection", { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || "Failed to load data integrations");
    const next = (Array.isArray(json?.connections) ? json.connections : []).reduce(
      (acc: DataConnection[], config: Record<string, unknown>) => {
        const platform = typeof config.provider === "string" ? config.provider : "";
        const id = typeof config.agentId === "string" ? config.agentId : "";
        if (!platform || !id) return acc;
        acc.push({
          id,
          platform: platform as PlatformType,
          name:
            typeof config.name === "string" && config.name.trim()
              ? config.name.trim()
              : prettyProvider(platform),
          connectionId:
            typeof config.connectionId === "string" ? config.connectionId : undefined,
          status:
            config.status === "expired" || config.status === "error"
              ? config.status
              : "connected",
          statusMessage:
            typeof config.statusMessage === "string" ? config.statusMessage : undefined,
          lastSync:
            typeof config.createdAt === "string" ? new Date(config.createdAt) : undefined,
        });
        return acc;
      },
      []
    );
    setConnections(next);
  }, []);

  const loadPixels = useCallback(async () => {
    const res = await fetch("/api/datagran/pixel-sites", { cache: "no-store" });
    if (!res.ok) return;
    const json = await res.json().catch(() => ({}));
    setPixels(
      (Array.isArray(json?.sites) ? json.sites : []).map(
        (site: { id?: unknown; name?: unknown; domain?: unknown; events_7d?: unknown }) => ({
          id: String(site.id || ""),
          siteId: String(site.id || ""),
          siteName: String(site.name || "Web pixel"),
          domain: String(site.domain || ""),
          status: "active" as const,
          eventsLast7Days: Number(site.events_7d) || undefined,
        })
      )
    );
  }, []);

  const loadAssignments = useCallback(async () => {
    const res = await fetch("/api/integrations/assignments", { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || "Failed to load integration assignments");
    setIntegrations(Array.isArray(json.integrations) ? json.integrations : []);
    setWorkers(Array.isArray(json.workers) ? json.workers : []);
    setCanManage(json.canManage === true);
    if (json.assignments) setAssignments(json.assignments as Assignments);
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await Promise.all([loadConnections(), loadPixels(), loadAssignments()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load integrations");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadAssignments, loadConnections, loadPixels]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const connect = useCallback(
    async (platform: PlatformType) => {
      if (!datagranScriptLoaded || !window.DatagranLink) {
        throw new Error("The secure connection window is still loading. Try again in a moment.");
      }
      const provider = getDatagranProvider(platform);
      const tokenRes = await fetch("/api/datagran/link-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const tokenJson = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok) throw new Error(tokenJson?.error || "Failed to start connection");
      const linkToken = String(tokenJson.linkToken || tokenJson.link_token || "");
      if (!linkToken) throw new Error("The integration service did not return a connection token");
      await new Promise<void>((resolve, reject) => {
        window.DatagranLink!.open({
          linkToken,
          onSuccess: async (payload) => {
            try {
              const createRes = await fetch("/api/agents", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: "datagran",
                  name: prettyProvider(provider),
                  datagranProvider: provider,
                  connectionId: String(payload.connection_id || ""),
                }),
              });
              const createJson = await createRes.json().catch(() => ({}));
              if (!createRes.ok) throw new Error(createJson?.error || "Failed to save connection");
              await refreshAll();
              resolve();
            } catch (cause) {
              reject(cause);
            }
          },
          onExit: () => resolve(),
        });
      });
    },
    [datagranScriptLoaded, refreshAll]
  );

  const reconnect = useCallback(
    async (agentId: string) => {
      if (!datagranScriptLoaded || !window.DatagranLink) {
        throw new Error("The secure connection window is still loading. Try again in a moment.");
      }
      const tokenRes = await fetch("/api/datagran/link-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      const tokenJson = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok) throw new Error(tokenJson?.error || "Failed to reconnect");
      const linkToken = String(tokenJson.linkToken || tokenJson.link_token || "");
      await new Promise<void>((resolve, reject) => {
        window.DatagranLink!.open({
          linkToken,
          onSuccess: async (payload) => {
            try {
              if (payload.connection_id) {
                const saveRes = await fetch("/api/datagran/connection", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ agentId, connectionId: payload.connection_id }),
                });
                if (!saveRes.ok) throw new Error("Failed to save the reconnected account");
              }
              await refreshAll();
              resolve();
            } catch (cause) {
              reject(cause);
            }
          },
          onExit: () => resolve(),
        });
      });
    },
    [datagranScriptLoaded, refreshAll]
  );

  const connectWithId = useCallback(
    async (platform: PlatformType, connectionId: string, apiKey: string, name: string) => {
      const res = await fetch("/api/datagran/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: getDatagranProvider(platform),
          connectionId,
          apiKey,
          name,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to save connection");
      await refreshAll();
    },
    [refreshAll]
  );

  const disconnect = useCallback(
    async (agentId: string) => {
      const res = await fetch(`/api/agents?id=${encodeURIComponent(agentId)}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to disconnect");
      await refreshAll();
    },
    [refreshAll]
  );

  const rename = useCallback(
    async (agentId: string, name: string) => {
      const res = await fetch("/api/agents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: agentId, name }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to rename");
      await refreshAll();
    },
    [refreshAll]
  );

  const toggleAssignment = useCallback(
    async (input: {
      integrationId: string;
      target: "orchestrator" | "worker";
      workerId?: string;
      enabled: boolean;
    }) => {
      const key = `${input.integrationId}:${input.target}:${input.workerId || "global"}`;
      setBusyAssignment(key);
      setError(null);
      try {
        const res = await fetch("/api/integrations/assignments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || "Failed to save assignment");
        setAssignments(json.assignments as Assignments);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to save assignment");
      } finally {
        setBusyAssignment(null);
      }
    },
    []
  );

  const targetCount = useMemo(() => 1 + workers.length, [workers.length]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-lg font-medium text-white">Integrations</h3>
          <p className="mt-1 text-sm leading-relaxed text-zinc-500">
            Connect capabilities once, then choose exactly which parts of your workforce can use
            them. Credentials stay encrypted in Groovy and are never copied into worker prompts.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-black/30 p-1">
        <button
          type="button"
          onClick={() => setActiveTab("data")}
          className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm ${
            activeTab === "data" ? "bg-cyan-500/15 text-cyan-200" : "text-zinc-500"
          }`}
        >
          <Database className="h-4 w-4" /> Groovy integrations
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("custom")}
          className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm ${
            activeTab === "custom" ? "bg-violet-500/15 text-violet-200" : "text-zinc-500"
          }`}
        >
          <Code2 className="h-4 w-4" /> Custom enterprise
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {activeTab === "data" ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 p-2">
                <Plug className="h-4 w-4 text-cyan-300" />
              </div>
              <div>
                <div className="text-sm font-medium text-white">Connected data sources</div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {connections.length} connected · assignable to {targetCount} target
                  {targetCount === 1 ? "" : "s"}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowDataPanel(true)}
              disabled={!canManage}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3 py-2 text-xs font-medium text-black hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
              title={
                canManage
                  ? "Manage workspace data sources"
                  : "Only workspace admins can manage data sources"
              }
            >
              Manage sources <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="rounded-xl border border-white/10 bg-black/20">
            <div className="border-b border-white/5 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <Users className="h-4 w-4 text-zinc-500" /> Access assignments
              </div>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                The orchestrator can query assigned sources directly. A worker assignment tells the
                orchestrator which sources it may consult when preparing context for that worker;
                raw credentials never leave the integration service.
              </p>
            </div>

            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-600" />
              </div>
            ) : integrations.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <Database className="mx-auto h-7 w-7 text-zinc-700" />
                <p className="mt-3 text-sm text-zinc-400">No Groovy integrations connected</p>
                <button
                  type="button"
                  onClick={() => setShowDataPanel(true)}
                  disabled={!canManage}
                  className="mt-2 text-xs text-cyan-300 hover:text-cyan-200 disabled:cursor-not-allowed disabled:text-zinc-600"
                >
                  {canManage ? "Connect your first source →" : "Ask an admin to connect a source"}
                </button>
              </div>
            ) : (
              <div className="divide-y divide-white/5">
                {integrations.map((integration) => {
                  const orchestratorAssigned = assignments.orchestrator.includes(integration.id);
                  return (
                    <div key={integration.id} className="space-y-3 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-white">
                            {integration.name}
                          </div>
                          <div className="text-[11px] text-zinc-500">
                            {prettyProvider(integration.provider)}
                          </div>
                        </div>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] ${
                            integration.connected
                              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                              : "border-amber-500/20 bg-amber-500/10 text-amber-300"
                          }`}
                        >
                          {integration.connected ? "Connected" : "Needs connection"}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <AssignmentChip
                          label="Orchestrator"
                          assigned={orchestratorAssigned}
                          busy={busyAssignment === `${integration.id}:orchestrator:global`}
                          disabled={!canManage}
                          onClick={() =>
                            void toggleAssignment({
                              integrationId: integration.id,
                              target: "orchestrator",
                              enabled: !orchestratorAssigned,
                            })
                          }
                        />
                        {workers.map((worker) => {
                          const assigned = (assignments.workers[worker.id] || []).includes(
                            integration.id
                          );
                          return (
                            <AssignmentChip
                              key={worker.id}
                              label={worker.name}
                              assigned={assigned}
                              disabled={!canManage}
                              busy={
                                busyAssignment === `${integration.id}:worker:${worker.id}`
                              }
                              onClick={() =>
                                void toggleAssignment({
                                  integrationId: integration.id,
                                  target: "worker",
                                  workerId: worker.id,
                                  enabled: !assigned,
                                })
                              }
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-cyan-500/10 bg-cyan-500/[0.04] p-3 text-xs leading-relaxed text-zinc-400">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
            Groovy keeps each connection centralized and encrypted. Assigning it controls access;
            it never copies the underlying credentials into an agent&apos;s prompt.
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-violet-500/15 bg-violet-500/[0.04] p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-lg border border-violet-500/20 bg-violet-500/10 p-2">
                <Code2 className="h-4 w-4 text-violet-300" />
              </div>
              <div className="flex-1">
                <h4 className="text-sm font-medium text-white">Developer-built integrations</h4>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  Define typed tools with a JSON manifest, choose Groovy cloud, a customer runner,
                  or the local connector, then install credentials and inspect audit telemetry.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!resolvedOrchestratorAgentId || !canManage}
                    onClick={() => setShowCustomPanel(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-violet-400 px-3 py-2 text-xs font-medium text-black hover:bg-violet-300 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Open custom integrations <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                  <a
                    href="/integrations/docs"
                    target="_blank"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-300 hover:bg-white/10"
                  >
                    Developer docs <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
                {!resolvedOrchestratorAgentId && (
                  <p className="mt-3 text-[11px] text-amber-300/80">
                    Start or select an orchestrator conversation first so Groovy can scope the
                    integration safely.
                  </p>
                )}
                {resolvedOrchestratorAgentId && !canManage && (
                  <p className="mt-3 text-[11px] text-zinc-500">
                    Custom integration management is limited to workspace admins.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <DataIntegrationsPanel
        isOpen={showDataPanel && canManage}
        onClose={() => {
          setShowDataPanel(false);
          void refreshAll();
        }}
        connections={connections}
        pixels={pixels}
        onConnect={connect}
        onConnectWithId={connectWithId}
        onReconnect={reconnect}
        onDisconnect={disconnect}
        onRename={rename}
        onRefresh={refreshAll}
      />
      <IntegrationsPanel
        isOpen={showCustomPanel && !!resolvedOrchestratorAgentId && canManage}
        onClose={() => setShowCustomPanel(false)}
        agentId={resolvedOrchestratorAgentId}
      />
    </div>
  );
}

function AssignmentChip({
  label,
  assigned,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  assigned: boolean;
  busy: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${
        assigned
          ? "border-cyan-500/25 bg-cyan-500/10 text-cyan-200"
          : "border-white/10 bg-white/[0.03] text-zinc-500 hover:text-zinc-300"
      }`}
      aria-pressed={assigned}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : assigned ? (
        <Check className="h-3 w-3" />
      ) : (
        <span className="h-3 w-3 rounded border border-current opacity-60" />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}
