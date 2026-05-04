"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  BookOpen,
  Check,
  CheckCircle2,
  Code2,
  FileText,
  GitBranch,
  HelpCircle,
  Laptop2,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { useRelay, type RelayMessage } from "@/hooks/useRelay";

type Target = "all" | "flow" | "claude" | "codex";
type ArtifactType = "skill" | "instruction_doc";

type WorkspaceInfo = {
  id: string;
  name: string;
  role: "admin" | "member";
};

type Repository = {
  id: string;
  repo_url: string;
  label: string;
  default_ref: string;
  status: string;
  last_commit_sha?: string | null;
  last_synced_at?: string | null;
  updated_at?: string | null;
};

type Artifact = {
  id: string;
  repository_id: string;
  artifact_type: ArtifactType;
  slug: string;
  name: string;
  description: string;
  relative_path: string;
  exact_filename?: string | null;
  targets: Target[];
  checksum: string;
  commit_sha?: string | null;
  lifecycle: string;
  metadata?: Record<string, unknown>;
  risk_flags?: string[];
  updated_at?: string | null;
};

type Assignment = {
  id: string;
  artifact_id: string;
  agent_id?: string | null;
  target: Target;
  scope: "workspace" | "agent";
  enabled: boolean;
};

type SyncState = {
  id: string;
  repository_id: string;
  user_id: string;
  device_id: string;
  status: "never" | "synced" | "no_permission" | "offline" | "error";
  local_path?: string | null;
  commit_sha?: string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  diagnostics?: Record<string, unknown>;
  synced_at?: string | null;
  materialized_at?: string | null;
  updated_at?: string | null;
};

type AuditEvent = {
  id: string;
  event_type: string;
  repository_id?: string | null;
  artifact_id?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
};

type Agent = {
  id: string;
  name: string;
  type: string;
  target: "flow" | "claude" | "codex";
  ownerEmail?: string | null;
};

type SkillsState = {
  currentUserId: string;
  workspace: WorkspaceInfo;
  repositories: Repository[];
  artifacts: Artifact[];
  assignments: Assignment[];
  syncs: SyncState[];
  auditEvents: AuditEvent[];
  agents: Agent[];
  privacy: {
    storesContents: boolean;
    summary: string;
  };
};

type CreateKind = "skill" | "instruction_doc";

const TARGETS: Array<{ id: Target; label: string; icon: typeof Sparkles }> = [
  { id: "flow", label: "Flow", icon: Sparkles },
  { id: "claude", label: "Claude", icon: Terminal },
  { id: "codex", label: "Codex", icon: Code2 },
];

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function shortSha(value?: string | null) {
  const text = asString(value).trim();
  return text ? text.slice(0, 8) : "not synced";
}

