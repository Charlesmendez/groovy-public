/**
 * Code Agent CLI API Route
 * Handles messages for Code Agent sessions via Claude or Codex CLI.
 * Resolves per-provider key modes and dispatches based on the agent's
 * configured code_cli_provider (claude or codex).
 *
 * Payload building lives in src/lib/claude/prepareCodeRun.ts (shared with the
 * server-side agent task runner).
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  prepareCodeRun,
  DEFAULT_CLAUDE_RUN_TIMEOUT_MS,
} from "@/lib/claude/prepareCodeRun";

type PostBody = {
  agentId: string;
  prompt: string;
  sessionId?: string;
  timeoutMs?: number;
  planMode?: boolean;
  // CLI flag overrides (from slash commands)
  model?: string;
  allowedTools?: string;
  maxTurns?: number;
  systemPrompt?: string;
  permissionMode?: string;
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
  if (!body || !body.agentId || !body.prompt?.trim()) {
    return NextResponse.json({ error: "Missing agentId or prompt" }, { status: 400 });
  }

  try {
    const result = await prepareCodeRun({
      supabase,
      userId: user.id,
      userEmail: user.email || null,
      agentId: body.agentId,
      prompt: body.prompt,
      sessionId: body.sessionId,
      timeoutMs: body.timeoutMs ?? DEFAULT_CLAUDE_RUN_TIMEOUT_MS,
      planMode: body.planMode ?? false,
      model: body.model,
      allowedTools: body.allowedTools,
      maxTurns: body.maxTurns,
      systemPrompt: body.systemPrompt,
      permissionMode: body.permissionMode,
      cookie: req.headers.get("cookie") || "",
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          ...(result.code ? { code: result.code } : {}),
          ...(result.billing ? { billing: result.billing } : {}),
        },
        { status: result.status }
      );
    }

    return NextResponse.json({
      ok: true,
      billing: result.billing,
      payload: result.payload,
    });
  } catch (e) {
    console.error("[claude-cli] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Server error" },
      { status: 500 }
    );
  }
}
