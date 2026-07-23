import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { encryptLlmApiKey, sha256Hex } from "@/lib/crypto/llmKey";
import {
  getDatagranChatModel,
  getFilesAgentModel,
} from "@/lib/ai/modelResolver";
import { rehomeScheduledJobsForDeletedAgent } from "@/lib/orchestrator/scheduledJobLifecycle";
import { ensureOrchestratorIntegrationAssignment } from "@/lib/integrations/assignments";
import { listWorkerAgents } from "@/lib/orchestrator/agentTasks";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";

type PostBody = {
  type?: unknown;
  name?: unknown;
  flagKey?: unknown;
  provider?: unknown;
  model?: unknown;
  llmKeySource?: unknown; // "user" | "groovy"
  apiKey?: unknown;
  reasoningEffort?: unknown; // OpenAI/Anthropic extended thinking
  systemPrompt?: unknown; // Custom system prompt
  useExistingKey?: unknown; // Use existing key from user_api_keys
  // Datagran-specific
  datagranProvider?: unknown;
  datagranApiKey?: unknown;
  anthropicApiKey?: unknown;
  connectionId?: unknown; // For web_pixel: the site_id
  // Cursor-specific
  cursorApiKey?: unknown;
  defaultRepository?: unknown;
  defaultBranch?: unknown;
  autoCreatePr?: unknown;
};

function toStringOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return null;
  return String(v);
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const agents = await listWorkerAgents(user.id, { supabase }).catch(() => []);
  return NextResponse.json({
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      harness: agent.harness,
      model: agent.model,
      deviceOnline: agent.deviceOnline,
    })),
  });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const type = toStringOrNull(body.type) || "";
  
  if (type === "datagran") {
    const workspace = await getOrCreateWorkspaceForUser();
    if (workspace.role !== "admin") {
      return NextResponse.json(
        { error: "Only workspace admins can manage integrations" },
        { status: 403 },
      );
    }
    return handleDatagranCreation(
      createSupabaseAdminClient(),
      workspace.billing_admin_user_id,
      body,
    );
  }

  if (type === "cursor") {
    return handleCursorCreation(supabase, user.id, body);
  }

  if (type === "files-agent") {
    return handleFilesAgentCreation(supabase, user.id, body);
  }
  
  if (type !== "ai-chat") {
    return NextResponse.json({ error: "Only ai-chat, cursor, datagran, and files-agent creation supported here" }, { status: 400 });
  }

  const name = (toStringOrNull(body.name) || "").trim();
  if (!name) return NextResponse.json({ error: "Agent name is required" }, { status: 400 });

  const provider = (toStringOrNull(body.provider) || "openai").toLowerCase();
  const model = (toStringOrNull(body.model) || "").trim();
  const flagKey = toStringOrNull(body.flagKey);
  const reasoningEffort = (provider === "openai" || provider === "anthropic") ? (toStringOrNull(body.reasoningEffort) || "medium") : null;
  const systemPrompt = (toStringOrNull(body.systemPrompt) || "").trim() || null;

  const { data: agent, error } = await supabase
    .from("agents")
    .insert({
      user_id: user.id,
      type: "ai-chat",
      name,
      flag_key: flagKey || null,
      provider,
      model,
      reasoning_effort: reasoningEffort,
      system_prompt: systemPrompt,
    })
    .select("id,type,name,flag_key,provider,model,reasoning_effort,system_prompt")
    .single();

  if (error || !agent) {
    return NextResponse.json({ error: error?.message || "Failed to create agent" }, { status: 500 });
  }

  // Create an initial session for the agent
  const { data: session, error: sessErr } = await supabase
    .from("chat_sessions")
    .insert({
      user_id: user.id,
      agent_id: agent.id,
      title: "New chat",
    })
    .select("id")
    .single();

  if (sessErr) {
    return NextResponse.json(
      { error: sessErr.message || "Failed to create session" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    agent,
    sessionId: session?.id || null,
  });
}

