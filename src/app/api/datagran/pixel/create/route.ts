import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { encryptLlmApiKey } from "@/lib/crypto/llmKey";
import crypto from "crypto";

const DATAGRAN_API_KEY = process.env.DATAGRAN_API_KEY;

type PostBody = {
  name?: unknown;
  allowedOrigins?: unknown;
};

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === "string");
  }
  if (typeof value === "string") {
    // Split by comma or newline
    return value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!DATAGRAN_API_KEY) {
    return NextResponse.json(
      { error: "Datagran API key not configured on server" },
      { status: 500 }
    );
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const name = toStringOrNull(body.name)?.trim();
  const allowedOrigins = toStringArray(body.allowedOrigins);

  if (!name) {
    return NextResponse.json({ error: "Site name is required" }, { status: 400 });
  }

  if (allowedOrigins.length === 0) {
    return NextResponse.json(
      { error: "At least one allowed origin is required" },
      { status: 400 }
    );
  }

  // Create pixel site via Datagran API
  const response = await fetch("https://www.datagran.io/api/pixel/sites", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": DATAGRAN_API_KEY,
    },
    body: JSON.stringify({
      name,
      allowed_origins: allowedOrigins,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown error");
    console.error("[Pixel Create] Datagran API error:", errText);
    return NextResponse.json(
      { error: `Datagran API error: ${errText}` },
      { status: response.status }
    );
  }

  const pixelData = await response.json();
  // Response: { id, name, write_key, write_key_prefix, allowed_origins, status }

  // Create an agent entry in our database to track this pixel
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .insert({
      user_id: user.id,
      name: `Pixel: ${name}`,
      type: "datagran",
      status: "ready",
    })
    .select("id")
    .single();

  if (agentError || !agent) {
    console.error("[Pixel Create] Failed to create agent:", agentError);
    // Still return the pixel data - it was created in Datagran
    return NextResponse.json({
      ...pixelData,
      warning: "Pixel created but failed to save to local database",
    });
  }

  // Create datagran_agent_configs entry
  const sha256Hex = (input: string) =>
    crypto.createHash("sha256").update(input, "utf8").digest("hex");

  const { error: configError } = await supabase
    .from("datagran_agent_configs")
    .insert({
      agent_id: agent.id,
      user_id: user.id,
      datagran_api_key_enc: encryptLlmApiKey(DATAGRAN_API_KEY),
      datagran_api_key_hash: sha256Hex(DATAGRAN_API_KEY),
      provider: "web_pixel",
      connection_id: pixelData.id, // site_id
      end_user_external_id: `flow_${user.id}`,
    });

  if (configError) {
    console.error("[Pixel Create] Failed to create config:", configError);
    // Prevent a "looks connected but isn't" state.
    await supabase.from("agents").delete().eq("id", agent.id).eq("user_id", user.id);
    return NextResponse.json(
      {
        error:
          "Pixel was created in Datagran, but linking it to this account failed. Reopen Data Integrations and reconnect this site.",
        pixelId: pixelData.id,
      },
      { status: 500 }
    );
  }

  // Return the pixel data including the write_key (shown only once!)
  return NextResponse.json({
    success: true,
    pixel: {
      id: pixelData.id,
      name: pixelData.name,
      writeKey: pixelData.write_key, // IMPORTANT: Only shown once!
      writeKeyPrefix: pixelData.write_key_prefix,
      allowedOrigins: pixelData.allowed_origins,
      status: pixelData.status,
    },
    agentId: agent.id,
  });
}
