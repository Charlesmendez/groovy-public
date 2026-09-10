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
  Pencil,
  Laptop2,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import { useRelay, type RelayMessage } from "@/hooks/useRelay";
import { CustomSelect } from "@/components/ui/CustomSelect";
import {
  defaultSkillActionsManifest,
  skillActionsManifestRelativePath,
} from "@/lib/skills-manager/actionManifestAuthoring";

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
  content_snapshot?: string | null;
  content_snapshot_truncated?: boolean;
  content_snapshot_updated_at?: string | null;
  updated_at?: string | null;
};

type Assignment = {
  id: string;
  artifact_id: string;
  agent_id?: string | null;
  profile_id?: string | null;
  target: Target;
  scope: "workspace" | "agent" | "profile";
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

type RuntimeSkillVersion = {
  id: string;
  skill_id: string;
  version: number;
  lifecycle: string;
  runner: string;
  validation_status: string;
  validation_task?: string | null;
  validated_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type RuntimeSkill = {
  id: string;
  user_id: string;
  agent_id: string;
  agent_name: string;
  slug: string;
  name: string;
  description: string;
  lifecycle: string;
  runner: string;
  latest_version: number;
  active_version_id?: string | null;
  rollback_version_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  versions: RuntimeSkillVersion[];
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
  runtimeSkills: RuntimeSkill[];
  privacy: {
    storesContents: boolean;
    summary: string;
  };
};

type CreateKind = "skill" | "instruction_doc";

const TARGETS: Array<{ id: Target; label: string; icon: typeof Sparkles }> = [
  { id: "flow", label: "Orchestrator", icon: Sparkles },
  { id: "claude", label: "Claude", icon: Terminal },
  { id: "codex", label: "Codex", icon: Code2 },
];

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function formatSkillsActionError(json: Record<string, unknown>, fallback: string) {
  const result = asRecord(json.result);
  const diagnostics = asRecord(result.diagnostics);
  const errorCode = asString(json.error || result.error || result.error_code || result.code);
  if (errorCode === "artifact_already_exists") {
    const relativePath = asString(result.relativePath || result.relative_path || diagnostics.relativePath);
    const localPath = asString(result.localPath || result.local_path || diagnostics.localPath);
    const artifactType = asString(result.artifactType || result.artifact_type || diagnostics.artifactType);
    return [
      `Artifact already exists${relativePath ? ` at ${relativePath}` : ""}.`,
      artifactType ? `Type: ${artifactType}` : "",
      localPath ? `Local checkout: ${localPath}` : "",
      "Retry Sync succeeded, so Git access is working. If this is an existing artifact, select the same repo/path after sync so Skills Manager can update it; otherwise change the name or path before writing.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (errorCode === "artifact_changed_on_remote") {
    return "This skill changed on GitHub after you opened it. Pull from GitHub, review the latest instructions, and edit again. Your newer GitHub version was not overwritten.";
  }
  return errorCode || fallback;
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
  return target === "all"
    ? "border-white/15 bg-white/[0.07] text-zinc-200"
    : "border-cyan-400/30 bg-cyan-500/10 text-cyan-100";
}

function riskLabel(flag: string) {
  return flag.replace(/_/g, " ");
}

function artifactActions(artifact: Artifact) {
  const manifest = asRecord(asRecord(artifact.metadata).groovyActions);
  return Array.isArray(manifest.actions) ? manifest.actions.map(asRecord) : [];
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

export function SkillsManagerContent({
  embedded = false,
}: {
  embedded?: boolean;
} = {}) {
  const relay = useRelay({ enabled: true });

  const [state, setState] = useState<SkillsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [onlineDevices, setOnlineDevices] = useState<Map<string, RelayMessage>>(new Map());
  const [helpOpen, setHelpOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingArtifact, setEditingArtifact] = useState<Artifact | null>(null);
  const [editContent, setEditContent] = useState("");
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
  const [createActionsEnabled, setCreateActionsEnabled] = useState(false);
  const [createActionsContent, setCreateActionsContent] = useState(
    defaultSkillActionsManifest,
  );

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
  const runtimeSkills = useMemo(() => state?.runtimeSkills || [], [state?.runtimeSkills]);
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

  const existingCreateArtifact = useMemo(() => {
    const normalizedPath = createPath.trim();
    if (!selectedRepoId || !normalizedPath) return null;
    return (
      artifacts.find(
        (artifact) =>
          artifact.repository_id === selectedRepoId &&
          artifact.artifact_type === createKind &&
          artifact.relative_path === normalizedPath
      ) || null
    );
  }, [artifacts, createKind, createPath, selectedRepoId]);
  const createActionsPath = useMemo(() => {
    if (createKind !== "skill") return "";
    try {
      return skillActionsManifestRelativePath(createPath);
    } catch {
      return "groovy-actions.json";
    }
  }, [createKind, createPath]);

  const filteredRuntimeSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return runtimeSkills;
    return runtimeSkills.filter((skill) =>
      [
        skill.name,
        skill.description,
        skill.slug,
        skill.agent_name,
        skill.lifecycle,
        skill.runner,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [query, runtimeSkills]);

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
      const normalizedName = createName.trim().toUpperCase();
      const filename =
        normalizedName === "AGENTS"
          ? "AGENTS.md"
          : normalizedName === "CLAUDE"
            ? "CLAUDE.md"
            : normalizedName === "CODEX"
              ? "CODEX.md"
              : `${slug || "agent-instructions"}.md`;
      setCreatePath(`instructions/shared/${filename}`);
      setCreateContent(defaultInstructionContent(createName || filename.replace(/\.md$/i, ""), createTargets));
    }
  }, [createKind, createName, createTargets]);

  useEffect(() => {
    if (createKind !== "skill") setCreateActionsEnabled(false);
  }, [createKind]);

  async function postAction(body: Record<string, unknown>, busy: string, successMessage?: string) {
    setBusyKey(busy);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/workspaces/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error || json.ok === false) {
        await loadState();
        throw new Error(formatSkillsActionError(asRecord(json), "Skills Manager action failed"));
      }
      await loadState();
      if (successMessage) setNotice(successMessage);
      return json;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Skills Manager action failed");
      setNotice(null);
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
      "connect_repo",
      activeDeviceId ? "Repo connected and synced." : "Repo connected."
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
      `sync:${repositoryId}`,
      "Repo sync completed."
    );
  };

  const pushRepoChanges = async (repositoryId: string, label = "Repo") => {
    if (!activeDeviceId) {
      setError("Start the Groovy Connector first, then retry sync.");
      return;
    }
    await postAction(
      { action: "push_repo", repositoryId, deviceId: activeDeviceId },
      `push:${repositoryId}`,
      `${label} synced to the repo.`
    );
  };

  const preflight = async (target: "flow" | "claude" | "codex", agentId?: string | null) => {
    if (!activeDeviceId) {
      setError("Start the Groovy Connector first, then retry preflight.");
      return;
    }
    await postAction(
      { action: "preflight", deviceId: activeDeviceId, target, agentId: agentId || null },
      `preflight:${target}:${agentId || "workspace"}`,
      "Preflight completed."
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
        overwrite: Boolean(existingCreateArtifact),
        actionsManifest:
          createKind === "skill" && createActionsEnabled
            ? createActionsContent
            : undefined,
      },
      "create_artifact",
      createActionsEnabled
        ? `${existingCreateArtifact ? "Skill updated" : "Skill created"} with groovy-actions.json and pushed to the repo.`
        : existingCreateArtifact
          ? "Artifact updated and pushed to the repo."
          : "Artifact created and pushed to the repo."
    );
    if (result) setCreateOpen(false);
  };

  const openArtifactEditor = (artifact: Artifact) => {
    if (artifact.content_snapshot_truncated) {
      setError("This file is too large for the browser editor. Edit it in the connected Git repository, then pull the latest version into Groovy.");
      return;
    }
    if (!artifact.content_snapshot) {
      setError("Groovy does not have an editable snapshot yet. Pull the latest version from GitHub, then try again.");
      return;
    }
    setEditingArtifact(artifact);
    setEditContent(artifact.content_snapshot);
    setError(null);
  };

  const saveArtifactEdit = async () => {
    if (!editingArtifact || !activeDeviceId) return;
    const result = await postAction(
      {
        action: "create_artifact",
        repositoryId: editingArtifact.repository_id,
        deviceId: activeDeviceId,
        artifactType: editingArtifact.artifact_type,
        relativePath: editingArtifact.relative_path,
        content: editContent,
        name: editingArtifact.name,
        targets: editingArtifact.targets,
        overwrite: true,
        expectedCommitSha: editingArtifact.commit_sha,
        commitMessage: `Edit ${editingArtifact.name} in Groovy`,
      },
      `edit:${editingArtifact.id}`,
      "Instructions saved and pushed to GitHub."
    );
    if (result) setEditingArtifact(null);
  };

  const exportRuntimeSkill = async (skill: RuntimeSkill) => {
    if (!selectedRepoId) {
      setError("Select a skills repo first.");
      return;
    }
    if (!activeDeviceId) {
      setError("Start the Groovy Connector first. Export writes into the local repo checkout.");
      return;
    }
    await postAction(
      {
        action: "export_runtime_skill",
        runtimeSkillId: skill.id,
        repositoryId: selectedRepoId,
        deviceId: activeDeviceId,
      },
      `export_runtime:${skill.id}`,
      `${skill.name} synced to the repo.`
    );
  };

  const isAssigned = (artifactId: string, target: Target, agentId?: string | null) =>
    assignments.some(
      (assignment) =>
        assignment.enabled &&
        assignment.artifact_id === artifactId &&
        assignment.target === target &&
        !assignment.profile_id &&
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
  const activeRepoStatus = activeRepoSync?.status || "never";
  const activeRepoNeedsAttention = Boolean(activeRepo && activeRepoStatus !== "synced");
  const activeRepoSyncBusy = activeRepo ? busyKey === `sync:${activeRepo.id}` : false;
  const activeRepoProblemTitle =
    activeRepoStatus === "no_permission"
      ? "Repo access failed on this Mac"
      : activeRepoStatus === "offline"
        ? "Connector is offline"
        : activeRepoStatus === "error"
          ? "Repo sync failed"
          : "Repo has not synced yet";
  const activeRepoProblemBody =
    activeRepoStatus === "no_permission"
      ? "Your local Git CLI could not access this repo."
      : activeRepoStatus === "offline"
        ? "Start the Groovy Connector on this Mac, then retry the sync."
        : activeRepoStatus === "error"
          ? "The last local sync attempt failed before this repo could be scanned."
          : "Run a sync to clone or refresh the local repo checkout.";
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
    <div
      className={`bg-[#08090b] text-white ${
        embedded ? "" : "app-scroll-page"
      }`}
    >
      <div
        className={`border-b border-white/10 bg-[#08090b]/90 backdrop-blur-xl ${
          embedded ? "relative" : "sticky top-0 z-30"
        }`}
      >
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            {!embedded ? (
              <a
                href="/dashboard"
                className="rounded-lg p-2 text-zinc-400 transition hover:bg-white/5 hover:text-white"
                title="Back to dashboard"
                aria-label="Back to dashboard"
              >
                <ArrowLeft className="h-5 w-5" />
              </a>
            ) : null}
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-zinc-300" />
                <h1 className="text-lg font-semibold">Skills &amp; Docs</h1>
              </div>
              <p className="text-xs text-zinc-500">
                Your shared library for orchestrator and worker-agent behavior.
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
        <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5 lg:col-span-2">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="max-w-2xl">
              <h2 className="text-base font-semibold text-white">
                A skill starts with one Markdown file
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-zinc-300">
                <span className="font-mono text-white">SKILL.md</span> tells an agent when to use a skill and what steps to follow.
                Most skills need only this file. Advanced skills can add scripts, references, or a
                <span className="font-mono text-white"> groovy-actions.json</span> file when they need a safe, secret-backed API action.
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                Use <strong className="text-zinc-300">Create skill or doc</strong>, choose Skill, then select <strong className="text-zinc-300">Add API actions</strong> to create both files together.
              </p>
            </div>
            <div className="grid shrink-0 grid-cols-3 gap-2 text-center text-[11px] text-zinc-300">
              <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">1. Write instructions</div>
              <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">2. Assign a Mind</div>
              <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">3. Test in Chat</div>
            </div>
          </div>
        </section>
        <section className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.035] p-4">
            <div className="flex items-start gap-3">
              <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" />
              <div>
                <div className="text-sm font-medium text-zinc-200">
                  {state?.privacy?.storesContents
                    ? "Cross-surface Markdown snapshots enabled"
                    : "Repo contents stay local"}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  {state?.privacy?.summary ||
                    "Groovy stores metadata, assignments, and bounded snapshots of assigned Markdown so the same capability works in Chat, Command Center, messaging, and API runs. The connector still performs repository discovery and writes locally."}
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
              <Laptop2 className={activeDeviceId ? "h-5 w-5 text-zinc-300" : "h-5 w-5 text-zinc-600"} />
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
                <CustomSelect
                  ariaLabel="Active connector"
                  size="sm"
                  className="mt-3 w-full"
                  value={activeDeviceId || ""}
                  onChange={(value) => setActiveDeviceId(value || null)}
                  options={Array.from(onlineDevices.keys()).map((deviceId) => ({
                    value: deviceId,
                    label: `Device ${deviceId.slice(0, 8)}`,
                  }))}
                />
              )}
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-zinc-400" />
              <h2 className="text-sm font-semibold">Connect Library Repo</h2>
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
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busyKey === "connect_repo" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Connect Library
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
                  const status = sync?.status || "never";
                  const needsRetry = status !== "synced";
                  const repoSyncBusy = busyKey === `sync:${repo.id}`;
                  return (
                    <div
                      key={repo.id}
                      className={`w-full rounded-lg border p-3 text-left transition ${
                        active
                          ? "border-white/25 bg-white/[0.07]"
                          : "border-white/10 bg-black/20 hover:bg-white/[0.06]"
                      }`}
                    >
                      <button type="button" onClick={() => setSelectedRepoId(repo.id)} className="w-full text-left">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{repo.label}</span>
                          {status === "synced" ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                          ) : status === "no_permission" || status === "error" || status === "offline" ? (
                            <AlertTriangle className="h-4 w-4 text-amber-300" />
                          ) : (
                            <GitBranch className="h-4 w-4 text-zinc-500" />
                          )}
                        </div>
                        <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">{repo.repo_url}</div>
                        <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
                          <span>{status === "never" ? "never synced" : status}</span>
                          <span>{shortSha(sync?.commit_sha || repo.last_commit_sha)}</span>
                        </div>
                      </button>
                      {needsRetry && (
                        <button
                          type="button"
                          onClick={() => void syncRepo(repo.id)}
                          disabled={!activeDeviceId || repoSyncBusy}
                          title={!activeDeviceId ? "Start the Groovy Connector first" : "Retry syncing this repo"}
                          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {repoSyncBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                          Retry Sync
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>

        <section className="min-w-0 space-y-5">
          {error && (
            <div className="whitespace-pre-wrap rounded-xl border border-rose-400/25 bg-rose-500/10 p-4 text-sm text-rose-100">
              {error}
            </div>
          )}
          {notice && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-4 text-sm text-emerald-100">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300" />
              {notice}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-white/10 bg-white/[0.025] px-4 py-3 text-xs text-zinc-500">
            <span><strong className="font-medium text-zinc-300">{artifacts.length}</strong> skills &amp; docs</span>
            <span><strong className="font-medium text-zinc-300">{assignments.length}</strong> assignments</span>
            {runtimeSkills.length > 0 && <span><strong className="font-medium text-zinc-300">{runtimeSkills.length}</strong> agent-authored</span>}
            <span className="ml-auto"><strong className="font-medium text-zinc-300">{syncs.filter((sync) => sync.status === "synced").length}</strong> of {repositories.length} repos synced</span>
          </div>

          {activeRepoNeedsAttention && (
            <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                  <div>
                    <div className="text-sm font-semibold text-amber-100">{activeRepoProblemTitle}</div>
                    <p className="mt-1 text-sm text-amber-100/75">{activeRepoProblemBody}</p>
                    {activeRepoSync?.last_error_message && (
                      <div className="mt-3 break-words rounded-lg border border-amber-400/20 bg-black/25 p-3 font-mono text-xs text-amber-100/80">
                        {activeRepoSync.last_error_message}
                      </div>
                    )}
                    {activeRepoStatus === "no_permission" && (
                      <div className="mt-3 rounded-lg border border-amber-400/20 bg-black/25 p-3 font-mono text-xs text-amber-100/80">
                        git ls-remote {activeRepo?.repo_url}
                        <br />
                        ssh -T git@github.com
                      </div>
                    )}
                    <p className="mt-3 text-xs text-amber-100/70">
                      Retry uses your active Groovy Connector and the Git credentials configured on this Mac.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => activeRepo && void syncRepo(activeRepo.id)}
                  disabled={!activeRepo || !activeDeviceId || activeRepoSyncBusy}
                  title={!activeDeviceId ? "Start the Groovy Connector first" : "Retry syncing this repo"}
                  className="flex shrink-0 items-center justify-center gap-2 rounded-lg border border-amber-300/25 bg-amber-400 px-3 py-2 text-xs font-semibold text-black transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50 md:min-w-32"
                >
                  {activeRepoSyncBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Retry Sync
                </button>
              </div>
            </div>
          )}

          {runtimeSkills.length > 0 && (
            <details className="group rounded-xl border border-white/10 bg-white/[0.035] p-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-zinc-400" />
                    <h2 className="text-sm font-semibold text-zinc-200">Agent-authored skills</h2>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">Advanced: skills created by agents in the runtime registry.</p>
                </div>
                <span className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-xs text-zinc-400">{filteredRuntimeSkills.length}</span>
              </summary>
              <div className="mt-4 border-t border-white/10 pt-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-zinc-400" />
                    <h2 className="text-base font-semibold text-zinc-200">Runtime registry</h2>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    Created through Orchestrator and stored in the runtime skill registry.
                  </p>
                </div>
                <span className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-xs text-zinc-400">
                  {filteredRuntimeSkills.length} shown
                </span>
              </div>

              {filteredRuntimeSkills.length === 0 ? (
                <div className="mt-4 rounded-lg border border-dashed border-white/10 p-4 text-xs text-zinc-500">
                  No runtime skills match the current search.
                </div>
              ) : (
                <div className="mt-4 grid gap-3 lg:grid-cols-2">
                  {filteredRuntimeSkills.map((skill) => {
                    const activeVersion = skill.versions.find((version) => version.id === skill.active_version_id) || null;
                    const latestVersion = skill.versions[0] || null;
                    const validationStatus =
                      activeVersion?.validation_status ||
                      latestVersion?.validation_status ||
                      "unvalidated";
                    return (
                      <div key={skill.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Sparkles className="h-4 w-4 text-zinc-400" />
                              <h3 className="truncate text-sm font-semibold text-white">{skill.name}</h3>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-500">
                              {skill.description || "Orchestrator runtime skill"}
                            </p>
                          </div>
                          <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase text-zinc-400">
                            {skill.lifecycle}
                          </span>
                        </div>
                        <div className="mt-3 grid gap-2 text-xs text-zinc-400 sm:grid-cols-2">
                          <div className="truncate">
                            <span className="text-zinc-600">Agent:</span> {skill.agent_name}
                          </div>
                          <div className="truncate">
                            <span className="text-zinc-600">Tool:</span> skill_{skill.slug}
                          </div>
                          <div>
                            <span className="text-zinc-600">Versions:</span> {skill.versions.length || skill.latest_version || 1}
                          </div>
                          <div>
                            <span className="text-zinc-600">Validation:</span> {validationStatus}
                          </div>
                        </div>
                        <div className="mt-3 flex items-center justify-end border-t border-white/10 pt-3">
                          <button
                            type="button"
                            onClick={() => void exportRuntimeSkill(skill)}
                            disabled={
                              !isAdmin ||
                              !selectedRepoId ||
                              !activeDeviceId ||
                              busyKey === `export_runtime:${skill.id}`
                            }
                            title={
                              !selectedRepoId
                                ? "Select a skills repo first"
                                : !activeDeviceId
                                  ? "Start the Groovy Connector first"
                                  : "Write this runtime skill into the selected skills repo"
                            }
                            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-200 transition hover:bg-white/10 disabled:opacity-50"
                          >
                            {busyKey === `export_runtime:${skill.id}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <GitBranch className="h-3.5 w-3.5" />
                            )}
                            Export to GitHub
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              </div>
            </details>
          )}

          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-base font-semibold">{activeRepo?.label || "Skills & Docs Library"}</h2>
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
                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-transparent px-3 py-2 text-xs text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 disabled:opacity-50"
                >
                  {busyKey === `sync:${activeRepo?.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Pull from GitHub
                </button>
                <button
                  type="button"
                  onClick={() => activeRepo && void pushRepoChanges(activeRepo.id, activeRepo.label || "Repo")}
                  disabled={!isAdmin || !activeRepo || !activeDeviceId || busyKey === `push:${activeRepo?.id}`}
                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-transparent px-3 py-2 text-xs text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 disabled:opacity-50"
                >
                  {busyKey === `push:${activeRepo?.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Push local changes
                </button>
                <button
                  type="button"
                  onClick={() => void preflight(agentTarget === "claude" || agentTarget === "codex" ? agentTarget : "flow", selectedAgentId || null)}
                  disabled={!activeDeviceId || busyKey?.startsWith("preflight:")}
                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-transparent px-3 py-2 text-xs text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 disabled:opacity-50"
                >
                  {busyKey?.startsWith("preflight:") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Prepare for selected agent
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setCreateOpen(true);
                  }}
                  disabled={!isAdmin || repositories.length === 0}
                  className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-black transition hover:bg-zinc-200 disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  Create skill or doc
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
              <CustomSelect
                ariaLabel="Selected agent"
                value={selectedAgentId}
                onChange={(value) => {
                  const next = agents.find((agent) => agent.id === value) || null;
                  setSelectedAgentId(value);
                  if (next) setAgentTarget(next.target);
                }}
                options={agents.map((agent) => ({
                  value: agent.id,
                  label: agent.name,
                  description: agent.target,
                }))}
              />
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
                const actions = artifactActions(artifact);
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
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {isSkill ? (
                            <Sparkles className="h-4 w-4 text-zinc-300" />
                          ) : (
                            <FileText className="h-4 w-4 text-zinc-400" />
                          )}
                          <h3 className="truncate text-sm font-semibold">{artifact.name}</h3>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-400">
                          {artifact.description || (isSkill ? "Repo-backed Agent Skill" : "Markdown instruction document")}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                        <span className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-400">
                          {isSkill ? "Skill" : "Doc"}
                        </span>
                        <button
                          type="button"
                          onClick={() => openArtifactEditor(artifact)}
                          disabled={!isAdmin || !activeDeviceId || !artifact.content_snapshot || artifact.content_snapshot_truncated}
                          title={!activeDeviceId ? "Start the Groovy Connector first" : "Edit this Markdown file and save it to GitHub"}
                          className="flex min-h-8 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-200 transition hover:bg-white/10 disabled:opacity-50"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Edit instructions
                        </button>
                      </div>
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
                          <span key={flag} className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-500">
                            {riskLabel(flag)}
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center justify-between text-zinc-500">
                        <span>{repo?.label || "Repo"}</span>
                        <span className="font-mono">GitHub {shortSha(artifact.commit_sha)}</span>
                      </div>
                      {actions.length > 0 ? (
                        <details className="rounded-lg border border-white/10 bg-black/20 p-3 text-zinc-500">
                          <summary className="cursor-pointer text-xs font-medium text-zinc-300">Advanced actions · {actions.length}</summary>
                          <p className="mt-1 leading-relaxed">
                            This skill also has <span className="font-mono text-zinc-300">groovy-actions.json</span>. It declares the specific operations Groovy may run and which secret names they require. Secret values never belong in this file.
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {actions.map((action) => (
                              <span key={asString(action.name)} className="rounded border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-zinc-400">
                                {asString(action.name)}
                              </span>
                            ))}
                          </div>
                        </details>
                      ) : isSkill ? (
                        <p className="text-zinc-600">Markdown-only skill — no JSON or code is required.</p>
                      ) : null}
                    </div>

                    <div className="mt-4 border-t border-white/10 pt-4">
                      <div className="mb-2">
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">Assign globally</div>
                        <div className="mt-0.5 text-[11px] text-zinc-600">The orchestrator or every worker using that harness receives it.</div>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-3">
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
                              {target.id === "flow" ? target.label : `All ${target.label} agents`}
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
                            <CustomSelect
                              ariaLabel={selectedAgentAssignment ? "Move this skill to another agent" : "Assign this skill to an agent"}
                              size="sm"
                              value=""
                              onChange={(toAgentId) => {
                                const toAgent = agents.find((agent) => agent.id === toAgentId) || null;
                                if (!toAgentId || !toAgent) return;
                                if (selectedAgentAssignment) {
                                  void reassignAssignment(selectedAgentAssignment, artifact, toAgentId);
                                } else {
                                  void toggleAssignment(artifact, toAgent.target, toAgentId);
                                }
                              }}
                              disabled={
                                !isAdmin ||
                                selectedAgentMoveTargets.length === 0 ||
                                (selectedAgentAssignment
                                  ? busyKey === `reassign:${selectedAgentAssignment.id}`
                                  : busyKey !== null)
                              }
                              placeholder={
                                selectedAgentAssignment && busyKey === `reassign:${selectedAgentAssignment.id}`
                                  ? "Moving..."
                                  : selectedAgentAssignment
                                    ? "Move to..."
                                    : "Assign to..."
                              }
                              options={selectedAgentMoveTargets.map((agent) => ({
                                value: agent.id,
                                label: agent.name,
                                description: agent.target,
                              }))}
                            />
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
                                  <CustomSelect
                                    ariaLabel={`Move ${currentAgent?.name || "assigned agent"}`}
                                    size="sm"
                                    value=""
                                    onChange={(toAgentId) => {
                                      if (!toAgentId) return;
                                      void reassignAssignment(assignment, artifact, toAgentId);
                                    }}
                                    disabled={
                                      !isAdmin ||
                                      compatibleAgents.length === 0 ||
                                      busyKey === `reassign:${assignment.id}`
                                    }
                                    placeholder={busyKey === `reassign:${assignment.id}` ? "Moving..." : "Move to..."}
                                    options={compatibleAgents.map((agent) => ({
                                      value: agent.id,
                                      label: agent.name,
                                      description: agent.target,
                                    }))}
                                  />
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
                <h2 className="text-lg font-semibold">Skills, explained simply</h2>
                <p className="mt-1 text-sm text-zinc-400">Start with Markdown. Add advanced files only when the skill truly needs them.</p>
              </div>
              <button type="button" onClick={() => setHelpOpen(false)} className="rounded-lg p-2 text-zinc-400 hover:bg-white/5 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <h3 className="text-sm font-semibold text-zinc-200">What files do I need?</h3>
                <ol className="mt-3 space-y-2 text-sm text-zinc-300">
                  <li><span className="font-mono text-white">SKILL.md</span> is the skill. It contains plain-language instructions. This is enough for most skills.</li>
                  <li><span className="font-mono text-white">groovy-actions.json</span> is optional. It declares approved API or local actions and the secret names they require.</li>
                  <li><span className="font-mono">scripts/</span> and <span className="font-mono">references/</span> are optional supporting files.</li>
                  <li>Never put passwords, tokens, or secret values in repository files. Assign secrets in Workspace Settings.</li>
                </ol>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <h3 className="text-sm font-semibold text-zinc-200">Recommended repo layout</h3>
                <pre className="mt-3 overflow-x-auto rounded-lg bg-black/35 p-3 text-xs text-zinc-300">{`company-agent-context/
  README.md
  skills/
    security-review/
      SKILL.md
      groovy-actions.json  # optional
      scripts/             # optional
      references/          # optional
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

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4 text-sm text-zinc-300">
                <h3 className="font-semibold text-white">How do I edit a skill?</h3>
                <p className="mt-2 leading-relaxed">Click <strong>Edit instructions</strong> on a skill card. Groovy opens its <span className="font-mono">SKILL.md</span>; saving creates a Git commit and pushes it to the connected repository.</p>
                <p className="mt-2 leading-relaxed">You can also edit the file directly on GitHub, then click <strong>Pull from GitHub</strong>.</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4 text-sm text-zinc-300">
                <h3 className="font-semibold text-white">What do the Git buttons mean?</h3>
                <p className="mt-2"><strong>Pull from GitHub</strong> downloads the repository&apos;s latest version into Groovy.</p>
                <p className="mt-2"><strong>Push local changes</strong> is advanced recovery for files edited in the Connector&apos;s local checkout. It is not a sync-status indicator.</p>
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

      {editingArtifact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950 p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Edit {editingArtifact.name}</h2>
                <p className="mt-1 text-sm text-zinc-400">
                  You are editing <span className="font-mono text-zinc-200">{editingArtifact.relative_path}</span>. Saving creates a Git commit and pushes it to {repoById.get(editingArtifact.repository_id)?.label || "the connected repository"}.
                </p>
              </div>
              <button type="button" onClick={() => setEditingArtifact(null)} className="rounded-lg p-2 text-zinc-400 hover:bg-white/5 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.04] p-3 text-xs leading-relaxed text-zinc-400">
              Edit the plain-language instructions here. If this skill has advanced actions, this editor does not change <span className="font-mono">groovy-actions.json</span> or any secret values.
            </div>
            <textarea
              value={editContent}
              onChange={(event) => setEditContent(event.target.value)}
              className="mt-4 min-h-[480px] w-full rounded-xl border border-white/10 bg-black/35 p-4 font-mono text-xs leading-relaxed text-zinc-100 outline-none focus:border-cyan-400/40"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setEditingArtifact(null)} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-200 hover:bg-white/10">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveArtifactEdit()}
                disabled={!activeDeviceId || busyKey === `edit:${editingArtifact.id}` || editContent === editingArtifact.content_snapshot}
                className="flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-zinc-200 disabled:opacity-50"
              >
                {busyKey === `edit:${editingArtifact.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Save and push to GitHub
              </button>
            </div>
          </div>
        </div>
      )}

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950 p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Create skill or instruction doc</h2>
                <p className="mt-1 text-sm text-zinc-400">Save both files together in one commit and push them to the selected GitHub repository.</p>
              </div>
              <button type="button" onClick={() => setCreateOpen(false)} className="rounded-lg p-2 text-zinc-400 hover:bg-white/5 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {error ? (
              <div className="mt-4 whitespace-pre-wrap rounded-xl border border-rose-400/25 bg-rose-500/10 p-3 text-sm text-rose-100">
                {error}
              </div>
            ) : null}

            <div className="mt-5 grid gap-4 lg:grid-cols-[300px_1fr]">
              <div className="space-y-3">
                <CustomSelect
                  ariaLabel="Repository"
                  value={selectedRepoId}
                  onChange={setSelectedRepoId}
                  options={repositories.map((repo) => ({
                    value: repo.id,
                    label: repo.label,
                  }))}
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCreateKind("skill")}
                    className={`rounded-lg border px-3 py-2 text-sm ${createKind === "skill" ? "border-white/25 bg-white/10 text-white" : "border-white/10 bg-black/20 text-zinc-400"}`}
                  >
                    Skill
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreateKind("instruction_doc")}
                    className={`rounded-lg border px-3 py-2 text-sm ${createKind === "instruction_doc" ? "border-white/25 bg-white/10 text-white" : "border-white/10 bg-black/20 text-zinc-400"}`}
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
                {existingCreateArtifact && (
                  <div className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-zinc-400">
                    Existing artifact path. Write will update this artifact.
                  </div>
                )}
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
                  Save and push to GitHub
                </button>
              </div>
              <div className="space-y-4">
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-zinc-200">
                        {createKind === "skill" ? "Skill instructions" : "Instruction document"}
                      </div>
                      <div className="font-mono text-[11px] text-zinc-500">{createPath}</div>
                    </div>
                    <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-zinc-400">
                      Markdown
                    </span>
                  </div>
                  <textarea
                    value={createContent}
                    onChange={(e) => setCreateContent(e.target.value)}
                    className="min-h-[360px] w-full rounded-xl border border-white/10 bg-black/35 p-4 font-mono text-xs leading-relaxed text-zinc-100 outline-none focus:border-cyan-400/40"
                  />
                </div>

                {createKind === "skill" ? (
                  <div className="rounded-xl border border-white/10 bg-white/[0.035] p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="max-w-xl">
                        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                          <Code2 className="h-4 w-4 text-zinc-400" />
                          API actions <span className="text-xs font-normal text-zinc-500">Optional</span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                          Add this only when the skill must call an API. Groovy will create a sibling <span className="font-mono text-zinc-300">groovy-actions.json</span> in the same Git commit.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setCreateActionsEnabled((current) => !current)}
                        className="flex shrink-0 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-200 transition hover:bg-white/10"
                      >
                        {createActionsEnabled ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                        {createActionsEnabled ? "Remove before saving" : "Add API actions"}
                      </button>
                    </div>

                    {createActionsEnabled ? (
                      <div className="mt-4">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <div className="font-mono text-[11px] text-zinc-400">{createActionsPath}</div>
                          <div className="text-[11px] text-zinc-500">JSON · validated before it is written</div>
                        </div>
                        <textarea
                          value={createActionsContent}
                          onChange={(event) => setCreateActionsContent(event.target.value)}
                          spellCheck={false}
                          className="min-h-[300px] w-full rounded-xl border border-white/10 bg-black/35 p-4 font-mono text-xs leading-relaxed text-zinc-100 outline-none focus:border-cyan-400/40"
                        />
                        <div className="mt-3 grid gap-2 text-xs leading-relaxed text-zinc-500 sm:grid-cols-2">
                          <p>
                            Replace the example URL, action name, and input fields with the API operation this skill needs.
                          </p>
                          <p>
                            Put only secret <strong className="text-zinc-300">names</strong> such as <span className="font-mono">HIBE_API_KEY</span> here. Add the actual values later in <a href="/settings/secrets" className="text-cyan-300 hover:text-cyan-200">Workspace Settings → Secrets</a>.
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
