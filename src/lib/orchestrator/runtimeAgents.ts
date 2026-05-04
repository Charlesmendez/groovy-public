import type { SupabaseClient } from "@supabase/supabase-js";

type EnsureUserAgentArgs = {
  supabase: SupabaseClient;
  userId: string;
  type: string;
  name: string;
  provider?: string | null;
  model?: string | null;
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function resolveOwnedAgentId(
  supabase: SupabaseClient,
  userId: string,
  candidateAgentId: unknown
): Promise<string | null> {
  const agentId = asNonEmptyString(candidateAgentId);
  if (!agentId) return null;
  try {
    const { data, error } = await supabase
      .from("agents")
      .select("id")
      .eq("id", agentId)
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn("[runtime-agent] validate_failed", { userId, agentId, error: error.message });
      return null;
    }
    return data?.id ? String(data.id) : null;
  } catch (error) {
    console.warn("[runtime-agent] validate_exception", { userId, agentId, error });
    return null;
  }
}

export async function createUserAgentId(args: EnsureUserAgentArgs): Promise<string | null> {
  const { supabase, userId, type, name, provider = null, model = null } = args;
  try {
    const { data: created, error: createErr } = await supabase
      .from("agents")
      .insert({
        user_id: userId,
        type,
        name,
        provider,
        model,
      })
      .select("id")
      .single();
    if (createErr) {
      console.warn("[runtime-agent] create_failed", { userId, type, error: createErr.message });
      return null;
    }
    return created?.id ? String(created.id) : null;
  } catch (error) {
    console.warn("[runtime-agent] create_exception", { userId, type, error });
    return null;
  }
}

export async function ensureUserAgentId(args: EnsureUserAgentArgs): Promise<string | null> {
  const { supabase, userId, type } = args;
  try {
    const { data: existing, error: existingErr } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", userId)
      .eq("type", type)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingErr) {
      console.warn("[runtime-agent] lookup_failed", { userId, type, error: existingErr.message });
    }
    if (existing?.id) return String(existing.id);
    return createUserAgentId(args);
  } catch (error) {
    console.warn("[runtime-agent] ensure_failed", { userId, type, error });
    return null;
  }
}

export async function ensureOrchestratorRuntimeAgentId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  return ensureUserAgentId({
    supabase,
    userId,
    type: "orchestrator-runtime",
    name: "Groovy Agent",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
  });
}

export async function createOrchestratorRuntimeAgentId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  return createUserAgentId({
    supabase,
    userId,
    type: "orchestrator-runtime",
    name: "Groovy Agent",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
  });
}

export async function ensureHeartbeatSystemAgentId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  return ensureUserAgentId({
    supabase,
    userId,
    type: "heartbeat-system",
    name: "Heartbeat",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
  });
}

export async function createHeartbeatSystemAgentId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  return createUserAgentId({
    supabase,
    userId,
    type: "heartbeat-system",
    name: "Heartbeat",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
  });
}
