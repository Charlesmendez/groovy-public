import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { callConnectorRpcViaRelay } from "@/lib/relay/connectorRpc";
import { getAuthedUser, getOrCreateWorkspaceForUser, type WorkspaceInfo } from "@/lib/workspaces";

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
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
      "id,workspace_id,repository_id,artifact_type,slug,name,description,relative_path,exact_filename,targets,checksum,commit_sha,lifecycle,metadata,risk_flags,created_at,updated_at"
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
      .select("id,workspace_id,artifact_id,agent_id,target,scope,enabled,metadata,created_at,updated_at")
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
  ]);

  for (const res of [reposRes, artifactsRes, assignmentsRes, syncsRes, auditsRes, agentsRes, codeConfigsRes]) {
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

  return {
    currentUserId: ctx.userId,
    workspace: ctx.workspace,
    repositories: reposRes.data || [],
    artifacts: artifactsRes.data || [],
    assignments: assignmentsRes.data || [],
    syncs: syncsRes.data || [],
    auditEvents: auditsRes.data || [],
    agents,
    privacy: {
      storesContents: false,
      summary:
        "Flow stores repo metadata, checksums, assignments, and sync status. Skill and Markdown bodies stay in the customer's Git repo and local connector checkout.",
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

export async function createSkillsArtifact(input: {
  repositoryId: string;
  deviceId: string;
  artifactType: "skill" | "instruction_doc";
  relativePath: string;
  content: string;
  name?: string;
  description?: string;
  targets?: string[];
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
    timeoutMs: 90_000,
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
  if (result.ok !== true) return result;
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

export async function setSkillAssignment(input: {
  artifactId: string;
  agentId?: string | null;
  target?: "all" | "flow" | "claude" | "codex";
  enabled?: boolean;
}) {
  const ctx = await getContext(true);
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
      .eq("target", target);
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
    .eq("target", target);
  existingQuery = agentId ? existingQuery.eq("agent_id", agentId) : existingQuery.is("agent_id", null);
  const { data: existing, error: existingErr } = await existingQuery.maybeSingle();
  if (existingErr) throw new Error(existingErr.message);

  const payload = {
    workspace_id: ctx.workspace.id,
    artifact_id: artifactId,
    agent_id: agentId,
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
    .select("id,workspace_id,artifact_id,agent_id,target,scope,enabled,metadata,created_at,updated_at")
    .single();
  if (error || !data?.id) throw new Error(error?.message || "Failed to assign artifact");
  await audit(ctx, "skills_assignment_set", {
    artifactId,
    assignmentId: String(data.id),
    metadata: { agentId, target },
  });
  return { ok: true, assignment: data };
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
    .select("id,workspace_id,artifact_id,agent_id,target,scope,enabled")
    .eq("id", assignmentId)
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (assignmentErr) throw new Error(assignmentErr.message);
  if (!assignment?.id) throw new Error("Assignment not found");
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
    target: "flow" | "claude" | "codex";
  }
) {
  const target = input.target === "codex" || input.target === "claude" ? input.target : "flow";
  const agentId = asString(input.agentId || "") || null;
  const { data: assignments, error: assignmentErr } = await ctx.admin
    .from("workspace_skill_assignments")
    .select("id,artifact_id,agent_id,target,scope,workspace_skill_artifacts!inner(id,repository_id,artifact_type,slug,name,description,relative_path,exact_filename,targets,checksum,commit_sha,metadata,risk_flags)")
    .eq("workspace_id", ctx.workspace.id)
    .eq("enabled", true)
    .in("target", ["all", target]);
  if (assignmentErr) throw new Error(assignmentErr.message);

  const selected = ((assignments || []) as Array<Record<string, unknown>>).filter((row) => {
    const rowAgentId = asString(row.agent_id);
    return !rowAgentId || (agentId && rowAgentId === agentId);
  });
  const artifacts = selected
    .map((row) => row.workspace_skill_artifacts)
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row));
  return { target, agentId, artifacts };
}

async function preflightAgentSkillsWithContext(
  ctx: AuthedContext,
  input: {
    deviceId: string;
    agentId?: string | null;
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
  target: "flow" | "claude" | "codex";
}) {
  const ctx = await getContext(false);
  return preflightAgentSkillsWithContext(ctx, input);
}

export async function preflightAgentSkillsForUser(input: {
  userId: string;
  deviceId: string;
  agentId?: string | null;
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
    target: "flow" | "claude" | "codex";
  }
): Promise<{ text: string; artifactCount: number }> {
  const deviceId = asString(input.deviceId);
  if (!deviceId) return { text: "", artifactCount: 0 };
  const { artifacts } = await loadAssignedArtifactsForTarget(ctx, input);
  if (artifacts.length === 0) return { text: "", artifactCount: 0 };

  const repoIds = Array.from(new Set(artifacts.map((artifact) => asString(artifact.repository_id)).filter(Boolean)));
  const [reposRes, syncsRes] = await Promise.all([
    repoIds.length
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

  const lines = [
    "## Groovy Skills Manager Context",
    "Use these assigned local capabilities when relevant. Flow stores only metadata and assignments; the skill and instruction bodies stay in the user's Git repo/local connector checkout.",
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
      lines.push(
        `- ${kind}: ${label} (${repoLabel}, ${commit ? commit.slice(0, 8) : "unsynced"}) -> read/follow local path: ${localPath}`
      );
    } else {
      lines.push(
        `- ${kind}: ${label} (${repoLabel}) is assigned but is not materialized on this connector yet. Ask the user to run Skills preflight if you need it.`
      );
    }
  }

  return { text: `${lines.join("\n")}\n`, artifactCount: artifacts.length };
}

export async function buildAssignedSkillsPromptContext(input: {
  deviceId: string;
  agentId?: string | null;
  target: "flow" | "claude" | "codex";
}): Promise<{ text: string; artifactCount: number }> {
  const ctx = await getContext(false);
  return buildAssignedSkillsPromptContextWithContext(ctx, input);
}

export async function buildAssignedSkillsPromptContextForUser(input: {
  userId: string;
  deviceId: string;
  agentId?: string | null;
  target: "flow" | "claude" | "codex";
}): Promise<{ text: string; artifactCount: number }> {
  const ctx = await getContextForUser(input.userId, false);
  return buildAssignedSkillsPromptContextWithContext(ctx, input);
}
