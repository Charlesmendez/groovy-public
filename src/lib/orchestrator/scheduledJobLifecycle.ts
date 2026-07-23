import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createHeartbeatSystemAgentId,
  createOrchestratorRuntimeAgentId,
} from "@/lib/orchestrator/runtimeAgents";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function rehomeScheduledJobsForDeletedAgent(args: {
  supabase: SupabaseClient;
  userId: string;
  deletedAgentId: string;
}): Promise<void> {
  const { supabase, userId, deletedAgentId } = args;

  // Worker-targeted jobs: clear the target explicitly (don't rely on FK
  // ordering) and leave an audit note so the UI can explain the retarget.
  // The job then falls back to the orchestrator on its next tick.
  const { data: targetedJobs } = await supabase
    .from("scheduled_jobs")
    .select("id,task")
    .eq("user_id", userId)
    .eq("target_agent_id", deletedAgentId);
  for (const job of targetedJobs || []) {
    const taskObj = { ...(asObject(job.task) || {}) };
    const options = { ...(asObject(taskObj.options) || {}) };
    options.retargeted_from = deletedAgentId;
    taskObj.options = options;
    await supabase
      .from("scheduled_jobs")
      .update({
        target_agent_id: null,
        task: taskObj,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("user_id", userId);
  }

  const { data: jobs, error } = await supabase
    .from("scheduled_jobs")
    .select("id,kind,agent_id,task")
    .eq("user_id", userId)
    .eq("kind", "orchestrator");
  if (error) {
    throw new Error(`Failed to load scheduled jobs for deleted agent: ${error.message}`);
  }

  const affectedJobs = (jobs || []).filter((job) => {
    const taskObj = asObject(job.task);
    const taskAgentId = asString(taskObj?.orchestrator_agent_id);
    return asString(job.agent_id) === deletedAgentId || taskAgentId === deletedAgentId;
  });
  if (affectedJobs.length === 0) return;

  let orchestratorFallbackAgentId: string | null | undefined;
  let heartbeatFallbackAgentId: string | null | undefined;

  for (const job of affectedJobs) {
    const taskObj = { ...(asObject(job.task) || {}) };
    const isHeartbeat = taskObj.type === "heartbeat_v1";
    const fallbackAgentId = isHeartbeat
      ? ((heartbeatFallbackAgentId ??= await createHeartbeatSystemAgentId(supabase, userId)))
      : ((orchestratorFallbackAgentId ??= await createOrchestratorRuntimeAgentId(supabase, userId)));

    if (!fallbackAgentId) {
      throw new Error(`Failed to create a fallback agent for scheduled job ${job.id}`);
    }

    taskObj.orchestrator_agent_id = fallbackAgentId;
    delete taskObj.orchestrator_session_id;

    const { error: updateErr } = await supabase
      .from("scheduled_jobs")
      .update({
        agent_id: fallbackAgentId,
        task: taskObj,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("user_id", userId);
    if (updateErr) {
      throw new Error(`Failed to rehome scheduled job ${job.id}: ${updateErr.message}`);
    }
  }
}
