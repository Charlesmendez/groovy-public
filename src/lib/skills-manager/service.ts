import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { callConnectorRpcViaRelay } from "@/lib/relay/connectorRpc";
import {
  getAuthedUser,
  getOrCreateWorkspaceForUser,
  isWorkspaceOperatorRole,
  type WorkspaceInfo,
} from "@/lib/workspaces";

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
  userId: string
): Promise<WorkspaceInfo> {
  const { data: memberships, error: memberErr } = await admin
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", userId)
    .limit(1);
  if (memberErr) throw new Error(memberErr.message);
  const membership = memberships?.[0];
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

async function getContextForUser(userId: string, requireAdmin = false): Promise<AuthedContext> {
  const admin = createSupabaseAdminClient();
  const workspace = await getWorkspaceForUserId(admin, userId);
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
    repositoryId?: string | null;
    artifactId?: string | null;
    assignmentId?: string | null;
    metadata?: Record<string, unknown>;
  } = {}
) {
  await ctx.admin.from("workspace_skill_audit_events").insert({
    workspace_id: ctx.workspace.id,
    actor_user_id: ctx.userId,
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
      .select("id,workspace_id,repository_id,artifact_type,slug,name,description,relative_path,exact_filename,targets,checksum,commit_sha,lifecycle,metadata,risk_flags,created_at,updated_at")
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
    artifacts: artifactsRes.data || [],
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

export async function syncSkillsRepository(input: { repositoryId: string; deviceId: string }) {
  const ctx = await getContext(false);
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

export async function createSkillsArtifact(input: {
  repositoryId: string;
  deviceId: string;
  artifactType: "skill" | "instruction_doc";
  relativePath: string;
  content: string;
  name?: string;
  description?: string;
  targets?: string[];
  overwrite?: boolean;
  commitMessage?: string;
}) {
  const ctx = await getContext(true);
  const repositoryId = asString(input.repositoryId);
  const deviceId = asString(input.deviceId);
  if (!repositoryId || !deviceId) throw new Error("repositoryId and deviceId are required");
  if (input.artifactType !== "skill" && input.artifactType !== "instruction_doc") {
    throw new Error("artifactType must be skill or instruction_doc");
  }
  if (!asString(input.relativePath).endsWith(".md")) {
    throw new Error("Markdown artifact path must end in .md");
  }
  const repo = await getRepository(ctx, repositoryId);
  const result = await callSkillsConnectorRpc({
    ctx,
    deviceId,
    rpcType: "skills_artifact_create",
    timeoutMs: 3 * 60 * 1000,
    payload: {
      repository_id: repositoryId,
      workspace_id: ctx.workspace.id,
      repo_url: asString(repo.repo_url),
      ref: asString(repo.default_ref) || "main",
      artifact_type: input.artifactType,
      relative_path: asString(input.relativePath),
      content: String(input.content || ""),
      name: asString(input.name),
      description: asString(input.description),
      targets: normalizeTargets(input.targets),
      overwrite: input.overwrite === true,
      commit_message: asString(input.commitMessage),
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
  const syncResult = await syncSkillsRepository({ repositoryId, deviceId });
  await audit(ctx, "skills_artifact_created", {
    repositoryId,
    metadata: {
      artifactType: input.artifactType,
      relativePath: asString(input.relativePath),
    },
  });
  return { ...result, syncResult };
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
  target?: "all" | "flow" | "claude" | "codex";
  enabled?: boolean;
  }
) {
  const artifactId = asString(input.artifactId);
  if (!artifactId) throw new Error("artifactId is required");
  const target = input.target === "flow" || input.target === "claude" || input.target === "codex" ? input.target : "all";
  const agentId = asString(input.agentId || "") || null;
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
      .eq("target", target)
      .is("profile_id", null);
    deleteQuery = agentId ? deleteQuery.eq("agent_id", agentId) : deleteQuery.is("agent_id", null);
    const { error } = await deleteQuery;
    if (error) throw new Error(error.message);
    await audit(ctx, "skills_assignment_removed", { artifactId, metadata: { agentId, target } });
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

  let existingQuery = ctx.admin
    .from("workspace_skill_assignments")
    .select("id")
    .eq("workspace_id", ctx.workspace.id)
    .eq("artifact_id", artifactId)
    .eq("target", target)
    .is("profile_id", null);
  existingQuery = agentId ? existingQuery.eq("agent_id", agentId) : existingQuery.is("agent_id", null);
  const { data: existing, error: existingErr } = await existingQuery.maybeSingle();
  if (existingErr) throw new Error(existingErr.message);

  const payload = {
    workspace_id: ctx.workspace.id,
    artifact_id: artifactId,
    agent_id: agentId,
    profile_id: null,
    target,
    scope: agentId ? "agent" : "workspace",
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
    metadata: { agentId, target },
  });
  return { ok: true, assignment: data };
}

export async function setSkillAssignment(input: {
  artifactId: string;
  agentId?: string | null;
  target?: "all" | "flow" | "claude" | "codex";
  enabled?: boolean;
}) {
  const ctx = await getContext(true);
  return setSkillAssignmentWithContext(ctx, input);
}

export async function setSkillAssignmentForUser(input: {
  userId: string;
  artifactId: string;
  agentId?: string | null;
  target?: "all" | "flow" | "claude" | "codex";
  enabled?: boolean;
}) {
  const ctx = await getContextForUser(input.userId, true);
  return setSkillAssignmentWithContext(ctx, input);
}

export async function listSkillsAndDocsForUser(input: {
  userId: string;
  query?: string;
}) {
  const ctx = await getContextForUser(input.userId, false);
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
    return [artifact.name, artifact.slug, artifact.description, artifact.relative_path]
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
    .select("id,artifact_id,agent_id,profile_id,target,scope,workspace_skill_artifacts!inner(id,repository_id,artifact_type,slug,name,description,relative_path,exact_filename,targets,checksum,commit_sha,metadata,risk_flags,content_snapshot,content_snapshot_truncated,content_snapshot_updated_at)")
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
  const artifacts = selected
    .map((row) => row.workspace_skill_artifacts)
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row))
    .filter(
      (artifact, index, rows) =>
        rows.findIndex((candidate) => asString(candidate.id) === asString(artifact.id)) === index,
    );
  return { target, agentId, artifacts };
}

async function preflightAgentSkillsWithContext(
  ctx: AuthedContext,
  input: {
    deviceId: string;
    agentId?: string | null;
    profileId?: string | null;
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
    target: "flow" | "claude" | "codex";
  }
): Promise<{ text: string; artifactCount: number }> {
  const deviceId = asString(input.deviceId);
  const { artifacts } = await loadAssignedArtifactsForTarget(ctx, input);
  if (artifacts.length === 0) return { text: "", artifactCount: 0 };

  const repoIds = Array.from(new Set(artifacts.map((artifact) => asString(artifact.repository_id)).filter(Boolean)));
  const [reposRes, syncsRes] = await Promise.all([
    repoIds.length && deviceId
      ? ctx.admin
          .from("workspace_skill_repositories")
          .select("id,label,repo_url,last_commit_sha")
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

  const materializedPaths = Array.from(new Set(pathByRepoAndRel.values())).slice(0, 20);
  const contentByPath = new Map<string, { content: string; truncated: boolean }>();
  if (deviceId && materializedPaths.length > 0) {
    const readResult = await callSkillsConnectorRpc({
      ctx,
      deviceId,
      rpcType: "skills_assigned_context_read",
      timeoutMs: 30_000,
      payload: { paths: materializedPaths },
    });
    if (readResult.ok === true) {
      for (const raw of asArray(readResult.items)) {
        const item = asRecord(raw);
        const itemPath = asString(item.path);
        const content = typeof item.content === "string" ? item.content : "";
        if (item.ok === true && itemPath && content) {
          contentByPath.set(itemPath, {
            content,
            truncated: item.truncated === true,
          });
        }
      }
    }
  }

  const lines = [
    "## Groovy Skills Manager Context",
    "Use these explicitly assigned capabilities when relevant. Git is the source of truth; Groovy uses the local connector copy when available and otherwise the bounded server snapshot created by the latest sync.",
  ];

  for (const artifact of artifacts.slice(0, 20)) {
    const repoId = asString(artifact.repository_id);
    const repo = repoById.get(repoId);
    const sync = syncByRepo.get(repoId);
    const relativePath = asString(artifact.relative_path);
    const localPath = pathByRepoAndRel.get(`${repoId}:${relativePath}`);
    const snapshot =
      typeof artifact.content_snapshot === "string"
        ? artifact.content_snapshot
        : "";
    const snapshotTruncated = artifact.content_snapshot_truncated === true;
    const kind = asString(artifact.artifact_type) === "skill" ? "Skill" : "Instruction";
    const label = asString(artifact.name) || asString(artifact.slug) || relativePath;
    const repoLabel = asString(repo?.label) || "skills repo";
    const commit = asString(sync?.commit_sha || artifact.commit_sha || repo?.last_commit_sha);
    if (localPath) {
      const localContent = contentByPath.get(localPath);
      lines.push(
        `\n### ${kind}: ${label}\nSource: ${repoLabel} at ${commit ? commit.slice(0, 8) : "unsynced"} (${localPath})`
      );
      if (localContent) {
        lines.push(
          `<assigned_artifact>\n${localContent.content}\n${localContent.truncated ? "\n[Content truncated by Groovy's context limit.]" : ""}\n</assigned_artifact>`
        );
      } else if (snapshot) {
        lines.push(
          `<assigned_artifact>\n${snapshot}\n${snapshotTruncated ? "\n[Content truncated by Groovy's snapshot limit.]" : ""}\n</assigned_artifact>`,
        );
      } else {
        lines.push("The assigned body could not be read. Do not claim this assignment was applied.");
      }
    } else if (snapshot) {
      lines.push(
        `\n### ${kind}: ${label}\nSource: ${repoLabel} at ${commit ? commit.slice(0, 8) : "unsynced"} (server snapshot)`,
      );
      lines.push(
        `<assigned_artifact>\n${snapshot}\n${snapshotTruncated ? "\n[Content truncated by Groovy's snapshot limit.]" : ""}\n</assigned_artifact>`,
      );
    } else {
      lines.push(
        `- ${kind}: ${label} (${repoLabel}) is assigned but has no readable snapshot yet. Ask a workspace admin to sync the Skills library.`
      );
    }
  }

  return { text: `${lines.join("\n")}\n`, artifactCount: artifacts.length };
}

export async function buildAssignedSkillsPromptContext(input: {
  deviceId: string;
  agentId?: string | null;
  profileId?: string | null;
  target: "flow" | "claude" | "codex";
}): Promise<{ text: string; artifactCount: number }> {
  const ctx = await getContext(false);
  return buildAssignedSkillsPromptContextWithContext(ctx, input);
}

export async function buildAssignedSkillsPromptContextForUser(input: {
  userId: string;
  deviceId: string;
  agentId?: string | null;
  profileId?: string | null;
  target: "flow" | "claude" | "codex";
}): Promise<{ text: string; artifactCount: number }> {
  const ctx = await getContextForUser(input.userId, false);
  return buildAssignedSkillsPromptContextWithContext(ctx, input);
}
