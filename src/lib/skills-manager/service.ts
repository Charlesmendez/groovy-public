import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { callConnectorRpcViaRelay } from "@/lib/relay/connectorRpc";
import {
  getAuthedUser,
  getOrCreateWorkspaceForUser,
  isWorkspaceOperatorRole,
  type WorkspaceInfo,
} from "@/lib/workspaces";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";
import { canManageChannelSkills } from "@/lib/chat/channelSkills";
import {
  resolveAssignedSkillReference,
  type AssignedSkillCatalogItem,
} from "@/lib/skills-manager/assignedSkills";
import {
  buildChannelSkillArtifact,
  normalizeChannelSkillActionsManifest,
  resolveChannelSkillRepository,
} from "@/lib/skills-manager/channelSkillAuthoring";
import { skillActionsManifestRelativePath } from "@/lib/skills-manager/actionManifestAuthoring";

type AuthedContext = {
  userId: string;
  workspace: WorkspaceInfo;
  admin: ReturnType<typeof createSupabaseAdminClient>;
};

type ConnectorArtifact = {
  artifactType?: unknown;
  type?: unknown;
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  relativePath?: unknown;
  relative_path?: unknown;
  exactFilename?: unknown;
  exact_filename?: unknown;
  targets?: unknown;
  checksum?: unknown;
  commitSha?: unknown;
  commit_sha?: unknown;
  metadata?: unknown;
  riskFlags?: unknown;
  risk_flags?: unknown;
  contentSnapshot?: unknown;
  content_snapshot?: unknown;
  contentSnapshotTruncated?: unknown;
  content_snapshot_truncated?: unknown;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncateUtf8(value: string, maxBytes: number): {
  value: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  let end = Math.min(value.length, maxBytes);
  while (end > 0) {
    const candidate = value.slice(0, end);
    const bytes = Buffer.byteLength(candidate, "utf8");
    if (bytes <= maxBytes) {
      return { value: candidate, truncated: true };
    }
    end = Math.max(0, end - Math.max(1, Math.ceil((bytes - maxBytes) / 2)));
  }
  return { value: "", truncated: true };
}

function asPositiveInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sanitizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function yamlString(value: string): string {
  return JSON.stringify(value || "");
}

function normalizeTargets(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const targets = raw
    .map((item) => asString(item).toLowerCase())
    .filter((item) => item === "flow" || item === "claude" || item === "codex" || item === "all");
  return Array.from(new Set(targets.length ? targets : ["all"]));
}

function isAllowedRepoUrl(url: string): boolean {
  return (
    /^git@[\w.-]+:[\w./-]+(?:\.git)?$/i.test(url) ||
    /^ssh:\/\/[\w.@:-]+\/[\w./-]+(?:\.git)?$/i.test(url) ||
    /^https:\/\/[\w.-]+\/[\w./-]+(?:\.git)?(?:[?#].*)?$/i.test(url)
  );
}

function defaultLabelForRepo(url: string): string {
  const cleaned = url.replace(/[?#].*$/, "").replace(/\.git$/, "");
  const tail = cleaned.split(/[/:]/).filter(Boolean).pop();
  return tail || "Skills repo";
}

function classifyConnectorFailure(result: Record<string, unknown>): "no_permission" | "error" {
  const text = `${asString(result.error)} ${asString(result.stderr)} ${asString(result.detail)}`.toLowerCase();
  if (
    text.includes("permission denied") ||
    text.includes("publickey") ||
    text.includes("repository not found") ||
    text.includes("authentication failed") ||
    text.includes("could not read from remote repository")
  ) {
    return "no_permission";
  }
  return "error";
}

function classifyDeviceSyncStatus(result: Record<string, unknown>): "no_permission" | "offline" | "error" {
  const text = `${asString(result.error)} ${asString(result.error_code)} ${asString(result.stderr)} ${asString(result.detail)}`.toLowerCase();
  if (
    text.includes("device_not_online") ||
    text.includes("connector_send_failed") ||
    text.includes("relay_timeout") ||
    text.includes("device not online")
  ) {
    return "offline";
  }
  return classifyConnectorFailure(result);
}

async function getContext(requireAdmin = false): Promise<AuthedContext> {
  const user = await getAuthedUser();
  const workspace = await getOrCreateWorkspaceForUser();
  if (!isWorkspaceOperatorRole(workspace.role)) {
    throw new Error("Workspace member access required");
  }
  if (requireAdmin && workspace.role !== "admin") {
    throw new Error("Admin access required");
  }
  return {
    userId: user.id,
    workspace,
    admin: createSupabaseAdminClient(),
  };
}

async function getWorkspaceForUserId(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  workspaceId?: string | null,
): Promise<WorkspaceInfo> {
  const membership = workspaceId
    ? await admin
        .from("workspace_members")
        .select("workspace_id,role,created_at")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error) throw new Error(error.message);
          if (!data) return null;
          return {
            workspace_id: String(data.workspace_id),
            role:
              data.role === "admin"
                ? ("admin" as const)
                : data.role === "guest"
                  ? ("guest" as const)
                  : ("member" as const),
            created_at:
              typeof data.created_at === "string" ? data.created_at : null,
          };
        })
    : await getWorkspaceMembershipForUser({
        userId,
        admin,
      });
  if (!membership?.workspace_id) throw new Error("Workspace not found");

  const { data: workspace, error: wsErr } = await admin
    .from("workspaces")
    .select("id, name, billing_admin_user_id")
    .eq("id", membership.workspace_id)
    .single();
  if (wsErr || !workspace) throw new Error(wsErr?.message || "Workspace not found");

  const { data: members, error: membersErr } = await admin
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspace.id);
  if (membersErr) throw new Error(membersErr.message);

  const memberList: WorkspaceInfo["members"] = [];
  for (const member of members || []) {
    let email: string | null = null;
    try {
      const { data } = await admin.auth.admin.getUserById(member.user_id);
      email = data.user?.email || null;
    } catch {
      email = null;
    }
    memberList.push({ ...member, email });
  }

  return {
    id: workspace.id,
    name: workspace.name,
    billing_admin_user_id: workspace.billing_admin_user_id,
    role: membership.role,
    members: memberList,
  };
}

async function getContextForUser(
  userId: string,
  requireAdmin = false,
  workspaceId?: string | null,
): Promise<AuthedContext> {
  const admin = createSupabaseAdminClient();
  const workspace = await getWorkspaceForUserId(admin, userId, workspaceId);
  if (!isWorkspaceOperatorRole(workspace.role)) {
    throw new Error("Workspace member access required");
  }
  if (requireAdmin && workspace.role !== "admin") {
    throw new Error("Admin access required");
  }
  return { userId, workspace, admin };
}

async function audit(
  ctx: AuthedContext,
  eventType: string,
  fields: {
    actorUserId?: string | null;
    repositoryId?: string | null;
    artifactId?: string | null;
    assignmentId?: string | null;
    metadata?: Record<string, unknown>;
  } = {}
) {
  await ctx.admin.from("workspace_skill_audit_events").insert({
    workspace_id: ctx.workspace.id,
    actor_user_id: fields.actorUserId || ctx.userId,
    event_type: eventType,
    repository_id: fields.repositoryId || null,
    artifact_id: fields.artifactId || null,
    assignment_id: fields.assignmentId || null,
    metadata: fields.metadata || {},
  });
}

async function getRepository(ctx: AuthedContext, repositoryId: string) {
  const { data, error } = await ctx.admin
    .from("workspace_skill_repositories")
    .select("id,workspace_id,repo_url,label,default_ref,last_commit_sha,last_synced_at,status")
    .eq("id", repositoryId)
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error("Skills repository not found");
  return data as Record<string, unknown>;
}

function normalizeConnectorArtifact(row: ConnectorArtifact, fallbackCommitSha: string | null) {
  const artifactType = asString(row.artifactType || row.type);
  const relativePath = asString(row.relativePath || row.relative_path);
  const checksum = asString(row.checksum);
  if ((artifactType !== "skill" && artifactType !== "instruction_doc") || !relativePath || !checksum) {
    return null;
  }
  const exactFilename = asString(row.exactFilename || row.exact_filename);
  const fallbackSlug = exactFilename ? exactFilename.replace(/\.md$/i, "") : relativePath;
  const slug = sanitizeSlug(asString(row.slug) || fallbackSlug);
  if (!slug) return null;
  const rawContent =
    typeof row.contentSnapshot === "string"
      ? row.contentSnapshot
      : typeof row.content_snapshot === "string"
        ? row.content_snapshot
        : "";
  const boundedContent = rawContent
    ? truncateUtf8(rawContent, 262144)
    : { value: "", truncated: false };
  const contentSnapshot = boundedContent.value || null;
  return {
    artifact_type: artifactType,
    slug,
    name: asString(row.name) || slug,
    description: asString(row.description),
    relative_path: relativePath,
    exact_filename: exactFilename || null,
    targets: normalizeTargets(row.targets),
    checksum,
    commit_sha: asString(row.commitSha || row.commit_sha) || fallbackCommitSha,
    metadata: asRecord(row.metadata),
    risk_flags: asArray(row.riskFlags || row.risk_flags),
    content_snapshot: contentSnapshot,
    content_snapshot_truncated:
      row.contentSnapshotTruncated === true ||
      row.content_snapshot_truncated === true ||
      boundedContent.truncated,
    content_snapshot_updated_at: contentSnapshot
      ? new Date().toISOString()
      : null,
    lifecycle: "active",
    updated_at: new Date().toISOString(),
  };
}

async function upsertArtifactsFromSync(
  ctx: AuthedContext,
  repositoryId: string,
  commitSha: string | null,
  artifacts: unknown[]
) {
  const rows = artifacts
    .map((item) => normalizeConnectorArtifact(item as ConnectorArtifact, commitSha))
    .filter((item): item is NonNullable<typeof item> => !!item)
    .map((item) => ({
      ...item,
      workspace_id: ctx.workspace.id,
      repository_id: repositoryId,
    }));

  if (rows.length === 0) return [];

  const { data, error } = await ctx.admin
    .from("workspace_skill_artifacts")
    .upsert(rows, { onConflict: "repository_id,relative_path" })
    .select(
      "id,workspace_id,repository_id,artifact_type,slug,name,description,relative_path,exact_filename,targets,checksum,commit_sha,lifecycle,metadata,risk_flags,content_snapshot_updated_at,created_at,updated_at"
    );
  if (error) throw new Error(error.message);
  return data || [];
}

async function recordSyncResult(args: {
  ctx: AuthedContext;
  repositoryId: string;
  deviceId: string;
  operation: "check" | "sync" | "scan" | "create" | "materialize" | "preflight";
  result: Record<string, unknown>;
  artifactCount?: number;
}) {
  const { ctx, repositoryId, deviceId, operation, result } = args;
  const ok = result.ok === true;
  const status = ok ? "success" : classifyConnectorFailure(result);
  const deviceStatus = ok ? "synced" : classifyDeviceSyncStatus(result);
  const nowIso = new Date().toISOString();
  const commitSha = asString(result.commitSha || result.commit_sha) || null;
  const errorMessage = ok ? null : asString(result.error || result.detail || result.stderr) || "Connector operation failed";
  const errorCode = ok ? null : asString(result.error_code || result.code) || status;
  const diagnostics = {
    ...asRecord(result.diagnostics),
    ...(asString(result.localPath || result.local_path)
      ? { localPath: asString(result.localPath || result.local_path) }
      : {}),
    ...(asString(result.materializedPath || result.materialized_path || result.materializedRoot)
      ? {
          materializedPath: asString(
            result.materializedPath || result.materialized_path || result.materializedRoot
          ),
        }
      : {}),
    ...(Array.isArray(result.artifacts) ? { artifacts: result.artifacts } : {}),
    ...(Array.isArray(result.materialized) ? { materialized: result.materialized } : {}),
  };

  await ctx.admin.from("workspace_skill_sync_runs").insert({
    workspace_id: ctx.workspace.id,
    repository_id: repositoryId,
    user_id: ctx.userId,
    device_id: deviceId,
    operation,
    status,
    commit_sha: commitSha,
    artifacts_count: args.artifactCount || 0,
    error_code: errorCode,
    error_message: errorMessage,
    diagnostics,
    completed_at: nowIso,
  });

  const deviceSyncPayload: Record<string, unknown> = {
    workspace_id: ctx.workspace.id,
    repository_id: repositoryId,
    user_id: ctx.userId,
    device_id: deviceId,
    status: deviceStatus,
    local_path: asString(result.localPath || result.local_path) || null,
    commit_sha: commitSha,
    last_error_code: errorCode,
    last_error_message: errorMessage,
    diagnostics,
    synced_at: ok ? nowIso : null,
    updated_at: nowIso,
  };
  if (ok && (operation === "preflight" || operation === "materialize")) {
    deviceSyncPayload.materialized_at = nowIso;
  }

  await ctx.admin
    .from("workspace_skill_device_syncs")
    .upsert(deviceSyncPayload, { onConflict: "repository_id,user_id,device_id" });

  return { ok, status, commitSha, errorMessage };
}

async function callSkillsConnectorRpc(args: {
  ctx: AuthedContext;
  deviceId: string;
  rpcType: string;
  timeoutMs: number;
  payload: Record<string, unknown>;
}) {
  try {
    return await callConnectorRpcViaRelay({
      userId: args.ctx.userId,
      deviceId: args.deviceId,
      rpcType: args.rpcType,
      timeoutMs: args.timeoutMs,
      payload: args.payload,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "connector_rpc_failed");
    return {
      ok: false,
      error: message,
      error_code: /device_not_online|relay_timeout|connector_send_failed/i.test(message)
        ? "offline"
        : "connector_rpc_failed",
    };
  }
}

export async function listSkillsManagerState() {
  const ctx = await getContext(false);
  const memberIds = ctx.workspace.members.map((m) => m.user_id);

  const [
    reposRes,
    artifactsRes,
    assignmentsRes,
    syncsRes,
    auditsRes,
    agentsRes,
    codeConfigsRes,
    runtimeSkillsRes,
  ] = await Promise.all([
    ctx.admin
      .from("workspace_skill_repositories")
      .select("id,workspace_id,repo_url,label,default_ref,status,last_commit_sha,last_synced_at,created_at,updated_at")
      .eq("workspace_id", ctx.workspace.id)
      .order("updated_at", { ascending: false }),
    ctx.admin
      .from("workspace_skill_artifacts")
      .select("id,workspace_id,repository_id,artifact_type,slug,name,description,relative_path,exact_filename,targets,checksum,commit_sha,lifecycle,metadata,risk_flags,content_snapshot,content_snapshot_truncated,content_snapshot_updated_at,created_at,updated_at")
      .eq("workspace_id", ctx.workspace.id)
      .order("updated_at", { ascending: false }),
    ctx.admin
      .from("workspace_skill_assignments")
      .select("id,workspace_id,artifact_id,agent_id,profile_id,target,scope,enabled,metadata,created_at,updated_at")
      .eq("workspace_id", ctx.workspace.id)
      .order("updated_at", { ascending: false }),
    ctx.admin
      .from("workspace_skill_device_syncs")
      .select("id,workspace_id,repository_id,user_id,device_id,status,local_path,commit_sha,last_error_code,last_error_message,diagnostics,synced_at,materialized_at,updated_at")
      .eq("workspace_id", ctx.workspace.id)
      .order("updated_at", { ascending: false }),
    ctx.admin
      .from("workspace_skill_audit_events")
      .select("id,event_type,repository_id,artifact_id,assignment_id,metadata,created_at,actor_user_id")
      .eq("workspace_id", ctx.workspace.id)
      .order("created_at", { ascending: false })
      .limit(50),
    memberIds.length
      ? ctx.admin
          .from("agents")
          .select("id,user_id,name,type,updated_at")
          .in("user_id", memberIds)
          .in("type", ["orchestrator-runtime", "claude-code"])
          .order("updated_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    ctx.admin
      .from("claude_code_agent_configs")
      .select("agent_id,code_cli_provider"),
    memberIds.length
      ? ctx.admin
          .from("orchestrator_skills")
          .select("id,user_id,agent_id,slug,name,description,lifecycle,runner,latest_version,active_version_id,rollback_version_id,created_at,updated_at")
          .in("user_id", memberIds)
          .order("updated_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);

  for (const res of [reposRes, artifactsRes, assignmentsRes, syncsRes, auditsRes, agentsRes, codeConfigsRes, runtimeSkillsRes]) {
    if (res.error) throw new Error(res.error.message);
  }

  const providerByAgent = new Map<string, "claude" | "codex">();
  for (const row of codeConfigsRes.data || []) {
    const agentId = asString((row as Record<string, unknown>).agent_id);
    if (!agentId) continue;
    providerByAgent.set(
      agentId,
      asString((row as Record<string, unknown>).code_cli_provider) === "codex" ? "codex" : "claude"
    );
  }

  const emailByUserId = new Map(ctx.workspace.members.map((m) => [m.user_id, m.email || null]));
  const agents = ((agentsRes.data || []) as Array<Record<string, unknown>>).map((agent) => {
    const id = asString(agent.id);
    const type = asString(agent.type);
    return {
      id,
      name: asString(agent.name) || "Agent",
      type,
      target:
        type === "claude-code"
          ? providerByAgent.get(id) || "claude"
          : "flow",
      ownerUserId: asString(agent.user_id),
      ownerEmail: emailByUserId.get(asString(agent.user_id)) || null,
      updatedAt: asString(agent.updated_at) || null,
    };
  });
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));

  const runtimeSkillRows = (runtimeSkillsRes.data || []) as Array<Record<string, unknown>>;
  const runtimeSkillIds = runtimeSkillRows
    .map((skill) => asString(skill.id))
    .filter((id): id is string => !!id);
  let runtimeVersionRows: Array<Record<string, unknown>> = [];
  if (runtimeSkillIds.length > 0) {
    const { data, error } = await ctx.admin
      .from("orchestrator_skill_versions")
      .select("id,skill_id,version,lifecycle,runner,validation_status,validation_task,validated_at,created_at,updated_at")
      .in("skill_id", runtimeSkillIds)
      .order("version", { ascending: false });
    if (error) throw new Error(error.message);
    runtimeVersionRows = (data as Array<Record<string, unknown>> | null) || [];
  }

  const runtimeVersionsBySkill = new Map<string, Array<Record<string, unknown>>>();
  for (const version of runtimeVersionRows) {
    const skillId = asString(version.skill_id);
    if (!skillId) continue;
    const versions = runtimeVersionsBySkill.get(skillId) || [];
    versions.push({
      id: asString(version.id),
      skill_id: skillId,
      version: asPositiveInteger(version.version),
      lifecycle: asString(version.lifecycle) || "draft",
      runner: asString(version.runner) || "code_cli_run",
      validation_status: asString(version.validation_status) || "unvalidated",
      validation_task: asString(version.validation_task) || null,
      validated_at: asString(version.validated_at) || null,
      created_at: asString(version.created_at) || null,
      updated_at: asString(version.updated_at) || null,
    });
    runtimeVersionsBySkill.set(skillId, versions);
  }

  const runtimeSkills = runtimeSkillRows.map((skill) => {
    const id = asString(skill.id);
    const agentId = asString(skill.agent_id);
    const agent = agentById.get(agentId) || null;
    return {
      id,
      user_id: asString(skill.user_id),
      agent_id: agentId,
      agent_name: agent?.name || "Orchestrator agent",
      slug: asString(skill.slug),
      name: asString(skill.name) || asString(skill.slug) || "Skill",
      description: asString(skill.description),
      lifecycle: asString(skill.lifecycle) || "draft",
      runner: asString(skill.runner) || "code_cli_run",
      latest_version: asPositiveInteger(skill.latest_version),
      active_version_id: asString(skill.active_version_id) || null,
      rollback_version_id: asString(skill.rollback_version_id) || null,
      created_at: asString(skill.created_at) || null,
      updated_at: asString(skill.updated_at) || null,
      versions: runtimeVersionsBySkill.get(id) || [],
    };
  });

  return {
    currentUserId: ctx.userId,
    workspace: ctx.workspace,
    repositories: reposRes.data || [],
    artifacts: (artifactsRes.data || []).map((artifact) => {
      if (ctx.workspace.role === "admin") return artifact;
      return Object.fromEntries(
        Object.entries(artifact).filter(
          ([key]) => ![
            "content_snapshot",
            "content_snapshot_truncated",
            "content_snapshot_updated_at",
          ].includes(key),
        ),
      );
    }),
    assignments: assignmentsRes.data || [],
    syncs: syncsRes.data || [],
    auditEvents: auditsRes.data || [],
    agents,
    runtimeSkills,
    privacy: {
      storesContents: true,
      summary:
        "Git remains the source of truth. Groovy stores a bounded Markdown snapshot for assigned cross-surface context; local connector materialization is still used for scripts and full skill directories.",
    },
  };
}

export async function connectSkillsRepository(input: {
  repoUrl: string;
  label?: string;
  defaultRef?: string;
  deviceId?: string;
}) {
  const ctx = await getContext(true);
  const repoUrl = asString(input.repoUrl);
  if (!repoUrl || !isAllowedRepoUrl(repoUrl)) {
    throw new Error("Use an HTTPS or SSH Git URL that your local CLI can access.");
  }
  const nowIso = new Date().toISOString();
  const { data: repo, error } = await ctx.admin
    .from("workspace_skill_repositories")
    .upsert(
      {
        workspace_id: ctx.workspace.id,
        created_by_user_id: ctx.userId,
        repo_url: repoUrl,
        label: asString(input.label) || defaultLabelForRepo(repoUrl),
        default_ref: asString(input.defaultRef) || "main",
        status: "active",
        updated_at: nowIso,
      },
      { onConflict: "workspace_id,repo_url" }
    )
    .select("id,workspace_id,repo_url,label,default_ref,status,last_commit_sha,last_synced_at,created_at,updated_at")
    .single();
  if (error || !repo?.id) throw new Error(error?.message || "Failed to save skills repository");
  await audit(ctx, "skills_repo_connected", { repositoryId: String(repo.id) });

  let syncResult: unknown = null;
  const deviceId = asString(input.deviceId);
  if (deviceId) {
    syncResult = await syncSkillsRepository({ repositoryId: String(repo.id), deviceId });
  }

  return { repository: repo, syncResult };
}

async function syncSkillsRepositoryWithContext(
  ctx: AuthedContext,
  input: { repositoryId: string; deviceId: string },
) {
  const repositoryId = asString(input.repositoryId);
  const deviceId = asString(input.deviceId);
  if (!repositoryId || !deviceId) throw new Error("repositoryId and deviceId are required");
  const repo = await getRepository(ctx, repositoryId);
  const result = await callSkillsConnectorRpc({
    ctx,
    deviceId,
    rpcType: "skills_repo_sync",
    timeoutMs: 5 * 60 * 1000,
    payload: {
      repository_id: repositoryId,
      workspace_id: ctx.workspace.id,
      repo_url: asString(repo.repo_url),
      ref: asString(repo.default_ref) || "main",
    },
  });
  const commitSha = asString(result.commitSha || result.commit_sha) || null;
  const artifacts = asArray(result.artifacts);
  const syncMeta = await recordSyncResult({
    ctx,
    repositoryId,
    deviceId,
    operation: "sync",
    result,
    artifactCount: artifacts.length,
  });
  let upsertedArtifacts: unknown[] = [];
  if (result.ok === true) {
    upsertedArtifacts = await upsertArtifactsFromSync(ctx, repositoryId, commitSha, artifacts);
    await ctx.admin
      .from("workspace_skill_repositories")
      .update({
        status: "active",
        last_commit_sha: commitSha,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", repositoryId)
      .eq("workspace_id", ctx.workspace.id);
    await audit(ctx, "skills_repo_synced", {
      repositoryId,
      metadata: { commitSha, artifactCount: upsertedArtifacts.length },
    });
  } else {
    await audit(ctx, "skills_repo_sync_failed", {
      repositoryId,
      metadata: {
        status: syncMeta.status,
        error: syncMeta.errorMessage,
      },
    });
  }
  return { ...result, upsertedArtifacts };
}

export async function syncSkillsRepository(input: { repositoryId: string; deviceId: string }) {
  const ctx = await getContext(false);
  return syncSkillsRepositoryWithContext(ctx, input);
}

export async function pushSkillsRepositoryChanges(input: { repositoryId: string; deviceId: string }) {
  const ctx = await getContext(true);
  const repositoryId = asString(input.repositoryId);
  const deviceId = asString(input.deviceId);
  if (!repositoryId || !deviceId) throw new Error("repositoryId and deviceId are required");
  const repo = await getRepository(ctx, repositoryId);
  const result = await callSkillsConnectorRpc({
    ctx,
    deviceId,
    rpcType: "skills_repo_push",
    timeoutMs: 5 * 60 * 1000,
    payload: {
      repository_id: repositoryId,
      workspace_id: ctx.workspace.id,
      repo_url: asString(repo.repo_url),
      ref: asString(repo.default_ref) || "main",
      commit_message: "Sync Groovy skills repo",
    },
  });
  const commitSha = asString(result.commitSha || result.commit_sha) || null;
  const artifacts = asArray(result.artifacts);
  const syncMeta = await recordSyncResult({
    ctx,
    repositoryId,
    deviceId,
    operation: "sync",
    result,
    artifactCount: artifacts.length,
  });
  let upsertedArtifacts: unknown[] = [];
  if (result.ok === true) {
    upsertedArtifacts = await upsertArtifactsFromSync(ctx, repositoryId, commitSha, artifacts);
    await ctx.admin
      .from("workspace_skill_repositories")
      .update({
        status: "active",
        last_commit_sha: commitSha,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", repositoryId)
      .eq("workspace_id", ctx.workspace.id);
    await audit(ctx, "skills_repo_pushed", {
      repositoryId,
      metadata: { commitSha, artifactCount: upsertedArtifacts.length },
    });
  } else {
    await audit(ctx, "skills_repo_push_failed", {
      repositoryId,
      metadata: {
        status: syncMeta.status,
        error: syncMeta.errorMessage,
      },
    });
  }
  return { ...result, upsertedArtifacts };
}

type CreateSkillsArtifactInput = {
  repositoryId: string;
  deviceId: string;
  artifactType: "skill" | "instruction_doc";
  relativePath: string;
  content: string;
  name?: string;
  description?: string;
  targets?: string[];
  overwrite?: boolean;
  expectedCommitSha?: string;
  commitMessage?: string;
  companionFiles?: Array<{ relativePath: string; content: string }>;
  preservePrimary?: boolean;
  actionsManifest?: string;
};

async function createSkillsArtifactWithContext(
  ctx: AuthedContext,
  input: CreateSkillsArtifactInput,
  auditActorUserId?: string,
) {
  const repositoryId = asString(input.repositoryId);
  const deviceId = asString(input.deviceId);
  if (!repositoryId || !deviceId) throw new Error("repositoryId and deviceId are required");
  if (input.artifactType !== "skill" && input.artifactType !== "instruction_doc") {
    throw new Error("artifactType must be skill or instruction_doc");
  }
  const relativePath = asString(input.relativePath);
  if (!relativePath.endsWith(".md")) {
    throw new Error("Markdown artifact path must end in .md");
  }
  const companionFiles = [...(input.companionFiles || [])];
  if (input.actionsManifest !== undefined) {
    if (input.artifactType !== "skill") {
      throw new Error("Only skills can include groovy-actions.json.");
    }
    const actionsContent = normalizeChannelSkillActionsManifest(
      input.actionsManifest,
    );
    if (!actionsContent) {
      throw new Error("A complete groovy-actions.json is required.");
    }
    const actionsRelativePath = skillActionsManifestRelativePath(relativePath);
    const existingIndex = companionFiles.findIndex(
      (file) => asString(file.relativePath) === actionsRelativePath,
    );
    const companion = {
      relativePath: actionsRelativePath,
      content: actionsContent,
    };
    if (existingIndex >= 0) companionFiles[existingIndex] = companion;
    else companionFiles.push(companion);
  }
  const repo = await getRepository(ctx, repositoryId);
  const result = await callSkillsConnectorRpc({
    ctx,
    deviceId,
    rpcType:
      companionFiles.length > 0
        ? input.preservePrimary
          ? "skills_artifact_companion_upsert"
          : "skills_artifact_bundle_create"
        : "skills_artifact_create",
    timeoutMs: 3 * 60 * 1000,
    payload: {
      repository_id: repositoryId,
      workspace_id: ctx.workspace.id,
      repo_url: asString(repo.repo_url),
      ref: asString(repo.default_ref) || "main",
      artifact_type: input.artifactType,
      relative_path: relativePath,
      content: String(input.content || ""),
      name: asString(input.name),
      description: asString(input.description),
      targets: normalizeTargets(input.targets),
      overwrite: input.overwrite === true,
      expected_commit_sha: asString(input.expectedCommitSha),
      commit_message: asString(input.commitMessage),
      companion_files: companionFiles.map((file) => ({
        relative_path: asString(file.relativePath),
        content: String(file.content || ""),
      })),
      preserve_primary: input.preservePrimary === true,
    },
  });
  await recordSyncResult({
    ctx,
    repositoryId,
    deviceId,
    operation: "create",
    result,
    artifactCount: asArray(result.artifacts).length,
  });
  if (result.ok !== true) {
    console.warn("[skills-manager] artifact create failed", {
      repositoryId,
      deviceId,
      artifactType: input.artifactType,
      relativePath: asString(input.relativePath),
      error: asString(result.error || result.error_code || result.code),
      diagnostics: asRecord(result.diagnostics),
    });
    return result;
  }
  const syncResult = await syncSkillsRepositoryWithContext(ctx, { repositoryId, deviceId });
  await audit(ctx, "skills_artifact_created", {
    actorUserId: auditActorUserId,
    repositoryId,
    metadata: {
      artifactType: input.artifactType,
      relativePath: asString(input.relativePath),
    },
  });
  return { ...result, syncResult };
}

export async function createSkillsArtifact(input: CreateSkillsArtifactInput) {
  const ctx = await getContext(true);
  return createSkillsArtifactWithContext(ctx, input);
}

function renderRuntimeSkillMarkdown(args: {
  skill: Record<string, unknown>;
  version: Record<string, unknown>;
}) {
  const name = asString(args.skill.name) || asString(args.skill.slug) || "Orchestrator Skill";
  const description = asString(args.skill.description) || "Orchestrator-authored runtime skill.";
  const source = asString(args.version.source) || "# No runtime source found.";
  const runner = asString(args.version.runner || args.skill.runner) || "code_cli_run";
  const validationStatus = asString(args.version.validation_status) || "unvalidated";
  return [
    "---",
    `name: ${yamlString(name)}`,
    `description: ${yamlString(description)}`,
    "targets: [flow]",
    "metadata:",
    `  source: ${yamlString("orchestrator_runtime")}`,
    `  groovy_runtime_skill_id: ${yamlString(asString(args.skill.id))}`,
    `  groovy_runtime_skill_version_id: ${yamlString(asString(args.version.id))}`,
    `  runner: ${yamlString(runner)}`,
    `  validation_status: ${yamlString(validationStatus)}`,
    "---",
    "",
    `# ${name}`,
    "",
    description,
    "",
    "## Runtime Source",
    "",
    source,
    "",
  ].join("\n");
}

export async function exportRuntimeSkillToRepository(input: {
  runtimeSkillId: string;
  repositoryId: string;
  deviceId: string;
}) {
  const ctx = await getContext(true);
  const runtimeSkillId = asString(input.runtimeSkillId);
  const repositoryId = asString(input.repositoryId);
  const deviceId = asString(input.deviceId);
  if (!runtimeSkillId || !repositoryId || !deviceId) {
    throw new Error("runtimeSkillId, repositoryId, and deviceId are required");
  }

  const memberIds = ctx.workspace.members.map((m) => m.user_id);
  const { data: skill, error: skillErr } = await ctx.admin
    .from("orchestrator_skills")
    .select("id,user_id,agent_id,slug,name,description,lifecycle,runner,latest_version,active_version_id,created_at,updated_at")
    .eq("id", runtimeSkillId)
    .in("user_id", memberIds)
    .maybeSingle();
  if (skillErr) throw new Error(skillErr.message);
  if (!skill?.id) throw new Error("Runtime skill not found");

  const activeVersionId = asString((skill as Record<string, unknown>).active_version_id);
  let versionQuery = ctx.admin
    .from("orchestrator_skill_versions")
    .select("id,skill_id,version,lifecycle,runner,source,validation_status,created_at,updated_at")
    .eq("skill_id", runtimeSkillId)
    .eq("user_id", asString((skill as Record<string, unknown>).user_id));
  versionQuery = activeVersionId
    ? versionQuery.eq("id", activeVersionId)
    : versionQuery.order("version", { ascending: false }).limit(1);
  const { data: version, error: versionErr } = await versionQuery.maybeSingle();
  if (versionErr) throw new Error(versionErr.message);
  if (!version?.id) throw new Error("Runtime skill version not found");

  const slug = sanitizeSlug(asString((skill as Record<string, unknown>).slug) || asString((skill as Record<string, unknown>).name) || "runtime-skill");
  const relativePath = `skills/${slug || "runtime-skill"}/SKILL.md`;
  const result = await createSkillsArtifact({
    repositoryId,
    deviceId,
    artifactType: "skill",
    relativePath,
    content: renderRuntimeSkillMarkdown({
      skill: skill as Record<string, unknown>,
      version: version as Record<string, unknown>,
    }),
    name: asString((skill as Record<string, unknown>).name),
    description: asString((skill as Record<string, unknown>).description),
    targets: ["flow"],
    overwrite: true,
    commitMessage: `Sync runtime skill: ${asString((skill as Record<string, unknown>).name) || slug}`,
  });
  await audit(ctx, "runtime_skill_exported_to_repo", {
    repositoryId,
    metadata: {
      runtimeSkillId,
      relativePath,
      ok: (result as Record<string, unknown>).ok === true,
    },
  });
  return {
    ...result,
    relativePath,
  };
}

async function setSkillAssignmentWithContext(
  ctx: AuthedContext,
  input: {
  artifactId: string;
  agentId?: string | null;
  profileId?: string | null;
  target?: "all" | "flow" | "claude" | "codex";
  enabled?: boolean;
  }
) {
  const artifactId = asString(input.artifactId);
  if (!artifactId) throw new Error("artifactId is required");
  const target = input.target === "flow" || input.target === "claude" || input.target === "codex" ? input.target : "all";
  const agentId = asString(input.agentId || "") || null;
  const profileId = asString(input.profileId || "") || null;
  if (agentId && profileId) throw new Error("Choose either a Mind or a worker assignment");
  const { data: artifact } = await ctx.admin
    .from("workspace_skill_artifacts")
    .select("id,workspace_id,targets")
    .eq("id", artifactId)
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (!artifact?.id) throw new Error("Artifact not found");

  if (input.enabled === false) {
    let deleteQuery = ctx.admin
      .from("workspace_skill_assignments")
      .delete()
      .eq("workspace_id", ctx.workspace.id)
      .eq("artifact_id", artifactId)
      .eq("target", target);
    deleteQuery = profileId
      ? deleteQuery.eq("profile_id", profileId)
      : deleteQuery.is("profile_id", null);
    deleteQuery = agentId ? deleteQuery.eq("agent_id", agentId) : deleteQuery.is("agent_id", null);
    const { error } = await deleteQuery;
    if (error) throw new Error(error.message);
    await audit(ctx, "skills_assignment_removed", { artifactId, metadata: { agentId, profileId, target } });
    return { ok: true, removed: true };
  }

  const artifactTargets = normalizeTargets((artifact as Record<string, unknown>).targets);
  if (target === "all" && !artifactTargets.includes("all")) {
    throw new Error("This artifact is not declared compatible with all targets.");
  }
  if (target !== "all" && !artifactTargets.includes("all") && !artifactTargets.includes(target)) {
    throw new Error(`This artifact is not declared compatible with ${target}.`);
  }

  if (agentId) {
    const memberUserIds = ctx.workspace.members.map((member) => member.user_id);
    const { data: agent, error: agentErr } = await ctx.admin
      .from("agents")
      .select("id,user_id,type")
      .eq("id", agentId)
      .in("user_id", memberUserIds.length ? memberUserIds : ["00000000-0000-0000-0000-000000000000"])
      .maybeSingle();
    if (agentErr) throw new Error(agentErr.message);
    if (!agent?.id) throw new Error("Agent not found in this workspace");
  }
  if (profileId) {
    const { data: profile, error: profileError } = await ctx.admin
      .from("orchestrator_profiles")
      .select("id")
      .eq("workspace_id", ctx.workspace.id)
      .eq("id", profileId)
      .maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile?.id) throw new Error("Mind not found in this workspace");
  }

  let existingQuery = ctx.admin
    .from("workspace_skill_assignments")
    .select("id")
    .eq("workspace_id", ctx.workspace.id)
    .eq("artifact_id", artifactId)
    .eq("target", target);
  existingQuery = profileId
    ? existingQuery.eq("profile_id", profileId)
    : existingQuery.is("profile_id", null);
  existingQuery = agentId ? existingQuery.eq("agent_id", agentId) : existingQuery.is("agent_id", null);
  const { data: existing, error: existingErr } = await existingQuery.maybeSingle();
  if (existingErr) throw new Error(existingErr.message);

  const payload = {
    workspace_id: ctx.workspace.id,
    artifact_id: artifactId,
    agent_id: agentId,
    profile_id: profileId,
    target,
    scope: agentId ? "agent" : profileId ? "profile" : "workspace",
    enabled: true,
    created_by_user_id: ctx.userId,
    updated_at: new Date().toISOString(),
  };

  const writeQuery = existing?.id
    ? ctx.admin
        .from("workspace_skill_assignments")
        .update(payload)
        .eq("id", String(existing.id))
        .eq("workspace_id", ctx.workspace.id)
    : ctx.admin.from("workspace_skill_assignments").insert(payload);

  const { data, error } = await writeQuery
    .select("id,workspace_id,artifact_id,agent_id,profile_id,target,scope,enabled,metadata,created_at,updated_at")
    .single();
  if (error || !data?.id) throw new Error(error?.message || "Failed to assign artifact");
  await audit(ctx, "skills_assignment_set", {
    artifactId,
    assignmentId: String(data.id),
    metadata: { agentId, profileId, target },
  });
  return { ok: true, assignment: data };
}

export async function setSkillAssignment(input: {
  artifactId: string;
  agentId?: string | null;
  profileId?: string | null;
  target?: "all" | "flow" | "claude" | "codex";
  enabled?: boolean;
}) {
  const ctx = await getContext(true);
  return setSkillAssignmentWithContext(ctx, input);
}

export async function setSkillAssignmentForUser(input: {
  userId: string;
  workspaceId?: string | null;
  artifactId: string;
  agentId?: string | null;
  profileId?: string | null;
  target?: "all" | "flow" | "claude" | "codex";
  enabled?: boolean;
}) {
  const ctx = await getContextForUser(input.userId, true, input.workspaceId);
  return setSkillAssignmentWithContext(ctx, input);
}

export async function listWorkspaceSecretAssignmentsForUser(input: {
  userId: string;
  workspaceId: string;
  query?: string;
}) {
  const ctx = await getContextForUser(input.userId, true, input.workspaceId);
  const query = asString(input.query).toLowerCase();
  const [secrets, profiles, workers, skills, profileGrants, workerGrants, skillGrants, readiness] = await Promise.all([
    ctx.admin.from("workspace_secret_definitions").select("id,name,key,description").eq("workspace_id", ctx.workspace.id).order("name"),
    ctx.admin.from("orchestrator_profiles").select("id,name,surface").eq("workspace_id", ctx.workspace.id).order("name"),
    ctx.admin.from("workspace_orchestrator_agents").select("agent_id,agents!workspace_orchestrator_agents_agent_id_fkey(name)").eq("workspace_id", ctx.workspace.id),
    ctx.admin.from("workspace_skill_artifacts").select("id,name,slug,relative_path").eq("workspace_id", ctx.workspace.id).eq("artifact_type", "skill").neq("lifecycle", "archived").order("name"),
    ctx.admin.from("workspace_secret_profile_grants").select("secret_id,profile_id").eq("workspace_id", ctx.workspace.id),
    ctx.admin.from("workspace_secret_agent_grants").select("secret_id,agent_id").eq("workspace_id", ctx.workspace.id),
    ctx.admin.from("workspace_secret_artifact_grants").select("secret_id,artifact_id").eq("workspace_id", ctx.workspace.id),
    ctx.admin.from("workspace_secret_device_readiness").select("secret_id,device_id,configured").eq("workspace_id", ctx.workspace.id),
  ]);
  for (const result of [secrets, profiles, workers, skills, profileGrants, workerGrants, skillGrants, readiness]) {
    if (result.error) throw new Error(result.error.message);
  }
  const matches = (item: Record<string, unknown>) => !query || Object.values(item).some((value) => asString(value).toLowerCase().includes(query));
  return {
    workspaceId: ctx.workspace.id,
    secrets: ((secrets.data || []) as Array<Record<string, unknown>>).filter(matches),
    minds: profiles.data || [],
    workers: (workers.data || []).map((row) => {
      const relation = Array.isArray(row.agents) ? row.agents[0] : row.agents;
      return { id: asString(row.agent_id), name: asString(relation?.name) || "Worker" };
    }),
    skills: skills.data || [],
    grants: {
      minds: profileGrants.data || [],
      workers: workerGrants.data || [],
      skills: skillGrants.data || [],
    },
    readiness: readiness.data || [],
    note: "Secret values are never returned. Readiness only reports whether a device has a configured value.",
  };
}

export async function setWorkspaceSecretAssignmentForUser(input: {
  userId: string;
  workspaceId: string;
  secretId: string;
  destination: "mind" | "worker" | "skill";
  destinationId: string;
  enabled: boolean;
}) {
  const ctx = await getContextForUser(input.userId, true, input.workspaceId);
  const secretId = asString(input.secretId);
  const destinationId = asString(input.destinationId);
  if (!secretId || !destinationId) throw new Error("Secret and assignment destination are required");
  const { data: secret, error: secretError } = await ctx.admin.from("workspace_secret_definitions").select("id,name,key").eq("workspace_id", ctx.workspace.id).eq("id", secretId).maybeSingle();
  if (secretError) throw new Error(secretError.message);
  if (!secret) throw new Error("Secret declaration not found");
  const target = input.destination === "mind"
    ? { table: "workspace_secret_profile_grants", column: "profile_id", validation: ctx.admin.from("orchestrator_profiles").select("id,name").eq("workspace_id", ctx.workspace.id).eq("id", destinationId).maybeSingle() }
    : input.destination === "worker"
      ? { table: "workspace_secret_agent_grants", column: "agent_id", validation: ctx.admin.from("workspace_orchestrator_agents").select("agent_id").eq("workspace_id", ctx.workspace.id).eq("agent_id", destinationId).maybeSingle() }
      : { table: "workspace_secret_artifact_grants", column: "artifact_id", validation: ctx.admin.from("workspace_skill_artifacts").select("id,name").eq("workspace_id", ctx.workspace.id).eq("artifact_type", "skill").eq("id", destinationId).maybeSingle() };
  const validation = await target.validation;
  if (validation.error) throw new Error(validation.error.message);
  if (!validation.data) throw new Error("Assignment destination not found in this workspace");
  if (input.enabled) {
    const { error } = await ctx.admin.from(target.table).upsert({ workspace_id: ctx.workspace.id, secret_id: secretId, [target.column]: destinationId, created_by: ctx.userId }, { onConflict: `secret_id,${target.column}` });
    if (error) throw new Error(error.message);
  } else {
    const { error } = await ctx.admin.from(target.table).delete().eq("workspace_id", ctx.workspace.id).eq("secret_id", secretId).eq(target.column, destinationId);
    if (error) throw new Error(error.message);
  }
  await audit(ctx, input.enabled ? "workspace_secret_assignment_set" : "workspace_secret_assignment_removed", {
    artifactId: input.destination === "skill" ? destinationId : undefined,
    metadata: { secretId, secretKey: secret.key, destination: input.destination, destinationId },
  });
  return { ok: true, secret: { id: secret.id, name: secret.name, key: secret.key }, destination: input.destination, destinationId, enabled: input.enabled };
}

export async function listSkillsAndDocsForUser(input: {
  userId: string;
  workspaceId?: string | null;
  query?: string;
}) {
  const ctx = await getContextForUser(input.userId, false, input.workspaceId);
  const query = asString(input.query).toLowerCase();
  const [{ data: artifacts, error: artifactError }, { data: assignments, error: assignmentError }] =
    await Promise.all([
      ctx.admin
        .from("workspace_skill_artifacts")
        .select(
          "id,artifact_type,slug,name,description,relative_path,exact_filename,targets,lifecycle,repository_id"
        )
        .eq("workspace_id", ctx.workspace.id)
        .neq("lifecycle", "archived")
        .order("name", { ascending: true }),
      ctx.admin
        .from("workspace_skill_assignments")
        .select("id,artifact_id,agent_id,profile_id,target,scope,enabled,updated_at")
        .eq("workspace_id", ctx.workspace.id)
        .eq("enabled", true)
        .order("updated_at", { ascending: false }),
    ]);
  if (artifactError) throw new Error(artifactError.message);
  if (assignmentError) throw new Error(assignmentError.message);
  const filtered = ((artifacts || []) as Array<Record<string, unknown>>).filter((artifact) => {
    if (!query) return true;
    return [artifact.id, artifact.name, artifact.slug, artifact.description, artifact.relative_path]
      .map((value) => asString(value).toLowerCase())
      .some((value) => value.includes(query));
  });
  return {
    workspaceId: ctx.workspace.id,
    role: ctx.workspace.role,
    artifacts: filtered,
    assignments: assignments || [],
  };
}

async function assertChannelSkillManager(
  ctx: AuthedContext,
  input: { channelId: string; actorUserId: string },
) {
  const channelId = asString(input.channelId);
  const actorUserId = asString(input.actorUserId);
  if (!channelId || !actorUserId) {
    throw new Error("Channel skill management context is incomplete.");
  }
  const [{ data: channel, error: channelError }, { data: membership, error: membershipError }] =
    await Promise.all([
      ctx.admin
        .from("chat_channels")
        .select("id,workspace_id,kind,is_archived,created_by")
        .eq("id", channelId)
        .eq("workspace_id", ctx.workspace.id)
        .maybeSingle(),
      ctx.admin
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", ctx.workspace.id)
        .eq("user_id", actorUserId)
        .maybeSingle(),
    ]);
  if (channelError) throw new Error(channelError.message);
  if (membershipError) throw new Error(membershipError.message);
  if (!channel || channel.kind !== "channel" || channel.is_archived === true) {
    throw new Error("Channel skills are unavailable for this conversation.");
  }
  const workspaceRole =
    membership?.role === "admin"
      ? "admin"
      : membership?.role === "member"
        ? "member"
        : membership?.role === "guest"
          ? "guest"
          : null;
  if (
    !canManageChannelSkills({
      actorUserId,
      channelCreatedBy: asString(channel.created_by),
      workspaceRole,
    })
  ) {
    throw new Error(
      "Only a workspace admin or this channel's full-member creator can manage channel skills.",
    );
  }
  return { channel, workspaceRole };
}

export async function listChannelSkillsForUser(input: {
  userId: string;
  workspaceId: string;
  channelId: string;
  actorUserId: string;
  query?: string;
}) {
  const ctx = await getContextForUser(input.userId, false, input.workspaceId);
  const access = await assertChannelSkillManager(ctx, input);
  const query = asString(input.query).toLowerCase();
  const [{ data: artifacts, error: artifactError }, { data: assignments, error: assignmentError }] =
    await Promise.all([
      ctx.admin
        .from("workspace_skill_artifacts")
        .select("id,artifact_type,slug,name,description,relative_path,targets,lifecycle")
        .eq("workspace_id", ctx.workspace.id)
        .eq("lifecycle", "active")
        .order("name", { ascending: true }),
      ctx.admin
        .from("chat_channel_skill_assignments")
        .select("id,artifact_id,created_at")
        .eq("channel_id", input.channelId),
    ]);
  if (artifactError) throw new Error(artifactError.message);
  if (assignmentError) throw new Error(assignmentError.message);
  const assignedIds = new Set(
    (assignments || []).map((assignment) => asString(assignment.artifact_id)),
  );
  const items = ((artifacts || []) as Array<Record<string, unknown>>)
    .filter((artifact) => {
      const targets = normalizeTargets(artifact.targets);
      if (!targets.includes("all") && !targets.includes("flow")) return false;
      if (!query) return true;
      return [artifact.id, artifact.name, artifact.slug, artifact.description, artifact.relative_path]
        .map((value) => asString(value).toLowerCase())
        .some((value) => value.includes(query));
    })
    .map((artifact) => ({
      ...assignedSkillCatalogItem(artifact),
      assigned: assignedIds.has(asString(artifact.id)),
    }));
  const { data: repositories, error: repositoriesError } =
    access.workspaceRole === "admin"
      ? await ctx.admin
          .from("workspace_skill_repositories")
          .select("id,label,status,updated_at")
          .eq("workspace_id", ctx.workspace.id)
          .eq("status", "active")
          .order("updated_at", { ascending: false })
      : { data: [], error: null };
  if (repositoriesError) throw new Error(repositoriesError.message);
  return {
    items,
    assignmentCount: assignedIds.size,
    canCreateSkills: access.workspaceRole === "admin",
    creationRepositories: (repositories || []).map((repository) => ({
      id: asString(repository.id),
      label: asString(repository.label) || "Skills repository",
    })),
  };
}

export async function setChannelSkillAssignmentForUser(input: {
  userId: string;
  workspaceId: string;
  channelId: string;
  actorUserId: string;
  artifactId: string;
  enabled: boolean;
}) {
  const ctx = await getContextForUser(input.userId, false, input.workspaceId);
  await assertChannelSkillManager(ctx, input);
  const artifactId = asString(input.artifactId);
  const { data: artifact, error: artifactError } = await ctx.admin
    .from("workspace_skill_artifacts")
    .select("id,artifact_type,slug,name,description,relative_path,targets,lifecycle")
    .eq("id", artifactId)
    .eq("workspace_id", ctx.workspace.id)
    .eq("lifecycle", "active")
    .maybeSingle();
  if (artifactError) throw new Error(artifactError.message);
  if (!artifact) throw new Error("Skill or instruction doc not found.");
  const targets = normalizeTargets(artifact.targets);
  if (!targets.includes("all") && !targets.includes("flow")) {
    throw new Error("This capability is not available to Team Chat.");
  }

  if (!input.enabled) {
    const { error } = await ctx.admin
      .from("chat_channel_skill_assignments")
      .delete()
      .eq("channel_id", input.channelId)
      .eq("workspace_id", ctx.workspace.id)
      .eq("artifact_id", artifactId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await ctx.admin
      .from("chat_channel_skill_assignments")
      .upsert(
        {
          channel_id: input.channelId,
          workspace_id: ctx.workspace.id,
          artifact_id: artifactId,
          added_by: input.actorUserId,
        },
        { onConflict: "channel_id,artifact_id", ignoreDuplicates: true },
      );
    if (error) throw new Error(error.message);
  }

  await ctx.admin.from("workspace_skill_audit_events").insert({
    workspace_id: ctx.workspace.id,
    actor_user_id: input.actorUserId,
    event_type: input.enabled
      ? "channel_skill_assignment_set"
      : "channel_skill_assignment_removed",
    artifact_id: artifactId,
    metadata: { channelId: input.channelId },
  });
  return {
    item: assignedSkillCatalogItem(artifact as Record<string, unknown>),
    enabled: input.enabled,
  };
}

export async function createChannelSkillForUser(input: {
  userId: string;
  workspaceId: string;
  channelId: string;
  actorUserId: string;
  deviceId: string;
  name: string;
  description: string;
  instructions: string;
  actionsManifest?: string | null;
  repository?: string | null;
}) {
  // The runtime owner supplies the connector, but the human actor remains the
  // authorization and audit subject for this workspace-wide Git write.
  const ctx = await getContextForUser(input.userId, true, input.workspaceId);
  const access = await assertChannelSkillManager(ctx, input);
  if (access.workspaceRole !== "admin") {
    throw new Error(
      "Only a workspace admin can author a new shared skill. Channel creators can assign existing skills.",
    );
  }
  const deviceId = asString(input.deviceId);
  if (!deviceId) {
    throw new Error(
      "The Groovy Connector must be online to create and push a Git-backed skill.",
    );
  }
  const skill = buildChannelSkillArtifact(input);
  const { data: repositoryRows, error: repositoriesError } = await ctx.admin
    .from("workspace_skill_repositories")
    .select("id,label,repo_url,status,updated_at")
    .eq("workspace_id", ctx.workspace.id)
    .eq("status", "active")
    .order("updated_at", { ascending: false });
  if (repositoriesError) throw new Error(repositoriesError.message);
  const repository = resolveChannelSkillRepository(
    ((repositoryRows || []) as Array<Record<string, unknown>>).map((row) => ({
      id: asString(row.id),
      label: asString(row.label) || defaultLabelForRepo(asString(row.repo_url)),
      repoUrl: asString(row.repo_url),
    })),
    input.repository,
  );

  const createResult = await createSkillsArtifactWithContext(
    ctx,
    {
      repositoryId: repository.id,
      deviceId,
      artifactType: "skill",
      relativePath: skill.relativePath,
      content: skill.content,
      name: skill.name,
      description: skill.description,
      targets: ["flow"],
      overwrite: false,
      commitMessage: `Add channel skill ${skill.name}`,
      companionFiles:
        skill.actionsRelativePath && skill.actionsContent
          ? [
              {
                relativePath: skill.actionsRelativePath,
                content: skill.actionsContent,
              },
            ]
          : [],
    },
    input.actorUserId,
  );
  if (createResult.ok !== true) {
    const code = asString(createResult.error || createResult.error_code);
    if (code.includes("unsupported_skills_rpc")) {
      throw new Error(
        "Update Groovy Desktop and its Connector to v0.24.33 or newer before creating an executable skill.",
      );
    }
    if (code === "artifact_already_exists") {
      throw new Error(
        `A skill already exists at ${skill.relativePath}. Choose a distinct skill name or assign the existing skill.`,
      );
    }
    throw new Error(code || "The connector could not create and push the skill.");
  }
  const syncResult = asRecord(createResult.syncResult);
  if (syncResult.ok !== true) {
    throw new Error(
      `The skill was written to the Git checkout, but Skills & Docs could not sync it: ${
        asString(syncResult.error) || "repository sync failed"
      }`,
    );
  }

  const { data: artifact, error: artifactError } = await ctx.admin
    .from("workspace_skill_artifacts")
    .select("id,artifact_type,slug,name,description,relative_path,targets,lifecycle")
    .eq("workspace_id", ctx.workspace.id)
    .eq("repository_id", repository.id)
    .eq("relative_path", skill.relativePath)
    .eq("lifecycle", "active")
    .maybeSingle();
  if (artifactError) throw new Error(artifactError.message);
  if (!artifact?.id) {
    throw new Error(
      "The skill was pushed, but its synced Skills & Docs artifact could not be resolved.",
    );
  }

  const assignment = await setChannelSkillAssignmentForUser({
    userId: input.userId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    actorUserId: input.actorUserId,
    artifactId: String(artifact.id),
    enabled: true,
  });
  return {
    ...assignment,
    repository: { id: repository.id, label: repository.label },
    relativePath: skill.relativePath,
    actionsRelativePath: skill.actionsRelativePath,
    commitSha: asString(createResult.commitSha || syncResult.commitSha) || null,
  };
}

export async function updateChannelSkillActionsForUser(input: {
  userId: string;
  workspaceId: string;
  channelId: string;
  actorUserId: string;
  deviceId: string;
  artifact: string;
  actionsManifest: string;
}) {
  const ctx = await getContextForUser(input.userId, true, input.workspaceId);
  const access = await assertChannelSkillManager(ctx, input);
  if (access.workspaceRole !== "admin") {
    throw new Error(
      "Only a workspace admin can update executable actions for a shared skill.",
    );
  }
  const deviceId = asString(input.deviceId);
  if (!deviceId) {
    throw new Error(
      "The Groovy Connector must be online to update a Git-backed skill.",
    );
  }
  const actionsContent = normalizeChannelSkillActionsManifest(
    input.actionsManifest,
  );
  if (!actionsContent) throw new Error("A complete groovy-actions.json is required.");

  const [artifactsResult, assignmentsResult] = await Promise.all([
    ctx.admin
      .from("workspace_skill_artifacts")
      .select(
        "id,repository_id,artifact_type,slug,name,description,relative_path,targets,lifecycle,content_snapshot",
      )
      .eq("workspace_id", ctx.workspace.id)
      .eq("artifact_type", "skill")
      .eq("lifecycle", "active"),
    ctx.admin
      .from("chat_channel_skill_assignments")
      .select("artifact_id")
      .eq("workspace_id", ctx.workspace.id)
      .eq("channel_id", input.channelId),
  ]);
  const { data: rows, error } = artifactsResult;
  if (error) throw new Error(error.message);
  if (assignmentsResult.error) throw new Error(assignmentsResult.error.message);
  const assignedIds = new Set(
    (assignmentsResult.data || []).map((row) => asString(row.artifact_id)),
  );
  const assignedRows = ((rows || []) as Array<Record<string, unknown>>).filter(
    (row) => assignedIds.has(asString(row.id)),
  );
  const items = assignedRows.map(
    assignedSkillCatalogItem,
  );
  const resolved = resolveAssignedSkillReference(items, input.artifact);
  if (!resolved.ok) throw new Error(resolved.error.replace("assigned capabilities", "skills"));
  const artifact = assignedRows.find(
    (row) => asString(row.id) === resolved.item.id,
  );
  if (!artifact) throw new Error("Skill not found.");
  const relativePath = asString(artifact.relative_path);
  const content = asString(artifact.content_snapshot);
  const repositoryId = asString(artifact.repository_id);
  if (!relativePath || !content || !repositoryId) {
    throw new Error(
      "This skill has no synchronized Git source. Sync its repository before adding actions.",
    );
  }
  const actionsRelativePath = `${relativePath.slice(0, -"SKILL.md".length)}groovy-actions.json`;
  const updateResult = await createSkillsArtifactWithContext(
    ctx,
    {
      repositoryId,
      deviceId,
      artifactType: "skill",
      relativePath,
      content,
      name: asString(artifact.name),
      description: asString(artifact.description),
      targets: normalizeTargets(artifact.targets),
      overwrite: true,
      preservePrimary: true,
      commitMessage: `Update actions for ${asString(artifact.name) || asString(artifact.slug) || "skill"}`,
      companionFiles: [
        { relativePath: actionsRelativePath, content: actionsContent },
      ],
    },
    input.actorUserId,
  );
  if (updateResult.ok !== true) {
    const code = asString(updateResult.error || updateResult.error_code);
    if (code.includes("unsupported_skills_rpc")) {
      throw new Error(
        "Update Groovy Desktop and its Connector to v0.24.33 or newer before adding executable skill actions.",
      );
    }
    throw new Error(
      code ||
        "The Connector could not update the skill action manifest.",
    );
  }
  const syncResult = asRecord(updateResult.syncResult);
  if (syncResult.ok !== true) {
    throw new Error(
      `The manifest was written, but Skills & Docs could not sync it: ${
        asString(syncResult.error) || "repository sync failed"
      }`,
    );
  }
  const { data: refreshed, error: refreshedError } = await ctx.admin
    .from("workspace_skill_artifacts")
    .select("id,artifact_type,slug,name,description,relative_path,targets,lifecycle,metadata")
    .eq("id", resolved.item.id)
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (refreshedError) throw new Error(refreshedError.message);
  if (!refreshed) throw new Error("The updated skill could not be resolved after sync.");
  return {
    item: assignedSkillCatalogItem(refreshed as Record<string, unknown>),
    relativePath,
    actionsRelativePath,
    commitSha:
      asString(updateResult.commitSha || syncResult.commitSha) || null,
  };
}

export async function reassignSkillAssignment(input: {
  assignmentId: string;
  toAgentId: string;
}) {
  const ctx = await getContext(true);
  const assignmentId = asString(input.assignmentId);
  const toAgentId = asString(input.toAgentId);
  if (!assignmentId || !toAgentId) throw new Error("assignmentId and toAgentId are required");

  const { data: assignment, error: assignmentErr } = await ctx.admin
    .from("workspace_skill_assignments")
    .select("id,workspace_id,artifact_id,agent_id,profile_id,target,scope,enabled")
    .eq("id", assignmentId)
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (assignmentErr) throw new Error(assignmentErr.message);
  if (!assignment?.id) throw new Error("Assignment not found");
  if (assignment.profile_id) {
    throw new Error("Mind assignments must be changed from the Mind capabilities editor");
  }
  if (!assignment.agent_id || assignment.scope !== "agent") {
    throw new Error("Only agent assignments can be reassigned");
  }

  const memberUserIds = ctx.workspace.members.map((member) => member.user_id);
  const { data: toAgent, error: agentErr } = await ctx.admin
    .from("agents")
    .select("id,user_id,type")
    .eq("id", toAgentId)
    .in("user_id", memberUserIds.length ? memberUserIds : ["00000000-0000-0000-0000-000000000000"])
    .maybeSingle();
  if (agentErr) throw new Error(agentErr.message);
  if (!toAgent?.id) throw new Error("Destination agent not found in this workspace");

  let nextTarget: "flow" | "claude" | "codex" = "flow";
  if (asString(toAgent.type) === "claude-code") {
    const { data: codeConfig, error: codeConfigErr } = await ctx.admin
      .from("claude_code_agent_configs")
      .select("code_cli_provider")
      .eq("agent_id", toAgentId)
      .maybeSingle();
    if (codeConfigErr) throw new Error(codeConfigErr.message);
    nextTarget = asString((codeConfig as Record<string, unknown> | null)?.code_cli_provider) === "codex" ? "codex" : "claude";
  }

  const { data: artifact, error: artifactErr } = await ctx.admin
    .from("workspace_skill_artifacts")
    .select("id,targets")
    .eq("id", asString(assignment.artifact_id))
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (artifactErr) throw new Error(artifactErr.message);
  if (!artifact?.id) throw new Error("Artifact not found");
  const artifactTargets = normalizeTargets((artifact as Record<string, unknown>).targets);
  if (!artifactTargets.includes("all") && !artifactTargets.includes(nextTarget)) {
    throw new Error(`This artifact is not declared compatible with ${nextTarget}.`);
  }

  if (toAgentId === asString(assignment.agent_id) && nextTarget === asString(assignment.target)) {
    return { ok: true, assignment, unchanged: true };
  }

  const { data: existing, error: existingErr } = await ctx.admin
    .from("workspace_skill_assignments")
    .select("id")
    .eq("workspace_id", ctx.workspace.id)
    .eq("artifact_id", asString(assignment.artifact_id))
    .eq("agent_id", toAgentId)
    .is("profile_id", null)
    .eq("target", nextTarget)
    .maybeSingle();
  if (existingErr) throw new Error(existingErr.message);

  if (existing?.id && String(existing.id) !== assignmentId) {
    const { data: mergedAssignment, error: mergeErr } = await ctx.admin
      .from("workspace_skill_assignments")
      .update({ enabled: true, updated_at: new Date().toISOString() })
      .eq("id", String(existing.id))
      .eq("workspace_id", ctx.workspace.id)
      .select("id,workspace_id,artifact_id,agent_id,target,scope,enabled,metadata,created_at,updated_at")
      .single();
    if (mergeErr || !mergedAssignment?.id) {
      throw new Error(mergeErr?.message || "Failed to update destination assignment");
    }
    const { error: deleteErr } = await ctx.admin
      .from("workspace_skill_assignments")
      .delete()
      .eq("id", assignmentId)
      .eq("workspace_id", ctx.workspace.id);
    if (deleteErr) throw new Error(deleteErr.message);
    await audit(ctx, "skills_assignment_reassigned", {
      artifactId: asString(assignment.artifact_id),
      assignmentId: String(existing.id),
      metadata: {
        fromAssignmentId: assignmentId,
        fromAgentId: asString(assignment.agent_id),
        toAgentId,
        fromTarget: asString(assignment.target),
        toTarget: nextTarget,
        merged: true,
      },
    });
    return { ok: true, assignment: mergedAssignment, merged: true };
  }

  const { data, error } = await ctx.admin
    .from("workspace_skill_assignments")
    .update({
      agent_id: toAgentId,
      target: nextTarget,
      scope: "agent",
      enabled: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", assignmentId)
    .eq("workspace_id", ctx.workspace.id)
    .select("id,workspace_id,artifact_id,agent_id,target,scope,enabled,metadata,created_at,updated_at")
    .single();
  if (error || !data?.id) throw new Error(error?.message || "Failed to reassign artifact");

  await audit(ctx, "skills_assignment_reassigned", {
    artifactId: asString(assignment.artifact_id),
    assignmentId: String(data.id),
    metadata: {
      fromAgentId: asString(assignment.agent_id),
      toAgentId,
      fromTarget: asString(assignment.target),
      toTarget: nextTarget,
    },
  });
  return { ok: true, assignment: data };
}

async function loadAssignedArtifactsForTarget(
  ctx: AuthedContext,
  input: {
    agentId?: string | null;
    profileId?: string | null;
    additionalArtifactIds?: string[];
    target: "flow" | "claude" | "codex";
  }
) {
  const target = input.target === "codex" || input.target === "claude" ? input.target : "flow";
  const agentId = asString(input.agentId || "") || null;
  const profileId =
    asString(input.profileId || "") && input.profileId !== "__default__"
      ? asString(input.profileId)
      : null;
  let inheritWorkspaceSkills = true;
  if (profileId) {
    const { data: profile, error: profileError } = await ctx.admin
      .from("orchestrator_profiles")
      .select("id,workspace_id,user_id,inherit_workspace_skills")
      .eq("id", profileId)
      .maybeSingle();
    if (profileError) throw new Error(profileError.message);
    const belongsToContext =
      profile?.workspace_id === ctx.workspace.id ||
      (
        profile?.workspace_id == null &&
        profile?.user_id === ctx.userId
      );
    if (!profile || !belongsToContext) {
      throw new Error("Harness profile is unavailable for skill assignment resolution");
    }
    inheritWorkspaceSkills = profile.inherit_workspace_skills !== false;
  }
  const { data: assignments, error: assignmentErr } = await ctx.admin
    .from("workspace_skill_assignments")
    .select("id,artifact_id,agent_id,profile_id,target,scope,workspace_skill_artifacts!inner(id,repository_id,artifact_type,slug,name,description,relative_path,exact_filename,targets,checksum,commit_sha,lifecycle,metadata,risk_flags,content_snapshot,content_snapshot_truncated,content_snapshot_updated_at)")
    .eq("workspace_id", ctx.workspace.id)
    .eq("enabled", true)
    .in("target", ["all", target]);
  if (assignmentErr) throw new Error(assignmentErr.message);

  const selected = ((assignments || []) as Array<Record<string, unknown>>).filter((row) => {
    const rowAgentId = asString(row.agent_id);
    const rowProfileId = asString(row.profile_id);
    if (rowProfileId) return Boolean(profileId && rowProfileId === profileId);
    if (!inheritWorkspaceSkills) return false;
    return !rowAgentId || (agentId && rowAgentId === agentId);
  });
  const assignedArtifacts = selected
    .map((row) => row.workspace_skill_artifacts)
    .filter(
      (row): row is Record<string, unknown> =>
        !!row &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        (row as Record<string, unknown>).lifecycle === "active",
    );
  const additionalArtifactIds = Array.from(
    new Set(
      (input.additionalArtifactIds || []).map(asString).filter(Boolean),
    ),
  );
  const { data: additionalArtifacts, error: additionalError } =
    additionalArtifactIds.length > 0
      ? await ctx.admin
          .from("workspace_skill_artifacts")
          .select(
            "id,repository_id,artifact_type,slug,name,description,relative_path,exact_filename,targets,checksum,commit_sha,metadata,risk_flags,content_snapshot,content_snapshot_truncated,content_snapshot_updated_at",
          )
          .eq("workspace_id", ctx.workspace.id)
          .eq("lifecycle", "active")
          .in("id", additionalArtifactIds)
      : { data: [], error: null };
  if (additionalError) throw new Error(additionalError.message);
  const explicitArtifacts = (
    (additionalArtifacts || []) as Array<Record<string, unknown>>
  ).filter((artifact) => {
    const targets = normalizeTargets(artifact.targets);
    return targets.includes("all") || targets.includes(target);
  });
  const artifacts = [...assignedArtifacts, ...explicitArtifacts].filter(
    (artifact, index, rows) =>
      rows.findIndex(
        (candidate) => asString(candidate.id) === asString(artifact.id),
      ) === index,
  );
  return { target, agentId, artifacts };
}

function assignedSkillCatalogItem(
  artifact: Record<string, unknown>,
): AssignedSkillCatalogItem {
  const metadata = asRecord(artifact.metadata);
  const actionsManifest = asRecord(metadata.groovyActions);
  const actions = asArray(actionsManifest.actions)
    .map(asRecord)
    .map((action) => ({
      name: asString(action.name),
      description: asString(action.description),
      secrets: asArray(action.secrets).map(asString).filter(Boolean),
    }))
    .filter((action) => action.name);
  return {
    id: asString(artifact.id),
    artifactType:
      asString(artifact.artifact_type) === "instruction_doc"
        ? "instruction_doc"
        : "skill",
    slug: asString(artifact.slug),
    name:
      asString(artifact.name) ||
      asString(artifact.slug) ||
      asString(artifact.relative_path),
    description: asString(artifact.description),
    relativePath: asString(artifact.relative_path),
    ...(actions.length ? { actions } : {}),
  };
}

export async function resolveAssignedSkillActionForUser(input: {
  userId: string;
  workspaceId?: string | null;
  agentId?: string | null;
  profileId?: string | null;
  additionalArtifactIds?: string[];
  target: "flow" | "claude" | "codex";
  artifact: string;
  action: string;
  args: Record<string, unknown>;
  deviceId: string;
}) {
  const ctx = await getContextForUser(input.userId, false, input.workspaceId);
  const { artifacts } = await loadAssignedArtifactsForTarget(ctx, input);
  const reference = input.artifact.trim().toLowerCase();
  const matches = artifacts.filter((artifact) =>
    [artifact.id, artifact.name, artifact.slug, artifact.relative_path]
      .map(asString).some((value) => value.toLowerCase() === reference),
  );
  if (matches.length !== 1) throw new Error(matches.length ? "Skill reference is ambiguous" : "Skill is not assigned to this Mind or channel");
  const artifact = matches[0];
  const manifest = asRecord(asRecord(artifact.metadata).groovyActions);
  const action = asArray(manifest.actions).map(asRecord).find((item) => asString(item.name) === input.action);
  if (!action) throw new Error("This action is not declared by the assigned skill");
  const requiredKeys = Array.from(new Set(asArray(action.secrets).map(asString).filter(Boolean)));
  const artifactId = asString(artifact.id);
  const profileId = asString(input.profileId || "");
  const agentId = asString(input.agentId || "");
  if (!profileId && !agentId) throw new Error("Secret-backed actions require an explicitly selected Mind or worker");

  const { data: artifactGrants, error: artifactGrantError } = await ctx.admin
    .from("workspace_secret_artifact_grants")
    .select("secret_id,workspace_secret_definitions!inner(id,key,name)")
    .eq("workspace_id", ctx.workspace.id)
    .eq("artifact_id", artifactId);
  if (artifactGrantError) throw new Error(artifactGrantError.message);
  const candidates = (artifactGrants || []).map((row) => {
    const definition = Array.isArray(row.workspace_secret_definitions) ? row.workspace_secret_definitions[0] : row.workspace_secret_definitions;
    return { id: asString(row.secret_id), key: asString(definition?.key), name: asString(definition?.name) };
  }).filter((item) => requiredKeys.includes(item.key));
  const candidateIds = candidates.map((item) => item.id);
  const targetQuery = profileId
    ? ctx.admin.from("workspace_secret_profile_grants").select("secret_id").eq("workspace_id", ctx.workspace.id).eq("profile_id", profileId).in("secret_id", candidateIds.length ? candidateIds : ["00000000-0000-0000-0000-000000000000"])
    : ctx.admin.from("workspace_secret_agent_grants").select("secret_id").eq("workspace_id", ctx.workspace.id).eq("agent_id", agentId).in("secret_id", candidateIds.length ? candidateIds : ["00000000-0000-0000-0000-000000000000"]);
  const { data: targetGrants, error: targetGrantError } = await targetQuery;
  if (targetGrantError) throw new Error(targetGrantError.message);
  const targetGranted = new Set((targetGrants || []).map((row) => asString(row.secret_id)));
  const bindings = candidates.filter((item) => targetGranted.has(item.id));
  const missing = requiredKeys.filter((key) => !bindings.some((item) => item.key === key));
  if (missing.length) throw new Error(`Required secrets are not assigned to both this skill and ${profileId ? "Mind" : "worker"}: ${missing.join(", ")}`);
  if (bindings.length) {
    const { data: readiness, error: readinessError } = await ctx.admin.from("workspace_secret_device_readiness").select("secret_id,configured").eq("workspace_id", ctx.workspace.id).eq("device_id", input.deviceId).in("secret_id", bindings.map((item) => item.id));
    if (readinessError) throw new Error(readinessError.message);
    const ready = new Set((readiness || []).filter((row) => row.configured).map((row) => asString(row.secret_id)));
    const unavailable = bindings.filter((item) => !ready.has(item.id));
    if (unavailable.length) throw new Error(`Configure these secrets on the selected Connector: ${unavailable.map((item) => item.key).join(", ")}`);
  }
  const { data: repository, error: repoError } = await ctx.admin.from("workspace_skill_repositories").select("repo_url,default_ref").eq("workspace_id", ctx.workspace.id).eq("id", asString(artifact.repository_id)).single();
  if (repoError) throw new Error(repoError.message);
  return {
    __connector_execute__: true as const,
    type: "skill_action_execute",
    params: { workspace_id: ctx.workspace.id, repo_url: repository.repo_url, ref: repository.default_ref, relative_path: asString(artifact.relative_path), action: input.action, args: input.args, secret_bindings: bindings },
    toolName: "run_skill_action",
    agent: "skills",
    message: `Running ${input.action} locally…`,
  };
}

async function listAssignedSkillsCatalogWithContext(
  ctx: AuthedContext,
  input: {
    agentId?: string | null;
    profileId?: string | null;
    additionalArtifactIds?: string[];
    target: "flow" | "claude" | "codex";
  },
): Promise<{ items: AssignedSkillCatalogItem[]; artifactCount: number }> {
  const { artifacts } = await loadAssignedArtifactsForTarget(ctx, input);
  const items = artifacts.map(assignedSkillCatalogItem);
  return { items, artifactCount: items.length };
}

export async function listAssignedSkillsCatalogForUser(input: {
  userId: string;
  workspaceId?: string | null;
  agentId?: string | null;
  profileId?: string | null;
  additionalArtifactIds?: string[];
  target: "flow" | "claude" | "codex";
}): Promise<{ items: AssignedSkillCatalogItem[]; artifactCount: number }> {
  const ctx = await getContextForUser(input.userId, false, input.workspaceId);
  return listAssignedSkillsCatalogWithContext(ctx, input);
}

async function preflightAgentSkillsWithContext(
  ctx: AuthedContext,
  input: {
    deviceId: string;
    agentId?: string | null;
    profileId?: string | null;
    additionalArtifactIds?: string[];
    target: "flow" | "claude" | "codex";
  }
) {
  const deviceId = asString(input.deviceId);
  if (!deviceId) throw new Error("deviceId is required");
  const { target, agentId, artifacts } = await loadAssignedArtifactsForTarget(ctx, input);
  const repoIds = Array.from(new Set(artifacts.map((artifact) => asString(artifact.repository_id)).filter(Boolean)));

  const results: unknown[] = [];
  for (const repositoryId of repoIds) {
    const repo = await getRepository(ctx, repositoryId);
    const repoArtifacts = artifacts.filter((artifact) => asString(artifact.repository_id) === repositoryId);
    const result = await callSkillsConnectorRpc({
      ctx,
      deviceId,
      rpcType: "skills_artifact_materialize",
      timeoutMs: 3 * 60 * 1000,
      payload: {
        repository_id: repositoryId,
        workspace_id: ctx.workspace.id,
        repo_url: asString(repo.repo_url),
        ref: asString(repo.default_ref) || "main",
        target,
        agent_id: agentId,
        artifacts: repoArtifacts.map((artifact) => ({
          id: asString(artifact.id),
          artifact_type: asString(artifact.artifact_type),
          slug: asString(artifact.slug),
          name: asString(artifact.name),
          relative_path: asString(artifact.relative_path),
          exact_filename: asString(artifact.exact_filename),
          checksum: asString(artifact.checksum),
        })),
      },
    });
    await recordSyncResult({
      ctx,
      repositoryId,
      deviceId,
      operation: "preflight",
      result,
      artifactCount: repoArtifacts.length,
    });
    results.push({ repositoryId, result });
  }

  await audit(ctx, "skills_preflight_ran", {
    metadata: { target, agentId, repositoryCount: repoIds.length, artifactCount: artifacts.length },
  });
  return { ok: true, target, agentId, artifactCount: artifacts.length, results };
}

export async function preflightAgentSkills(input: {
  deviceId: string;
  agentId?: string | null;
  profileId?: string | null;
  target: "flow" | "claude" | "codex";
}) {
  const ctx = await getContext(false);
  return preflightAgentSkillsWithContext(ctx, input);
}

export async function preflightAgentSkillsForUser(input: {
  userId: string;
  deviceId: string;
  agentId?: string | null;
  profileId?: string | null;
  target: "flow" | "claude" | "codex";
}) {
  const ctx = await getContextForUser(input.userId, false);
  return preflightAgentSkillsWithContext(ctx, input);
}

async function buildAssignedSkillsPromptContextWithContext(
  ctx: AuthedContext,
  input: {
    deviceId: string;
    agentId?: string | null;
    profileId?: string | null;
    additionalArtifactIds?: string[];
    target: "flow" | "claude" | "codex";
  }
): Promise<{ text: string; artifactCount: number }> {
  const deviceId = asString(input.deviceId);
  const { artifacts } = await loadAssignedArtifactsForTarget(ctx, input);
  if (artifacts.length === 0) return { text: "", artifactCount: 0 };

  const repoIds = Array.from(new Set(artifacts.map((artifact) => asString(artifact.repository_id)).filter(Boolean)));
  const [reposRes, syncsRes] = await Promise.all([
    repoIds.length
      ? ctx.admin
          .from("workspace_skill_repositories")
          .select("id,label,last_commit_sha")
          .eq("workspace_id", ctx.workspace.id)
          .in("id", repoIds)
      : Promise.resolve({ data: [], error: null }),
    repoIds.length
      ? ctx.admin
          .from("workspace_skill_device_syncs")
          .select("repository_id,status,commit_sha,diagnostics,materialized_at,updated_at")
          .eq("workspace_id", ctx.workspace.id)
          .eq("user_id", ctx.userId)
          .eq("device_id", deviceId)
          .in("repository_id", repoIds)
          .order("updated_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (reposRes.error) throw new Error(reposRes.error.message);
  if (syncsRes.error) throw new Error(syncsRes.error.message);

  const repoById = new Map(
    ((reposRes.data || []) as Array<Record<string, unknown>>).map((repo) => [asString(repo.id), repo])
  );
  const syncByRepo = new Map<string, Record<string, unknown>>();
  for (const sync of (syncsRes.data || []) as Array<Record<string, unknown>>) {
    const repoId = asString(sync.repository_id);
    if (repoId && !syncByRepo.has(repoId)) syncByRepo.set(repoId, sync);
  }

  const pathByRepoAndRel = new Map<string, string>();
  for (const sync of syncByRepo.values()) {
    const repoId = asString(sync.repository_id);
    const diagnostics = asRecord(sync.diagnostics);
    const materialized = [...asArray(diagnostics.artifacts), ...asArray(diagnostics.materialized)];
    for (const raw of materialized) {
      const row = asRecord(raw);
      const rel = asString(row.relativePath || row.relative_path);
      const p = asString(row.path || row.materializedPath || row.materialized_path);
      if (repoId && rel && p) pathByRepoAndRel.set(`${repoId}:${rel}`, p);
    }
  }

  const lines = [
    "## Enabled Skills & Docs (local catalog only)",
    "The entries below are enabled for this worker, but their bodies are not included in this prompt.",
    "Before starting a task for which an entry clearly applies, read that exact local file first and follow it. Do not read capabilities for unrelated tasks.",
  ];

  for (const artifact of artifacts.slice(0, 20)) {
    const repoId = asString(artifact.repository_id);
    const repo = repoById.get(repoId);
    const sync = syncByRepo.get(repoId);
    const relativePath = asString(artifact.relative_path);
    const localPath = pathByRepoAndRel.get(`${repoId}:${relativePath}`);
    const kind = asString(artifact.artifact_type) === "skill" ? "Skill" : "Instruction";
    const label = asString(artifact.name) || asString(artifact.slug) || relativePath;
    const repoLabel = asString(repo?.label) || "skills repo";
    const commit = asString(sync?.commit_sha || artifact.commit_sha || repo?.last_commit_sha);
    if (localPath) {
      const readablePath =
        kind === "Skill"
          ? `${localPath.replace(/[\\/]+$/, "")}/SKILL.md`
          : localPath;
      lines.push(
        `- ${kind}: ${label} — ${asString(artifact.description) || "No description provided."} [${repoLabel} at ${commit ? commit.slice(0, 8) : "unsynced"}; local path: ${readablePath}]`,
      );
    } else {
      lines.push(
        `- ${kind}: ${label} (${repoLabel}) is enabled but has no readable local path. Do not claim it was applied.`,
      );
    }
  }

  return { text: `${lines.join("\n")}\n`, artifactCount: artifacts.length };
}

async function readAssignedSkillWithContext(
  ctx: AuthedContext,
  input: {
    artifact: string;
    deviceId?: string | null;
    agentId?: string | null;
    profileId?: string | null;
    additionalArtifactIds?: string[];
    target: "flow" | "claude" | "codex";
  },
) {
  const { target, agentId, artifacts } = await loadAssignedArtifactsForTarget(
    ctx,
    input,
  );
  const catalog = artifacts.map(assignedSkillCatalogItem);
  const resolved = resolveAssignedSkillReference(catalog, input.artifact);
  if (!resolved.ok) throw new Error(resolved.error);
  const artifact = artifacts.find(
    (candidate) => asString(candidate.id) === resolved.item.id,
  );
  if (!artifact) throw new Error("Assigned capability is unavailable.");

  const deviceId = asString(input.deviceId || "");
  const repositoryId = asString(artifact.repository_id);
  let content = "";
  let source = "server_snapshot";
  let truncated = artifact.content_snapshot_truncated === true;

  if (deviceId && repositoryId) {
    try {
      const repo = await getRepository(ctx, repositoryId);
      const materialized = await callSkillsConnectorRpc({
        ctx,
        deviceId,
        rpcType: "skills_artifact_materialize",
        timeoutMs: 3 * 60 * 1000,
        payload: {
          repository_id: repositoryId,
          workspace_id: ctx.workspace.id,
          repo_url: asString(repo.repo_url),
          ref: asString(repo.default_ref) || "main",
          target,
          agent_id: agentId,
          artifacts: [
            {
              id: asString(artifact.id),
              artifact_type: asString(artifact.artifact_type),
              slug: asString(artifact.slug),
              name: asString(artifact.name),
              relative_path: asString(artifact.relative_path),
              exact_filename: asString(artifact.exact_filename),
              checksum: asString(artifact.checksum),
            },
          ],
        },
      });
      await recordSyncResult({
        ctx,
        repositoryId,
        deviceId,
        operation: "materialize",
        result: materialized,
        artifactCount: 1,
      });
      const materializedItem = asArray(materialized.artifacts)
        .map(asRecord)
        .find(
          (item) =>
            item.ok === true &&
            asString(item.relativePath || item.relative_path) ===
              asString(artifact.relative_path),
        );
      const localPath = asString(materializedItem?.path);
      if (localPath) {
        const readResult = await callSkillsConnectorRpc({
          ctx,
          deviceId,
          rpcType: "skills_assigned_context_read",
          timeoutMs: 30_000,
          payload: { paths: [localPath] },
        });
        const readItem = asArray(readResult.items).map(asRecord)[0];
        if (readItem?.ok === true && typeof readItem.content === "string") {
          content = readItem.content;
          truncated = readItem.truncated === true;
          source = "local_connector";
        }
      }
    } catch (error) {
      console.warn("[skills-manager] assigned skill local read failed", {
        artifactId: resolved.item.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!content && typeof artifact.content_snapshot === "string") {
    const bounded = truncateUtf8(artifact.content_snapshot, 32 * 1024);
    content = bounded.value;
    truncated = truncated || bounded.truncated;
  }
  if (!content) {
    throw new Error(
      "This enabled capability has no readable content. Ask a workspace admin to sync the Skills library.",
    );
  }

  await audit(ctx, "assigned_skill_read", {
    repositoryId,
    artifactId: resolved.item.id,
    metadata: { target, agentId, source, truncated },
  });
  return {
    ...resolved.item,
    source,
    truncated,
    content,
  };
}

export async function readAssignedSkillForUser(input: {
  userId: string;
  workspaceId?: string | null;
  artifact: string;
  deviceId?: string | null;
  agentId?: string | null;
  profileId?: string | null;
  additionalArtifactIds?: string[];
  target: "flow" | "claude" | "codex";
}) {
  const ctx = await getContextForUser(input.userId, false, input.workspaceId);
  return readAssignedSkillWithContext(ctx, input);
}

export async function buildAssignedSkillsPromptContext(input: {
  deviceId: string;
  agentId?: string | null;
  profileId?: string | null;
  additionalArtifactIds?: string[];
  target: "flow" | "claude" | "codex";
}): Promise<{ text: string; artifactCount: number }> {
  const ctx = await getContext(false);
  return buildAssignedSkillsPromptContextWithContext(ctx, input);
}

export async function buildAssignedSkillsPromptContextForUser(input: {
  userId: string;
  workspaceId?: string | null;
  deviceId: string;
  agentId?: string | null;
  profileId?: string | null;
  additionalArtifactIds?: string[];
  target: "flow" | "claude" | "codex";
}): Promise<{ text: string; artifactCount: number }> {
  const ctx = await getContextForUser(input.userId, false, input.workspaceId);
  return buildAssignedSkillsPromptContextWithContext(ctx, input);
}
