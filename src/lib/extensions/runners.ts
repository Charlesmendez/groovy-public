import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptLlmApiKey, encryptLlmApiKey, sha256Hex } from "@/lib/crypto/llmKey";
import type {
  ExtensionRunnerRuntime,
  ExtensionRunnerStatus,
  ExtensionRunnerTransport,
  ExtensionRuntimeTarget,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRunnerStatus(value: unknown): ExtensionRunnerStatus {
  return value === "pending" || value === "online" || value === "error" ? value : "offline";
}

function asRunnerTransport(value: unknown): ExtensionRunnerTransport {
  return value === "relay" || value === "local" ? value : "https";
}

function asRuntimeTarget(value: unknown): ExtensionRuntimeTarget {
  return value === "groovy_cloud" || value === "device_connector" ? value : "customer_runner";
}

async function requireOwnedAgent(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
}) {
  const { data, error } = await args.supabase
    .from("agents")
    .select("id")
    .eq("id", args.agentId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(error?.message || "Agent not found");
  }
}

function decryptRunnerAuthToken(enc: string): string | null {
  const trimmed = asTrimmed(enc);
  if (!trimmed) return null;
  try {
    const token = decryptLlmApiKey(trimmed);
    return token.trim() || null;
  } catch {
    return null;
  }
}

export async function listExtensionRunners(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId?: string | null;
}): Promise<Array<Record<string, unknown>>> {
  let query = args.supabase
    .from("orchestrator_extension_runners")
    .select("id,user_id,agent_id,name,runtime_target,transport,status,endpoint,public_key,metadata,last_seen_at,created_at,updated_at")
    .eq("user_id", args.userId)
    .order("updated_at", { ascending: false });

  if (asTrimmed(args.agentId)) {
    query = query.eq("agent_id", asTrimmed(args.agentId));
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message || "Failed to load runners");
  return (data || []) as Array<Record<string, unknown>>;
}

export async function upsertExtensionRunner(args: {
  supabase: SupabaseClient;
  userId: string;
  runnerId?: string | null;
  agentId: string;
  name: string;
  runtimeTarget?: ExtensionRuntimeTarget;
  transport?: ExtensionRunnerTransport;
  status?: ExtensionRunnerStatus;
  endpoint?: string | null;
  publicKey?: string | null;
  authToken?: string | null;
  metadata?: unknown;
  lastSeenAt?: string | null;
}): Promise<Record<string, unknown>> {
  await requireOwnedAgent({
    supabase: args.supabase,
    userId: args.userId,
    agentId: args.agentId,
  });

  const runnerId = asTrimmed(args.runnerId);
  const name = asTrimmed(args.name);
  if (!name) throw new Error("Runner name is required");

  let existingEnc = "";
  let existingHash = "";
  let existingRow: Record<string, unknown> | null = null;
  if (runnerId) {
    const { data: existing, error: existingError } = await args.supabase
      .from("orchestrator_extension_runners")
      .select("id,endpoint,public_key,runtime_target,transport,status,metadata,last_seen_at,auth_token_enc,auth_token_hash")
      .eq("id", runnerId)
      .eq("user_id", args.userId)
      .eq("agent_id", args.agentId)
      .maybeSingle();

    if (existingError || !existing) {
      throw new Error(existingError?.message || "Runner not found");
    }
    existingRow = existing as Record<string, unknown>;
    existingEnc = asTrimmed(existing.auth_token_enc);
    existingHash = asTrimmed(existing.auth_token_hash);
  }

  const authToken = args.authToken === undefined ? undefined : asTrimmed(args.authToken);
  const authTokenEnc =
    authToken === undefined
      ? existingEnc || null
      : authToken
        ? encryptLlmApiKey(authToken)
        : null;
  const authTokenHash =
    authToken === undefined
      ? existingHash || null
      : authToken
        ? sha256Hex(authToken)
        : null;

  const payload = {
    user_id: args.userId,
    agent_id: args.agentId,
    name,
    runtime_target:
      args.runtimeTarget === undefined
        ? asRuntimeTarget(existingRow?.runtime_target)
        : asRuntimeTarget(args.runtimeTarget),
    transport:
      args.transport === undefined
        ? asRunnerTransport(existingRow?.transport)
        : asRunnerTransport(args.transport),
    status:
      args.status === undefined
        ? asRunnerStatus(existingRow?.status)
        : asRunnerStatus(args.status),
    endpoint:
      args.endpoint === undefined
        ? asTrimmed(existingRow?.endpoint) || null
        : asTrimmed(args.endpoint) || null,
    public_key:
      args.publicKey === undefined
        ? asTrimmed(existingRow?.public_key) || null
        : asTrimmed(args.publicKey) || null,
    auth_token_enc: authTokenEnc,
    auth_token_hash: authTokenHash,
    metadata:
      args.metadata === undefined
        ? asRecord(existingRow?.metadata)
        : asRecord(args.metadata),
    last_seen_at:
      args.lastSeenAt === undefined
        ? asTrimmed(existingRow?.last_seen_at) || null
        : asTrimmed(args.lastSeenAt) || null,
    updated_at: new Date().toISOString(),
  };

  const runnerQuery = runnerId
    ? args.supabase
        .from("orchestrator_extension_runners")
        .update(payload)
        .eq("id", runnerId)
    : args.supabase
        .from("orchestrator_extension_runners")
        .insert({
          ...payload,
          created_at: new Date().toISOString(),
        });

  const { data, error } = await runnerQuery
    .select("id,user_id,agent_id,name,runtime_target,transport,status,endpoint,public_key,metadata,last_seen_at,created_at,updated_at")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to save runner");
  }

  return data;
}

