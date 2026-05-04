import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureOrchestratorRuntimeAgentId } from "./runtimeAgents";

export type RuntimeScope = {
  agentId: string;
  epochId: string;
  branchId: string;
  branchTurnCount: number;
  activeBranchCount: number;
};

export type WorkerBranchTaskInput = {
  title?: string | null;
  goal: string;
};

export type SpawnedWorkerBranch = {
  branchId: string;
  title: string;
  goal: string;
};

function normalizeBranchTitle(input: string | null | undefined, fallback: string): string {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) return fallback;
  return trimmed.slice(0, 80);
}

export async function getOrCreateRuntimeSessionForAgent(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  title?: string | null;
}): Promise<string | null> {
  const { supabase, userId, agentId } = args;
  const title =
    typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Groovy Agent";

  const { data: mappedRows } = await supabase
    .from("orchestrator_session_runtime")
    .select("session_id,updated_at")
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .order("updated_at", { ascending: false })
    .limit(5);

  const mappedIds = (mappedRows || [])
    .map((row) => (row as { session_id?: unknown }).session_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (mappedIds.length > 0) {
    const { data: existingSession } = await supabase
      .from("orchestrator_sessions")
      .select("id")
      .eq("user_id", userId)
      .in("id", mappedIds)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (typeof existingSession?.id === "string" && existingSession.id) {
      return existingSession.id;
    }
  }

  const { data: createdSession, error: createErr } = await supabase
    .from("orchestrator_sessions")
    .insert({
      user_id: userId,
      title,
    })
    .select("id")
    .single();
  if (createErr || !createdSession?.id) {
    console.warn("[runtime-graph] getOrCreateRuntimeSessionForAgent create_session_failed", {
      userId,
      agentId,
      error: createErr?.message,
    });
    return null;
  }

  const sessionId = String(createdSession.id);
  await resolveRuntimeScope({
    supabase,
    userId,
    sessionId,
    agentId,
  });
  return sessionId;
}

async function ensureActiveEpoch(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
}): Promise<string | null> {
  const { supabase, userId, agentId } = args;
  const { data: active } = await supabase
    .from("orchestrator_agent_epochs")
    .select("id")
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .eq("status", "active")
    .order("sequence", { ascending: false })
    .limit(1)
    .maybeSingle();
  const activeId = (active as { id?: unknown } | null)?.id;
  if (typeof activeId === "string" && activeId) return activeId;

  const { data: latest } = await supabase
    .from("orchestrator_agent_epochs")
    .select("sequence")
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .order("sequence", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSequence =
    Number.isFinite(Number((latest as { sequence?: unknown } | null)?.sequence))
      ? Math.floor(Number((latest as { sequence?: unknown } | null)?.sequence)) + 1
      : 1;

  const { data: created, error } = await supabase
    .from("orchestrator_agent_epochs")
    .insert({
      user_id: userId,
      agent_id: agentId,
      sequence: nextSequence,
      status: "active",
      reason: "auto_created",
    })
    .select("id")
    .single();
  if (error) {
    console.warn("[runtime-graph] ensureActiveEpoch create_failed", { userId, agentId, error: error.message });
    return null;
  }
  return typeof created?.id === "string" ? created.id : null;
}

async function ensureMainBranch(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  epochId: string;
}): Promise<{ id: string; turnCount: number } | null> {
  const { supabase, userId, agentId, epochId } = args;
  const { data: existing } = await supabase
    .from("orchestrator_branches")
    .select("id,turn_count")
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .eq("epoch_id", epochId)
    .is("parent_branch_id", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const existingId = (existing as { id?: unknown } | null)?.id;
  if (typeof existingId === "string" && existingId) {
    const turnCount = Number((existing as { turn_count?: unknown } | null)?.turn_count);
    return {
      id: existingId,
      turnCount: Number.isFinite(turnCount) ? Math.max(0, Math.floor(turnCount)) : 0,
    };
  }

  const { data: created, error } = await supabase
    .from("orchestrator_branches")
    .insert({
      user_id: userId,
      agent_id: agentId,
      epoch_id: epochId,
      parent_branch_id: null,
      name: "main",
      status: "active",
      turn_count: 0,
      fork_reason: "main_auto_created",
    })
    .select("id,turn_count")
    .single();
  if (error) {
    console.warn("[runtime-graph] ensureMainBranch create_failed", {
      userId,
      agentId,
      epochId,
      error: error.message,
    });
    return null;
  }
  return {
    id: String(created.id),
    turnCount: Number.isFinite(Number(created.turn_count)) ? Math.max(0, Math.floor(Number(created.turn_count))) : 0,
  };
}

async function countActiveBranches(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  epochId: string;
}): Promise<number> {
  const { count } = await args.supabase
    .from("orchestrator_branches")
    .select("id", { count: "exact", head: true })
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .eq("epoch_id", args.epochId)
    .eq("status", "active");
  return Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0;
}

