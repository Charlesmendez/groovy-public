import type { SupabaseClient } from "@supabase/supabase-js";
import { datagranCompileRawText, formatTraceAsRawText } from "@/lib/datagran/memory";
import { loadDatagranMemoryConfig } from "@/lib/datagran/memoryServer";
import { getGroovyMemoryConnection } from "@/lib/memory/groovyMemory";

export async function createAgentTrace(
  supabase: SupabaseClient,
  input: {
    userId: string;
    agentId?: string | null;
    sessionId?: string | null;
    agentName: string;
    agentType: string;
    flagKey?: string | null;
    provider?: string | null;
    model?: string | null;
    prompt: string;
    metadata?: Record<string, unknown>;
  }
): Promise<{ traceId: string | null; createdAtIso: string }> {
  const createdAtIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("agent_traces")
    .insert({
      user_id: input.userId,
      agent_id: input.agentId || null,
      session_id: input.sessionId || null,
      agent_name: input.agentName,
      agent_type: input.agentType,
      flag_key: input.flagKey || null,
      provider: input.provider || null,
      model: input.model || null,
      prompt: input.prompt,
      response: null,
      created_at: createdAtIso,
      metadata: input.metadata || {},
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    return { traceId: null, createdAtIso };
  }

  return { traceId: String(data.id), createdAtIso };
}

export async function completeAgentTrace(
  supabase: SupabaseClient,
  input: {
    traceId: string;
    response: string;
    completedAtIso?: string;
  }
) {
  await supabase
    .from("agent_traces")
    .update({
      response: input.response,
      completed_at: input.completedAtIso || new Date().toISOString(),
    })
    .eq("id", input.traceId);
}

export async function ingestAgentTraceToDatagranBestEffort(
  supabase: SupabaseClient,
  input: {
    userId: string;
    traceId: string;
    createdAtIso: string;
    agentName: string;
    agentType: string;
    flagKey?: string | null;
    provider?: string | null;
    model?: string | null;
    sessionId?: string | null;
    prompt: string;
    response?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  try {
    let compileApiKey: string | null = null;
    let compileConnectionId: string | null = null;

    const cfg = await loadDatagranMemoryConfig(supabase, input.userId);
    if (cfg.configured && cfg.connectionId) {
      compileApiKey = cfg.apiKey;
      compileConnectionId = cfg.connectionId;
    }

    // Fallback for users without explicit datagran_memory_configs:
    // use Groovy-managed memory connection so traces are still persisted
    // in the same memory surface queried by orchestrator/heartbeat.
    if ((!compileApiKey || !compileConnectionId) && process.env.DATAGRAN_API_KEY) {
      const groovyConnectionId = await getGroovyMemoryConnection(
        input.userId,
        undefined,
        supabase
      );
      if (groovyConnectionId) {
        compileApiKey = process.env.DATAGRAN_API_KEY;
        compileConnectionId = groovyConnectionId;
      }
    }

    if (!compileApiKey || !compileConnectionId) {
      return;
    }

    const text = formatTraceAsRawText({
      traceId: input.traceId,
      createdAtIso: input.createdAtIso,
      agentName: input.agentName,
      agentType: input.agentType,
      flagKey: input.flagKey,
      provider: input.provider,
      model: input.model,
      sessionId: input.sessionId,
      prompt: input.prompt,
      response: input.response,
      metadata: input.metadata,
    });

    const compiled = await datagranCompileRawText({
      apiKey: compileApiKey,
      connectionId: compileConnectionId,
      text,
      name: "groovy_trace",
      ref: input.traceId,
    });

    if (!compiled.ok) {
      return;
    }

    // Datagran API returns different fields depending on storage mode:
    // - compiled_memory_id: older format
    // - brain.artifact_id: newer "brain" storage format
    const data = compiled.data as Record<string, unknown>;
    const brain = data?.brain as Record<string, unknown> | undefined;
    const compiledMemoryId =
      (data?.compiled_memory_id as string) ||
      (brain?.artifact_id as string) ||
      (data?.trace_id as string) ||
      null;

    if (compiledMemoryId) {
      await supabase
        .from("agent_traces")
        .update({ datagran_compiled_memory_id: compiledMemoryId })
        .eq("id", input.traceId);
    }
  } catch {
    // Best-effort: ignore errors
  }
}

