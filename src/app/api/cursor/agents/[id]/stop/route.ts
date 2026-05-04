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

// POST /api/cursor/agents/[id]/stop - Stop a running agent
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: cursorAgentId } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const agentId = body.agentId;

  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  try {
    const apiKey = await getCursorApiKey(supabase, agentId);

    const res = await fetch(`${CURSOR_API_BASE}/agents/${cursorAgentId}/stop`, {
      method: "POST",
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

    // Update our local task record
    await supabase
      .from("cursor_agent_tasks")
      .update({
        status: "STOPPED",
        updated_at: new Date().toISOString(),
      })
      .eq("cursor_agent_id", cursorAgentId)
      .eq("user_id", user.id);

    return NextResponse.json({ id: cursorAgentId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to stop agent" },
      { status: 500 }
    );
  }
}