async function handleDatagranCreation(
  supabase: SupabaseClient,
  userId: string,
  body: PostBody
) {
  const name = (toStringOrNull(body.name) || "").trim();
  if (!name) return NextResponse.json({ error: "Agent name is required" }, { status: 400 });

  const flagKey = toStringOrNull(body.flagKey);
  const datagranProvider = (toStringOrNull(body.datagranProvider) || "").trim();
  const datagranApiKey = (toStringOrNull(body.datagranApiKey) || "").trim();
  const connectionId = toStringOrNull(body.connectionId); // For web_pixel: the site_id

  if (!datagranProvider) {
    return NextResponse.json({ error: "Datagran provider is required" }, { status: 400 });
  }

  const validProviders = [
    "facebook_ads", "facebook_leads", "instagram", "google_ads",
    "linkedin_ads", "google_drive", "tiktok", "postgres", "firecrawl",
    "salesforce", "web_pixel", "gmail", "google_calendar"
  ];
  if (!validProviders.includes(datagranProvider)) {
    return NextResponse.json({ error: "Invalid Datagran provider" }, { status: 400 });
  }

  // web_pixel requires a connection_id (site_id) upfront
  if (datagranProvider === "web_pixel" && !connectionId) {
    return NextResponse.json({ error: "Pixel site selection is required for Web Pixel" }, { status: 400 });
  }

  const serverDatagranKey = process.env.DATAGRAN_API_KEY || "";
  const datagranKeyToUse = datagranApiKey || serverDatagranKey;
  if (!datagranKeyToUse) {
    return NextResponse.json(
      { error: "Datagran API key is not configured (set DATAGRAN_API_KEY on server)" },
      { status: 500 }
    );
  }

  // Encrypt the API keys
  const datagranApiKeyEnc = encryptLlmApiKey(datagranKeyToUse);
  const datagranApiKeyHash = sha256Hex(datagranKeyToUse);

  // Create the agent
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .insert({
      user_id: userId,
      type: "datagran",
      name,
      flag_key: flagKey || null,
      provider: "anthropic",
      model: getDatagranChatModel(),
    })
    .select("id,type,name,flag_key,provider,model")
    .single();

  if (agentError || !agent) {
    return NextResponse.json(
      { error: agentError?.message || "Failed to create agent" },
      { status: 500 }
    );
  }

  // Create the Datagran config
  // For web_pixel, connection_id is the site_id passed from the client
  // For OAuth providers, it will be set after the OAuth flow
  const { error: cfgError } = await supabase.from("datagran_agent_configs").insert({
    agent_id: agent.id,
    user_id: userId,
    datagran_api_key_enc: datagranApiKeyEnc,
    datagran_api_key_hash: datagranApiKeyHash,
    provider: datagranProvider,
    connection_id: connectionId || null,
    end_user_external_id: `flow_${userId}`, // External ID for Datagran
  });

  if (cfgError) {
    // Rollback agent creation
    await supabase.from("agents").delete().eq("id", agent.id);
    return NextResponse.json(
      { error: cfgError.message || "Failed to create Datagran config" },
      { status: 500 }
    );
  }

  await ensureOrchestratorIntegrationAssignment({
    supabase,
    userId,
    integrationId: String(agent.id),
  }).catch((error) => {
    console.warn("[agents] failed to auto-assign Datagran integration", error);
  });

  // Create an initial session for the agent
  const { data: session, error: sessErr } = await supabase
    .from("chat_sessions")
    .insert({
      user_id: userId,
      agent_id: agent.id,
      title: "New chat",
    })
    .select("id")
    .single();

  if (sessErr) {
    console.error("Failed to create session:", sessErr);
    // Don't fail the whole operation for this
  }

  return NextResponse.json({
    agent,
    sessionId: session?.id || null,
  });
}

