import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { decryptLlmApiKey, encryptLlmApiKey, sha256Hex } from "@/lib/crypto/llmKey";
import { createDatagranLinkToken, resolveDatagranLinkOrigin } from "@/lib/datagran/linkToken";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";

const DATAGRAN_API_KEY = process.env.DATAGRAN_API_KEY;

const GMAIL_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.labels",
];

type PostBody = {
  agentId?: unknown;
  provider?: unknown; // For new connections
};

function toStringOrEmpty(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function providerScopes(provider: string): string[] | undefined {
  const p = toStringOrEmpty(provider).toLowerCase();
  if (p !== "gmail") return undefined;
  return GMAIL_REQUIRED_SCOPES;
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
  const provider = toStringOrEmpty(body.provider);

  const origin = resolveDatagranLinkOrigin(req.url, "http://localhost:3000");

  let apiKeys: Array<string | null | undefined>;
  let endUserExternalId: string;
  let providerToUse: string;
  let shouldRefreshStoredServerKey = false;

  if (agentId) {
    // Existing agent flow - load config from database
    const { data: config, error: cfgError } = await admin
      .from("datagran_agent_configs")
      .select("datagran_api_key_enc, provider, end_user_external_id")
      .eq("agent_id", agentId)
      .eq("user_id", ownerUserId)
      .single();

    if (cfgError || !config) {
      return NextResponse.json(
        { error: "Datagran config not found" },
        { status: 404 }
      );
    }

    let savedApiKey = "";
    if (config.datagran_api_key_enc) {
      try {
        savedApiKey = decryptLlmApiKey(config.datagran_api_key_enc);
      } catch (e) {
        if (!DATAGRAN_API_KEY) {
          return NextResponse.json(
            { error: e instanceof Error ? e.message : "Failed to decrypt API key" },
            { status: 500 }
          );
        }
      }
    }
    apiKeys = [savedApiKey, DATAGRAN_API_KEY];
    endUserExternalId = config.end_user_external_id || `flow_${ownerUserId}`;
    providerToUse = config.provider;
    shouldRefreshStoredServerKey = Boolean(DATAGRAN_API_KEY);
  } else if (provider) {
    // New connection flow - use server-side API key
    if (!DATAGRAN_API_KEY) {
      return NextResponse.json(
        { error: "Datagran API key not configured on server" },
        { status: 500 }
      );
    }
    apiKeys = [DATAGRAN_API_KEY];
    endUserExternalId = `flow_${ownerUserId}`;
    providerToUse = provider;
  } else {
    return NextResponse.json(
      { error: "Missing agentId or provider" },
      { status: 400 }
    );
  }

  // Call Datagran API to create link token
  const scopes = providerScopes(providerToUse);
  const result = await createDatagranLinkToken({
    apiKeys,
    endUserExternalId,
    email: user.email,
    origin,
    provider: providerToUse,
    scopes,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: `Datagran API error: ${result.error}` },
      { status: result.status }
    );
  }

  if (agentId && result.usedApiKeyIndex > 0 && shouldRefreshStoredServerKey && DATAGRAN_API_KEY) {
    const { error: updateError } = await admin
      .from("datagran_agent_configs")
      .update({
        datagran_api_key_enc: encryptLlmApiKey(DATAGRAN_API_KEY),
        datagran_api_key_hash: sha256Hex(DATAGRAN_API_KEY),
        updated_at: new Date().toISOString(),
      })
      .eq("agent_id", agentId)
      .eq("user_id", ownerUserId);
    if (updateError) {
      console.warn("[datagran-link-token] failed to refresh stored Datagran key", {
        agentId,
        provider: providerToUse,
        error: updateError.message,
      });
    }
  }

  return NextResponse.json(result.data);
}
