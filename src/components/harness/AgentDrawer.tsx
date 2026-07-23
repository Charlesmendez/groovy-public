"use client";

/**
 * AgentDrawer — per-agent configuration slide-over.
 *
 * Tabs:
 *  General      — name, harness, model, workspace, danger zone
 *  Skills       — assign repo skills (workspace_skill_assignments)
 *  Integrations — attach Groovy integrations to this worker
 *  Instructions — edit workspace CLAUDE.md / AGENTS.md on the device
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen,
  Check,
  Database,
  Folder,
  Loader2,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { WorkerAgentInfo } from "@/hooks/useWorkerAgents";
import { WORKER_MODEL_PRESETS } from "@/lib/agents/modelPresets";
import { reasoningEffortsForModel } from "@/lib/ai/modelCatalog";

type DrawerTab = "general" | "skills" | "integrations" | "instructions";

type SkillArtifact = {
  id: string;
  artifact_type: "skill" | "instruction_doc";
  slug: string;
  name: string;
  description: string;
  targets: string[];
  lifecycle: string;
};

type SkillAssignment = {
  id: string;
  artifact_id: string;
  agent_id?: string | null;
  target: string;
  enabled: boolean;
};

type DatagranIntegration = {
  agentId: string;
  name: string;
  provider: string | null;
};

export function AgentDrawer({
  agent,
  capabilities,
  connectorOnline,
  onClose,
  onUpdateAgent,
  onRenameAgent,
  onDeleteAgent,
  onPickWorkspace,
  onRefreshAgents,
}: {
  agent: WorkerAgentInfo | null;
  capabilities: {
    claudeCliInstalled: boolean | null;
    codexCliInstalled: boolean | null;
  };
  connectorOnline: boolean;
  onClose: () => void;
  onUpdateAgent: (
    id: string,
    patch: {
      harness?: "claude" | "codex";
      model?: string | null;
      reasoningEffort?: string | null;
      emoji?: string | null;
      color?: string | null;
    }
  ) => Promise<boolean>;
  onRenameAgent: (id: string, name: string) => Promise<boolean>;
  onDeleteAgent: (id: string) => Promise<boolean>;
  onPickWorkspace: () => Promise<{ id: string; rootPath: string } | null>;
  onRefreshAgents: () => Promise<void>;
}) {
  const supabase = getSupabaseBrowserClient();
  const [tab, setTab] = useState<DrawerTab>("general");
  // Reset to General when a different agent opens (adjust-state-during-render).
  const [lastAgentId, setLastAgentId] = useState<string | null>(agent?.id || null);
  if (agent && agent.id !== lastAgentId) {
    setLastAgentId(agent.id);
    setTab("general");
  }

  return (
    <AnimatePresence>
      {agent && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50"
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            initial={{ x: 420 }}
            animate={{ x: 0 }}
            exit={{ x: 420 }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="absolute right-0 top-0 bottom-0 w-full max-w-[420px] bg-zinc-950/95 backdrop-blur-xl border-l border-white/10 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
              <div className="w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center text-base">
                {agent.emoji || agent.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white truncate">{agent.name}</div>
                <div className="text-[10px] text-zinc-500">
                  {agent.harness === "codex" ? "Codex" : "Claude Code"}
                  {agent.model ? ` · ${agent.model}` : ""}
                  {agent.reasoningEffort
                    ? ` · ${agent.reasoningEffort === "xhigh" ? "Extra high" : agent.reasoningEffort}`
                    : ""}
                </div>
              </div>
              <button
                onClick={onClose}
                className="ml-auto w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 px-3 pt-2 border-b border-white/5 pb-2">
              {(
                [
                  { id: "general", label: "General", icon: Settings2 },
                  { id: "skills", label: "Skills", icon: Sparkles },
                  { id: "integrations", label: "Data", icon: Database },
                  { id: "instructions", label: "Instructions", icon: BookOpen },
                ] as Array<{ id: DrawerTab; label: string; icon: typeof Settings2 }>
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    tab === id ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {tab === "general" && (
                <GeneralTab
                  key={agent.id}
                  agent={agent}
                  capabilities={capabilities}
                  connectorOnline={connectorOnline}
                  onUpdateAgent={onUpdateAgent}
                  onRenameAgent={onRenameAgent}
                  onDeleteAgent={onDeleteAgent}
                  onPickWorkspace={onPickWorkspace}
                  onRefreshAgents={onRefreshAgents}
                  supabase={supabase}
                />
              )}
              {tab === "skills" && <SkillsTab key={agent.id} agent={agent} />}
              {tab === "integrations" && (
                <IntegrationsTab key={agent.id} agent={agent} />
              )}
              {tab === "instructions" && (
                <InstructionsTab key={agent.id} agent={agent} connectorOnline={connectorOnline} />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------

function GeneralTab({
  agent,
  capabilities,
  connectorOnline,
  onUpdateAgent,
  onRenameAgent,
  onDeleteAgent,
  onPickWorkspace,
  onRefreshAgents,
  supabase,
}: {
  agent: WorkerAgentInfo;
  capabilities: { claudeCliInstalled: boolean | null; codexCliInstalled: boolean | null };
  connectorOnline: boolean;
  onUpdateAgent: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
  onRenameAgent: (id: string, name: string) => Promise<boolean>;
  onDeleteAgent: (id: string) => Promise<boolean>;
  onPickWorkspace: () => Promise<{ id: string; rootPath: string } | null>;
  onRefreshAgents: () => Promise<void>;
  supabase: ReturnType<typeof getSupabaseBrowserClient>;
}) {
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(agent.model || "");
  const [reasoningEffort, setReasoningEffort] = useState(agent.reasoningEffort || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [changingWorkspace, setChangingWorkspace] = useState(false);
  const supportedReasoningEfforts = reasoningEffortsForModel(model, "cli");
  const normalizedReasoningEffort = supportedReasoningEfforts.includes(
    reasoningEffort as (typeof supportedReasoningEfforts)[number]
  )
    ? reasoningEffort
    : null;

  const dirty =
    name.trim() !== agent.name ||
    (model.trim() || null) !== (agent.model || null) ||
    normalizedReasoningEffort !== (agent.reasoningEffort || null);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (name.trim() !== agent.name) {
        if (!name.trim()) throw new Error("Agent name is required.");
        const renamed = await onRenameAgent(agent.id, name.trim());
        if (!renamed) throw new Error("Could not rename the agent.");
      }
      const configChanged =
        (model.trim() || null) !== (agent.model || null) ||
        normalizedReasoningEffort !== (agent.reasoningEffort || null);
      if (configChanged) {
        const updated = await onUpdateAgent(agent.id, {
          model: model.trim() || null,
          reasoningEffort: normalizedReasoningEffort,
        });
        if (!updated) throw new Error("Could not update the model settings.");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save changes.");
    } finally {
      setSaving(false);
    }
  }, [
    dirty,
    saving,
    name,
    model,
    normalizedReasoningEffort,
    agent,
    onRenameAgent,
    onUpdateAgent,
  ]);

  const switchHarness = useCallback(
    async (harness: "claude" | "codex") => {
      if (harness === agent.harness) return;
      await onUpdateAgent(agent.id, { harness });
    },
    [agent, onUpdateAgent]
  );

  const changeWorkspace = useCallback(async () => {
    setChangingWorkspace(true);
    try {
      const picked = await onPickWorkspace();
      if (picked) {
        await supabase
          .from("claude_code_agent_configs")
          .update({ workspace_id: picked.id, updated_at: new Date().toISOString() })
          .eq("agent_id", agent.id);
        await onRefreshAgents();
      }
    } finally {
      setChangingWorkspace(false);
    }
  }, [agent.id, onPickWorkspace, onRefreshAgents, supabase]);

  return (
    <div className="px-4 py-4 space-y-5">
      {/* Name */}
      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Agent name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/40 transition-colors"
        />
      </div>

      {/* Harness */}
      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Harness</label>
        <div className="grid grid-cols-2 gap-2">
          {(["claude", "codex"] as const).map((h) => {
            const installed =
              h === "claude" ? capabilities.claudeCliInstalled : capabilities.codexCliInstalled;
            return (
              <button
                key={h}
                onClick={() => switchHarness(h)}
                className={`rounded-xl border px-3 py-2 text-left transition-all ${
                  agent.harness === h
                    ? h === "claude"
                      ? "border-orange-400/40 bg-orange-500/10"
                      : "border-emerald-400/40 bg-emerald-500/10"
                    : "border-white/10 bg-white/[0.02] hover:bg-white/5"
                }`}
              >
                <div className="text-sm text-white">{h === "claude" ? "Claude Code" : "Codex"}</div>
                {installed === false && (
                  <div className="text-[10px] text-amber-300/90 mt-0.5">CLI not detected</div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Model */}
      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">
          Default model
        </label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={`${agent.harness === "codex" ? "Codex" : "Claude Code"} default`}
          className="w-full rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-cyan-400/40 transition-colors"
        />
        <div className="flex flex-wrap gap-1.5 mt-2">
          <button
            onClick={() => setModel("")}
            className={`px-2 py-1 rounded-lg text-[11px] transition-colors ${
              !model ? "bg-cyan-400/15 text-cyan-200" : "bg-white/5 text-zinc-400 hover:bg-white/10"
            }`}
          >
            Harness default
          </button>
          {WORKER_MODEL_PRESETS[agent.harness].map((preset) => (
            <button
              key={preset}
              onClick={() => setModel(preset)}
              className={`px-2 py-1 rounded-lg text-[11px] transition-colors ${
                model === preset
                  ? "bg-cyan-400/15 text-cyan-200"
                  : "bg-white/5 text-zinc-400 hover:bg-white/10"
              }`}
            >
              {preset}
            </button>
          ))}
        </div>
      </div>

      {reasoningEffortsForModel(model, "cli").length > 0 && (
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">
            Reasoning effort
          </label>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setReasoningEffort("")}
              className={`px-2 py-1 rounded-lg text-[11px] transition-colors ${
                !reasoningEffort
                  ? "bg-cyan-400/15 text-cyan-200"
                  : "bg-white/5 text-zinc-400 hover:bg-white/10"
              }`}
            >
              Model default
            </button>
            {reasoningEffortsForModel(model, "cli").map((effort) => (
              <button
                type="button"
                key={effort}
                onClick={() => setReasoningEffort(effort)}
                className={`px-2 py-1 rounded-lg text-[11px] transition-colors ${
                  reasoningEffort === effort
                    ? "bg-cyan-400/15 text-cyan-200"
                    : "bg-white/5 text-zinc-400 hover:bg-white/10"
                }`}
              >
                {effort === "xhigh"
                  ? "Extra high"
                  : effort.charAt(0).toUpperCase() + effort.slice(1)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Workspace */}
      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Workspace</label>
        <button
          onClick={changeWorkspace}
          disabled={!connectorOnline || changingWorkspace}
          className="w-full flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-left hover:border-white/20 transition-colors disabled:opacity-50"
        >
          {changingWorkspace ? (
            <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
          ) : (
            <Folder className="w-4 h-4 text-zinc-500" />
          )}
          <span className="text-sm text-zinc-300 truncate">
            {agent.workspaceRootPath || "Home folder (default)"}
          </span>
        </button>
      </div>

      {/* Save */}
      {saveError && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {saveError}
        </div>
      )}
      <button
        onClick={save}
        disabled={!dirty || saving}
        className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-cyan-400 text-black text-sm font-semibold hover:bg-cyan-300 disabled:opacity-30 transition-all"
      >
        {saving ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : saved ? (
          <Check className="w-3.5 h-3.5" />
        ) : (
          <Save className="w-3.5 h-3.5" />
        )}
        {saved ? "Saved" : "Save changes"}
      </button>

      {/* Danger zone */}
      <div className="pt-3 border-t border-white/5">
        {confirmDelete ? (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3">
            <p className="text-xs text-red-200 mb-2">
              Delete {agent.name}? Its transcripts stay in the database, but the agent and
              its schedules retarget to the orchestrator.
            </p>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  setDeleting(true);
                  await onDeleteAgent(agent.id);
                  setDeleting(false);
                }}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-red-500/20 text-red-200 hover:bg-red-500/30 text-xs font-medium transition-colors"
              >
                {deleting && <Loader2 className="w-3 h-3 animate-spin" />}
                Delete agent
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="flex-1 py-1.5 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 text-xs transition-colors"
              >
                Keep
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-red-300 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete this agent
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SkillsTab({ agent }: { agent: WorkerAgentInfo }) {
  const [artifacts, setArtifacts] = useState<SkillArtifact[]>([]);
  const [assignments, setAssignments] = useState<SkillAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyArtifactId, setBusyArtifactId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/workspaces/skills", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setArtifacts(Array.isArray(json.artifacts) ? json.artifacts : []);
        setAssignments(Array.isArray(json.assignments) ? json.assignments : []);
        setError(null);
      } else {
        setError(json?.error || "Failed to load skills");
      }
    } catch {
      setError("Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const target = agent.harness; // skills target follows the harness
  const assignedArtifactIds = useMemo(
    () =>
      new Set(
        assignments
          .filter((a) => a.agent_id === agent.id && a.enabled)
          .map((a) => a.artifact_id)
      ),
    [assignments, agent.id]
  );

  const eligible = useMemo(
    () =>
      artifacts.filter(
        (artifact) =>
          artifact.lifecycle !== "archived" &&
          (artifact.targets.includes(target) || artifact.targets.includes("all"))
      ),
    [artifacts, target]
  );

  const toggle = useCallback(
    async (artifact: SkillArtifact, enable: boolean) => {
      setBusyArtifactId(artifact.id);
      setError(null);
      try {
        const res = await fetch("/api/workspaces/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: enable ? "set_assignment" : "remove_assignment",
            artifactId: artifact.id,
            agentId: agent.id,
            target,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.ok === false) {
          setError(json?.error || "Could not update this assignment");
          return;
        }
        await load();
      } catch {
        setError("Could not update this assignment");
      } finally {
        setBusyArtifactId(null);
      }
    },
    [agent.id, target, load]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="px-4 py-4 space-y-3">
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Assign reusable skills and Markdown instruction docs from your shared library.
        Groovy prepares them locally and includes them when {agent.name} runs.
      </p>
      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      {eligible.length === 0 ? (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 text-center">
          <p className="text-xs text-zinc-500">
            No skills targeting {target === "codex" ? "Codex" : "Claude"} yet.
          </p>
          <a
            href="/dashboard/skills"
            className="inline-block mt-2 text-xs text-cyan-300 hover:text-cyan-200"
          >
            Open Skills &amp; Docs library →
          </a>
        </div>
      ) : (
        <>
          {eligible.map((artifact) => {
            const assigned = assignedArtifactIds.has(artifact.id);
            const busy = busyArtifactId === artifact.id;
            return (
              <div
                key={artifact.id}
                className={`rounded-xl border p-3 transition-colors ${
                  assigned ? "border-cyan-400/25 bg-cyan-400/[0.04]" : "border-white/5 bg-white/[0.02]"
                }`}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {artifact.artifact_type === "instruction_doc" ? (
                        <BookOpen className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
                      )}
                      <div className="text-xs font-medium text-white truncate">{artifact.name}</div>
                    </div>
                    {artifact.description && (
                      <div className="text-[10px] text-zinc-500 mt-0.5 line-clamp-2">
                        {artifact.description}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => toggle(artifact, !assigned)}
                    disabled={busy}
                    className={`shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                      assigned
                        ? "bg-cyan-400/15 text-cyan-200 hover:bg-cyan-400/25"
                        : "bg-white/5 text-zinc-400 hover:bg-white/10"
                    }`}
                  >
                    {busy ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : assigned ? (
                      "Assigned"
                    ) : (
                      "Assign"
                    )}
                  </button>
                </div>
              </div>
            );
          })}
          <a
            href="/dashboard/skills"
            className="block text-center text-xs text-zinc-500 hover:text-cyan-300 transition-colors pt-1"
          >
            Open Skills &amp; Docs library →
          </a>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function IntegrationsTab({
  agent,
}: {
  agent: WorkerAgentInfo;
}) {
  const [integrations, setIntegrations] = useState<DatagranIntegration[]>([]);
  const [attachedIds, setAttachedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/integrations/assignments", { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setIntegrations([]);
      setAttachedIds(new Set());
      setLoading(false);
      return;
    }
    setIntegrations(
      (Array.isArray(json.integrations) ? json.integrations : []).map(
        (integration: { id?: unknown; name?: unknown; provider?: unknown }) => ({
          agentId: String(integration.id || ""),
          name: String(integration.name || "Data source"),
          provider: integration.provider ? String(integration.provider) : null,
        })
      )
    );
    setAttachedIds(
      new Set(
        Array.isArray(json?.assignments?.workers?.[agent.id])
          ? json.assignments.workers[agent.id].map(String)
          : []
      )
    );
    setLoading(false);
  }, [agent.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (integration: DatagranIntegration, attach: boolean) => {
      setBusyId(integration.agentId);
      try {
        const res = await fetch("/api/integrations/assignments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            integrationId: integration.agentId,
            target: "worker",
            workerId: agent.id,
            enabled: attach,
          }),
        });
        if (!res.ok) return;
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [agent.id, load]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="px-4 py-4 space-y-3">
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Attach your data integrations so {agent.name} can pull from them during tasks.
      </p>
      {integrations.length === 0 ? (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 text-center">
          <p className="text-xs text-zinc-500">No data integrations connected yet.</p>
          <Link
            href="/dashboard"
            className="inline-block mt-2 text-xs text-cyan-300 hover:text-cyan-200"
          >
            Connect a data source →
          </Link>
        </div>
      ) : (
        integrations.map((integration) => {
          const attached = attachedIds.has(integration.agentId);
          const busy = busyId === integration.agentId;
          return (
            <div
              key={integration.agentId}
              className={`flex items-center gap-3 rounded-xl border p-3 transition-colors ${
                attached ? "border-cyan-400/25 bg-cyan-400/[0.04]" : "border-white/5 bg-white/[0.02]"
              }`}
            >
              <Database className="w-4 h-4 text-zinc-500 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-white truncate">{integration.name}</div>
                {integration.provider && (
                  <div className="text-[10px] text-zinc-500">{integration.provider}</div>
                )}
              </div>
              <button
                onClick={() => toggle(integration, !attached)}
                disabled={busy}
                className={`shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                  attached
                    ? "bg-cyan-400/15 text-cyan-200 hover:bg-cyan-400/25"
                    : "bg-white/5 text-zinc-400 hover:bg-white/10"
                }`}
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : attached ? "Attached" : "Attach"}
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function InstructionsTab({
  agent,
  connectorOnline,
}: {
  agent: WorkerAgentInfo;
  connectorOnline: boolean;
}) {
  const filename = agent.harness === "codex" ? "AGENTS.md" : "CLAUDE.md";
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/agents/workers/md?agentId=${agent.id}&filename=${filename}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) {
          setContent(json.content || "");
          setOriginalContent(json.content || "");
        } else {
          setError(json?.error || "Could not load the file");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the file");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, filename]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/workers/md", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, filename, content }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error || "Save failed");
        return;
      }
      setOriginalContent(content);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  }, [agent.id, filename, content]);

  return (
    <div className="h-full flex flex-col px-4 py-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-xs font-medium text-white">{filename}</div>
          <div className="text-[10px] text-zinc-500">
            In {agent.workspaceRootPath || "the workspace root"} — read by{" "}
            {agent.harness === "codex" ? "Codex" : "Claude Code"} on every run.
          </div>
        </div>
        <button
          onClick={save}
          disabled={saving || loading || content === originalContent}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-400 text-black text-xs font-semibold hover:bg-cyan-300 disabled:opacity-30 transition-all"
        >
          {saving ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : saved ? (
            <Check className="w-3 h-3" />
          ) : (
            <Save className="w-3 h-3" />
          )}
          {saved ? "Saved" : "Save"}
        </button>
      </div>

      <div className="mb-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[10px] leading-relaxed text-zinc-500">
        This file belongs only to this project. For reusable rules or playbooks that you can
        assign across agents and to the orchestrator, use the{" "}
        <Link href="/dashboard/skills" className="text-cyan-300 hover:text-cyan-200">
          Skills &amp; Docs library
        </Link>
        .
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-300 mb-2">
          {error}
        </div>
      )}
      {!connectorOnline && !loading && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-300 mb-2">
          Device offline — the file can&apos;t be read or saved right now.
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={`# ${filename}\n\nProject instructions for this agent…`}
          spellCheck={false}
          className="flex-1 min-h-[280px] w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2.5 text-xs text-zinc-200 font-mono leading-relaxed placeholder-zinc-700 outline-none focus:border-cyan-400/40 resize-none transition-colors"
        />
      )}
    </div>
  );
}
