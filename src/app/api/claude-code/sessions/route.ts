import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type ClaudeCodeSession = {
  id: string;
  name: string;
  createdAt: string;
  workspaceId: string | undefined;
  workspaceRoot: string | undefined;
  codeCliProvider: "claude" | "codex";
};

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("claude_code_agent_configs")
      .select("agent_id, workspace_id, code_cli_provider, agents!inner(id, name, created_at), device_workspaces(root_path)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const sessions = (data || []).reduce<ClaudeCodeSession[]>((acc, row) => {
      const agent = row.agents as unknown as { id: string; name: string; created_at: string } | null;
      if (!agent) return acc;

      const workspace = row.device_workspaces as unknown as { root_path?: string } | null;
      const codeCliProvider =
        (row as { code_cli_provider?: unknown }).code_cli_provider === "codex"
          ? "codex"
          : "claude";
      acc.push({
        id: agent.id,
        name: agent.name,
        createdAt: agent.created_at,
        workspaceId: row.workspace_id ? String(row.workspace_id) : undefined,
        workspaceRoot: workspace?.root_path ? String(workspace.root_path) : undefined,
        codeCliProvider,
      });
      return acc;
    }, []);

    return NextResponse.json({ ok: true, sessions });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
