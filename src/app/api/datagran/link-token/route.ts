import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";

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

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const agentId = toStringOrEmpty(body.agentId);
  const provider = toStringOrEmpty(body.provider);

  const origin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  let apiKey: string;
  let endUserExternalId: string;
  let providerToUse: string;

  if (agentId) {
    // Existing agent flow - load config from database
    const { data: config, error: cfgError } = await supabase
      .from("datagran_agent_configs")
      .select("datagran_api_key_enc, provider, end_user_external_id")
      .eq("agent_id", agentId)
      .eq("user_id", user.id)
      .single();

    if (cfgError || !config) {
      return NextResponse.json(
        { error: "Datagran config not found" },
        { status: 404 }
      );
    }

    try {
      apiKey = decryptLlmApiKey(config.datagran_api_key_enc);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Failed to decrypt API key" },
        { status: 500 }
      );
    }
    endUserExternalId = config.end_user_external_id;
    providerToUse = config.provider;
  } else if (provider) {
    // New connection flow - use server-side API key
    if (!DATAGRAN_API_KEY) {
      return NextResponse.json(
        { error: "Datagran API key not configured on server" },
        { status: 500 }
      );
    }
    apiKey = DATAGRAN_API_KEY;
    endUserExternalId = `flow_${user.id}`;
    providerToUse = provider;
  } else {
    return NextResponse.json(
      { error: "Missing agentId or provider" },
      { status: 400 }
    );
  }

  // Call Datagran API to create link token
  const scopes = providerScopes(providerToUse);
  const response = await fetch("https://www.datagran.io/api/link/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      endUser: {
        externalId: endUserExternalId,
        email: user.email,
      },
      origin,
      provider: providerToUse,
      ...(Array.isArray(scopes) && scopes.length > 0 ? { scopes } : {}),
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown error");
    return NextResponse.json(
      { error: `Datagran API error: ${errText}` },
      { status: response.status }
    );
  }

  const data = await response.json();
  return NextResponse.json(data);
}
