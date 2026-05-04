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

// GET /api/cursor/agents/[id] - Get agent status
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

    const res = await fetch(`${CURSOR_API_BASE}/agents/${cursorAgentId}`, {
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

    const cursorAgent = await res.json();

    // Update our local task record
    await supabase
      .from("cursor_agent_tasks")
      .update({
        status: cursorAgent.status,
        name: cursorAgent.name || undefined,
        branch_name: cursorAgent.target?.branchName || undefined,
        pr_url: cursorAgent.target?.prUrl || undefined,
        agent_url: cursorAgent.target?.url || undefined,
        summary: cursorAgent.summary || undefined,
        updated_at: new Date().toISOString(),
      })
      .eq("cursor_agent_id", cursorAgentId)
      .eq("user_id", user.id);

    return NextResponse.json(cursorAgent);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to get agent status" },
      { status: 500 }
    );
  }
}

// DELETE /api/cursor/agents/[id] - Delete agent
export async function DELETE(
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

    const res = await fetch(`${CURSOR_API_BASE}/agents/${cursorAgentId}`, {
      method: "DELETE",
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

    // Delete from our database
    await supabase
      .from("cursor_agent_tasks")
      .delete()
      .eq("cursor_agent_id", cursorAgentId)
      .eq("user_id", user.id);

    return NextResponse.json({ id: cursorAgentId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to delete agent" },
      { status: 500 }
    );
  }
}
