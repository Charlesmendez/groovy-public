import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";

const CURSOR_API_BASE = "https://api.cursor.com/v0";

async function getCursorApiKey(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  agentId: string
) {
  const { data: config } = await supabase
    .from("cursor_agent_configs")
    .select("cursor_api_key_enc")
    .eq("agent_id", agentId)
    .single();

  if (!config?.cursor_api_key_enc) {
    throw new Error("Cursor API key not configured");
  }

  return decryptLlmApiKey(config.cursor_api_key_enc);
}

// GET /api/cursor/agents/[id]/conversation - Get agent conversation history
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: cursorAgentId } = await params;
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
    const apiKey = await getCursorApiKey(supabase, agentId);

    const res = await fetch(`${CURSOR_API_BASE}/agents/${cursorAgentId}/conversation`, {
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

    const conversation = await res.json();
    return NextResponse.json(conversation);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to get conversation" },
      { status: 500 }
    );
  }
}
