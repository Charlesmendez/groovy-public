import { NextResponse } from "next/server";
import crypto from "crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

type Body = {
  provider?: string; // defaults to whatsapp_web
  threadKey?: string;
  threadName?: string;
  command?: "new"; // start a new Claude Code session for this thread
  codeCwd?: string; // absolute repo/workspace path on the device
};

function requireString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

async function getOrCreateWorkspaceId(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  deviceId: string;
  rootPath: string;
  label?: string | null;
}): Promise<string> {
  const { supabase, userId, deviceId, rootPath, label } = opts;

  const { data: existing } = await supabase
    .from("device_workspaces")
    .select("id")
    .eq("user_id", userId)
    .eq("device_id", deviceId)
    .eq("root_path", rootPath)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: row, error } = await supabase
    .from("device_workspaces")
    .insert({
      user_id: userId,
      device_id: deviceId,
      label: label || "Workspace",
      root_path: rootPath,
      policy: {},
    })
    .select("id")
    .single();
  if (error || !row?.id) throw new Error(error?.message || "Failed to create workspace");
  return row.id as string;
}

async function getOrCreateClaudeCodeAgent(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  deviceId: string;
  provider: string;
  threadKey: string;
  threadName?: string | null;
  workspaceId: string;
  forceNew?: boolean;
}): Promise<{ agentId: string; terminalId: string }> {
  const { supabase, userId, deviceId, provider, threadKey, threadName, workspaceId, forceNew } = opts;

  if (!forceNew) {
    const { data: mapRow } = await supabase
      .from("claude_code_external_threads")
      .select("claude_code_agent_id")
      .eq("user_id", userId)
      .eq("provider", provider)
      .eq("thread_key", threadKey)
      .limit(1);
    const existing = Array.isArray(mapRow) ? mapRow[0] : null;
    const agentId = (existing as { claude_code_agent_id?: unknown } | null)?.claude_code_agent_id;
    if (typeof agentId === "string" && agentId) {
      const { data: cfg } = await supabase
        .from("claude_code_agent_configs")
        .select("terminal_id")
        .eq("agent_id", agentId)
        .maybeSingle();
      const terminalId = (cfg as { terminal_id?: unknown } | null)?.terminal_id;
      if (typeof terminalId === "string" && terminalId) return { agentId, terminalId };
      // If config is missing/partial, fall through and recreate session.
    }
  }

  const nowIso = new Date().toISOString();
  const suffix = new Date().toLocaleString();
  const name = threadName ? `WhatsApp Code: ${threadName} (${suffix})` : `WhatsApp Code (${suffix})`;
  const terminalId = crypto.randomUUID();

  const { data: agentRow, error: agentErr } = await supabase
    .from("agents")
    .insert({
      user_id: userId,
      type: "claude-code",
      name,
      flag_key: null,
      provider: null,
      model: null,
    })
    .select("id")
    .single();
  if (agentErr || !agentRow?.id) throw new Error(agentErr?.message || "Failed to create Claude Code agent");

  const agentId = agentRow.id as string;

  const { error: cfgErr } = await supabase.from("claude_code_agent_configs").insert({
    agent_id: agentId,
    user_id: userId,
    device_id: deviceId,
    workspace_id: workspaceId,
    terminal_id: terminalId,
  });
  if (cfgErr) {
    // Best-effort rollback (avoid orphan agent rows).
    await supabase.from("agents").delete().eq("id", agentId);
    throw new Error(cfgErr.message || "Failed to create Claude Code config");
  }

  await supabase
    .from("claude_code_external_threads")
    .upsert(
      {
        user_id: userId,
        provider,
        thread_key: threadKey,
        thread_name: threadName || null,
        claude_code_agent_id: agentId,
        updated_at: nowIso,
      },
      { onConflict: "user_id,provider,thread_key" }
    );

  return { agentId, terminalId };
}

export async function POST(req: Request) {
  const deviceToken = req.headers.get("x-device-token") || "";
  const relaySecret = process.env.RELAY_JWT_SECRET || "";
  const verified = verifyRelayDeviceToken(deviceToken, relaySecret);
  if (!verified) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const provider = requireString(body.provider) || "whatsapp_web";
  const threadKey = requireString(body.threadKey);
  if (!threadKey) return NextResponse.json({ error: "threadKey required" }, { status: 400 });
  const userScopedThreadKey = `${verified.userId}:${threadKey}`;

  const threadName = requireString(body.threadName);
  const command = body.command;

  const codeCwdRaw = requireString(body.codeCwd);
  if (!codeCwdRaw) {
    return NextResponse.json(
      { error: "codeCwd required (path to your repo/workspace on this device)" },
      { status: 400 }
    );
  }

  // Basic sanity: avoid obviously dangerous inputs; must be absolute-ish.
  const codeCwd = codeCwdRaw;
  if (!codeCwd.startsWith("/")) {
    return NextResponse.json({ error: "codeCwd must be an absolute path" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  const workspaceId = await getOrCreateWorkspaceId({
    supabase,
    userId: verified.userId,
    deviceId: verified.deviceId,
    rootPath: codeCwd,
    label: threadName ? `WhatsApp: ${threadName}` : "WhatsApp",
  });

  const forceNew = command === "new";
  const session = await getOrCreateClaudeCodeAgent({
    supabase,
    userId: verified.userId,
    deviceId: verified.deviceId,
    provider,
    threadKey: userScopedThreadKey,
    threadName,
    workspaceId,
    forceNew,
  });

  return NextResponse.json({
    ok: true,
    kind: forceNew ? "new_session" : "ready",
    provider,
    threadKey: userScopedThreadKey,
    threadName,
    agentId: session.agentId,
    terminalId: session.terminalId,
    workspaceId,
    workspaceRootPath: codeCwd,
  });
}

