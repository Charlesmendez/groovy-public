/**
 * Shared Code Agent run preparation.
 *
 * Builds the `claude_run` connector payload (Claude CLI or Codex CLI) plus the
 * signed billing block for a worker agent run. Used by:
 * - POST /api/claude-cli (browser path: the client forwards the payload to the
 *   connector over the relay websocket)
 * - the server-side agent task runner (headless path: the server executes the
 *   payload via the relay internal RPC)
 *
 * Extracted behavior-neutrally from src/app/api/claude-cli/route.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";
import { createCodeAgentUsageBillingToken } from "@/lib/billing/codeAgentUsageToken";
import { getOrCreateWorkspaceIdForUser } from "@/lib/billing/workspace";
import { preflightGroovyUsage } from "@/lib/billing/guard";
import { getProductAccessForUser } from "@/lib/licensing/access";
import {
  buildAssignedSkillsPromptContext,
  preflightAgentSkills,
} from "@/lib/skills-manager/service";
import { reasoningEffortsForModel } from "@/lib/ai/modelCatalog";

export const DEFAULT_CLAUDE_RUN_TIMEOUT_MS = 20 * 60 * 1000;

export type CodeCliProvider = "claude" | "codex";

export type CodeRunBilling = {
  billable: true;
  chargeType: "external_key_fee";
  provider: "anthropic" | "openai";
  codeCliProvider: CodeCliProvider;
  authMethod: "cli_token" | "api_key" | "local_codex_login";
  authOrigin: "user" | "local";
};

export type PrepareCodeRunParams = {
  supabase: SupabaseClient;
  userId: string;
  userEmail: string | null;
  agentId: string;
  prompt: string;
  sessionId?: string | null;
  timeoutMs?: number;
  planMode?: boolean;
  // CLI flag overrides (from slash commands / callers)
  model?: string | null;
  reasoningEffort?: string | null;
  allowedTools?: string | null;
  maxTurns?: number | null;
  systemPrompt?: string | null;
  permissionMode?: string | null;
  /** Raw cookie header. Empty/undefined for non-browser (headless) contexts. */
  cookie?: string;
  /** Billing preflight source bucket. */
  billingSource?: string;
};

export type PrepareCodeRunError = {
  ok: false;
  status: number;
  error: string;
  code?: string;
  billing?: {
    monthSpendUsd?: number | null;
    monthlyLimitUsd?: number | null;
    availableBalanceUsd?: number | null;
  };
};

export type PrepareCodeRunSuccess = {
  ok: true;
  deviceId: string | null;
  codeCliProvider: CodeCliProvider;
  requestId: string;
  billing: CodeRunBilling & { token: string };
  payload: Record<string, unknown>;
};

export type PrepareCodeRunResult = PrepareCodeRunSuccess | PrepareCodeRunError;

