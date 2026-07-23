import { NextResponse } from "next/server";
import crypto from "crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { decryptLlmApiKey, encryptLlmApiKey } from "@/lib/crypto/llmKey";
import type { DatagranProvider } from "@/lib/datagran/prompts";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureOrchestratorIntegrationAssignment } from "@/lib/integrations/assignments";
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
  datagran_api_key_enc?: unknown;
  agents?: { name?: unknown } | Array<{ name?: unknown }> | null;
};

type ConnectionUiStatus = "connected" | "error" | "expired";

const DATAGRAN_PROVIDER_REAUTH_CAPABLE = new Set<DatagranProvider>([
  "facebook_ads",
  "facebook_leads",
  "instagram",
  "google_ads",
  "google_calendar",
  "gmail",
  "linkedin_ads",
  "google_drive",
  "tiktok",
  "salesforce",
]);

const DATAGRAN_CONNECTION_HEALTH_CHECKS: Partial<
  Record<
    DatagranProvider,
    {
      method: "GET" | "POST";
      endpoint: string;
      body?: unknown;
    }
  >
> = {
  gmail: {
    method: "GET",
    endpoint: "/api/proxy/gmail/gmail/v1/users/me/profile",
  },
  google_calendar: {
    method: "GET",
    endpoint: "/api/proxy/google-calendar/calendar/v3/users/me/calendarList?maxResults=1",
  },
  google_drive: {
    method: "GET",
    endpoint: "/api/proxy/google-drive/drive/v3/about?fields=user",
  },
  salesforce: {
    method: "GET",
    endpoint: "/api/proxy/salesforce/services/data",
  },
};

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

function supportsDatagranProviderReauth(provider: unknown): boolean {
  const normalized = toProvider(provider);
  return normalized ? DATAGRAN_PROVIDER_REAUTH_CAPABLE.has(normalized) : false;
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

function isAuthorizationRequiredError(
  status: number,
  data: unknown,
  provider?: string
): boolean {
  if (!supportsDatagranProviderReauth(provider)) return false;

  if (status === 401) return true;

  if (status === 403 && data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const rootError =
      d.error && typeof d.error === "object"
        ? (d.error as Record<string, unknown>)
        : null;
    const msg = `${
      typeof d.message === "string" ? d.message : ""
    } ${typeof rootError?.message === "string" ? rootError.message : ""}`.toLowerCase();
    const nested = Array.isArray(rootError?.errors) ? rootError.errors : [];
    const details = Array.isArray(rootError?.details) ? rootError.details : [];
    const reasons = [
      ...nested.map((x) =>
        x && typeof x === "object" && typeof (x as Record<string, unknown>).reason === "string"
          ? ((x as Record<string, unknown>).reason as string)
          : ""
      ),
      ...details.map((x) =>
        x && typeof x === "object" && typeof (x as Record<string, unknown>).reason === "string"
          ? ((x as Record<string, unknown>).reason as string)
          : ""
      ),
    ].filter(Boolean);
    if (
      msg.includes("insufficient authentication scopes") ||
      msg.includes("insufficient permission") ||
      reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
      reasons.includes("insufficientPermissions")
    ) {
      return true;
    }
  }

  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (d.status === "authorization_required") return true;
    if (d.error === "authorization_required") return true;
    if (
      typeof d.error === "string" &&
      /token.*expired|invalid.*token|authorization.*required|requires reauthorization|reauthorization/i.test(
        d.error
      )
    ) {
      return true;
    }
    if (
      typeof d.message === "string" &&
      /token.*expired|invalid.*token|authorization.*required|requires reauthorization|reauthorization/i.test(
        d.message
      )
    ) {
      return true;
    }
  }

  if (
    typeof data === "string" &&
    /token.*expired|invalid.*token|authorization.*required|requires reauthorization|reauthorization/i.test(
      data
    )
  ) {
    return true;
  }

  return false;
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

  if (isAuthorizationRequiredError(result.status, result.data, provider)) {
    return { status: "expired", statusMessage: "Needs re-authentication" };
  }

  return {
    status: "error",
    statusMessage: result.error ? `Health check failed: ${result.error}` : "Health check failed",
  };
}

export async function GET() {
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
  const connections = await Promise.all(
    rows.map(async (row) => {
      const provider = toProvider(row.provider);
      const statusInfo = await resolveConnectionStatus(row, defaultDatagranApiKey);
      return {
        agentId: toStringOrEmpty(row.agent_id),
        provider,
        name: getAgentName(row.agents, provider),
        connectionId: toOptionalString(row.connection_id),
        createdAt: toOptionalString(row.created_at),
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
