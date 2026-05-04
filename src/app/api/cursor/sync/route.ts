import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import { completeAgentTrace, ingestAgentTraceToDatagranBestEffort } from "@/lib/traces/agentTraces";

const CURSOR_API_BASE = "https://api.cursor.com/v0";

// POST /api/cursor/sync - Sync local task states with Cursor API
export async function POST(req: Request) {
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

    // Get all tasks for this agent
    const { data: tasks } = await supabase
      .from("cursor_agent_tasks")
      .select("cursor_agent_id")
      .eq("agent_id", agentId)
      .eq("user_id", user.id);

    if (!tasks || tasks.length === 0) {
      return NextResponse.json({ synced: 0 });
    }

    // Fetch status for each task
    let synced = 0;
    for (const task of tasks) {
      try {
        const res = await fetch(`${CURSOR_API_BASE}/agents/${task.cursor_agent_id}`, {
          headers: {
            Authorization: `Basic ${Buffer.from(apiKey + ":").toString("base64")}`,
          },
        });

        if (res.ok) {
          const cursorAgent = await res.json();

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
            .eq("cursor_agent_id", task.cursor_agent_id)
            .eq("user_id", user.id);

          // If the agent produced a summary, attach it to the most recent pending trace for this Cursor agent
          // so it becomes searchable in Datagran memory.
          try {
            const summary = typeof cursorAgent.summary === "string" ? cursorAgent.summary.trim() : "";
            if (summary) {
              const { data: pendingTrace } = await supabase
                .from("agent_traces")
                .select(
                  "id, created_at, agent_name, agent_type, flag_key, provider, model, prompt, metadata"
                )
                .eq("user_id", user.id)
                .contains("metadata", { cursor_agent_id: task.cursor_agent_id })
                .is("response", null)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

              if (pendingTrace?.id) {
                const completedAtIso = new Date().toISOString();
                await completeAgentTrace(supabase, {
                  traceId: String(pendingTrace.id),
                  response: summary,
                  completedAtIso,
                });

                ingestAgentTraceToDatagranBestEffort(supabase, {
                  userId: user.id,
                  traceId: String(pendingTrace.id),
                  createdAtIso: String(pendingTrace.created_at || new Date().toISOString()),
                  agentName: String(pendingTrace.agent_name || "Cursor Agent"),
                  agentType: String(pendingTrace.agent_type || "cursor"),
                  flagKey: (pendingTrace as unknown as { flag_key?: string | null }).flag_key || null,
                  provider: String(pendingTrace.provider || "cursor"),
                  model: pendingTrace.model ? String(pendingTrace.model) : null,
                  sessionId: null,
                  prompt: String(pendingTrace.prompt || ""),
                  response: summary,
                  metadata: pendingTrace.metadata as Record<string, unknown>,
                });
              }
            }
          } catch {
            // ignore
          }

          synced++;
        }
      } catch {
        // Continue with other tasks
      }
    }

    return NextResponse.json({ synced });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to sync" },
      { status: 500 }
    );
  }
}
