/**
 * Executor for the worker-agent delegation tools:
 * list_agents, assign_task, check_agent_status, collect_result, transfer_context.
 *
 * These are the orchestrator's core harness tools — they turn the orchestrator
 * from a chat model into a dispatcher over the user's worker agents.
 */

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  createAgentTask,
  getAgentTask,
  kickAgentTask,
  listWorkerAgents,
  resolveWorkerAgentByRef,
  runAgentTask,
  transferContext,
  type AgentTaskNotifyTargets,
  type AgentTaskRow,
} from "@/lib/orchestrator/agentTasks";
import type { ToolExecutionContext, ToolResult } from "@/lib/orchestrator/toolExecutor";
import {
  filterAgentRoster,
  toolPolicyDenialReason,
} from "@/lib/orchestrator/toolPolicy";
import { callConnectorRpcViaRelay } from "@/lib/relay/connectorRpc";
import {
  listSkillsAndDocsForUser,
  setSkillAssignmentForUser,
} from "@/lib/skills-manager/service";
import { loadIntegrationAssignments } from "@/lib/integrations/assignments";

const WAIT_INLINE_TIMEOUT_MS = 2 * 60 * 1000;
const CONSULTATION_TIMEOUT_MS = {
  quick: 2 * 60 * 1000,
  standard: 5 * 60 * 1000,
  thorough: 9 * 60 * 1000,
} as const;
const MAX_CONSULTATIONS_PER_PLAN = 3;

function ok(
  toolName: string,
  startTime: number,
  result: unknown
): ToolResult {
  return {
    success: true,
    result,
    agent: "harness",
    toolName,
    executionTime: Date.now() - startTime,
  };
}

function fail(toolName: string, startTime: number, error: string): ToolResult {
  return {
    success: false,
    error,
    agent: "harness",
    toolName,
    executionTime: Date.now() - startTime,
  };
}

function taskSummary(task: AgentTaskRow) {
  return {
    taskId: task.id,
    status: task.status,
    title: task.title,
    agentId: task.agent_id,
    createdAt: task.created_at,
    finishedAt: task.finished_at,
    error: task.error,
    resultPreview: task.result_text
      ? task.result_text.length > 300
        ? `${task.result_text.slice(0, 300)}…`
        : task.result_text
      : null,
  };
}

type LibraryArtifact = {
  id: string;
  artifact_type: "skill" | "instruction_doc";
  slug: string;
  name: string;
  description?: string | null;
  relative_path: string;
  targets: string[];
};

function resolveLibraryArtifact(
  artifacts: LibraryArtifact[],
  ref: string
): { ok: true; artifact: LibraryArtifact } | { ok: false; error: string } {
  const needle = ref.trim().toLowerCase();
  const exact = artifacts.filter((artifact) =>
    [artifact.id, artifact.name, artifact.slug, artifact.relative_path]
      .filter(Boolean)
      .some((value) => String(value).trim().toLowerCase() === needle)
  );
  if (exact.length === 1) return { ok: true, artifact: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      error: `Multiple library items exactly match "${ref}": ${exact
        .map((artifact) => `${artifact.name} (${artifact.relative_path})`)
        .join(", ")}`,
    };
  }
  const partial = artifacts.filter((artifact) =>
    [artifact.name, artifact.slug, artifact.relative_path]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  );
  if (partial.length === 1) return { ok: true, artifact: partial[0] };
  if (partial.length > 1) {
    return {
      ok: false,
      error: `"${ref}" is ambiguous. Matching items: ${partial
        .slice(0, 10)
        .map((artifact) => `${artifact.name} (${artifact.relative_path})`)
        .join(", ")}`,
    };
  }
  return { ok: false, error: `No skill or instruction doc matches "${ref}".` };
}

async function resolveSkillAssignmentDestination(
  userId: string,
  params: Record<string, unknown>,
  allowedAgentIds?: string[] | null,
): Promise<
  | {
      ok: true;
      agentId: string | null;
      target: "flow" | "claude" | "codex";
      label: string;
    }
  | { ok: false; error: string }
