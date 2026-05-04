import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import { createAgentTrace, ingestAgentTraceToDatagranBestEffort } from "@/lib/traces/agentTraces";

const CURSOR_API_BASE = "https://api.cursor.com/v0";

async function getCursorApiKey(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, agentId: string) {
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

// GET /api/cursor/agents - List agents from Cursor API
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
    const apiKey = await getCursorApiKey(supabase, agentId);

    const res = await fetch(`${CURSOR_API_BASE}/agents?limit=100`, {
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
      { error: e instanceof Error ? e.message : "Failed to list agents" },
      { status: 500 }
    );
  }
}

// POST /api/cursor/agents - Launch a new cloud agent
export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { agentId, prompt, repository, ref, autoCreatePr, branchName, model } = body;

  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }
  if (!prompt || typeof prompt !== "string") {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  if (!repository || typeof repository !== "string") {
    return NextResponse.json({ error: "repository is required" }, { status: 400 });
  }

  try {
    // Create a trace for the prompt (best-effort)
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
          model: typeof model === "string" ? model : null,
          prompt,
          metadata: {
            repository,
            ref: ref || "main",
            autoCreatePr: autoCreatePr === true,
            branchName: branchName || null,
          },
        });

        if (trace.traceId) {
          // Fire-and-forget: don't block response waiting for Datagran
          ingestAgentTraceToDatagranBestEffort(supabase, {
            userId: user.id,
            traceId: trace.traceId,
            createdAtIso: trace.createdAtIso,
            agentName: String(agentRow.name || "Cursor Agent"),
            agentType: String(agentRow.type || "cursor"),
            flagKey: (agentRow as unknown as { flag_key?: string | null }).flag_key || null,
            provider: "cursor",
            model: typeof model === "string" ? model : null,
            prompt,
            response: null,
            sessionId: null,
            metadata: {
              repository,
              ref: ref || "main",
              autoCreatePr: autoCreatePr === true,
              branchName: branchName || null,
            },
          });
        }
      }
    } catch {
      // ignore
    }

    const apiKey = await getCursorApiKey(supabase, agentId);

    const payload: Record<string, unknown> = {
      prompt: { text: prompt },
      source: {
        repository,
        ref: ref || "main",
      },
      target: {
        autoCreatePr: autoCreatePr === true,
        ...(branchName ? { branchName } : {}),
      },
    };

    if (model) {
      payload.model = model;
    }

    const res = await fetch(`${CURSOR_API_BASE}/agents`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(apiKey + ":").toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Cursor API error: ${res.status} ${text}` },
        { status: res.status }
      );
    }

    const cursorAgent = await res.json();

    // Store the task in our database
    const { error: insertError } = await supabase.from("cursor_agent_tasks").insert({
      agent_id: agentId,
      user_id: user.id,
      cursor_agent_id: cursorAgent.id,
      name: cursorAgent.name || null,
      status: cursorAgent.status || "CREATING",
      repository: cursorAgent.source?.repository || repository,
      branch: cursorAgent.source?.ref || ref || "main",
      branch_name: cursorAgent.target?.branchName || null,
      agent_url: cursorAgent.target?.url || null,
      prompt: prompt,
    });

    if (insertError) {
      console.error("Failed to store task:", insertError);
    }

    return NextResponse.json(cursorAgent);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to launch agent" },
      { status: 500 }
    );
  }
}