export async function loadExtensionRunnerRuntime(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  runnerId: string;
}): Promise<ExtensionRunnerRuntime | null> {
  const { data, error } = await args.supabase
    .from("orchestrator_extension_runners")
    .select("id,agent_id,name,runtime_target,transport,status,endpoint,metadata,auth_token_enc")
    .eq("id", args.runnerId)
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: asTrimmed(data.id),
    agentId: asTrimmed(data.agent_id),
    name: asTrimmed(data.name),
    runtimeTarget: asRuntimeTarget(data.runtime_target),
    transport: asRunnerTransport(data.transport),
    status: asRunnerStatus(data.status),
    endpoint: asTrimmed(data.endpoint) || null,
    metadata: asRecord(data.metadata),
    authToken: decryptRunnerAuthToken(asTrimmed(data.auth_token_enc)),
  };
}

export async function recordExtensionRunnerHeartbeat(args: {
  supabase: SupabaseClient;
  userId: string;
  runnerId: string;
  status?: ExtensionRunnerStatus;
  metadata?: unknown;
  lastSeenAt?: string | null;
}): Promise<Record<string, unknown>> {
  const runnerId = asTrimmed(args.runnerId);
  if (!runnerId) throw new Error("Runner id is required");

  const { data: existing, error: existingError } = await args.supabase
    .from("orchestrator_extension_runners")
    .select("id,metadata")
    .eq("id", runnerId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (existingError || !existing) {
    throw new Error(existingError?.message || "Runner not found");
  }

  const mergedMetadata = {
    ...asRecord(existing.metadata),
    ...asRecord(args.metadata),
  };

  const { data, error } = await args.supabase
    .from("orchestrator_extension_runners")
    .update({
      status: args.status ? asRunnerStatus(args.status) : "online",
      last_seen_at: asTrimmed(args.lastSeenAt) || new Date().toISOString(),
      metadata: mergedMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runnerId)
    .eq("user_id", args.userId)
    .select("id,user_id,agent_id,name,runtime_target,transport,status,endpoint,public_key,metadata,last_seen_at,created_at,updated_at")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to update runner heartbeat");
  }

  return data;
}
