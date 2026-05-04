import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";

type PostBody = {
  agentId: string;
  timeoutMs?: number;
};

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body?.agentId) {
    return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
  }

  const timeoutMs = Number.isFinite(Number(body.timeoutMs)) ? Number(body.timeoutMs) : 45_000;

  try {
    const { data: agentConfig, error: configErr } = await supabase
      .from("claude_code_agent_configs")
      .select("device_id, workspace_id")
      .eq("agent_id", body.agentId)
      .single();

    if (configErr || !agentConfig) {
      return NextResponse.json({ error: "Code session not configured" }, { status: 400 });
    }

    const workspaceId =
      typeof (agentConfig as { workspace_id?: unknown } | null)?.workspace_id === "string"
        ? String((agentConfig as { workspace_id: string }).workspace_id)
        : null;

    let rootPath = "";
    if (workspaceId) {
      const { data: workspace } = await supabase
        .from("device_workspaces")
        .select("root_path")
        .eq("id", workspaceId)
        .single();
      rootPath = workspace?.root_path ? String(workspace.root_path) : "";
    }

    const cookie = req.headers.get("cookie") || "";
    const resolved = await resolveKeys(user.id, supabase, cookie);

    const useCliToken = !!resolved.claudeCliToken;
    const anthropicMode = resolved.keyModes.anthropic || resolved.globalMode;
    const apiKey = useCliToken
      ? null
      : anthropicMode === "user"
        ? (resolved.userKeys.anthropic || null)
        : (process.env.ANTHROPIC_API_KEY || null);

    if (!apiKey && !resolved.claudeCliToken) {
      return NextResponse.json({
        error:
          anthropicMode === "user"
            ? "Missing Anthropic API key. Add it in Settings, or switch Anthropic to Groovy."
            : "No API key or CLI token configured. Add your Claude CLI token or configure Groovy Anthropic key on server.",
      }, { status: 400 });
    }

    const requestId = `claude-cmds-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log("[claude-cli/commands] prepared discovery payload", {
      agentId: body.agentId,
      requestId,
      deviceId: agentConfig.device_id,
      cwd: rootPath || null,
      authMethod: useCliToken ? "cli_token" : "api_key",
      timeoutMs,
    });

    return NextResponse.json({
      ok: true,
      payload: {
        type: "claude_discover_commands",
        request_id: requestId,
        device_id: agentConfig.device_id,
        cwd: rootPath,
        ...(useCliToken
          ? { cli_token: resolved.claudeCliToken }
          : { api_key: apiKey }),
        timeout_ms: timeoutMs,
      },
    });
  } catch (e) {
    console.error("[claude-cli/commands] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Server error" },
      { status: 500 }
    );
  }
}