> {
  const destination = typeof params.destination === "string" ? params.destination : "";
  if (destination === "orchestrator") {
    return { ok: true, agentId: null, target: "flow", label: "the orchestrator" };
  }
  if (destination === "all_claude") {
    if (Array.isArray(allowedAgentIds)) {
      return {
        ok: false,
        error:
          "This conversation has a restricted worker roster. Choose one selected worker instead of all Claude agents.",
      };
    }
    return { ok: true, agentId: null, target: "claude", label: "all Claude agents" };
  }
  if (destination === "all_codex") {
    if (Array.isArray(allowedAgentIds)) {
      return {
        ok: false,
        error:
          "This conversation has a restricted worker roster. Choose one selected worker instead of all Codex agents.",
      };
    }
    return { ok: true, agentId: null, target: "codex", label: "all Codex agents" };
  }
  if (destination !== "worker") {
    return { ok: false, error: "Choose orchestrator, all_claude, all_codex, or worker." };
  }
  const agentRef = typeof params.agent === "string" ? params.agent.trim() : "";
  if (!agentRef) return { ok: false, error: "A worker name or id is required." };
  const roster = filterAgentRoster(await listWorkerAgents(userId), allowedAgentIds);
  const resolved = await resolveWorkerAgentByRef(userId, agentRef, { roster });
  if (!resolved.ok) {
    return {
      ok: false,
      error:
        resolved.error === "ambiguous"
          ? `Multiple workers match "${agentRef}": ${(resolved.candidates || []).join(", ")}`
          : `No worker agent named "${agentRef}".`,
    };
  }
  return {
    ok: true,
    agentId: resolved.agent.id,
    target: resolved.agent.harness,
    label: resolved.agent.name,
  };
}