export async function getActiveBranchCount(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  epochId: string;
}): Promise<number> {
  return countActiveBranches(args);
}

const STALE_WORKER_BRANCH_MINUTES = 15;

export async function abortStaleWorkerBranches(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  epochId: string;
}): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_WORKER_BRANCH_MINUTES * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  const { data, error } = await args.supabase
    .from("orchestrator_branches")
    .update({
      status: "aborted",
      closed_at: nowIso,
      updated_at: nowIso,
    })
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .eq("epoch_id", args.epochId)
    .eq("status", "active")
    .not("parent_branch_id", "is", null)
    .lt("updated_at", cutoff)
    .select("id");
  if (error) {
    console.warn("[runtime-graph] abortStaleWorkerBranches failed", {
      userId: args.userId,
      epochId: args.epochId,
      error: error.message,
    });
    return 0;
  }
  const aborted = data?.length || 0;
  if (aborted > 0) {
    console.log("[runtime-graph] aborted stale worker branches", {
      userId: args.userId,
      epochId: args.epochId,
      count: aborted,
      cutoffMinutes: STALE_WORKER_BRANCH_MINUTES,
    });
  }
  return aborted;
}

export async function resolveRuntimeScope(args: {
  supabase: SupabaseClient;
  userId: string;
  sessionId?: string | null;
  agentId?: string | null;
}): Promise<RuntimeScope | null> {
  const { supabase, userId } = args;
  const sessionId =
    typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : null;
  const explicitAgentId =
    typeof args.agentId === "string" && args.agentId.trim() ? args.agentId.trim() : null;

  let mapped: {
    agentId: string;
    epochId: string;
    branchId: string;
  } | null = null;

  if (sessionId) {
    const { data: sessionRuntime } = await supabase
      .from("orchestrator_session_runtime")
      .select("agent_id,active_epoch_id,active_branch_id")
      .eq("session_id", sessionId)
      .eq("user_id", userId)
      .maybeSingle();
    const sr = (sessionRuntime || null) as
      | {
          agent_id?: unknown;
          active_epoch_id?: unknown;
          active_branch_id?: unknown;
        }
      | null;
    if (
      typeof sr?.agent_id === "string" &&
      typeof sr?.active_epoch_id === "string" &&
      typeof sr?.active_branch_id === "string"
    ) {
      mapped = {
        agentId: sr.agent_id,
        epochId: sr.active_epoch_id,
        branchId: sr.active_branch_id,
      };
    }
  }

  const agentId = mapped?.agentId || explicitAgentId || (await ensureOrchestratorRuntimeAgentId(supabase, userId));
  if (!agentId) return null;

  const epochId = mapped?.epochId || (await ensureActiveEpoch({ supabase, userId, agentId }));
  if (!epochId) return null;
  const mainBranch = await ensureMainBranch({ supabase, userId, agentId, epochId });
  if (!mainBranch) return null;
  const branchId = mapped?.branchId || mainBranch.id;

  if (sessionId) {
    await supabase.from("orchestrator_session_runtime").upsert(
      {
        session_id: sessionId,
        user_id: userId,
        agent_id: agentId,
        active_epoch_id: epochId,
        active_branch_id: branchId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_id,user_id" }
    );
  }

  const activeBranchCount = await countActiveBranches({ supabase, userId, agentId, epochId });
  let branchTurnCount = mainBranch.turnCount;
  if (branchId !== mainBranch.id) {
    const { data: branchRow } = await supabase
      .from("orchestrator_branches")
      .select("turn_count")
      .eq("id", branchId)
      .eq("user_id", userId)
      .maybeSingle();
    const t = Number((branchRow as { turn_count?: unknown } | null)?.turn_count);
    branchTurnCount = Number.isFinite(t) ? Math.max(0, Math.floor(t)) : 0;
  }

  return {
    agentId,
    epochId,
    branchId,
    branchTurnCount,
    activeBranchCount,
  };
}

export async function rotateAgentEpoch(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  sessionId?: string | null;
  reason?: string | null;
}): Promise<RuntimeScope | null> {
  const { supabase, userId, agentId } = args;
  const nowIso = new Date().toISOString();
  const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : "clear_conversation";

  const { data: activeEpochs } = await supabase
    .from("orchestrator_agent_epochs")
    .select("id")
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .eq("status", "active");

  const activeIds = (activeEpochs || [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (activeIds.length > 0) {
    await supabase
      .from("orchestrator_branches")
      .update({
        status: "aborted",
        abort_reason: reason,
        closed_at: nowIso,
        updated_at: nowIso,
      })
      .eq("user_id", userId)
      .eq("agent_id", agentId)
      .in("epoch_id", activeIds)
      .eq("status", "active");

    await supabase
      .from("orchestrator_agent_epochs")
      .update({ status: "closed", closed_at: nowIso, updated_at: nowIso, reason })
      .eq("user_id", userId)
      .eq("agent_id", agentId)
      .in("id", activeIds)
      .eq("status", "active");
  }

  const { data: latest } = await supabase
    .from("orchestrator_agent_epochs")
    .select("sequence")
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .order("sequence", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSequence =
    Number.isFinite(Number((latest as { sequence?: unknown } | null)?.sequence))
      ? Math.floor(Number((latest as { sequence?: unknown } | null)?.sequence)) + 1
      : 1;

  const { data: epoch, error: epochErr } = await supabase
    .from("orchestrator_agent_epochs")
    .insert({
      user_id: userId,
      agent_id: agentId,
      sequence: nextSequence,
      status: "active",
      reason,
    })
    .select("id")
    .single();
  if (epochErr || !epoch?.id) {
    console.warn("[runtime-graph] rotateAgentEpoch epoch_create_failed", { userId, agentId, error: epochErr?.message });
    return null;
  }
  const epochId = String(epoch.id);

  const { data: branch, error: branchErr } = await supabase
    .from("orchestrator_branches")
    .insert({
      user_id: userId,
      agent_id: agentId,
      epoch_id: epochId,
      parent_branch_id: null,
      name: "main",
      status: "active",
      turn_count: 0,
      fork_reason: reason,
    })
    .select("id")
    .single();
  if (branchErr || !branch?.id) {
    console.warn("[runtime-graph] rotateAgentEpoch branch_create_failed", { userId, agentId, error: branchErr?.message });
    return null;
  }
  const branchId = String(branch.id);

  const sessionId =
    typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : null;
  if (sessionId) {
    await supabase.from("orchestrator_session_runtime").upsert(
      {
        session_id: sessionId,
        user_id: userId,
        agent_id: agentId,
        active_epoch_id: epochId,
        active_branch_id: branchId,
        updated_at: nowIso,
      },
      { onConflict: "session_id,user_id" }
    );
  }

  return {
    agentId,
    epochId,
    branchId,
    branchTurnCount: 0,
    activeBranchCount: 1,
  };
}

export async function incrementBranchTurnCount(args: {
  supabase: SupabaseClient;
  userId: string;
  branchId: string;
}) {
  const { data: row } = await args.supabase
    .from("orchestrator_branches")
    .select("turn_count")
    .eq("id", args.branchId)
    .eq("user_id", args.userId)
    .maybeSingle();
  const current = Number((row as { turn_count?: unknown } | null)?.turn_count);
  const next = (Number.isFinite(current) ? Math.max(0, Math.floor(current)) : 0) + 1;
  await args.supabase
    .from("orchestrator_branches")
    .update({ turn_count: next, updated_at: new Date().toISOString() })
    .eq("id", args.branchId)
    .eq("user_id", args.userId);
  return next;
}

export async function spawnWorkerBranches(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  epochId: string;
  parentBranchId: string;
  maxBranches?: number | null;
  tasks: WorkerBranchTaskInput[];
}): Promise<SpawnedWorkerBranch[]> {
  const requestedTasks = Array.isArray(args.tasks)
    ? args.tasks.filter(
        (task): task is WorkerBranchTaskInput =>
          !!task && typeof task.goal === "string" && task.goal.trim().length > 0
      )
    : [];
  if (requestedTasks.length === 0) return [];

  const activeCount = await countActiveBranches({
    supabase: args.supabase,
    userId: args.userId,
    agentId: args.agentId,
    epochId: args.epochId,
  });
  const maxBranches = Number(args.maxBranches);
  const availableSlots =
    Number.isFinite(maxBranches) && maxBranches > 0
      ? Math.max(0, Math.floor(maxBranches) - activeCount)
      : requestedTasks.length;
  if (availableSlots <= 0) return [];

  const limitedTasks = requestedTasks.slice(0, availableSlots);
  const { count: totalBranchCount } = await args.supabase
    .from("orchestrator_branches")
    .select("id", { count: "exact", head: true })
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .eq("epoch_id", args.epochId);
  let nextOrdinal = Number.isFinite(Number(totalBranchCount))
    ? Math.max(1, Number(totalBranchCount) + 1)
    : 1;

  const rows = limitedTasks.map((task) => {
    const title = normalizeBranchTitle(task.title || null, `worker-${nextOrdinal}`);
    nextOrdinal += 1;
    return {
      user_id: args.userId,
      agent_id: args.agentId,
      epoch_id: args.epochId,
      parent_branch_id: args.parentBranchId,
      name: title,
      status: "active",
      branch_kind: "worker",
      turn_count: 0,
      goal: task.goal.trim(),
      fork_reason: "runtime_branch_parallel",
    };
  });

  const { data, error } = await args.supabase
    .from("orchestrator_branches")
    .insert(rows)
    .select("id,name,goal");
  if (error) {
    console.warn("[runtime-graph] spawnWorkerBranches create_failed", {
      userId: args.userId,
      agentId: args.agentId,
      epochId: args.epochId,
      parentBranchId: args.parentBranchId,
      error: error.message,
    });
    return [];
  }

  return (data || [])
    .map((row) => {
      const branchId = typeof row.id === "string" ? row.id : "";
      const title = normalizeBranchTitle(
        typeof row.name === "string" ? row.name : null,
        "worker"
      );
      const goal = typeof row.goal === "string" ? row.goal.trim() : "";
      if (!branchId || !goal) return null;
      return { branchId, title, goal };
    })
    .filter((row): row is SpawnedWorkerBranch => !!row);
}

export async function finalizeWorkerBranch(args: {
  supabase: SupabaseClient;
  userId: string;
  branchId: string;
  status: "merged" | "aborted";
  summary: string;
  payload?: Record<string, unknown> | null;
  reason?: string | null;
}) {
  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: args.status,
    result_summary: args.summary.trim(),
    result_payload: args.payload || {},
    completed_at: nowIso,
    closed_at: nowIso,
    updated_at: nowIso,
  };
  if (args.status === "merged") {
    update.merge_reason =
      typeof args.reason === "string" && args.reason.trim()
        ? args.reason.trim()
        : "runtime_branch_parallel_completed";
  } else {
    update.abort_reason =
      typeof args.reason === "string" && args.reason.trim()
        ? args.reason.trim()
        : "runtime_branch_parallel_failed";
  }

  await args.supabase
    .from("orchestrator_branches")
    .update(update)
    .eq("id", args.branchId)
    .eq("user_id", args.userId);
}

export async function maybeAutoForkBranchByTurnBudget(args: {
  supabase: SupabaseClient;
  userId: string;
  scope: RuntimeScope;
  mode: "read_only" | "read_write";
  maxTurnsPerBranch: number;
  maxBranches?: number | null;
  sessionId?: string | null;
}): Promise<RuntimeScope> {
  const { supabase, userId, scope } = args;
  const maxTurns = Number(args.maxTurnsPerBranch);
  const maxBranches = Number(args.maxBranches);
  if (args.mode !== "read_write") return scope;
  if (!Number.isFinite(maxTurns) || maxTurns < 1) return scope;
  if (scope.branchTurnCount < Math.floor(maxTurns)) return scope;
  if (Number.isFinite(maxBranches) && maxBranches > 0 && scope.activeBranchCount >= Math.floor(maxBranches)) {
    return scope;
  }

  const nowIso = new Date().toISOString();
  await supabase
    .from("orchestrator_branches")
    .update({
      status: "merged",
      merge_reason: "auto_fork_turn_budget",
      closed_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", scope.branchId)
    .eq("user_id", userId)
    .eq("status", "active");

  const { count } = await supabase
    .from("orchestrator_branches")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("agent_id", scope.agentId)
    .eq("epoch_id", scope.epochId);
  const forkOrdinal = Number.isFinite(Number(count)) ? Number(count) + 1 : 1;

  const { data: fork, error: forkErr } = await supabase
    .from("orchestrator_branches")
    .insert({
      user_id: userId,
      agent_id: scope.agentId,
      epoch_id: scope.epochId,
      parent_branch_id: scope.branchId,
      name: `fork-${forkOrdinal}`,
      status: "active",
      turn_count: 0,
      fork_reason: "auto_fork_turn_budget",
    })
    .select("id")
    .single();
  if (forkErr || !fork?.id) {
    console.warn("[runtime-graph] maybeAutoForkBranchByTurnBudget create_failed", {
      userId,
      agentId: scope.agentId,
      epochId: scope.epochId,
      branchId: scope.branchId,
      error: forkErr?.message,
    });
    return scope;
  }

  const nextBranchId = String(fork.id);
  const sessionId =
    typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : null;
  if (sessionId) {
    await supabase.from("orchestrator_session_runtime").upsert(
      {
        session_id: sessionId,
        user_id: userId,
        agent_id: scope.agentId,
        active_epoch_id: scope.epochId,
        active_branch_id: nextBranchId,
        updated_at: nowIso,
      },
      { onConflict: "session_id,user_id" }
    );
  }

  const activeBranchCount = await countActiveBranches({
    supabase,
    userId,
    agentId: scope.agentId,
    epochId: scope.epochId,
  });

  return {
    agentId: scope.agentId,
    epochId: scope.epochId,
    branchId: nextBranchId,
    branchTurnCount: 0,
    activeBranchCount,
  };
}
