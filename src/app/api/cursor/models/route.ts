import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";

const CURSOR_API_BASE = "https://api.cursor.com/v0";

// GET /api/cursor/models - List recommended models for cloud agents
export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get("agentId");

  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  try {
    const { data: config } = await supabase
      .from("cursor_agent_configs")
      .select("cursor_api_key_enc")
      .eq("agent_id", agentId)
      .single();

    if (!config?.cursor_api_key_enc) {
      return NextResponse.json({ error: "Cursor API key not configured" }, { status: 400 });
    }

    const apiKey = decryptLlmApiKey(config.cursor_api_key_enc);

    const res = await fetch(`${CURSOR_API_BASE}/models`, {
      headers: {
        Authorization: `Basic ${Buffer.from(apiKey + ":").toString("base64")}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Cursor API error: ${res.status} ${text}` },
        { status: res.status }
      );
    }

    const json = await res.json();
    return NextResponse.json(json);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to list models" },
      { status: 500 }
    );
  }
}