function formatTime(value?: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function targetBadgeClass(target: Target) {
  if (target === "flow") return "border-emerald-400/25 bg-emerald-500/10 text-emerald-200";
  if (target === "claude") return "border-cyan-400/25 bg-cyan-500/10 text-cyan-200";
  if (target === "codex") return "border-sky-400/25 bg-sky-500/10 text-sky-200";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function riskLabel(flag: string) {
  return flag.replace(/_/g, " ");
}

function defaultSkillContent(name: string, targets: Target[]) {
  const title = name.trim() || "New Skill";
  return [
    "---",
    `name: ${title}`,
    "description: Describe when this skill should be used.",
    `targets: [${targets.join(", ")}]`,
    "---",
    "",
    `# ${title}`,
    "",
    "Use this skill when the task matches the description above.",
    "",
    "## Workflow",
    "",
    "1. Inspect the relevant files and current state.",
    "2. Apply the company-specific process.",
    "3. Return the result with concrete file paths, commands, or decisions.",
    "",
  ].join("\n");
}

function defaultInstructionContent(name: string, targets: Target[]) {
  const title = name.trim() || "Agent Instructions";
  return [
    "---",
    `name: ${title}`,
    "description: Shared guidance for assigned agents.",
    `targets: [${targets.join(", ")}]`,
    "---",
    "",
    `# ${title}`,
    "",
    "Add the exact guidance agents should follow. Keep it specific and operational.",
    "",
  ].join("\n");
}

export function SkillsManagerContent() {
  const relay = useRelay({ enabled: true });

  const [state, setState] = useState<SkillsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [onlineDevices, setOnlineDevices] = useState<Map<string, RelayMessage>>(new Map());
  const [helpOpen, setHelpOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [agentTarget, setAgentTarget] = useState<Target>("flow");

  const [repoUrl, setRepoUrl] = useState("");
  const [repoLabel, setRepoLabel] = useState("");
  const [repoRef, setRepoRef] = useState("main");

  const [createKind, setCreateKind] = useState<CreateKind>("skill");
  const [createName, setCreateName] = useState("Security Review");
  const [createPath, setCreatePath] = useState("skills/security-review/SKILL.md");
  const [createTargets, setCreateTargets] = useState<Target[]>(["all"]);
  const [createContent, setCreateContent] = useState(defaultSkillContent("Security Review", ["all"]));

  const loadState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/workspaces/skills", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load Skills Manager");
      setState(json as SkillsState);
      const repos = Array.isArray(json.repositories) ? (json.repositories as Repository[]) : [];
      if (!selectedRepoId && repos[0]?.id) setSelectedRepoId(repos[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Skills Manager");
    } finally {
      setLoading(false);
    }
  }, [selectedRepoId]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    return relay.subscribe((msg) => {
      if (msg.type === "device_online") {
        const deviceId = asString(msg.device_id);
        if (!deviceId) return;
        setOnlineDevices((prev) => {
          const next = new Map(prev);
          next.set(deviceId, msg);
          return next;
        });
        setActiveDeviceId((prev) => prev || deviceId);
      }
      if (msg.type === "device_offline") {
        const deviceId = asString(msg.device_id);
        if (!deviceId) return;
        setOnlineDevices((prev) => {
          const next = new Map(prev);
          next.delete(deviceId);
          return next;
        });
        setActiveDeviceId((prev) => (prev === deviceId ? null : prev));
      }
    });
  }, [relay]);

  const repositories = useMemo(() => state?.repositories || [], [state?.repositories]);
  const artifacts = useMemo(() => state?.artifacts || [], [state?.artifacts]);
  const assignments = useMemo(() => state?.assignments || [], [state?.assignments]);
  const syncs = useMemo(() => state?.syncs || [], [state?.syncs]);
  const agents = useMemo(() => state?.agents || [], [state?.agents]);
  const isAdmin = state?.workspace?.role === "admin";

  const repoById = useMemo(() => new Map(repositories.map((repo) => [repo.id, repo])), [repositories]);
  const syncByRepo = useMemo(() => {
    const map = new Map<string, SyncState>();
    const relevantSyncs = syncs.filter((sync) => {
      if (activeDeviceId) return sync.device_id === activeDeviceId;
      return !state?.currentUserId || sync.user_id === state.currentUserId;
    });
    for (const sync of relevantSyncs) {
      if (!map.has(sync.repository_id)) map.set(sync.repository_id, sync);
    }
    return map;
  }, [activeDeviceId, state?.currentUserId, syncs]);

  const filteredArtifacts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return artifacts.filter((artifact) => {
      if (selectedRepoId && artifact.repository_id !== selectedRepoId) return false;
      if (!q) return true;
      return [
        artifact.name,
        artifact.description,
        artifact.slug,
        artifact.relative_path,
        artifact.exact_filename || "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [artifacts, query, selectedRepoId]);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) || null;

  useEffect(() => {
    if (!selectedAgentId && agents[0]?.id) {
      setSelectedAgentId(agents[0].id);
      setAgentTarget(agents[0].target);
    }
  }, [agents, selectedAgentId]);

  useEffect(() => {
    const slug = slugify(createName || "new-skill");
    if (createKind === "skill") {
      setCreatePath(`skills/${slug || "new-skill"}/SKILL.md`);
      setCreateContent(defaultSkillContent(createName, createTargets));
    } else {
      const filename = createName.trim().toUpperCase() === "CLAUDE" ? "CLAUDE.md" : createName.trim().toUpperCase() === "CODEX" ? "CODEX.md" : "AGENTS.md";
      setCreatePath(`instructions/shared/${filename}`);
      setCreateContent(defaultInstructionContent(createName || filename.replace(/\.md$/i, ""), createTargets));
    }
  }, [createKind, createName, createTargets]);

  async function postAction(body: Record<string, unknown>, busy: string) {
    setBusyKey(busy);
    setError(null);
    try {
      const res = await fetch("/api/workspaces/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error || json.ok === false) {
        await loadState();
        throw new Error(json.error || "Skills Manager action failed");
      }
      await loadState();
      return json;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Skills Manager action failed");
      return null;
    } finally {
      setBusyKey(null);
    }
  }

  const connectRepo = async () => {
    const result = await postAction(
      {
        action: "connect_repo",
        repoUrl,
        label: repoLabel,
        defaultRef: repoRef || "main",
        deviceId: activeDeviceId || undefined,
      },
      "connect_repo"
    );
    if (result) {
      setRepoUrl("");
      setRepoLabel("");
    }
  };

  const syncRepo = async (repositoryId: string) => {
    if (!activeDeviceId) {
      setError("Start the Groovy Connector first, then retry sync.");
      return;
    }
    await postAction(
      { action: "sync_repo", repositoryId, deviceId: activeDeviceId },
      `sync:${repositoryId}`
    );
  };

  const preflight = async (target: "flow" | "claude" | "codex", agentId?: string | null) => {
    if (!activeDeviceId) {
      setError("Start the Groovy Connector first, then retry preflight.");
      return;
    }
    await postAction(
      { action: "preflight", deviceId: activeDeviceId, target, agentId: agentId || null },
      `preflight:${target}:${agentId || "workspace"}`
    );
  };

  const createArtifact = async () => {
    if (!selectedRepoId) {
      setError("Connect or select a skills repo first.");
      return;
    }
    if (!activeDeviceId) {
      setError("Start the Groovy Connector first. Creation writes directly into the local repo checkout.");
      return;
    }
    const result = await postAction(
      {
        action: "create_artifact",
        repositoryId: selectedRepoId,
        deviceId: activeDeviceId,
        artifactType: createKind,
        relativePath: createPath,
        content: createContent,
        name: createName,
        targets: createTargets,
      },
      "create_artifact"
    );
    if (result) setCreateOpen(false);
  };

  const isAssigned = (artifactId: string, target: Target, agentId?: string | null) =>
    assignments.some(
      (assignment) =>
        assignment.enabled &&
        assignment.artifact_id === artifactId &&
        assignment.target === target &&
        (agentId ? assignment.agent_id === agentId : !assignment.agent_id)
    );

  const artifactSupportsTarget = (artifact: Artifact, target: Target) => {
    const targets = artifact.targets || ["all"];
    return targets.includes("all") || targets.includes(target);
  };

  const toggleAssignment = async (artifact: Artifact, target: Target, agentId?: string | null) => {
    if (!artifactSupportsTarget(artifact, target)) {
      setError(`${artifact.name} is not declared compatible with ${target}.`);
      return;
    }
    const assigned = isAssigned(artifact.id, target, agentId);
    await postAction(
      {
        action: assigned ? "remove_assignment" : "set_assignment",
        artifactId: artifact.id,
        target,
        agentId: agentId || null,
      },
      `assign:${artifact.id}:${target}:${agentId || "workspace"}`
    );
  };

  const activeRepo = selectedRepoId ? repoById.get(selectedRepoId) || null : null;
  const activeRepoSync = activeRepo ? syncByRepo.get(activeRepo.id) || null : null;
  const permissionError = activeRepoSync?.status === "no_permission";
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const reassignAssignment = async (
    assignment: Assignment,
    artifact: Artifact,
    toAgentId: string
  ) => {
    const toAgent = agentById.get(toAgentId);
    if (!toAgent) {
      setError("Choose a destination agent.");
      return;
    }
    if (!artifactSupportsTarget(artifact, toAgent.target)) {
      setError(`${artifact.name} is not declared compatible with ${toAgent.target}.`);
      return;
    }
    await postAction(
      {
        action: "reassign_assignment",
        assignmentId: assignment.id,
        toAgentId,
      },
      `reassign:${assignment.id}`
    );
  };

  const compatibleDestinationAgents = (artifact: Artifact, assignment: Assignment) =>
    agents.filter(
      (agent) =>
        agent.id !== assignment.agent_id &&
        artifactSupportsTarget(artifact, agent.target)
    );

  return (
    <div className="app-scroll-page bg-[#08090b] text-white">
      <div className="sticky top-0 z-30 border-b border-white/10 bg-[#08090b]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <a
              href="/dashboard"
              className="rounded-lg p-2 text-zinc-400 transition hover:bg-white/5 hover:text-white"
              title="Back to dashboard"
              aria-label="Back to dashboard"
            >
              <ArrowLeft className="h-5 w-5" />
            </a>
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-emerald-300" />
                <h1 className="text-lg font-semibold">Skills Manager</h1>
              </div>
              <p className="text-xs text-zinc-500">
                Git-owned skills and instruction docs for Flow, Claude Code, and Codex.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-200 transition hover:bg-white/10"
            >
              <HelpCircle className="h-4 w-4" />
              Help
            </button>
            <button
              type="button"
              onClick={() => void loadState()}
              className="rounded-lg border border-white/10 bg-white/5 p-2 text-zinc-300 transition hover:bg-white/10"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
      </div>

      <main className="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[360px_1fr]">
        <section className="space-y-4">
          <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-4">
            <div className="flex items-start gap-3">
              <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
              <div>
                <div className="text-sm font-medium text-emerald-100">No skill contents stored</div>
                <p className="mt-1 text-xs leading-relaxed text-emerald-100/75">
                  {state?.privacy?.summary ||
                    "Flow stores repo metadata, checksums, assignments, and sync status. Bodies stay in Git and local connector checkouts."}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Connector</h2>
                <p className="text-xs text-zinc-500">Repo access uses this machine&apos;s local Git CLI.</p>
              </div>
              <Laptop2 className={activeDeviceId ? "h-5 w-5 text-cyan-300" : "h-5 w-5 text-zinc-600"} />
            </div>
            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="flex items-center gap-2 text-sm">
                <span className={`h-2 w-2 rounded-full ${activeDeviceId ? "bg-emerald-400" : "bg-zinc-600"}`} />
                <span>{activeDeviceId ? "Connector online" : "No connector online"}</span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {activeDeviceId ? `Device ${activeDeviceId.slice(0, 8)}` : "Start Groovy Connector to sync private repos."}
              </div>
              {onlineDevices.size > 1 && (
                <select
                  value={activeDeviceId || ""}
                  onChange={(e) => setActiveDeviceId(e.target.value || null)}
                  className="mt-3 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-zinc-200 outline-none"
                >
                  {Array.from(onlineDevices.keys()).map((deviceId) => (
                    <option key={deviceId} value={deviceId}>
                      {deviceId.slice(0, 8)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-cyan-300" />
              <h2 className="text-sm font-semibold">Connect Repo</h2>
            </div>
            <div className="space-y-3">
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="git@github.com:acme/agent-context.git"
                disabled={!isAdmin}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-400/40"
              />
              <div className="grid grid-cols-[1fr_88px] gap-2">
                <input
                  value={repoLabel}
                  onChange={(e) => setRepoLabel(e.target.value)}
                  placeholder="Display name"
                  disabled={!isAdmin}
                  className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-400/40"
                />
                <input
                  value={repoRef}
                  onChange={(e) => setRepoRef(e.target.value)}
                  placeholder="main"
                  disabled={!isAdmin}
                  className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-400/40"
                />
              </div>
              <button
                type="button"
                onClick={() => void connectRepo()}
                disabled={!isAdmin || !repoUrl.trim() || busyKey === "connect_repo"}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-400 px-3 py-2 text-sm font-semibold text-black transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busyKey === "connect_repo" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Connect and Sync
              </button>
              {!isAdmin && <p className="text-xs text-zinc-500">Only workspace admins can connect or assign repos.</p>}
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Repositories</h2>
              <span className="text-xs text-zinc-500">{repositories.length}</span>
            </div>
            <div className="space-y-2">
              {repositories.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/10 p-4 text-xs text-zinc-500">
                  Connect a Git repo to discover `skills/*/SKILL.md` and `instructions/**/*.md`.
                </div>
              ) : (
                repositories.map((repo) => {
                  const sync = syncByRepo.get(repo.id);
                  const active = repo.id === selectedRepoId;
                  return (
                    <button
                      key={repo.id}
                      type="button"
                      onClick={() => setSelectedRepoId(repo.id)}
                      className={`w-full rounded-lg border p-3 text-left transition ${
                        active
                          ? "border-cyan-400/35 bg-cyan-500/10"
                          : "border-white/10 bg-black/20 hover:bg-white/[0.06]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{repo.label}</span>
                        {sync?.status === "synced" ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                        ) : sync?.status === "no_permission" ? (
                          <AlertTriangle className="h-4 w-4 text-amber-300" />
                        ) : (
                          <GitBranch className="h-4 w-4 text-zinc-500" />
                        )}
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">{repo.repo_url}</div>
                      <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
                        <span>{sync?.status || "never synced"}</span>
                        <span>{shortSha(sync?.commit_sha || repo.last_commit_sha)}</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </section>

        <section className="min-w-0 space-y-5">
          {error && (
            <div className="rounded-xl border border-rose-400/25 bg-rose-500/10 p-4 text-sm text-rose-100">
              {error}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-4">
            {[
              ["Repos", repositories.length, "text-cyan-300"],
              ["Artifacts", artifacts.length, "text-emerald-300"],
              ["Assignments", assignments.length, "text-sky-300"],
              ["Synced", syncs.filter((sync) => sync.status === "synced").length, "text-amber-300"],
            ].map(([label, value, color]) => (
              <div key={String(label)} className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
                <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
              </div>
            ))}
          </div>

          {permissionError && (
            <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                <div>
                  <div className="text-sm font-semibold text-amber-100">Repo access failed on this Mac</div>
                  <p className="mt-1 text-sm text-amber-100/75">
                    Flow did not connect to GitHub. Your local Git CLI could not access this repo.
                  </p>
                  <div className="mt-3 rounded-lg border border-amber-400/20 bg-black/25 p-3 font-mono text-xs text-amber-100/80">
                    git ls-remote {activeRepo?.repo_url}
                    <br />
                    ssh -T git@github.com
                  </div>
                  <p className="mt-3 text-xs text-amber-100/70">
                    Confirm your SSH key or credential helper is configured and that your GitHub user has access, then retry sync.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-base font-semibold">{activeRepo?.label || "Skill Catalog"}</h2>
                <p className="text-xs text-zinc-500">
                  Last sync {formatTime(activeRepoSync?.synced_at || activeRepo?.last_synced_at)} · commit{" "}
                  {shortSha(activeRepoSync?.commit_sha || activeRepo?.last_commit_sha)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => activeRepo && void syncRepo(activeRepo.id)}
                  disabled={!activeRepo || !activeDeviceId || busyKey === `sync:${activeRepo?.id}`}
                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-200 transition hover:bg-white/10 disabled:opacity-50"
                >
                  {busyKey === `sync:${activeRepo?.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Sync
                </button>
                <button
                  type="button"
                  onClick={() => void preflight(agentTarget === "claude" || agentTarget === "codex" ? agentTarget : "flow", selectedAgentId || null)}
                  disabled={!activeDeviceId || busyKey?.startsWith("preflight:")}
                  className="flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100 transition hover:bg-emerald-500/15 disabled:opacity-50"
                >
                  {busyKey?.startsWith("preflight:") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Preflight
                </button>
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  disabled={!isAdmin || repositories.length === 0}
                  className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-black transition hover:bg-zinc-200 disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  Create
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_280px]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search skills, docs, paths, checksums"
                  className="w-full rounded-lg border border-white/10 bg-black/30 py-2 pl-9 pr-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-400/40"
                />
              </div>
              <select
                value={selectedAgentId}
                onChange={(e) => {
                  const next = agents.find((agent) => agent.id === e.target.value) || null;
                  setSelectedAgentId(e.target.value);
                  if (next) setAgentTarget(next.target);
                }}
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none"
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} · {agent.target}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {loading ? (
              <div className="col-span-full flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] p-12 text-zinc-400">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Loading skills…
              </div>
            ) : filteredArtifacts.length === 0 ? (
              <div className="col-span-full rounded-xl border border-dashed border-white/10 bg-white/[0.03] p-10 text-center">
                <BookOpen className="mx-auto h-8 w-8 text-zinc-600" />
                <div className="mt-3 text-sm font-medium">No artifacts found</div>
                <p className="mt-1 text-xs text-zinc-500">Sync a repo with `skills/*/SKILL.md` or `instructions/**/*.md`.</p>
              </div>
            ) : (
              filteredArtifacts.map((artifact) => {
                const repo = repoById.get(artifact.repository_id);
                const isSkill = artifact.artifact_type === "skill";
                const agentAssignments = assignments.filter(
                  (assignment) =>
                    assignment.enabled &&
                    assignment.artifact_id === artifact.id &&
                    !!assignment.agent_id
                );
                const selectedAgentAssignment = selectedAgent
                  ? agentAssignments.find(
                      (assignment) =>
                        assignment.agent_id === selectedAgent.id &&
                        assignment.target === selectedAgent.target
                    ) ||
                    agentAssignments.find((assignment) => assignment.agent_id === selectedAgent.id) ||
                    null
                  : null;
                const selectedAgentAssignmentTarget =
                  selectedAgentAssignment?.target || selectedAgent?.target || "flow";
                const assignedAgentIds = new Set(
                  agentAssignments
                    .map((assignment) => assignment.agent_id)
                    .filter((agentId): agentId is string => !!agentId)
                );
                const selectedAgentMoveTargets = selectedAgentAssignment
                  ? compatibleDestinationAgents(artifact, selectedAgentAssignment)
                  : agents.filter(
                      (agent) =>
                        !assignedAgentIds.has(agent.id) &&
                        artifactSupportsTarget(artifact, agent.target)
                    );
                const remainingAgentAssignments = selectedAgentAssignment
                  ? agentAssignments.filter((assignment) => assignment.id !== selectedAgentAssignment.id)
                  : agentAssignments;
                return (
                  <div key={artifact.id} className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {isSkill ? (
                            <Sparkles className="h-4 w-4 text-emerald-300" />
                          ) : (
                            <FileText className="h-4 w-4 text-amber-300" />
                          )}
                          <h3 className="truncate text-sm font-semibold">{artifact.name}</h3>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-400">
                          {artifact.description || (isSkill ? "Repo-backed Agent Skill" : "Markdown instruction document")}
                        </p>
                      </div>
                      <span className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-400">
                        {isSkill ? "Skill" : "Doc"}
                      </span>
                    </div>

                    <div className="mt-3 space-y-2 text-xs">
                      <div className="truncate font-mono text-zinc-500">{artifact.relative_path}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {(artifact.targets || ["all"]).map((target) => (
                          <span key={target} className={`rounded-md border px-2 py-1 text-[11px] ${targetBadgeClass(target)}`}>
                            {target}
                          </span>
                        ))}
                        {(artifact.risk_flags || []).map((flag) => (
                          <span key={flag} className="rounded-md border border-amber-400/20 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                            {riskLabel(flag)}
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center justify-between text-zinc-500">
                        <span>{repo?.label || "Repo"}</span>
                        <span className="font-mono">{shortSha(artifact.commit_sha)}</span>
                      </div>
                    </div>

                    <div className="mt-4 border-t border-white/10 pt-4">
                      <div className="mb-2">
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">Global assignment</div>
                        <div className="mt-0.5 text-[11px] text-zinc-600">Applies to every agent matching the target.</div>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {TARGETS.map((target) => {
                          const Icon = target.icon;
                          const assigned = isAssigned(artifact.id, target.id);
                          const supported = artifactSupportsTarget(artifact, target.id);
                          return (
                            <button
                              key={target.id}
                              type="button"
                              onClick={() => void toggleAssignment(artifact, target.id)}
                              disabled={!isAdmin || !supported || busyKey === `assign:${artifact.id}:${target.id}:workspace`}
                              title={supported ? `Assign to all ${target.label} agents` : `Not declared compatible with ${target.label}`}
                              className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs transition disabled:opacity-50 ${
                                assigned
                                  ? targetBadgeClass(target.id)
                                  : "border-white/10 bg-black/20 text-zinc-400 hover:bg-white/[0.06]"
                              }`}
                            >
                              <Icon className="h-3.5 w-3.5" />
                              All {target.label}
                            </button>
                          );
                        })}
                      </div>

                      {selectedAgent && (
                        <>
                          <div className="mt-4 mb-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide text-zinc-500">
                            <span>Selected agent</span>
                            <span className="truncate normal-case tracking-normal text-zinc-400">{selectedAgent.name}</span>
                          </div>
                          <div className="grid gap-2 md:grid-cols-[1fr_180px]">
                            <button
                              type="button"
                              onClick={() => void toggleAssignment(artifact, selectedAgentAssignmentTarget, selectedAgent.id)}
                              disabled={
                                !isAdmin ||
                                !artifactSupportsTarget(artifact, selectedAgentAssignmentTarget) ||
                                busyKey === `assign:${artifact.id}:${selectedAgentAssignmentTarget}:${selectedAgent.id}`
                              }
                              className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs transition disabled:opacity-50 ${
                                selectedAgentAssignment
                                  ? targetBadgeClass(selectedAgent.target)
                                  : "border-white/10 bg-black/20 text-zinc-300 hover:bg-white/[0.06]"
                              }`}
                            >
                              <Check className="h-3.5 w-3.5" />
                              {selectedAgentAssignment ? "Assigned only to this agent" : "Assign only to this agent"}
                            </button>
                            <select
                              value=""
                              onChange={(e) => {
                                const toAgentId = e.target.value;
                                const toAgent = agents.find((agent) => agent.id === toAgentId) || null;
                                if (!toAgentId || !toAgent) return;
                                if (selectedAgentAssignment) {
                                  void reassignAssignment(selectedAgentAssignment, artifact, toAgentId);
                                } else {
                                  void toggleAssignment(artifact, toAgent.target, toAgentId);
                                }
                                e.currentTarget.value = "";
                              }}
                              disabled={
                                !isAdmin ||
                                selectedAgentMoveTargets.length === 0 ||
                                (selectedAgentAssignment
                                  ? busyKey === `reassign:${selectedAgentAssignment.id}`
                                  : busyKey !== null)
                              }
                              title={selectedAgentAssignment ? "Move this skill to another agent" : "Assign this skill to an agent"}
                              className="rounded-lg border border-white/10 bg-black/40 px-2 py-2 text-xs text-zinc-200 outline-none disabled:opacity-50"
                            >
                              <option value="">
                                {selectedAgentAssignment && busyKey === `reassign:${selectedAgentAssignment.id}`
                                  ? "Moving..."
                                  : selectedAgentAssignment
                                    ? "Move to..."
                                    : "Assign to..."}
                              </option>
                              {selectedAgentMoveTargets.map((agent) => (
                                <option key={agent.id} value={agent.id}>
                                  {agent.name} · {agent.target}
                                </option>
                              ))}
                            </select>
                          </div>
                        </>
                      )}

                      {remainingAgentAssignments.length > 0 && (
                        <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3">
                          <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-zinc-500">
                            <ArrowRightLeft className="h-3.5 w-3.5" />
                            Other assigned agents
                          </div>
                          <div className="space-y-2">
                            {remainingAgentAssignments.map((assignment) => {
                              const currentAgent = assignment.agent_id
                                ? agentById.get(assignment.agent_id)
                                : null;
                              const compatibleAgents = compatibleDestinationAgents(artifact, assignment);
                              return (
                                <div
                                  key={assignment.id}
                                  className="grid gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2 md:grid-cols-[1fr_180px]"
                                >
                                  <div className="min-w-0">
                                    <div className="truncate text-xs text-zinc-200">
                                      {currentAgent?.name || "Unknown agent"}
                                    </div>
                                    <div className="text-[10px] text-zinc-500">
                                      {assignment.target}
                                    </div>
                                  </div>
                                  <select
                                    value=""
                                    onChange={(e) => {
                                      const toAgentId = e.target.value;
                                      if (!toAgentId) return;
                                      void reassignAssignment(assignment, artifact, toAgentId);
                                      e.currentTarget.value = "";
                                    }}
                                    disabled={
                                      !isAdmin ||
                                      compatibleAgents.length === 0 ||
                                      busyKey === `reassign:${assignment.id}`
                                    }
                                    className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-zinc-200 outline-none disabled:opacity-50"
                                  >
                                    <option value="">
                                      {busyKey === `reassign:${assignment.id}`
                                        ? "Moving..."
                                        : "Move to..."}
                                    </option>
                                    {compatibleAgents.map((agent) => (
                                      <option key={agent.id} value={agent.id}>
                                        {agent.name} · {agent.target}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-zinc-400" />
              <h2 className="text-sm font-semibold">Audit</h2>
            </div>
            <div className="space-y-2">
              {(state?.auditEvents || []).slice(0, 8).map((event) => (
                <div key={event.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs">
                  <span className="truncate text-zinc-300">{event.event_type.replace(/_/g, " ")}</span>
                  <span className="shrink-0 text-zinc-500">{formatTime(event.created_at)}</span>
                </div>
              ))}
              {(state?.auditEvents || []).length === 0 && <div className="text-xs text-zinc-500">No audit events yet.</div>}
            </div>
          </div>
        </section>
      </main>

      {helpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950 p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">How Skills Manager Works</h2>
                <p className="mt-1 text-sm text-zinc-400">Use Git as the source of truth. Groovy coordinates sync, assignments, and preflight.</p>
              </div>
              <button type="button" onClick={() => setHelpOpen(false)} className="rounded-lg p-2 text-zinc-400 hover:bg-white/5 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <h3 className="text-sm font-semibold text-emerald-200">Step by step</h3>
                <ol className="mt-3 space-y-2 text-sm text-zinc-300">
                  <li>1. Create a private repo for agent context.</li>
                  <li>2. Add `skills/name/SKILL.md` folders and `instructions/**/*.md` docs.</li>
                  <li>3. Paste the repo URL here.</li>
                  <li>4. The connector runs local `git clone` using the user&apos;s CLI permissions.</li>
                  <li>5. Assign skills/docs to Flow, Claude, Codex, or specific agents.</li>
                  <li>6. Preflight materializes assigned files locally before an agent runs.</li>
                </ol>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <h3 className="text-sm font-semibold text-cyan-200">Recommended repo layout</h3>
                <pre className="mt-3 overflow-x-auto rounded-lg bg-black/35 p-3 text-xs text-zinc-300">{`company-agent-context/
  README.md
  skills/
    security-review/
      SKILL.md
      scripts/
      references/
  instructions/
    shared/
      AGENTS.md
    claude/
      CLAUDE.md
    codex/
      CODEX.md
    flow/
      release-process.md`}</pre>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-500/10 p-4 text-sm text-amber-100/80">
              <div className="font-semibold text-amber-100">Permission failure means local Git failed</div>
              <p className="mt-1">
                We do not use a GitHub App or OAuth. If sync fails, run `git ls-remote &lt;repo&gt;` and `ssh -T git@github.com` on the same Mac, then retry.
              </p>
            </div>
          </div>
        </div>
      )}

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950 p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Create Repo Artifact</h2>
                <p className="mt-1 text-sm text-zinc-400">The connector writes this file into the local repo checkout. Flow does not persist the body.</p>
              </div>
              <button type="button" onClick={() => setCreateOpen(false)} className="rounded-lg p-2 text-zinc-400 hover:bg-white/5 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-[300px_1fr]">
              <div className="space-y-3">
                <select
                  value={selectedRepoId}
                  onChange={(e) => setSelectedRepoId(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none"
                >
                  {repositories.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.label}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCreateKind("skill")}
                    className={`rounded-lg border px-3 py-2 text-sm ${createKind === "skill" ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100" : "border-white/10 bg-black/20 text-zinc-300"}`}
                  >
                    Skill
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreateKind("instruction_doc")}
                    className={`rounded-lg border px-3 py-2 text-sm ${createKind === "instruction_doc" ? "border-amber-400/30 bg-amber-500/10 text-amber-100" : "border-white/10 bg-black/20 text-zinc-300"}`}
                  >
                    .md Doc
                  </button>
                </div>
                <input
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none"
                  placeholder="Name"
                />
                <input
                  value={createPath}
                  onChange={(e) => setCreatePath(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white outline-none"
                  placeholder="instructions/shared/AGENTS.md"
                />
                <div className="grid grid-cols-2 gap-2">
                  {(["all", "flow", "claude", "codex"] as Target[]).map((target) => {
                    const enabled = createTargets.includes(target);
                    return (
                      <button
                        key={target}
                        type="button"
                        onClick={() => {
                          setCreateTargets((prev) => {
                            if (target === "all") return ["all"];
                            const next = prev.filter((item) => item !== "all");
                            return enabled ? next.filter((item) => item !== target) : [...next, target];
                          });
                        }}
                        className={`rounded-lg border px-3 py-2 text-xs ${enabled ? targetBadgeClass(target) : "border-white/10 bg-black/20 text-zinc-400"}`}
                      >
                        {target}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => void createArtifact()}
                  disabled={busyKey === "create_artifact" || !activeDeviceId}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-black transition hover:bg-zinc-200 disabled:opacity-50"
                >
                  {busyKey === "create_artifact" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Write to Local Repo
                </button>
              </div>
              <textarea
                value={createContent}
                onChange={(e) => setCreateContent(e.target.value)}
                className="min-h-[430px] w-full rounded-xl border border-white/10 bg-black/35 p-4 font-mono text-xs leading-relaxed text-zinc-100 outline-none focus:border-cyan-400/40"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