export async function prepareCodeRun(
  params: PrepareCodeRunParams
): Promise<PrepareCodeRunResult> {
  const {
    supabase,
    userId,
    userEmail,
    agentId,
    sessionId,
    planMode = false,
    allowedTools,
    maxTurns,
    systemPrompt,
    permissionMode,
    cookie = "",
    billingSource = "code_agent_cli",
  } = params;

  const prompt = params.prompt?.trim() || "";
  if (!agentId || !prompt) {
    return { ok: false, status: 400, error: "Missing agentId or prompt" };
  }

  const productAccess = await getProductAccessForUser({ userId }).catch(() => null);
  if (!productAccess?.hasAccess) {
    return {
      ok: false,
      status: 402,
      code:
        productAccess?.accessStatus === "trial_available"
          ? "trial_not_started"
          : "license_required",
      error:
        productAccess?.accessStatus === "trial_available"
          ? "Start your free 5-day trial to run agents."
          : "Your free trial has ended. Purchase a Groovy license to run agents.",
    };
  }

  const requestedTimeoutMs = params.timeoutMs ?? DEFAULT_CLAUDE_RUN_TIMEOUT_MS;
  const timeoutMs = Math.min(
    Math.max(1_000, Math.trunc(Number(requestedTimeoutMs) || DEFAULT_CLAUDE_RUN_TIMEOUT_MS)),
    DEFAULT_CLAUDE_RUN_TIMEOUT_MS
  );

  // Get agent config (device, workspace, provider, per-agent model override)
  const { data: agentConfig, error: configErr } = await supabase
    .from("claude_code_agent_configs")
    .select("device_id, workspace_id, code_cli_provider, model, reasoning_effort")
    .eq("agent_id", agentId)
    .eq("user_id", userId)
    .single();

  if (configErr || !agentConfig) {
    return { ok: false, status: 400, error: "Code session not configured" };
  }

  const codeCliProvider: CodeCliProvider =
    (agentConfig as { code_cli_provider?: string }).code_cli_provider === "codex"
      ? "codex"
      : "claude";

  // Explicit model (slash command / caller) beats the per-agent override.
  const configuredModel =
    typeof (agentConfig as { model?: unknown }).model === "string" &&
    (agentConfig as { model: string }).model.trim()
      ? (agentConfig as { model: string }).model.trim()
      : null;
  const model = params.model || configuredModel;
  const storedReasoningEffort =
    typeof (agentConfig as { reasoning_effort?: unknown }).reasoning_effort === "string"
      ? String((agentConfig as { reasoning_effort: string }).reasoning_effort).trim() || null
      : null;
  const supportedEfforts = reasoningEffortsForModel(model, "cli");
  const requestedReasoningEffort = params.reasoningEffort || storedReasoningEffort;
  const reasoningEffort =
    requestedReasoningEffort &&
    supportedEfforts.includes(requestedReasoningEffort as (typeof supportedEfforts)[number])
      ? requestedReasoningEffort
      : null;

  console.log("[prepareCodeRun] model settings", {
    agentId,
    codeCliProvider,
    configuredModel,
    requestedModel: params.model || null,
    resolvedModel: model,
    storedReasoningEffort,
    requestedReasoningEffort: params.reasoningEffort || null,
    resolvedReasoningEffort: reasoningEffort,
    supportedEfforts,
  });

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
      .eq("user_id", userId)
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
        "[prepareCodeRun] skills preflight failed:",
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
      "[prepareCodeRun] skills context unavailable:",
      error instanceof Error ? error.message : String(error)
    );
    return { text: "", artifactCount: 0 };
  });
  const effectivePrompt = skillsPromptContext.text
    ? `${skillsPromptContext.text}\n\n${prompt}`
    : prompt;

  // Resolve per-provider key modes for CLI token + API key
  const resolved = await resolveKeys(userId, supabase, cookie);

  const ensureUsageBillingAllowed = async (
    traceId: string
  ): Promise<PrepareCodeRunError | null> => {
    const billingWorkspaceId = await getOrCreateWorkspaceIdForUser({
      userId,
      email: userEmail || null,
    }).catch((e) => {
      console.warn(
        "[prepareCodeRun] getOrCreateWorkspaceIdForUser failed:",
        e instanceof Error ? e.message : String(e)
      );
      return null;
    });
    if (!billingWorkspaceId) return null;
    const preflight = await preflightGroovyUsage({
      workspaceId: billingWorkspaceId,
      userId,
      userEmail: userEmail || null,
      traceId,
      source: billingSource,
    });
    if (preflight.allowed) return null;
    return {
      ok: false,
      status: 402,
      error: preflight.message,
      code: preflight.reason,
      billing: {
        monthSpendUsd: preflight.monthSpendUsd,
        monthlyLimitUsd: preflight.monthlyLimitUsd,
        availableBalanceUsd: preflight.availableBalanceUsd,
      },
    };
  };

  if (codeCliProvider === "codex") {
    // Prefer the connector machine's Codex login when no explicit Codex
    // Headless key is configured. That preserves ChatGPT/Codex entitlements
    // such as gpt-5.5 and avoids forcing API-key auth through OPENAI_API_KEY.
    const codexApiKey = resolved.codexCliApiKey || null;
    const codexSource = codexApiKey ? "codex_cli_user" : "local_codex_login";
    console.log("[prepareCodeRun] codex auth resolved", {
      method: codexApiKey ? "api_key" : "local_codex_login",
      source: codexSource,
    });

    const requestId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const billing: CodeRunBilling = {
      billable: true,
      chargeType: "external_key_fee",
      provider: "openai",
      codeCliProvider: "codex",
      authMethod: codexApiKey ? "api_key" : "local_codex_login",
      authOrigin: codexApiKey ? "user" : "local",
    };
    const billingToken = createCodeAgentUsageBillingToken({
      userId,
      agentId,
      requestId,
      ...billing,
      issuedAt: Date.now(),
    });
    if (!billingToken) {
      return {
        ok: false,
        status: 500,
        error: "Billing usage signing is not configured.",
      };
    }
    const billingBlock = await ensureUsageBillingAllowed(requestId);
    if (billingBlock) return billingBlock;

    return {
      ok: true,
      deviceId: agentConfig.device_id ? String(agentConfig.device_id) : null,
      codeCliProvider,
      requestId,
      billing: { ...billing, token: billingToken },
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
    };
  }

  const useCliToken = !!resolved.claudeCliToken;
  const anthropicMode = resolved.keyModes.anthropic || resolved.globalMode;
  const apiKey = useCliToken
    ? null
    : anthropicMode === "user"
      ? (resolved.userKeys.anthropic || null)
      : null;

  console.log("[prepareCodeRun] auth resolved", {
    method: useCliToken ? "cli_token" : "api_key",
    source: useCliToken
      ? "user"
      : anthropicMode === "user"
        ? (resolved.userKeys.anthropic ? "user" : "missing")
        : "server_key_not_exposed",
  });

  if (!apiKey && !resolved.claudeCliToken) {
    return {
      ok: false,
      status: 400,
      error:
        anthropicMode === "user"
          ? "Missing Anthropic API key. Add it in Settings, or connect a Claude CLI token."
          : "Connector Claude runs require your own Anthropic API key or Claude CLI token. Groovy server keys are never sent to connectors.",
    };
  }

  const requestId = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const billing: CodeRunBilling = {
    billable: true,
    chargeType: "external_key_fee",
    provider: "anthropic",
    codeCliProvider: "claude",
    authMethod: useCliToken ? "cli_token" : "api_key",
    authOrigin: "user",
  };
  const billingToken = createCodeAgentUsageBillingToken({
    userId,
    agentId,
    requestId,
    ...billing,
    issuedAt: Date.now(),
  });
  if (!billingToken) {
    return {
      ok: false,
      status: 500,
      error: "Billing usage signing is not configured.",
    };
  }
  const billingBlock = await ensureUsageBillingAllowed(requestId);
  if (billingBlock) return billingBlock;

  return {
    ok: true,
    deviceId: agentConfig.device_id ? String(agentConfig.device_id) : null,
    codeCliProvider,
    requestId,
    billing: { ...billing, token: billingToken },
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
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(maxTurns ? { max_turns: maxTurns } : {}),
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
      ...(permissionMode ? { permission_mode: permissionMode } : {}),
    },
  };
}
