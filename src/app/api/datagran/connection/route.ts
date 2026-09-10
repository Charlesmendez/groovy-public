import { NextResponse } from "next/server";
import crypto from "crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { decryptLlmApiKey, encryptLlmApiKey } from "@/lib/crypto/llmKey";
import type { DatagranProvider } from "@/lib/datagran/prompts";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureOrchestratorIntegrationAssignment } from "@/lib/integrations/assignments";
import {
  DATAGRAN_CONNECTION_HEALTH_CHECKS,
  isDatagranAuthorizationRequiredError,
} from "@/lib/datagran/connectionHealth";
import {
  getOrCreateWorkspaceForUser,
  isWorkspaceOperatorRole,
} from "@/lib/workspaces";

type PostBody = {
  agentId?: unknown;
  connectionId?: unknown;
  provider?: unknown;
  apiKey?: unknown;
  name?: unknown;
};

type DatagranConfigRow = {
  agent_id?: unknown;
  provider?: unknown;
  connection_id?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  datagran_api_key_enc?: unknown;
  agents?: { name?: unknown } | Array<{ name?: unknown }> | null;
};

type ConnectionUiStatus = "connected" | "error" | "expired";

function toStringOrEmpty(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function toOptionalString(value: unknown): string | undefined {
  const str = toStringOrEmpty(value).trim();
  return str || undefined;
}

function toProvider(value: unknown): DatagranProvider | null {
  const normalized = toStringOrEmpty(value).trim();
  if (
    normalized === "facebook_ads" ||
    normalized === "facebook_leads" ||
    normalized === "instagram" ||
    normalized === "google_ads" ||
    normalized === "google_calendar" ||
    normalized === "gmail" ||
    normalized === "linkedin_ads" ||
    normalized === "google_drive" ||
    normalized === "tiktok" ||
    normalized === "postgres" ||
    normalized === "firecrawl" ||
    normalized === "salesforce" ||
    normalized === "web_pixel"
  ) {
    return normalized;
  }
  return null;
}

function getAgentName(
  agents: DatagranConfigRow["agents"],
  provider: DatagranProvider | null
): string {
  const first = Array.isArray(agents) ? agents[0] : agents;
  const name = toOptionalString(first?.name);
  if (name) return name;
  if (!provider) return "Unknown";
  return provider.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
}

async function datagranApiCall(
  datagranApiKey: string,
  connectionId: string,
  method: "GET" | "POST",
  endpoint: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const url = new URL(endpoint, "https://www.datagran.io");
  if (!url.searchParams.has("connection_id")) {
    url.searchParams.set("connection_id", connectionId);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        "x-api-key": datagranApiKey,
        "Content-Type": "application/json",
      },
      ...(body && method !== "GET" ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data,
        error:
          typeof data === "string"
            ? data.slice(0, 300)
            : JSON.stringify(data).slice(0, 300),
      };
    }
    return { ok: true, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveConnectionStatus(
  row: DatagranConfigRow,
  defaultDatagranApiKey: string
): Promise<{ status: ConnectionUiStatus; statusMessage?: string }> {
  const provider = toProvider(row.provider);
  const connectionId = toOptionalString(row.connection_id);
  if (!connectionId) {
    return { status: "error", statusMessage: "Missing connection ID" };
  }
  if (!provider) {
    return { status: "error", statusMessage: "Unknown provider" };
  }

  const healthCheck = DATAGRAN_CONNECTION_HEALTH_CHECKS[provider];
  if (!healthCheck) {
    return { status: "connected" };
  }

  let apiKey = defaultDatagranApiKey;
  const enc = toOptionalString(row.datagran_api_key_enc);
  if (enc) {
    try {
      apiKey = decryptLlmApiKey(enc);
    } catch {
      return { status: "error", statusMessage: "Saved Datagran key could not be decrypted" };
    }
  }
  if (!apiKey) {
    return { status: "error", statusMessage: "Missing Datagran API key" };
  }

  const result = await datagranApiCall(
    apiKey,
    connectionId,
    healthCheck.method,
    healthCheck.endpoint,
    healthCheck.body
  );

  if (result.ok) {
    return { status: "connected" };
  }

  if (
    isDatagranAuthorizationRequiredError(
      result.status,
      result.data,
      provider,
    )
  ) {
    return { status: "expired", statusMessage: "Needs re-authentication" };
  }

  return {
    status: "error",
    statusMessage: result.error ? `Health check failed: ${result.error}` : "Health check failed",
  };
}

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspace = await getOrCreateWorkspaceForUser();
  if (!isWorkspaceOperatorRole(workspace.role)) {
    return NextResponse.json({ error: "Workspace member access required" }, { status: 403 });
  }
  const ownerUserId = workspace.billing_admin_user_id;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("datagran_agent_configs")
    .select(`
      agent_id,
      provider,
      connection_id,
      created_at,
      updated_at,
      datagran_api_key_enc,
      agents!datagran_agent_configs_agent_id_fkey(name)
    `)
    .eq("user_id", ownerUserId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message || "Failed to load connections" }, { status: 500 });
  }

  const defaultDatagranApiKey = toStringOrEmpty(process.env.DATAGRAN_API_KEY);
  const rows = (data || []) as DatagranConfigRow[];
  const skipHealth =
    new URL(request.url).searchParams.get("health") === "skip";
  const connections = await Promise.all(
    rows.map(async (row) => {
      const provider = toProvider(row.provider);
      const statusInfo = skipHealth
        ? toOptionalString(row.connection_id)
          ? { status: "connected" as const }
          : {
              status: "error" as const,
              statusMessage: "Missing connection ID",
            }
        : await resolveConnectionStatus(row, defaultDatagranApiKey);
      return {
        agentId: toStringOrEmpty(row.agent_id),
        provider,
        name: getAgentName(row.agents, provider),
        connectionId: toOptionalString(row.connection_id),
        createdAt: toOptionalString(row.created_at),
        updatedAt: toOptionalString(row.updated_at),
        status: statusInfo.status,
        statusMessage: statusInfo.statusMessage,
      };
    })
  );

  return NextResponse.json({ connections });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspace = await getOrCreateWorkspaceForUser();
  if (workspace.role !== "admin") {
    return NextResponse.json(
      { error: "Only workspace admins can manage integrations" },
      { status: 403 },
    );
  }
  const ownerUserId = workspace.billing_admin_user_id;
  const admin = createSupabaseAdminClient();
  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const agentId = toStringOrEmpty(body.agentId);
  const connectionId = toStringOrEmpty(body.connectionId);
  const provider = toStringOrEmpty(body.provider);
  const apiKey = toStringOrEmpty(body.apiKey);
  const name = toStringOrEmpty(body.name);

  if (!connectionId) {
    return NextResponse.json(
      { error: "Missing connectionId" },
      { status: 400 }
    );
  }

  // Case 1: Update existing agent with connection ID
  if (agentId) {
    const { data: current, error: currentError } = await admin
      .from("datagran_agent_configs")
      .select("provider,connection_id")
      .eq("agent_id", agentId)
      .eq("user_id", ownerUserId)
      .maybeSingle();
    if (currentError) {
      return NextResponse.json(
        { error: currentError.message || "Failed to load connection" },
        { status: 500 },
      );
    }
    if (!current) {
      return NextResponse.json(
        { error: "Datagran config not found for this user" },
        { status: 404 },
      );
    }
    const previousConnectionId = toStringOrEmpty(current.connection_id).trim();
    if (
      current.provider === "gmail" &&
      previousConnectionId &&
      previousConnectionId !== connectionId
    ) {
      for (const table of [
        "email_mailbox_preferences",
        "email_classification_feedback",
        "email_sender_affinity_cache",
        "inbox_actions",
      ]) {
        const { error: remapError } = await admin
          .from(table)
          .update({ connection_id: connectionId })
          .eq("user_id", ownerUserId)
          .eq("connection_id", previousConnectionId);
        if (remapError) {
          return NextResponse.json(
            {
              error:
                remapError.message ||
                "Failed to preserve Gmail workspace history",
            },
            { status: 500 },
          );
        }
      }
      const { data: snippets, error: snippetsError } = await admin
        .from("email_snippets")
        .select("id,mailbox_connection_ids")
        .eq("user_id", ownerUserId);
      if (snippetsError) {
        return NextResponse.json(
          { error: snippetsError.message || "Failed to preserve snippets" },
          { status: 500 },
        );
      }
      for (const snippet of snippets || []) {
        const mailboxIds = Array.isArray(snippet.mailbox_connection_ids)
          ? snippet.mailbox_connection_ids.map((value) =>
              toStringOrEmpty(value).trim(),
            )
          : [];
        if (!mailboxIds.includes(previousConnectionId)) continue;
        const { error: snippetError } = await admin
          .from("email_snippets")
          .update({
            mailbox_connection_ids: Array.from(
              new Set(
                mailboxIds.map((value) =>
                  value === previousConnectionId ? connectionId : value,
                ),
              ),
            ),
            updated_at: new Date().toISOString(),
          })
          .eq("id", snippet.id)
          .eq("user_id", ownerUserId);
        if (snippetError) {
          return NextResponse.json(
            { error: snippetError.message || "Failed to preserve snippets" },
            { status: 500 },
          );
        }
      }
    }
    const { data: updated, error } = await admin
      .from("datagran_agent_configs")
      .update({
        connection_id: connectionId,
        updated_at: new Date().toISOString(),
      })
      .eq("agent_id", agentId)
      .eq("user_id", ownerUserId)
      .select("agent_id")
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: error.message || "Failed to save connection ID" },
        { status: 500 }
      );
    }
    if (!updated) {
      return NextResponse.json(
        { error: "Datagran config not found for this user" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  }

  // Case 2: Create new agent with existing connection ID + API key
  if (provider) {
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing Datagran API key" },
        { status: 400 }
      );
    }

    // Encrypt the user's API key for storage
    const datagranApiKeyEnc = encryptLlmApiKey(apiKey);
    const datagranApiKeyHash = sha256Hex(apiKey);

    // Create the agent with custom name or fallback to provider name
    const agentName = name || provider.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    const { data: newAgent, error: agentError } = await admin
      .from("agents")
      .insert({
        user_id: ownerUserId,
        type: "datagran",
        name: agentName,
      })
      .select("id")
      .single();

    if (agentError || !newAgent) {
      return NextResponse.json(
        { error: agentError?.message || "Failed to create agent" },
        { status: 500 }
      );
    }

    // Create the datagran config with the connection ID
    const { error: configError } = await admin
      .from("datagran_agent_configs")
      .insert({
        agent_id: newAgent.id,
        user_id: ownerUserId,
        datagran_api_key_enc: datagranApiKeyEnc,
        datagran_api_key_hash: datagranApiKeyHash,
        provider,
        connection_id: connectionId,
        end_user_external_id: `flow_${ownerUserId}`,
      });

    if (configError) {
      // Clean up the agent if config creation fails
      await admin.from("agents").delete().eq("id", newAgent.id);
      return NextResponse.json(
        { error: configError.message || "Failed to create agent config" },
        { status: 500 }
      );
    }

    await ensureOrchestratorIntegrationAssignment({
      supabase: admin,
      userId: ownerUserId,
      integrationId: String(newAgent.id),
    }).catch((error) => {
      console.warn("[datagran-connection] failed to auto-assign integration", error);
    });

    return NextResponse.json({ success: true, agentId: newAgent.id });
  }

  return NextResponse.json(
    { error: "Missing agentId or provider" },
    { status: 400 }
  );
}