export async function executeAgentDelegationTool(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  const userId = context.userId;
  const integrationOwnerUserId = context.integrationOwnerUserId || userId;
  const allowedAgentIds = context.toolPolicy?.agentRoster;
  const teamChatTaskScope = context.taskRequestedChannel?.startsWith(
    "team_chat:",
  )
    ? context.taskRequestedChannel
    : null;
  const taskIsVisible = (task: AgentTaskRow): boolean =>
    (!Array.isArray(allowedAgentIds) ||
      allowedAgentIds.includes(task.agent_id)) &&
    (!teamChatTaskScope || task.requested_channel === teamChatTaskScope);
  if (!userId) return fail(toolName, startTime, "Missing user context");
  const policyDenial = toolPolicyDenialReason(toolName, context.toolPolicy);
  if (policyDenial) return fail(toolName, startTime, policyDenial);

  try {
    if (toolName === "list_agents") {
      const roster = filterAgentRoster(
        await listWorkerAgents(userId),
        context.toolPolicy?.agentRoster,
      );
      if (roster.length === 0) {
        return ok(toolName, startTime, {
          agents: [],
          message:
            "No worker agents yet. The user can create one from the dashboard grid (name + harness + workspace folder).",
        });
      }
      const admin = createSupabaseAdminClient();
      const { data: integrationRows } = await admin
        .from("datagran_agent_configs")
        .select("agent_id,provider,agents!datagran_agent_configs_agent_id_fkey(name)")
        .eq("user_id", integrationOwnerUserId);
      const integrationCatalog = (integrationRows || []).map((row) => {
        const relation = Array.isArray(row.agents) ? row.agents[0] : row.agents;
        return {
          id: String(row.agent_id || ""),
          name:
            relation && typeof relation === "object" && "name" in relation
              ? String((relation as { name?: unknown }).name || row.provider || "Data source")
              : String(row.provider || "Data source"),
          provider: String(row.provider || ""),
        };
      });
      const integrationAssignments = await loadIntegrationAssignments({
        supabase: admin,
        userId: integrationOwnerUserId,
        availableIntegrationIds: integrationCatalog.map((integration) => integration.id),
        profileId: context.harnessProfile?.id || null,
      });
      const integrationById = new Map(
        integrationCatalog.map((integration) => [integration.id, integration])
      );
      const { data: openTasks } = await admin
        .from("agent_tasks")
        .select("agent_id, status")
        .eq("user_id", userId)
        .in("status", ["queued", "running", "awaiting_approval"]);
      const openByAgent = new Map<string, number>();
      for (const row of openTasks || []) {
        const r = row as { agent_id?: string };
        if (r.agent_id) openByAgent.set(r.agent_id, (openByAgent.get(r.agent_id) || 0) + 1);
      }
      return ok(toolName, startTime, {
        agents: roster.map((agent) => ({
          id: agent.id,
          name: agent.name,
          harness: agent.harness,
          model: agent.model,
          workspace: agent.workspaceRootPath,
          deviceOnline: agent.deviceOnline === true,
          openTasks: openByAgent.get(agent.id) || 0,
          dataIntegrations: (integrationAssignments.assignments.workers[agent.id] || [])
            .map((integrationId) => integrationById.get(integrationId))
            .filter(Boolean),
        })),
      });
    }

    if (toolName === "list_skills_and_docs") {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      const [library, roster] = await Promise.all([
        listSkillsAndDocsForUser({ userId, query }),
        listWorkerAgents(userId).then((agents) =>
          filterAgentRoster(agents, context.toolPolicy?.agentRoster)
        ),
      ]);
      const nameByAgentId = new Map(roster.map((agent) => [agent.id, agent.name]));
      const assignmentsByArtifact = new Map<string, string[]>();
      for (const row of library.assignments as Array<Record<string, unknown>>) {
        const artifactId = typeof row.artifact_id === "string" ? row.artifact_id : "";
        if (!artifactId) continue;
        const agentId = typeof row.agent_id === "string" ? row.agent_id : null;
        if (
          agentId &&
          Array.isArray(allowedAgentIds) &&
          !allowedAgentIds.includes(agentId)
        ) {
          continue;
        }
        const target = typeof row.target === "string" ? row.target : "";
        if (
          !agentId &&
          Array.isArray(allowedAgentIds) &&
          (target === "claude" || target === "codex")
        ) {
          continue;
        }
        const label = agentId
          ? nameByAgentId.get(agentId) || `worker ${agentId.slice(0, 8)}`
          : target === "flow"
            ? "orchestrator"
            : target === "claude"
              ? "all Claude agents"
              : target === "codex"
                ? "all Codex agents"
                : target;
        assignmentsByArtifact.set(artifactId, [
          ...(assignmentsByArtifact.get(artifactId) || []),
          label,
        ]);
      }
      return ok(toolName, startTime, {
        role: library.role,
        canManageAssignments: library.role === "admin",
        items: (library.artifacts as LibraryArtifact[]).map((artifact) => ({
          id: artifact.id,
          type: artifact.artifact_type === "instruction_doc" ? "instruction_doc" : "skill",
          name: artifact.name,
          description: artifact.description || null,
          path: artifact.relative_path,
          compatibleWith: artifact.targets,
          assignedTo: assignmentsByArtifact.get(artifact.id) || [],
        })),
        message:
          library.artifacts.length === 0
            ? "No matching Skills & Docs library items were found."
            : undefined,
      });
    }

    if (
      toolName === "assign_skill_or_doc" ||
      toolName === "remove_skill_or_doc_assignment"
    ) {
      const artifactRef = typeof params.artifact === "string" ? params.artifact.trim() : "";
      if (!artifactRef) return fail(toolName, startTime, "A skill or doc name is required.");
      const library = await listSkillsAndDocsForUser({ userId, query: artifactRef });
      const resolvedArtifact = resolveLibraryArtifact(
        library.artifacts as LibraryArtifact[],
        artifactRef
      );
      if (!resolvedArtifact.ok) return fail(toolName, startTime, resolvedArtifact.error);
      const destination = await resolveSkillAssignmentDestination(
        userId,
        params,
        context.toolPolicy?.agentRoster,
      );
      if (!destination.ok) return fail(toolName, startTime, destination.error);
      const enabled = toolName === "assign_skill_or_doc";
      await setSkillAssignmentForUser({
        userId,
        artifactId: resolvedArtifact.artifact.id,
        agentId: destination.agentId,
        target: destination.target,
        enabled,
      });
      const action = enabled ? "assigned to" : "removed from";
      return ok(toolName, startTime, {
        artifactId: resolvedArtifact.artifact.id,
        artifact: resolvedArtifact.artifact.name,
        artifactType: resolvedArtifact.artifact.artifact_type,
        destination: destination.label,
        target: destination.target,
        enabled,
        applies: enabled ? "next run" : "next run",
        message: `${resolvedArtifact.artifact.name} ${action} ${destination.label}. This change applies on the next run.`,
        manageUrl: "/dashboard/skills",
      });
    }

    if (toolName === "assign_task") {
      const agentRef = typeof params.agent === "string" ? params.agent.trim() : "";
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!agentRef || !task) {
        return fail(toolName, startTime, "assign_task requires agent and task");
      }

      const roster = filterAgentRoster(
        await listWorkerAgents(userId),
        context.toolPolicy?.agentRoster,
      );
      const resolved = await resolveWorkerAgentByRef(userId, agentRef, { roster });
      if (!resolved.ok) {
        const names = roster.map((a) => a.name).join(", ") || "(none)";
        return fail(
          toolName,
          startTime,
          resolved.error === "ambiguous"
            ? `Multiple agents match "${agentRef}": ${(resolved.candidates || []).join(", ")}. Use the exact name.`
            : `No worker agent named "${agentRef}". Available agents: ${names}.`
        );
      }

      const requireApproval = params.require_approval === true;
      const planMode = params.plan_mode === true;
      const wait = params.wait === true;

      const notify: AgentTaskNotifyTargets = {
        dashboard: true,
        ...(context.taskNotifyTargets || {}),
      };

      const created = await createAgentTask({
        userId,
        agentId: resolved.agent.id,
        prompt: task,
        title: typeof params.title === "string" ? params.title : null,
        context: typeof params.context === "string" ? params.context : null,
        orchestratorSessionId: context.orchestratorSessionId || null,
        requestedChannel: context.taskRequestedChannel || "dashboard",
        notify,
        requireApproval,
        planMode,
        source: "orchestrator",
        traceId: context.traceId || null,
        turnId: context.turnId || null,
      });

      if (requireApproval) {
        const { notifyTaskAwaitingApproval } = await import("@/lib/orchestrator/agentTasks");
        await notifyTaskAwaitingApproval(created).catch(() => {});
        return ok(toolName, startTime, {
          taskId: created.id,
          agent: resolved.agent.name,
          status: "awaiting_approval",
          message: `Task ${created.id.slice(0, 8)} is awaiting the user's approval (they can approve from the dashboard or by replying "approve ${created.id.slice(0, 8)}").`,
        });
      }

      const offlineWarning =
        resolved.agent.deviceOnline === false
          ? ` Warning: ${resolved.agent.name}'s device appears offline — the task will fail if the connector does not come online.`
          : "";

      if (wait) {
        const outcome = await runAgentTask({
          taskId: created.id,
          userId,
          timeoutMs: WAIT_INLINE_TIMEOUT_MS,
        });
        return ok(toolName, startTime, {
          taskId: created.id,
          agent: resolved.agent.name,
          status: outcome.task.status,
          result: outcome.resultText || null,
          error: outcome.error,
        });
      }

      kickAgentTask({ taskId: created.id, userId });
      return ok(toolName, startTime, {
        taskId: created.id,
        agent: resolved.agent.name,
        harness: resolved.agent.harness,
        status: "queued",
        planMode: planMode || undefined,
        message: planMode
          ? `Plan task ${created.id} queued on ${resolved.agent.name}. It will draft a plan (no changes). When it finishes, tell the user to review it in the Tasks rail — approving saves it to the workspace's .claude/plans/ and lets them pick which agent executes it.${offlineWarning}`
          : `Task ${created.id} queued on ${resolved.agent.name} (${resolved.agent.harness}${resolved.agent.model ? `/${resolved.agent.model}` : ""}). It runs in the background; the completion result will arrive as a follow-up event.${offlineWarning}`,
      });
    }

    if (toolName === "consult_agent") {
      const agentRef = typeof params.agent === "string" ? params.agent.trim() : "";
      const objective = typeof params.objective === "string" ? params.objective.trim() : "";
      if (!agentRef || !objective) {
        return fail(toolName, startTime, "consult_agent requires agent and objective");
      }

      const roster = filterAgentRoster(
        await listWorkerAgents(userId),
        context.toolPolicy?.agentRoster,
      );
      const resolved = await resolveWorkerAgentByRef(userId, agentRef, { roster });
      if (!resolved.ok) {
        return fail(toolName, startTime, `No unambiguous worker agent named "${agentRef}"`);
      }
      if (resolved.agent.deviceOnline === false) {
        return fail(
          toolName,
          startTime,
          `${resolved.agent.name}'s connector is offline; repository consultation requires that machine online.`
        );
      }

      const requestedPlanningSessionId =
        typeof params.planning_session_id === "string" && params.planning_session_id.trim()
          ? params.planning_session_id.trim()
          : null;
      const planningSessionId = requestedPlanningSessionId || crypto.randomUUID();
      const admin = createSupabaseAdminClient();
      let existingConsultationsQuery = admin
        .from("agent_tasks")
        .select("id,agent_id,result_text,result_meta,created_at")
        .eq("user_id", userId)
        .contains("result_meta", { planning_session_id: planningSessionId })
        .order("created_at", { ascending: true });
      if (teamChatTaskScope) {
        existingConsultationsQuery = existingConsultationsQuery.eq(
          "requested_channel",
          teamChatTaskScope,
        );
      }
      const { data: existingConsultations } =
        await existingConsultationsQuery;
      const prior = (existingConsultations || []) as Array<{
        id: string;
        agent_id: string;
        result_text: string | null;
        result_meta: Record<string, unknown> | null;
        created_at: string;
      }>;
      if (requestedPlanningSessionId && prior.length === 0) {
        return fail(toolName, startTime, "Unknown planning_session_id");
      }
      if (prior.length >= MAX_CONSULTATIONS_PER_PLAN) {
        return fail(
          toolName,
          startTime,
          `Planning session already used its ${MAX_CONSULTATIONS_PER_PLAN} consultation rounds; synthesize and finalize the plan now.`
        );
      }
      if (prior.some((entry) => entry.agent_id !== resolved.agent.id)) {
        return fail(
          toolName,
          startTime,
          "A planning session stays bound to its originally selected agent. Start a new session to consult another workspace."
        );
      }

      const questions = Array.isArray(params.questions)
        ? params.questions
            .filter((value): value is string => typeof value === "string" && !!value.trim())
            .map((value) => value.trim())
            .slice(0, 12)
        : [];
      const depth =
        params.depth === "quick" || params.depth === "thorough"
          ? params.depth
          : "standard";
      const round = prior.length + 1;
      const repositorySnapshot =
        resolved.agent.deviceId && resolved.agent.workspaceRootPath
          ? await callConnectorRpcViaRelay({
              userId,
              deviceId: resolved.agent.deviceId,
              rpcType: "workspace_repo_snapshot",
              payload: { workspace_root: resolved.agent.workspaceRootPath },
              timeoutMs: 20_000,
            }).catch(() => null)
          : null;
      if (!repositorySnapshot || repositorySnapshot.ok === false) {
        return fail(
          toolName,
          startTime,
          "Could not capture the selected workspace repository snapshot"
        );
      }
      const originalSnapshot = prior[0]?.result_meta?.repository_snapshot as
        | Record<string, unknown>
        | undefined;
      if (
        originalSnapshot &&
        (originalSnapshot.commit_sha !== repositorySnapshot.commit_sha ||
          originalSnapshot.status_hash !== repositorySnapshot.status_hash)
      ) {
        return fail(
          toolName,
          startTime,
          "The repository changed since the first consultation. Start a fresh planning session so the final plan is based on one consistent snapshot."
        );
      }
      const priorBrief = prior
        .map((entry, index) =>
          entry.result_text?.trim()
            ? `Consultation ${index + 1}:\n${entry.result_text.trim().slice(0, 12_000)}`
            : ""
        )
        .filter(Boolean)
        .join("\n\n");
      const taskPrompt = [
        `Planning objective: ${objective}`,
        questions.length > 0
          ? `Questions from the orchestrator:\n${questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}`
          : "Map the relevant implementation comprehensively and identify the evidence the orchestrator needs to plan it.",
        priorBrief
          ? `This is follow-up consultation ${round}. Do not repeat established findings; resolve gaps or contradictions in this prior evidence:\n\n${priorBrief}`
          : "This is the initial repository consultation.",
      ].join("\n\n");

      const created = await createAgentTask({
        userId,
        agentId: resolved.agent.id,
        prompt: taskPrompt,
        title: `${round === 1 ? "Explore" : "Follow up"}: ${objective.slice(0, 90)}`,
        orchestratorSessionId: context.orchestratorSessionId || null,
        requestedChannel: context.taskRequestedChannel || "dashboard",
        notify: { dashboard: true },
        resultMeta: {
          consultation_mode: true,
          planning_session_id: planningSessionId,
          planning_round: round,
          planning_depth: depth,
          planning_objective: objective,
          planning_status: "exploring",
          repository_snapshot: repositorySnapshot,
        },
        source: "orchestrator",
        traceId: context.traceId || null,
        turnId: context.turnId || null,
      });

      const outcome = await runAgentTask({
        taskId: created.id,
        userId,
        timeoutMs: CONSULTATION_TIMEOUT_MS[depth],
      });
      if (!outcome.ok) {
        return fail(
          toolName,
          startTime,
          outcome.error || `Repository consultation failed on ${resolved.agent.name}`
        );
      }

      await admin
        .from("agent_tasks")
        .update({
          result_meta: {
            ...((outcome.task.result_meta as Record<string, unknown> | null) || {}),
            planning_status: "evidence_ready",
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", created.id)
        .eq("user_id", userId);

      return ok(toolName, startTime, {
        planning_session_id: planningSessionId,
        consultationTaskId: created.id,
        round,
        maxRounds: MAX_CONSULTATIONS_PER_PLAN,
        agent: resolved.agent.name,
        harness: resolved.agent.harness,
        workspace: resolved.agent.workspaceRootPath,
        evidence: outcome.resultText,
        instruction:
          "Use this repository evidence to reason about the plan. Ask a targeted follow-up with the same planning_session_id only if a material gap remains; otherwise synthesize the final plan and call finalize_plan.",
      });
    }

    if (toolName === "finalize_plan") {
      const planningSessionId =
        typeof params.planning_session_id === "string"
          ? params.planning_session_id.trim()
          : "";
      const title = typeof params.title === "string" ? params.title.trim() : "";
      const plan = typeof params.plan === "string" ? params.plan.trim() : "";
      if (!planningSessionId || !title || !plan) {
        return fail(toolName, startTime, "finalize_plan requires planning_session_id, title, and plan");
      }

      const admin = createSupabaseAdminClient();
      let consultationQuery = admin
        .from("agent_tasks")
        .select("*")
        .eq("user_id", userId)
        .contains("result_meta", { planning_session_id: planningSessionId })
        .order("created_at", { ascending: true });
      if (teamChatTaskScope) {
        consultationQuery = consultationQuery.eq(
          "requested_channel",
          teamChatTaskScope,
        );
      }
      const { data: consultationRows, error: consultationError } =
        await consultationQuery;
      if (consultationError || !consultationRows?.length) {
        return fail(toolName, startTime, "Planning session not found");
      }

      const consultations = consultationRows as AgentTaskRow[];
      if (!consultations.every(taskIsVisible)) {
        return fail(
          toolName,
          startTime,
          "Planning session unavailable in this conversation.",
        );
      }
      const unfinished = consultations.find(
        (task) => task.status !== "done" || !task.result_text?.trim()
      );
      if (unfinished) {
        return fail(toolName, startTime, "All repository consultations must finish before finalizing");
      }
      const rootTask = consultations[0];
      const rootMeta = (rootTask.result_meta || {}) as Record<string, unknown>;
      const previousEvidence = Array.isArray(rootMeta.planning_evidence)
        ? (rootMeta.planning_evidence as Array<{
            round?: number;
            taskId?: string;
            text?: string;
          }>)
        : [];
      const previousEvidenceIds = new Set(
        previousEvidence
          .map((entry) => (typeof entry?.taskId === "string" ? entry.taskId : ""))
          .filter(Boolean)
      );
      const newEvidence = consultations
        .filter(
          (task) =>
            (task.result_meta as Record<string, unknown> | null)?.consultation_mode === true &&
            !previousEvidenceIds.has(task.id)
        )
        .map((task, index) => ({
          round: previousEvidence.length + index + 1,
          taskId: task.id,
          text: task.result_text!.slice(0, 30_000),
        }));
      const evidence = [...previousEvidence, ...newEvidence];
      const { data: finalized, error: finalizeError } = await admin
        .from("agent_tasks")
        .update({
          title,
          result_text: plan,
          result_meta: {
            ...rootMeta,
            consultation_mode: false,
            plan_mode: true,
            planning_session_id: planningSessionId,
            planning_consultation_count: evidence.length,
            planning_consultation_task_ids: evidence.map((entry) => entry.taskId),
            planning_evidence: evidence,
            orchestrator_synthesized: true,
            planning_status: "ready_for_review",
            finalized_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", rootTask.id)
        .eq("user_id", userId)
        .select("*")
        .single();
      if (finalizeError || !finalized) {
        return fail(toolName, startTime, "Failed to persist synthesized plan");
      }

      return ok(toolName, startTime, {
        planning_session_id: planningSessionId,
        planTaskId: rootTask.id,
        status: "ready_for_review",
        title,
        consultationCount: evidence.length,
        message:
          "The orchestrator's evidence-backed plan is ready in the Tasks rail. The user can review it, investigate further, or approve and choose an execution agent.",
      });
    }

    if (toolName === "check_agent_status") {
      const admin = createSupabaseAdminClient();
      const taskId = typeof params.task_id === "string" ? params.task_id.trim() : "";
      if (taskId) {
        const task = await getAgentTask(userId, taskId);
        if (!task || !taskIsVisible(task)) {
          return fail(toolName, startTime, "Task unavailable in this conversation.");
        }
        return ok(toolName, startTime, taskSummary(task));
      }

      const agentRef = typeof params.agent === "string" ? params.agent.trim() : "";
      const roster = filterAgentRoster(
        await listWorkerAgents(userId),
        context.toolPolicy?.agentRoster,
      );
      let agentFilter: string | null = null;
      if (agentRef) {
        const resolved = await resolveWorkerAgentByRef(userId, agentRef, { roster });
        if (!resolved.ok) return fail(toolName, startTime, `No worker agent named "${agentRef}"`);
        agentFilter = resolved.agent.id;
      }

      let query = admin
        .from("agent_tasks")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(15);
      if (agentFilter) query = query.eq("agent_id", agentFilter);
      if (Array.isArray(allowedAgentIds)) {
        if (allowedAgentIds.length === 0) {
          return ok(toolName, startTime, { agents: [], recentTasks: [] });
        }
        query = query.in("agent_id", allowedAgentIds);
      }
      if (teamChatTaskScope) {
        query = query.eq("requested_channel", teamChatTaskScope);
      }
      const { data: tasks } = await query;

      const nameById = new Map(roster.map((a) => [a.id, a.name]));
      return ok(toolName, startTime, {
        agents: roster.map((a) => ({
          name: a.name,
          harness: a.harness,
          deviceOnline: a.deviceOnline === true,
        })),
        recentTasks: ((tasks || []) as AgentTaskRow[]).map((t) => ({
          ...taskSummary(t),
          agent: nameById.get(t.agent_id) || t.agent_id,
        })),
      });
    }

    if (toolName === "collect_result") {
      const taskId = typeof params.task_id === "string" ? params.task_id.trim() : "";
      if (!taskId) return fail(toolName, startTime, "collect_result requires task_id");
      const task = await getAgentTask(userId, taskId);
      if (!task || !taskIsVisible(task)) {
        return fail(toolName, startTime, "Task unavailable in this conversation.");
      }
      return ok(toolName, startTime, {
        taskId: task.id,
        status: task.status,
        title: task.title,
        result: task.result_text,
        error: task.error,
        meta: task.result_meta,
      });
    }

    if (toolName === "transfer_context") {
      if (teamChatTaskScope) {
        return fail(
          toolName,
          startTime,
          "Cross-task context transfer is unavailable in Team Chat because it can contain information from another conversation.",
        );
      }
      const fromAgent = typeof params.from_agent === "string" ? params.from_agent.trim() : "";
      const toAgent = typeof params.to_agent === "string" ? params.to_agent.trim() : "";
      if (!fromAgent || !toAgent) {
        return fail(toolName, startTime, "transfer_context requires from_agent and to_agent");
      }
      const roster = filterAgentRoster(
        await listWorkerAgents(userId),
        allowedAgentIds,
      );
      const [resolvedFrom, resolvedTo] = await Promise.all([
        resolveWorkerAgentByRef(userId, fromAgent, { roster }),
        resolveWorkerAgentByRef(userId, toAgent, { roster }),
      ]);
      if (!resolvedFrom.ok || !resolvedTo.ok) {
        return fail(
          toolName,
          startTime,
          "Both workers must be selected for this conversation.",
        );
      }
      const provider = context.apiKeys?.anthropic
        ? ("anthropic" as const)
        : context.apiKeys?.openai
          ? ("openai" as const)
          : ("anthropic" as const);
      const outcome = await transferContext({
        userId,
        fromAgentRef: resolvedFrom.agent.id,
        toAgentRef: resolvedTo.agent.id,
        instructions: typeof params.instructions === "string" ? params.instructions : null,
        provider,
        apiKey: provider === "anthropic" ? context.apiKeys?.anthropic : context.apiKeys?.openai,
      });
      if (!outcome.ok) return fail(toolName, startTime, outcome.error);
      return ok(toolName, startTime, {
        transferId: outcome.transferId,
        from: outcome.fromAgent,
        to: outcome.toAgent,
        message: `Context transferred from ${outcome.fromAgent} to ${outcome.toAgent}. It will be prepended to ${outcome.toAgent}'s next task.`,
        briefingPreview: outcome.summaryPreview,
      });
    }

    if (toolName === "usage_report") {
      if (Array.isArray(allowedAgentIds)) {
        return fail(
          toolName,
          startTime,
          "Workspace-wide agent usage is unavailable from a restricted conversation.",
        );
      }
      const { buildAgentUsageReport } = await import("@/lib/billing/agentUsageReport");
      const days = Number.isFinite(Number(params.days)) ? Number(params.days) : 30;
      const report = await buildAgentUsageReport({ userId, days });
      return ok(toolName, startTime, report);
    }

    return fail(toolName, startTime, `Unknown delegation tool: ${toolName}`);
  } catch (error) {
    return fail(
      toolName,
      startTime,
      error instanceof Error ? error.message : String(error)
    );
  }
}