async function handleCursorCreation(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
  body: PostBody
) {
  const name = (toStringOrNull(body.name) || "").trim();
  if (!name) return NextResponse.json({ error: "Agent name is required" }, { status: 400 });

  const flagKey = toStringOrNull(body.flagKey);
  const cursorApiKey = (toStringOrNull(body.cursorApiKey) || "").trim();
  const defaultRepository = (toStringOrNull(body.defaultRepository) || "").trim();
  const defaultBranch = (toStringOrNull(body.defaultBranch) || "main").trim();
  const autoCreatePr = Boolean(body.autoCreatePr);

  if (!cursorApiKey) {
    return NextResponse.json({ error: "Cursor API key is required" }, { status: 400 });
  }

  // Encrypt the API key
  const cursorApiKeyEnc = encryptLlmApiKey(cursorApiKey);
  const cursorApiKeyHash = sha256Hex(cursorApiKey);

  // Create the agent
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .insert({
      user_id: userId,
      type: "cursor",
      name,
      flag_key: flagKey || null,
      provider: null,
      model: null,
    })
    .select("id,type,name,flag_key")
    .single();

  if (agentError || !agent) {
    return NextResponse.json(
      { error: agentError?.message || "Failed to create agent" },
      { status: 500 }
    );
  }

  // Create the Cursor config
  const { error: cfgError } = await supabase.from("cursor_agent_configs").insert({
    agent_id: agent.id,
    user_id: userId,
    cursor_api_key_enc: cursorApiKeyEnc,
    cursor_api_key_hash: cursorApiKeyHash,
    default_repository: defaultRepository || null,
    default_branch: defaultBranch || "main",
    auto_create_pr: autoCreatePr,
  });

  if (cfgError) {
    // Rollback agent creation
    await supabase.from("agents").delete().eq("id", agent.id);
    return NextResponse.json(
      { error: cfgError.message || "Failed to create Cursor config" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    agent,
    sessionId: null,
  });
}

async function handleFilesAgentCreation(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
  body: PostBody
) {
  const name = (toStringOrNull(body.name) || "").trim();
  if (!name) return NextResponse.json({ error: "Agent name is required" }, { status: 400 });

  const flagKey = toStringOrNull(body.flagKey);

  // Create the agent with fixed provider/model
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .insert({
      user_id: userId,
      type: "files-agent",
      name,
      flag_key: flagKey || null,
      provider: "anthropic",
      model: getFilesAgentModel(),
    })
    .select("id,type,name,flag_key,provider,model")
    .single();

  if (agentError || !agent) {
    return NextResponse.json(
      { error: agentError?.message || "Failed to create agent" },
      { status: 500 }
    );
  }

  // Create an initial session for the agent
  const { data: session, error: sessErr } = await supabase
    .from("chat_sessions")
    .insert({
      user_id: userId,
      agent_id: agent.id,
      title: "New chat",
    })
    .select("id")
    .single();

  if (sessErr) {
    console.error("Failed to create session:", sessErr);
  }

  return NextResponse.json({
    agent,
    sessionId: session?.id || null,
  });
}

export async function DELETE(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get("id");

  if (!agentId) {
    return NextResponse.json({ error: "Agent ID is required" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data: candidate, error: fetchError } = await admin
    .from("agents")
    .select("id, type, user_id")
    .eq("id", agentId)
    .maybeSingle();

  if (fetchError || !candidate) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  let operationClient: SupabaseClient = supabase;
  let operationUserId = user.id;
  if (candidate.type === "datagran") {
    const workspace = await getOrCreateWorkspaceForUser();
    if (
      workspace.role !== "admin" ||
      candidate.user_id !== workspace.billing_admin_user_id
    ) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    operationClient = admin;
    operationUserId = workspace.billing_admin_user_id;
  } else if (candidate.user_id !== user.id) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  try {
    await rehomeScheduledJobsForDeletedAgent({
      supabase: operationClient,
      userId: operationUserId,
      deletedAgentId: agentId,
    });
  } catch (error) {
    console.error("[agents] schedule rehome error:", error);
    return NextResponse.json(
      { error: "Failed to preserve scheduled jobs for this agent" },
      { status: 500 }
    );
  }

  // Configs and chat sessions reference agents with ON DELETE CASCADE. Delete the
  // parent row only after scheduled jobs have been safely rehomed.
  const { error: deleteError } = await operationClient
    .from("agents")
    .delete()
    .eq("id", agentId)
    .eq("user_id", operationUserId);

  if (deleteError) {
    console.error("[agents] delete error:", deleteError);
    return NextResponse.json({ error: "Failed to delete agent" }, { status: 500 });
  }

  return NextResponse.json({ success: true, deleted: agentId });
}

export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { id?: string; name?: string } | null;
  if (!body?.id) {
    return NextResponse.json({ error: "Agent ID is required" }, { status: 400 });
  }

  const newName = body.name?.trim();
  if (!newName) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data: candidate } = await admin
    .from("agents")
    .select("id,type,user_id")
    .eq("id", body.id)
    .maybeSingle();
  if (!candidate) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  let operationClient: SupabaseClient = supabase;
  let operationUserId = user.id;
  if (candidate.type === "datagran") {
    const workspace = await getOrCreateWorkspaceForUser();
    if (
      workspace.role !== "admin" ||
      candidate.user_id !== workspace.billing_admin_user_id
    ) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    operationClient = admin;
    operationUserId = workspace.billing_admin_user_id;
  } else if (candidate.user_id !== user.id) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const { data: agent, error } = await operationClient
    .from("agents")
    .update({ name: newName, updated_at: new Date().toISOString() })
    .eq("id", body.id)
    .eq("user_id", operationUserId)
    .select("id, name")
    .single();

  if (error || !agent) {
    return NextResponse.json({ error: error?.message || "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, agent });
}
