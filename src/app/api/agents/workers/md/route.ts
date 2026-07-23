/**
 * Workspace instruction files (CLAUDE.md / AGENTS.md) for a worker agent.
 *
 * GET  ?agentId=..&filename=CLAUDE.md — read from the agent's workspace root
 * POST { agentId, filename, content } — write
 *
 * Executed on the agent's device over the relay internal RPC with a scoped
 * connector handler (workspace_md_read/write) — no generic file access.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { callConnectorRpcViaRelay } from "@/lib/relay/connectorRpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_FILENAMES = new Set(["CLAUDE.md", "AGENTS.md"]);

async function resolveAgentWorkspace(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
  agentId: string
): Promise<{ deviceId: string; rootPath: string } | { error: string; status: number }> {
  const { data: config } = await supabase
    .from("claude_code_agent_configs")
    .select("device_id, workspace_id")
    .eq("agent_id", agentId)
    .eq("user_id", userId)
    .maybeSingle();
  const deviceId =
    typeof (config as { device_id?: unknown } | null)?.device_id === "string"
      ? String((config as { device_id: string }).device_id)
      : "";
  const workspaceId =
    typeof (config as { workspace_id?: unknown } | null)?.workspace_id === "string"
      ? String((config as { workspace_id: string }).workspace_id)
      : "";
  if (!deviceId) return { error: "Agent has no device", status: 400 };
  if (!workspaceId) return { error: "Agent has no workspace folder", status: 400 };

  const { data: workspace } = await supabase
    .from("device_workspaces")
    .select("root_path")
    .eq("id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  const rootPath =
    typeof (workspace as { root_path?: unknown } | null)?.root_path === "string"
      ? String((workspace as { root_path: string }).root_path)
      : "";
  if (!rootPath) return { error: "Workspace root not found", status: 400 };
  return { deviceId, rootPath };
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId") || "";
  const filename = url.searchParams.get("filename") || "";
  if (!agentId || !ALLOWED_FILENAMES.has(filename)) {
    return NextResponse.json({ error: "Invalid agentId or filename" }, { status: 400 });
  }

  const resolved = await resolveAgentWorkspace(supabase, user.id, agentId);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  try {
    const result = await callConnectorRpcViaRelay({
      userId: user.id,
      deviceId: resolved.deviceId,
      rpcType: "workspace_md_read",
      payload: { workspace_root: resolved.rootPath, filename },
      timeoutMs: 30_000,
    });
    if (result.ok === false) {
      return NextResponse.json({ error: String(result.error || "read_failed") }, { status: 400 });
    }
    return NextResponse.json({
      exists: result.exists === true,
      content: typeof result.content === "string" ? result.content : "",
      path: result.path || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connector unavailable";
    return NextResponse.json(
      { error: message.includes("device_not_online") ? "Device is offline" : message },
      { status: 503 }
    );
  }
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    agentId?: string;
    filename?: string;
    content?: string;
  } | null;
  const agentId = typeof body?.agentId === "string" ? body.agentId : "";
  const filename = typeof body?.filename === "string" ? body.filename : "";
  if (!agentId || !ALLOWED_FILENAMES.has(filename)) {
    return NextResponse.json({ error: "Invalid agentId or filename" }, { status: 400 });
  }

  const resolved = await resolveAgentWorkspace(supabase, user.id, agentId);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  try {
    const result = await callConnectorRpcViaRelay({
      userId: user.id,
      deviceId: resolved.deviceId,
      rpcType: "workspace_md_write",
      payload: {
        workspace_root: resolved.rootPath,
        filename,
        content: typeof body?.content === "string" ? body.content : "",
      },
      timeoutMs: 30_000,
    });
    if (result.ok === false) {
      return NextResponse.json({ error: String(result.error || "write_failed") }, { status: 400 });
    }
    return NextResponse.json({ ok: true, path: result.path || null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connector unavailable";
    return NextResponse.json(
      { error: message.includes("device_not_online") ? "Device is offline" : message },
      { status: 503 }
    );
  }
}
