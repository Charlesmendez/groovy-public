/**
 * Code Agent CLI API Route
 * Handles messages for Code Agent sessions via Claude or Codex CLI.
 * Resolves per-provider key modes and dispatches based on the agent's
 * configured code_cli_provider (claude or codex).
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";
import { createCodeAgentUsageBillingToken } from "@/lib/billing/codeAgentUsageToken";
import { getOrCreateWorkspaceIdForUser } from "@/lib/billing/workspace";
import { preflightGroovyUsage } from "@/lib/billing/guard";
import {
  buildAssignedSkillsPromptContext,
  preflightAgentSkills,
} from "@/lib/skills-manager/service";

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

const DEFAULT_CLAUDE_RUN_TIMEOUT_MS = 10 * 60 * 1000;

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

  const {
    agentId, prompt, sessionId, timeoutMs = DEFAULT_CLAUDE_RUN_TIMEOUT_MS, planMode = false,
    model, allowedTools, maxTurns, systemPrompt, permissionMode,
  } = body;

  try {
    // Get agent config (device, workspace, provider)
    const { data: agentConfig, error: configErr } = await supabase
      .from("claude_code_agent_configs")
      .select("device_id, workspace_id, code_cli_provider")
      .eq("agent_id", agentId)
      .eq("user_id", user.id)
      .single();

    if (configErr || !agentConfig) {
      return NextResponse.json({ error: "Code session not configured" }, { status: 400 });
    }

    const codeCliProvider: "claude" | "codex" =
      (agentConfig as { code_cli_provider?: string }).code_cli_provider === "codex"
        ? "codex"
        : "claude";

    const workspaceId =
      typeof (agentConfig as { workspace_id?: unknown } | null)?.workspace_id === "string"
        ? String((agentConfig as { workspace_id: string }).workspace_id)
        : null;

    // Get workspace root path (optional). If missing, let connector default to $HOME.
    let rootPath = "";
    if (workspaceId) {
      const { data: workspace } = await supabase
        .from("device_workspaces")
        .select("root_path")
        .eq("id", workspaceId)
        .eq("user_id", user.id)
        .single();
      rootPath = workspace?.root_path ? String(workspace.root_path) : "";
    }

    if (agentConfig.device_id) {
      await preflightAgentSkills({
        deviceId: String(agentConfig.device_id),
        agentId,
        target: codeCliProvider,
      }).catch((error) => {
        console.warn(
          "[claude-cli] skills preflight failed:",
          error instanceof Error ? error.message : String(error)
        );
      });
    }

    const skillsPromptContext = await buildAssignedSkillsPromptContext({
      deviceId: String(agentConfig.device_id || ""),
      agentId,
      target: codeCliProvider,
    }).catch((error) => {
      console.warn(
        "[claude-cli] skills context unavailable:",
        error instanceof Error ? error.message : String(error)
      );
      return { text: "", artifactCount: 0 };
    });
    const effectivePrompt = skillsPromptContext.text
      ? `${skillsPromptContext.text}\n\n${prompt.trim()}`
      : prompt.trim();

    // Resolve per-provider key modes for CLI token + API key
    const cookie = req.headers.get("cookie") || "";
    const resolved = await resolveKeys(user.id, supabase, cookie);
    const ensureUsageBillingAllowed = async (traceId: string) => {
      const billingWorkspaceId = await getOrCreateWorkspaceIdForUser({
        userId: user.id,
        email: user.email || null,
      }).catch((e) => {
        console.warn(
          "[claude-cli] getOrCreateWorkspaceIdForUser failed:",
          e instanceof Error ? e.message : String(e)
        );
        return null;
      });
      if (!billingWorkspaceId) return null;
      const preflight = await preflightGroovyUsage({
        workspaceId: billingWorkspaceId,
        userId: user.id,
        userEmail: user.email || null,
        traceId,
        source: "code_agent_cli",
      });
      if (preflight.allowed) return null;
      return NextResponse.json(
        {
          error: preflight.message,
          code: preflight.reason,
          billing: {
            monthSpendUsd: preflight.monthSpendUsd,
            monthlyLimitUsd: preflight.monthlyLimitUsd,
            availableBalanceUsd: preflight.availableBalanceUsd,
          },
        },
        { status: 402 }
      );
    };

    if (codeCliProvider === "codex") {
      // Prefer the connector machine's Codex login when no explicit Codex
      // Headless key is configured. That preserves ChatGPT/Codex entitlements
      // such as gpt-5.5 and avoids forcing API-key auth through OPENAI_API_KEY.
      const codexApiKey = resolved.codexCliApiKey || null;
      const codexSource = codexApiKey ? "codex_cli_user" : "local_codex_login";
      console.log("[claude-cli] codex auth resolved", {
        method: codexApiKey ? "api_key" : "local_codex_login",
        source: codexSource,
      });

      const requestId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const billing = {
        billable: true,
        chargeType: "external_key_fee" as const,
        provider: "openai" as const,
        codeCliProvider: "codex" as const,
        authMethod: codexApiKey ? ("api_key" as const) : ("local_codex_login" as const),
        authOrigin: codexApiKey ? ("user" as const) : ("local" as const),
      };
      const billingToken = createCodeAgentUsageBillingToken({
        userId: user.id,
        agentId,
        requestId,
        ...billing,
        issuedAt: Date.now(),
      });
      if (!billingToken) {
        return NextResponse.json(
          { error: "Billing usage signing is not configured." },
          { status: 500 }
        );
      }
      const billingBlock = await ensureUsageBillingAllowed(requestId);
      if (billingBlock) return billingBlock;

      return NextResponse.json({
        ok: true,
        billing: {
          ...billing,
          token: billingToken,
        },
        payload: {
          type: "claude_run",
          provider: "codex",
          request_id: requestId,
          device_id: agentConfig.device_id,
          agent_id: agentId,
          prompt: effectivePrompt,
          cwd: rootPath,
          timeout_ms: timeoutMs,
          ...(codexApiKey ? { api_key: codexApiKey } : {}),
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(planMode ? { plan_mode: true } : {}),
          ...(model ? { model } : {}),
        },
      });
    }

    const useCliToken = !!resolved.claudeCliToken;
    const anthropicMode = resolved.keyModes.anthropic || resolved.globalMode;
    const apiKey = useCliToken
      ? null
      : anthropicMode === "user"
        ? (resolved.userKeys.anthropic || null)
        : null;

    console.log("[claude-cli] auth resolved", {
      method: useCliToken ? "cli_token" : "api_key",
      source: useCliToken
        ? "user"
        : anthropicMode === "user"
          ? (resolved.userKeys.anthropic ? "user" : "missing")
          : "server_key_not_exposed",
    });

    if (!apiKey && !resolved.claudeCliToken) {
      return NextResponse.json({
        error:
          anthropicMode === "user"
            ? "Missing Anthropic API key. Add it in Settings, or connect a Claude CLI token."
            : "Connector Claude runs require your own Anthropic API key or Claude CLI token. Groovy server keys are never sent to connectors.",
      }, { status: 400 });
    }

    const requestId = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const authOrigin = useCliToken
      ? ("user" as const)
      : ("user" as const);
    const billing = {
      billable: true,
      chargeType: "external_key_fee" as const,
      provider: "anthropic" as const,
      codeCliProvider: "claude" as const,
      authMethod: useCliToken ? ("cli_token" as const) : ("api_key" as const),
      authOrigin,
    };
    const billingToken = createCodeAgentUsageBillingToken({
      userId: user.id,
      agentId,
      requestId,
      ...billing,
      issuedAt: Date.now(),
    });
    if (!billingToken) {
      return NextResponse.json(
        { error: "Billing usage signing is not configured." },
        { status: 500 }
      );
    }
    const billingBlock = await ensureUsageBillingAllowed(requestId);
    if (billingBlock) return billingBlock;

    return NextResponse.json({
      ok: true,
      billing: {
        ...billing,
        token: billingToken,
      },
      payload: {
        type: "claude_run",
        provider: "claude",
        request_id: requestId,
        device_id: agentConfig.device_id,
        agent_id: agentId,
        prompt: effectivePrompt,
        cwd: rootPath,
        ...(useCliToken
          ? { cli_token: resolved.claudeCliToken }
          : { api_key: apiKey }),
        allowed_tools: allowedTools || "Read,Edit,Bash,Write",
        timeout_ms: timeoutMs,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(planMode ? { plan_mode: true } : {}),
        ...(model ? { model } : {}),
        ...(maxTurns ? { max_turns: maxTurns } : {}),
        ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
        ...(permissionMode ? { permission_mode: permissionMode } : {}),
      },
    });
  } catch (e) {
    console.error("[claude-cli] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Server error" },
      { status: 500 }
    );
  }
}
