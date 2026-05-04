import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import { createAgentTrace, ingestAgentTraceToDatagranBestEffort } from "@/lib/traces/agentTraces";

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

// POST /api/cursor/agents/[id]/followup - Add follow-up instruction
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

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { agentId, prompt } = body;

  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }
  if (!prompt || typeof prompt !== "string") {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  try {
    // Best-effort trace of the followup instruction (response will be filled later by /api/cursor/sync)
    try {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id,name,type,flag_key")
        .eq("id", agentId)
        .single();

      if (agentRow?.id) {
        const trace = await createAgentTrace(supabase, {
          userId: user.id,
          agentId,
          sessionId: null,
          agentName: String(agentRow.name || "Cursor Agent"),
          agentType: String(agentRow.type || "cursor"),
          flagKey: (agentRow as unknown as { flag_key?: string | null }).flag_key || null,
          provider: "cursor",
          model: null,
          prompt,
          metadata: {
            cursor_agent_id: cursorAgentId,
            kind: "cursor_followup",
          },
        });

        if (trace.traceId) {
          ingestAgentTraceToDatagranBestEffort(supabase, {
            userId: user.id,
            traceId: trace.traceId,
            createdAtIso: trace.createdAtIso,
            agentName: String(agentRow.name || "Cursor Agent"),
            agentType: String(agentRow.type || "cursor"),
            flagKey: (agentRow as unknown as { flag_key?: string | null }).flag_key || null,
            provider: "cursor",
            model: null,
            prompt,
            response: null,
            sessionId: null,
            metadata: {
              cursor_agent_id: cursorAgentId,
              kind: "cursor_followup",
            },
          });
        }
      }
    } catch {
      // ignore
    }

    const apiKey = await getCursorApiKey(supabase, agentId);

    const res = await fetch(`${CURSOR_API_BASE}/agents/${cursorAgentId}/followup`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(apiKey + ":").toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: { text: prompt },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Cursor API error: ${res.status} ${text}` },
        { status: res.status }
      );
    }

    // Update task status to running
    await supabase
      .from("cursor_agent_tasks")
      .update({
        status: "RUNNING",
        updated_at: new Date().toISOString(),
      })
      .eq("cursor_agent_id", cursorAgentId)
      .eq("user_id", user.id);

    return NextResponse.json({ id: cursorAgentId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to add follow-up" },
      { status: 500 }
    );
  }
}
