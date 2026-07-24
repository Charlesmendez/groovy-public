/**
 * Tool Executor
 * Executes tools by routing to the appropriate service (connector, Datagran agents, etc.)
 * 
 * IMPORTANT: Data tools DELEGATE to specialized Datagran agents, not call APIs directly.
 * Each agent has its own specialized prompts and uses Claude Opus with code execution.
 */

import { toolToAgent, toolToConnectorMessage } from "./tools";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentType } from "./router";
import type { ConnectorClientPlatform } from "@/lib/connector/platform";
import { generateText, type ModelMessage } from "ai";
import { resolveChatModel, type ProviderId } from "@/lib/ai/modelResolver";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import { insertBillingUsageEventBestEffort } from "@/lib/billing/events";
import { preflightGroovyUsage, settleGroovyUsageDebitBestEffort } from "@/lib/billing/guard";
import { usageChargeTypeForKeyMode } from "@/lib/billing/pricing";
import { getUpreadyReadinessForFlowUser } from "@/lib/upready/client";
import { buildInternalRouteAuthHeaders } from "@/lib/internalRouteAuth";
import { getAppUrl } from "@/lib/config/appConfig";
import { inferScheduledWhatsAppDeliveryIntent } from "@/lib/scheduler/delivery";
import { inferProviderForModelId } from "@/lib/ai/modelCatalog";
import {
  channelScheduleSummary,
  parseTeamChatChannelId,
  publicChannelSchedule,
} from "@/lib/chat/channelSchedules";
import { ensureOrchestratorRuntimeAgentId } from "./runtimeAgents";
import { startParallelBranchRuntime } from "./parallelBranchRuntime";
import {
  coachAiyraTwilioChild,
  getAiyraTwilioChildStatus,
  startAiyraTwilioCall,
  startAiyraTwilioSms,
} from "@/lib/aiyra/twilio";
import {
  activateSkillDraft,
  createSkillDraft,
  createSkillValidationToken,
  listSkillRegistry,
  requestSkillDraftValidation,
  resolveSkillDraftVersion,
} from "./skillsRuntime";
import { executeExtensionRuntimeTool } from "@/lib/extensions/runtime";
import {
  toolPolicyDenialReason,
  toolPolicyParameterDenialReason,
  type ToolPolicyExecutionContext,
} from "@/lib/orchestrator/toolPolicy";
import type { HarnessProfile } from "@/lib/orchestrator/harnessProfiles";
import type { ExtensionRuntimeTool } from "@/lib/extensions/types";
import { loadIntegrationAssignments } from "@/lib/integrations/assignments";
import {
  sendTelegramText,
  sendTelegramPhoto,
  sendTelegramDocument,
  createTelegramForumTopic,
  getTelegramFileUrl,
  getTelegramFile,
} from "@/lib/telegram/client";

export type AgentActivity = {
  agentId: string;
  agentName: string;
  agentType: string;
  provider?: string;
  status: "starting" | "processing" | "complete" | "error";
  message?: string;
  result?: unknown;
  startedAt: string;
  completedAt?: string;
};

export type ToolExecutionContext = {
  userId: string;
  /** Owner of workspace-scoped integration credentials (distinct from actor). */
  integrationOwnerUserId?: string;
  /**
   * Security boundary for the active harness profile and source surface.
   * executeTool checks this before resolving extensions or dispatching to any
   * specialized executor.
   */
  toolPolicy?: ToolPolicyExecutionContext;
  /** Exact resolved profile inherited by nested/parallel orchestrator rounds. */
  harnessProfile?: HarnessProfile | null;
  traceId?: string;
  /** Shared turn cancellation signal. Executors must fail closed once aborted. */
  abortSignal?: AbortSignal;
  connectorPlatform?: ConnectorClientPlatform;
  // Stable id for the user "turn" across multi-round loops (used for billing aggregation)
  turnId?: string;
  // Workspace to bill usage under (optional; resolved by caller)
  billingWorkspaceId?: string | null;
  deviceId?: string | null;
  // Code mode (Claude Code PTY relay)
  codeTerminalId?: string | null;
  codeWorkspaceRootPath?: string | null;
  /**
   * Base URL (origin) for internal API calls (e.g. http://localhost:3001).
   * When available, prefer this over env vars so internal fetches work in dev
   * (where Next may not be on 3000) and in hosted environments.
   */
  appBaseUrl?: string;
  /**
   * Default Obsidian vault path to use when obsidian_* tools omit vault_path.
   * This is chosen client-side via vault discovery and sent with orchestrator requests.
   */
  obsidianVaultPath?: string | null;
  /**
   * Routing hint from the orchestrator. When present, tool definitions may be
   * restricted to match the user's explicit @ mention (e.g. @browser).
   */
  directAgent?: AgentType | null;
  // Relay send function for connector communication
  relaySend?: (msg: unknown) => void;
  // Callback when waiting for connector response
  onWaitingForConnector?: (toolName: string) => void;
  // Datagran connection ID for memory
  datagranConnectionId?: string | null;
  // Authed Supabase client (server-side route passes this in)
  supabase?: SupabaseClient;
  // Callback to emit agent activity events (for UI updates)
  onAgentActivity?: (activity: AgentActivity) => void;
  // User's API keys for external services
  apiKeys?: {
    anthropic?: string;
    openai?: string;
  };
  // Claude headless CLI OAuth token (from `claude setup-token`; uses CLAUDE_CODE_OAUTH_TOKEN)
  claudeCliToken?: string | null;
  // For forwarding auth to sub-agent calls
  cookies?: string;
  // Optional: device token for server-side sub-agent auth (WhatsApp mode)
  deviceToken?: string;
  // Optional: Telegram bot token for server-side Telegram tool execution
  telegramBotToken?: string;
  // Optional originating Aiyra conversation id when the turn came from a live runtime.
  sourceConversationId?: string | null;
  // Optional connector-local IANA timezone (e.g. America/New_York).
  localTimezone?: string;
  // True when invoked from scheduled job routes.
  scheduledMode?: boolean;
  // Optional soft deadline for one scheduled server round.
  scheduledHardDeadlineAtMs?: number;
  // Optional per-task timeout override for data_query (ms).
  scheduledDataQueryTimeoutMs?: number;
  // Files agent session info (for document creation requests)
  filesAgent?: {
    agentId: string;
    sessionId: string;
  } | null;
  // Stream tool output (for long-running tools like files_agent_request)
  onToolStream?: (data: { toolName: string; text: string }) => void;
  // Tool lifecycle notifications for lightweight progress UX (voice/connector, etc.)
  onToolEvent?: (data: {
    phase: "start" | "end";
    toolName: string;
    agent?: string;
    success?: boolean;
    error?: string;
  }) => void;
  // Available Claude Code sessions (claude-code agents) for UI open commands
  codeSessions?: Array<{ id: string; name: string }>;
  // Dynamically loaded enterprise extension tools available in this runtime.
  extensionToolsByName?: Record<string, ExtensionRuntimeTool>;
  // User's AI chat agents (for delegation)
  aiChatAgents?: Array<{ id: string; name: string; systemPrompt?: string }>;
  // Pixel names available to this runtime.
  webPixelNames?: string[];
  // Disable browser_task tool (for WhatsApp where it doesn't work)
  disableBrowserTask?: boolean;
  // When true, keep the normal full toolset but expose only browser_task
  // from the browser family so explicit "computer use / visible browser"
  // requests do not fall back to headless DOM tools.
  forceVisibleBrowserTask?: boolean;
  // Disable non-interactive terminal_exec when workflow should stay in code_cli_run only.
  disableTerminalExec?: boolean;
  // Orchestrator agent ID (agent-owned runtime and schedules).
  orchestratorAgentId?: string | null;
  // Branch-controller policy and current runtime branch stats.
  branchControllerMode?: "read_only" | "read_write";
  branchControllerMaxBranches?: number | null;
  branchControllerMaxTurnsPerBranch?: number | null;
  branchCurrentTurnCount?: number | null;
  branchActiveCount?: number | null;
  runtimeEpochId?: string | null;
  runtimeBranchId?: string | null;
  branchRole?: "main" | "worker";
  branchGoal?: string | null;
  // Orchestrator session ID (so scheduled jobs can be linked back to the session that created them)
  orchestratorSessionId?: string | null;
  // Notification targets for worker-agent tasks created this turn (assign_task).
  // Set by channel entrypoints (WhatsApp webhook, Telegram, dashboard).
  taskNotifyTargets?: import("@/lib/orchestrator/agentTasks").AgentTaskNotifyTargets;
  // Channel that requested this turn, recorded on created agent tasks.
  taskRequestedChannel?: string | null;
  // Handshake: active inter-agent communication session
  activeHandshakeId?: string | null;
  handshakePartnerSessionId?: string | null;
  handshakePartnerName?: string | null;
  // Runtime circuit-breaker for repeated data_query auth failures within one run.
  // When set, executors should avoid additional delegated data_query attempts.
  dataQueryReauthState?: {
    blocked: boolean;
    reason?:
      | "provider_reauth"
      | "session_unauthorized"
      | "non_retryable_error";
    provider?: string;
    agentId?: string;
    linkToken?: string;
    message?: string;
  };
};

const WRITE_LIKE_TOOLS = new Set<string>([
  "schedule_create",
  "schedule_pause",
  "schedule_resume",
  "schedule_cancel_next",
  "schedule_delete",
  "remember",
  "wiki_file_learning",
  "files_write",
  "files_delete",
  "files_move",
  "files_mkdir",
  "obsidian_write",
  "obsidian_daily",
  "whatsapp_send_text",
  "whatsapp_send_media",
  "terminal_exec",
  "code_cli_run",
  "browser_task",
  "site_publish",
  "site_attach_domain",
  "site_unpublish",
  "site_delete",
  "sqlite_exec",
  "linkdb_upsert_links",
  "linkdb_update",
  "skill_registry_create_draft",
  "skill_registry_validate_draft",
  "skill_registry_activate_draft",
  "assign_skill_or_doc",
  "remove_skill_or_doc_assignment",
]);

function isWriteLikeTool(toolName: string, context?: ToolExecutionContext): boolean {
  if (WRITE_LIKE_TOOLS.has(toolName)) return true;
  if (toolName === "skill_registry_list") return false;
  if (toolName.startsWith("skill_")) return true;
  if (toolName.startsWith("browser_")) return true;
  const extensionTool = context?.extensionToolsByName?.[toolName];
  if (extensionTool) return extensionTool.riskLevel !== "read";
  return false;
}

function applyBranchControllerGate(
  toolName: string,
  context: ToolExecutionContext
): { ok: true } | { ok: false; error: string } {
  const mode = context.branchControllerMode || "read_write";
  const isWriteLike = isWriteLikeTool(toolName, context);
  if (mode === "read_only" && isWriteLike) {
    return {
      ok: false,
      error:
        "Branch Controller blocked this operation: current branch mode is read_only. Switch to read_write to allow side effects.",
    };
  }

  return { ok: true };
}

function branchGateReason(error: string): "read_only" | "max_turns" | "max_branches" | "unknown" {
  const msg = String(error || "").toLowerCase();
  if (msg.includes("read_only")) return "read_only";
  if (msg.includes("max turns per branch")) return "max_turns";
  if (msg.includes("maxbranches")) return "max_branches";
  return "unknown";
}

async function recordBranchBudgetLimitHit(
  context: ToolExecutionContext,
  reason: "read_only" | "max_turns" | "max_branches" | "unknown"
) {
  if (!context.supabase) return;
  if (!context.runtimeBranchId) return;
  if (!context.userId) return;
  if (reason === "unknown") return;
  try {
    await context.supabase
      .from("orchestrator_branches")
      .update({
        budget_limit_hit: reason,
        budget_hit_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", context.runtimeBranchId)
      .eq("user_id", context.userId);
  } catch {
    // best-effort branch telemetry
  }
}

function parseConnectorEnvelope(value: unknown):
  | {
      __connector_execute__: true;
      type: string;
      params: Record<string, unknown>;
      toolName?: string;
      agent?: string;
      message?: string;
    }
  | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.__connector_execute__ !== true) return null;
  return {
    __connector_execute__: true,
    type: typeof record.type === "string" ? record.type : "",
    params:
      record.params && typeof record.params === "object" && !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : {},
    toolName: typeof record.toolName === "string" ? record.toolName : undefined,
    agent: typeof record.agent === "string" ? record.agent : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

function buildSkillValidationPrompt(args: {
  slug: string;
  source: string;
  stateJson: string;
  validationTask: string;
  token: string;
}): string {
  return [
    `Validate the reusable Groovy skill "${args.slug}".`,
    "",
    "SKILL SOURCE:",
    args.source,
    "",
    "CURRENT_SKILL_STATE_JSON:",
    args.stateJson,
    "",
    "VALIDATION TASK:",
    args.validationTask,
    "",
    "Run the skill exactly as intended.",
    `On the VERY LAST LINE, print exactly one marker: __SKILL_VALIDATION__:${args.token}:PASS`,
    `If validation fails, the VERY LAST LINE must be: __SKILL_VALIDATION__:${args.token}:FAIL:<short_reason>`,
    "Do not omit the marker.",
  ].join("\n");
}

function buildSkillValidationCommand(args: {
  source: string;
  validationTask: string;
  token: string;
}): string {
  return [
    "set +e",
    "TASK_FILE=$(mktemp)",
    "cat > \"$TASK_FILE\" <<'EOF'",
    args.validationTask,
    "EOF",
    "TASK_CONTENT=$(cat \"$TASK_FILE\")",
    "",
    "export SKILL_VALIDATION_TASK=\"$TASK_CONTENT\"",
    "",
    "# Skill source below. It may reference the validation task directly.",
    args.source,
    "",
    "STATUS=$?",
    `if [ "$STATUS" -eq 0 ]; then printf '\\n__SKILL_VALIDATION__:${args.token}:PASS\\n'; else printf '\\n__SKILL_VALIDATION__:${args.token}:FAIL:exit_%s\\n' "$STATUS"; fi`,
    "rm -f \"$TASK_FILE\"",
    "exit 0",
  ].join("\n");
}

async function executeRuntimeBranchTool(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  if (context.branchRole === "worker") {
    return {
      success: false,
      error: "Hidden worker branches cannot spawn additional runtime branches.",
      agent: "chat",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
  if (
    !context.supabase ||
    !context.orchestratorAgentId ||
    !context.runtimeEpochId ||
    !context.runtimeBranchId
  ) {
    return {
      success: false,
      error: "Runtime branch execution requires an active orchestrator branch context.",
      agent: "chat",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
  if (!context.deviceId) {
    return {
      success: false,
      error: "runtime_branch_parallel requires the local Groovy Connector to be online.",
      agent: "chat",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  const rawTasks = Array.isArray(params.tasks) ? params.tasks : [];
  const sharedContext =
    typeof params.shared_context === "string" && params.shared_context.trim()
      ? params.shared_context.trim()
      : typeof params.sharedContext === "string" && params.sharedContext.trim()
        ? params.sharedContext.trim()
        : "";
  const requestedTasks = rawTasks
    .map((task, index) => {
      if (!task || typeof task !== "object") return null;
      const record = task as Record<string, unknown>;
      const goal = typeof record.goal === "string" ? record.goal.trim() : "";
      if (!goal) return null;
      const title =
        typeof record.title === "string" && record.title.trim()
          ? record.title.trim()
          : `worker-${index + 1}`;
      return { title, goal };
    })
    .filter((task): task is { title: string; goal: string } => !!task);

  if (requestedTasks.length === 0) {
    return {
      success: false,
      error: "runtime_branch_parallel requires at least one non-empty task goal.",
      agent: "chat",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  try {
    return {
      success: true,
      result: {
        __connector_execute__: true,
        type: "runtime_branch_parallel_batch",
        params: await startParallelBranchRuntime({
          supabase: context.supabase,
          userId: context.userId,
          parentBranchId: context.runtimeBranchId,
          branchController: {
            mode: context.branchControllerMode || "read_write",
            maxBranches:
              Number.isFinite(Number(context.branchControllerMaxBranches)) &&
              Number(context.branchControllerMaxBranches) > 0
                ? Math.floor(Number(context.branchControllerMaxBranches))
                : 4,
            maxTurnsPerBranch:
              Number.isFinite(Number(context.branchControllerMaxTurnsPerBranch)) &&
              Number(context.branchControllerMaxTurnsPerBranch) > 0
                ? Math.floor(Number(context.branchControllerMaxTurnsPerBranch))
                : 8,
          },
          context: {
            orchestratorAgentId: context.orchestratorAgentId,
            orchestratorSessionId: context.orchestratorSessionId || null,
            epochId: context.runtimeEpochId,
            appBaseUrl: context.appBaseUrl,
            deviceId: context.deviceId,
            connectorPlatform: context.connectorPlatform,
            obsidianVaultPath: context.obsidianVaultPath || null,
            codeTerminalId: context.codeTerminalId || null,
            codeWorkspaceRootPath: context.codeWorkspaceRootPath || null,
            filesAgent: context.filesAgent || null,
            aiChatAgents: context.aiChatAgents,
            webPixelNames: context.webPixelNames,
            localTimezone: context.localTimezone,
            scheduledMode: context.scheduledMode === true,
            traceId: context.traceId,
            harnessProfile: context.harnessProfile,
          },
          tasks: requestedTasks,
          sharedContext,
          cookies: context.cookies,
          deviceToken: context.deviceToken || null,
        }),
        toolName,
        agent: "chat",
        message: "Running parallel branches on the local connector…",
      },
      agent: "chat",
      toolName,
      executionTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to start parallel branches.",
      agent: "chat",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
}

async function executeSkillRegistryTool(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  if (!context.supabase || !context.orchestratorAgentId) {
    return {
      success: false,
      error: "Skill registry tools require an orchestrator agent context.",
      agent: "code",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  try {
    if (toolName === "skill_registry_list") {
      const items = await listSkillRegistry({
        supabase: context.supabase,
        userId: context.userId,
        agentId: context.orchestratorAgentId,
      });
      return {
        success: true,
        result: {
          count: items.length,
          items,
        },
        agent: "code",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "skill_registry_create_draft") {
      const runner = params.runner;
      if (runner !== "code_cli_run" && runner !== "terminal_exec") {
        throw new Error("runner must be code_cli_run or terminal_exec");
      }
      const draft = await createSkillDraft({
        supabase: context.supabase,
        userId: context.userId,
        agentId: context.orchestratorAgentId,
        name: typeof params.name === "string" ? params.name : "",
        slug: typeof params.slug === "string" ? params.slug : null,
        description: typeof params.description === "string" ? params.description : null,
        runner,
        source: typeof params.source === "string" ? params.source : "",
        defaultState:
          params.default_state && typeof params.default_state === "object" && !Array.isArray(params.default_state)
            ? (params.default_state as Record<string, unknown>)
            : null,
      });
      return {
        success: true,
        result: {
          status: "draft_created",
          skill: draft,
          nextStep:
            context.deviceId
              ? "Call skill_registry_validate_draft with a concrete validation task before activating this skill."
              : "Draft created. Validation requires a connected local connector before this skill can be activated.",
        },
        agent: "code",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "skill_registry_validate_draft") {
      if (!context.deviceId) {
        throw new Error("A connected local connector is required to validate draft skills.");
      }
      const skillRef = typeof params.skill_ref === "string" ? params.skill_ref.trim() : "";
      const validationTask =
        typeof params.validation_task === "string" ? params.validation_task.trim() : "";
      if (!skillRef || !validationTask) {
        throw new Error("skill_ref and validation_task are required.");
      }

      const draft = await resolveSkillDraftVersion({
        supabase: context.supabase,
        userId: context.userId,
        agentId: context.orchestratorAgentId,
        skillRef,
      });
      if (!draft) {
        throw new Error(`Draft skill "${skillRef}" was not found.`);
      }

      const token = createSkillValidationToken();
      await requestSkillDraftValidation({
        supabase: context.supabase,
        userId: context.userId,
        agentId: context.orchestratorAgentId,
        versionId: draft.versionId,
        validationTask,
        token,
      });

      const timeoutMs =
        typeof params.timeout_ms === "number" && Number.isFinite(params.timeout_ms)
          ? Math.max(10_000, Math.floor(params.timeout_ms))
          : 120_000;
      const cwd =
        typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined;
      const stateJson = JSON.stringify(draft.defaultState || {});
      const renderedTerminalSource = draft.source.includes("{{task}}")
        ? draft.source
            .replaceAll("{{task}}", validationTask)
            .replaceAll("{{state_json}}", stateJson)
        : `${draft.source}\n# TASK\n${validationTask}`;

      const validationResult =
        draft.runner === "terminal_exec"
          ? await executeTool(
              "terminal_exec",
              {
                command: buildSkillValidationCommand({
                  source: renderedTerminalSource,
                  validationTask,
                  token,
                }),
                cwd,
                timeout_ms: timeoutMs,
              },
              context
            )
          : await executeTool(
              "code_cli_run",
              {
                prompt: buildSkillValidationPrompt({
                  slug: draft.slug,
                  source: draft.source,
                  stateJson,
                  validationTask,
                  token,
                }),
                cwd,
                timeout_ms: timeoutMs,
              },
              context
            );

      if (!validationResult.success) {
        return {
          success: false,
          error: validationResult.error || "Skill validation failed to start.",
          agent: "code",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      const connectorEnvelope = parseConnectorEnvelope(validationResult.result);
      if (connectorEnvelope) {
        return {
          success: true,
          result: {
            __connector_execute__: true,
            type: connectorEnvelope.type,
            params: connectorEnvelope.params,
            toolName,
            agent: "code",
            message: `Validating draft skill ${draft.slug}...`,
          },
          agent: "code",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      return {
        success: true,
        result: {
          status: "validation_finished",
          skill: {
            skillId: draft.skillId,
            versionId: draft.versionId,
            slug: draft.slug,
            runner: draft.runner,
            validationToken: token,
          },
          output: validationResult.result,
        },
        agent: "code",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "skill_registry_activate_draft") {
      const skillRef = typeof params.skill_ref === "string" ? params.skill_ref.trim() : "";
      const validationOutput =
        typeof params.validation_output === "string" ? params.validation_output : "";
      if (!skillRef || !validationOutput.trim()) {
        throw new Error("skill_ref and validation_output are required.");
      }
      const activated = await activateSkillDraft({
        supabase: context.supabase,
        userId: context.userId,
        agentId: context.orchestratorAgentId,
        skillRef,
        validationOutput,
      });
      return {
        success: true,
        result: {
          status: "activated",
          skill: activated,
          liveToolName: `skill_${activated.slug}`,
          note: "This skill is active for future turns.",
        },
        agent: "code",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Unknown skill registry tool: ${toolName}`,
      agent: "code",
      toolName,
      executionTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Skill registry tool failed.",
      agent: "code",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
}

export type ToolResult = {
  success: boolean;
  result?: unknown;
  error?: string;
  agent: string;
  toolName: string;
  executionTime: number;
  // Which sub-agent handled this (for UI activity display)
  delegatedTo?: {
    agentId: string;
    agentName: string;
    provider: string;
  };
};

function logEvent(
  context: ToolExecutionContext,
  event: string,
  details?: Record<string, unknown>
) {
  if (event === "tool_execute_start" || event === "tool_execute_end") {
    try {
      const toolName =
        details && typeof details.toolName === "string" ? details.toolName : "";
      if (toolName) {
        context.onToolEvent?.({
          phase: event === "tool_execute_start" ? "start" : "end",
          toolName,
          agent:
            details && typeof details.agent === "string" ? details.agent : undefined,
          success:
            details && typeof details.success === "boolean"
              ? details.success
              : undefined,
          error:
            details && typeof details.error === "string" && details.error.trim()
              ? details.error
              : undefined,
        });
      }
    } catch {
      // ignore tool event sink failures
    }
  }
  const base = {
    traceId: context.traceId,
    userId: context.userId,
    event,
    ...details,
  };
  console.log("[orchestrator-tool]", JSON.stringify(base));
}

function isClaudeCliOAuthToken(value: string): boolean {
  return value.trim().toLowerCase().startsWith("sk-ant-oat");
}

function isInvalidApiKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  const status =
    typeof e.statusCode === "number"
      ? e.statusCode
      : typeof e.status === "number"
        ? e.status
        : null;
  if (status !== 401 && status !== 403) return false;

  const msg = typeof e.message === "string" ? e.message : "";
  const body = typeof e.responseBody === "string" ? e.responseBody : "";
  const combined = `${msg}\n${body}`.toLowerCase();

  if (combined.includes("invalid x-api-key")) return true;
  if (combined.includes("authentication_error") && combined.includes("api")) return true;
  if (combined.includes("incorrect api key")) return true;
  if (combined.includes("invalid api key")) return true;

  return false;
}

const DATA_PROVIDER_REAUTH_CAPABLE = new Set([
  "facebook_ads",
  "facebook_leads",
  "instagram",
  "google_ads",
  "google_calendar",
  "gmail",
  "linkedin_ads",
  "google_drive",
  "tiktok",
  "salesforce",
]);

function supportsDataProviderReauth(provider: unknown): boolean {
  const normalized =
    typeof provider === "string" ? provider.trim().toLowerCase() : "";
  return DATA_PROVIDER_REAUTH_CAPABLE.has(normalized);
}

function mergeCookieHeader(
  currentCookieHeader: string | undefined,
  setCookieHeaders: string[]
): string | undefined {
  const jar = new Map<string, string>();
  const current = (currentCookieHeader || "").trim();
  if (current) {
    for (const pair of current.split(";")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!key) continue;
      jar.set(key, value);
    }
  }

  for (const setCookie of setCookieHeaders) {
    const firstPart = setCookie.split(";")[0] || "";
    const eqIdx = firstPart.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = firstPart.slice(0, eqIdx).trim();
    const value = firstPart.slice(eqIdx + 1).trim();
    if (!key) continue;
    jar.set(key, value);
  }

  if (jar.size === 0) return undefined;
  return Array.from(jar.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

function refreshContextCookiesFromResponse(
  context: ToolExecutionContext,
  response: Response
) {
  const headersWithGetSetCookie = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookieHeaders =
    typeof headersWithGetSetCookie.getSetCookie === "function"
      ? headersWithGetSetCookie.getSetCookie()
      : [];
  if (setCookieHeaders.length === 0) return;
  context.cookies = mergeCookieHeader(context.cookies, setCookieHeaders);
}

function hasGroovyProviderKey(provider: ProviderId): boolean {
  if (provider === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return !!process.env.OPENAI_API_KEY;
  if (provider === "google") {
    return (
      !!process.env.GEMINI_API_KEY ||
      !!process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      !!process.env.GOOGLE_API_KEY
    );
  }
  if (provider === "xai") return !!process.env.XAI_API_KEY;
  return false;
}

// Pending connector requests
const pendingRequests = new Map<
  string,
  {
    resolve: (result: ToolResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    toolName: string;
    startTime: number;
  }
>();

/**
 * Handle response from connector
 */
export function handleConnectorResponse(
  requestId: string,
  success: boolean,
  result?: unknown,
  error?: string
) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timeout);
  pendingRequests.delete(requestId);

  const executionTime = Date.now() - pending.startTime;

  if (success) {
    pending.resolve({
      success: true,
      result,
      agent: toolToAgent(pending.toolName) || "unknown",
      toolName: pending.toolName,
      executionTime,
    });
  } else {
    pending.resolve({
      success: false,
      error: error || "Unknown error",
      agent: toolToAgent(pending.toolName) || "unknown",
      toolName: pending.toolName,
      executionTime,
    });
  }
}

/**
 * Execute a tool call
 */
export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const startTime = Date.now();
  if (context.abortSignal?.aborted) {
    return {
      success: false,
      error: "This run was stopped by a team member.",
      agent: toolToAgent(toolName) || "unknown",
      toolName,
      executionTime: 0,
    };
  }
  const policyDenial =
    toolPolicyDenialReason(toolName, context.toolPolicy) ||
    toolPolicyParameterDenialReason(toolName, params, context.toolPolicy);
  if (policyDenial) {
    logEvent(context, "tool_policy_blocked", {
      toolName,
      profileId: context.toolPolicy?.profileId ?? null,
      surface: context.toolPolicy?.surface ?? null,
      provider: context.toolPolicy?.provider ?? null,
    });
    return {
      success: false,
      error: policyDenial,
      agent: toolToAgent(toolName) || "unknown",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
  const extensionTool = context.extensionToolsByName?.[toolName];
  const agent = extensionTool ? "extension" : toolToAgent(toolName);
  const gate = applyBranchControllerGate(toolName, context);
  if (!gate.ok) {
    const reason = branchGateReason(gate.error);
    await recordBranchBudgetLimitHit(context, reason);
    logEvent(context, "branch_controller_blocked", {
      toolName,
      agent,
      reason,
      mode: context.branchControllerMode || "read_write",
      maxBranches: context.branchControllerMaxBranches ?? null,
      maxTurnsPerBranch: context.branchControllerMaxTurnsPerBranch ?? null,
      branchCurrentTurnCount: context.branchCurrentTurnCount ?? null,
      branchActiveCount: context.branchActiveCount ?? null,
    });
    return {
      success: false,
      error: gate.error,
      agent: agent || "unknown",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
  logEvent(context, "tool_execute_start", {
    toolName,
    agent,
    params: truncateForLog(params),
  });

  if (extensionTool) {
    const r = await executeExtensionRuntimeTool({
      tool: extensionTool,
      params,
      context,
      startTime,
    });
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  if (toolName === "runtime_branch_parallel") {
    const r = await executeRuntimeBranchTool(toolName, params, context, startTime);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  // Worker-agent delegation tools (harness core)
  if (
    toolName === "list_agents" ||
    toolName === "list_skills_and_docs" ||
    toolName === "assign_skill_or_doc" ||
    toolName === "remove_skill_or_doc_assignment" ||
    toolName === "assign_task" ||
    toolName === "consult_agent" ||
    toolName === "finalize_plan" ||
    toolName === "check_agent_status" ||
    toolName === "collect_result" ||
    toolName === "transfer_context" ||
    toolName === "usage_report"
  ) {
    const { executeAgentDelegationTool } = await import(
      "@/lib/orchestrator/delegationToolExecutor"
    );
    const r = await executeAgentDelegationTool(toolName, params, context, startTime);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  if (toolName.startsWith("skill_registry_")) {
    const r = await executeSkillRegistryTool(toolName, params, context, startTime);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  // Handshake tools - server-side inter-agent communication
  if (agent === "handshake") {
    const r = await executeHandshakeTool(toolName, params, context, startTime);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  // Memory tools - handle directly
  if (agent === "memory") {
    const r = await executeMemoryTool(toolName, params, context, startTime);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  // Schedule tools - server-side CRUD for local scheduled jobs
  if (agent === "schedule") {
    const r = await executeScheduleTool(toolName, params, context, startTime);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  // Data tools - DELEGATE to specialized Datagran agents
  if (agent === "data") {
    const r = await executeDataToolViaDelegation(toolName, params, context, startTime);
    if (r.success) captureMediaRefsFromToolResult(context, r.result);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
      delegatedTo: r.delegatedTo,
    });
    return r;
  }

  // Browser task uses Claude Computer Use - handled specially
  if (toolName === "browser_task") {
    const r = await executeBrowserTask(toolName, params, context, startTime);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  // Files agent request - delegate to Files agent (cloud-based document creation)
  if (toolName === "files_agent_request") {
    const r = await executeFilesAgentRequest(toolName, params, context, startTime);
    if (r.success) captureMediaRefsFromToolResult(context, r.result);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  // AI agent delegate - call a user-configured AI chat agent
  if (toolName === "ai_agent_delegate") {
    const r = await executeAiAgentDelegate(toolName, params, context, startTime);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  // Site Builder server-side tools (call Vercel API directly, not via connector)
  if (toolName === "site_publish" || toolName === "site_attach_domain" || toolName === "site_verify_domain" || toolName === "site_delete" || toolName === "site_unpublish") {
    const r = await executeSiteServerTool(toolName, params, context, startTime);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  if (
    toolName === "start_twilio_call" ||
    toolName === "start_twilio_sms" ||
    toolName === "coach_twilio_child" ||
    toolName === "get_twilio_child_status"
  ) {
    const r = await executeTwilioTool(toolName, params, context, startTime);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  // Telegram tools - executed server-side (no connector needed)
  if (agent === "telegram") {
    const r = await executeTelegramTool(toolName, params, context, startTime);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  // Local tools (browser, files, pages, obsidian, code) - send to connector via relay
  if (
    agent === "browser" ||
    agent === "files" ||
    agent === "pages" ||
    agent === "obsidian" ||
    agent === "code"
  ) {
    const r = await executeConnectorTool(toolName, params, context, startTime);
    logEvent(context, "tool_execute_end", {
      toolName,
      agent: r.agent,
      success: r.success,
      executionTimeMs: r.executionTime,
      error: r.error,
    });
    return r;
  }

  const unknown: ToolResult = {
    success: false,
    error: `Unknown tool: ${toolName}`,
    agent: "unknown",
    toolName,
    executionTime: Date.now() - startTime,
  };
  logEvent(context, "tool_execute_end", {
    toolName,
    agent: "unknown",
    success: false,
    executionTimeMs: unknown.executionTime,
    error: unknown.error,
  });
  return unknown;
}

async function executeTwilioTool(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  const agent = "chat";
  if (!context.supabase) {
    return {
      success: false,
      error: "Supabase client unavailable in this context",
      agent,
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  const orchestratorSessionId = asNonEmptyString(context.orchestratorSessionId);
  if (!orchestratorSessionId) {
    return {
      success: false,
      error: "Twilio supervision requires an orchestrator session id",
      agent,
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  try {
    let result: Record<string, unknown>;
    if (toolName === "start_twilio_call") {
      result = await startAiyraTwilioCall({
        supabase: context.supabase,
        userId: context.userId,
        orchestratorSessionId,
        deviceId: asNonEmptyString(context.deviceId),
        sourceConversationId: asNonEmptyString(context.sourceConversationId),
        to: asNonEmptyString(params.to),
        from: asNonEmptyString(params.from),
        message: asNonEmptyString(params.message),
        lang: asNonEmptyString(params.lang),
      });
    } else if (toolName === "start_twilio_sms") {
      const message = asNonEmptyString(params.message);
      if (!message) {
        return {
          success: false,
          error: "start_twilio_sms requires a non-empty message",
          agent,
          toolName,
          executionTime: Date.now() - startTime,
        };
      }
      result = await startAiyraTwilioSms({
        supabase: context.supabase,
        userId: context.userId,
        orchestratorSessionId,
        deviceId: asNonEmptyString(context.deviceId),
        sourceConversationId: asNonEmptyString(context.sourceConversationId),
        to: asNonEmptyString(params.to),
        from: asNonEmptyString(params.from),
        message,
        lang: asNonEmptyString(params.lang),
      });
    } else if (toolName === "coach_twilio_child") {
      const message = asNonEmptyString(params.message);
      if (!message) {
        return {
          success: false,
          error: "coach_twilio_child requires a non-empty message",
          agent,
          toolName,
          executionTime: Date.now() - startTime,
        };
      }
      result = await coachAiyraTwilioChild({
        supabase: context.supabase,
        userId: context.userId,
        orchestratorSessionId,
        deviceId: asNonEmptyString(context.deviceId),
        sourceConversationId: asNonEmptyString(context.sourceConversationId),
        message,
      });
    } else {
      result = await getAiyraTwilioChildStatus({
        supabase: context.supabase,
        userId: context.userId,
        orchestratorSessionId,
        deviceId: asNonEmptyString(context.deviceId),
        sourceConversationId: asNonEmptyString(context.sourceConversationId),
      });
    }

    return {
      success: true,
      result,
      agent,
      toolName,
      executionTime: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      agent,
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
}

async function executeTelegramTool(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  const agent = "telegram";
  const botToken = context.telegramBotToken;
  if (!botToken) {
    return {
      success: false,
      error: "Telegram bot token not configured for this user",
      agent,
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
  if (!context.supabase) {
    return {
      success: false,
      error: "Supabase client unavailable in this context",
      agent,
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  try {
    if (toolName === "telegram_resolve_recipient") {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      const limit = typeof params.limit === "number" ? Math.min(params.limit, 20) : 5;
      if (!query) {
        return { success: false, error: "query is required", agent, toolName, executionTime: Date.now() - startTime };
      }
      const safeQuery = query.replace(/[%_,.()"'\\]/g, "");
      const [{ data: contacts }, { data: groups }] = await Promise.all([
        context.supabase
          .from("telegram_known_contacts")
          .select("telegram_user_id, telegram_username, first_name, last_name, dm_chat_id")
          .eq("user_id", context.userId)
          .or(
            `first_name.ilike.%${safeQuery}%,last_name.ilike.%${safeQuery}%,telegram_username.ilike.%${safeQuery}%`
          )
          .limit(limit),
        context.supabase
          .from("telegram_groups")
          .select("telegram_chat_id, group_name, is_forum")
          .eq("user_id", context.userId)
          .ilike("group_name", `%${safeQuery}%`)
          .limit(limit),
      ]);
      const results: Array<Record<string, unknown>> = [];
      if (Array.isArray(contacts)) {
        for (const c of contacts) {
          results.push({
            type: "contact",
            chatId: c.dm_chat_id ? String(c.dm_chat_id) : null,
            telegramUserId: String(c.telegram_user_id),
            username: c.telegram_username || null,
            name: [c.first_name, c.last_name].filter(Boolean).join(" "),
          });
        }
      }
      if (Array.isArray(groups)) {
        for (const g of groups) {
          results.push({
            type: "group",
            chatId: String(g.telegram_chat_id),
            name: g.group_name || null,
            isForum: g.is_forum || false,
          });
        }
      }
      return { success: true, result: { matches: results, total: results.length }, agent, toolName, executionTime: Date.now() - startTime };
    }

    if (toolName === "telegram_send_text") {
      const chatId = typeof params.chat_id === "string" ? params.chat_id.trim() : "";
      const text = typeof params.text === "string" ? params.text.trim() : "";
      const messageThreadId = typeof params.message_thread_id === "number" ? params.message_thread_id : undefined;
      if (!chatId || !text) {
        return { success: false, error: "chat_id and text are required", agent, toolName, executionTime: Date.now() - startTime };
      }
      const msg = await sendTelegramText({
        botToken,
        chatId: Number(chatId),
        text: text.slice(0, 4096),
        messageThreadId,
      });
      return { success: true, result: { messageId: msg.message_id, chatId }, agent, toolName, executionTime: Date.now() - startTime };
    }

    if (toolName === "telegram_send_media") {
      const chatId = typeof params.chat_id === "string" ? params.chat_id.trim() : "";
      const url = typeof params.url === "string" ? params.url.trim() : "";
      const storagePath = typeof params.storage_path === "string" ? params.storage_path.trim() : "";
      const fileId = typeof params.file_id === "string" ? params.file_id.trim() : "";
      const filename = typeof params.filename === "string" ? params.filename.trim() : "";
      const caption = typeof params.caption === "string" ? params.caption.trim() : undefined;
      const messageThreadId = typeof params.message_thread_id === "number" ? params.message_thread_id : undefined;
      if (!chatId) {
        return { success: false, error: "chat_id is required", agent, toolName, executionTime: Date.now() - startTime };
      }
      let resolvedUrl = url;
      if (!resolvedUrl && storagePath) {
        const { data: signedData } = await context.supabase.storage
          .from("chat_uploads")
          .createSignedUrl(storagePath, 3600);
        if (signedData?.signedUrl) resolvedUrl = signedData.signedUrl;
      }
      if (!resolvedUrl && fileId) {
        const fileInfo = await getTelegramFile(botToken, fileId);
        resolvedUrl = getTelegramFileUrl(botToken, fileInfo.file_path);
      }
      if (!resolvedUrl) {
        return { success: false, error: "One of url, storage_path, or file_id is required", agent, toolName, executionTime: Date.now() - startTime };
      }
      const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(filename || resolvedUrl);
      let msg;
      if (isImage) {
        msg = await sendTelegramPhoto({
          botToken,
          chatId: Number(chatId),
          photo: resolvedUrl,
          caption,
          messageThreadId,
        });
      } else {
        msg = await sendTelegramDocument({
          botToken,
          chatId: Number(chatId),
          document: resolvedUrl,
          filename: filename || undefined,
          caption,
          messageThreadId,
        });
      }
      return { success: true, result: { messageId: msg.message_id, chatId }, agent, toolName, executionTime: Date.now() - startTime };
    }

    if (toolName === "telegram_create_topic") {
      const chatId = typeof params.chat_id === "string" ? params.chat_id.trim() : "";
      const name = typeof params.name === "string" ? params.name.trim() : "";
      if (!chatId || !name) {
        return { success: false, error: "chat_id and name are required", agent, toolName, executionTime: Date.now() - startTime };
      }
      const topic = await createTelegramForumTopic({
        botToken,
        chatId: Number(chatId),
        name,
      });
      return { success: true, result: { messageThreadId: topic.message_thread_id, name: topic.name }, agent, toolName, executionTime: Date.now() - startTime };
    }

    return { success: false, error: `Unknown telegram tool: ${toolName}`, agent, toolName, executionTime: Date.now() - startTime };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      agent,
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
}

async function executeScheduleTool(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  if (!context.supabase) {
    return {
      success: false,
      error: "Supabase client unavailable in this context",
      agent: "schedule",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  const supabase = context.supabase;
  const userId = context.userId;
  const teamChatChannelId = parseTeamChatChannelId(
    context.taskRequestedChannel,
  );
  const channelSafeJob = (job: unknown): unknown => {
    if (!job || typeof job !== "object" || Array.isArray(job)) return job;
    const value = job as Record<string, unknown>;
    return {
      id: typeof value.id === "string" ? value.id : null,
      name:
        typeof value.name === "string"
          ? value.name.replace(/\s+/g, " ").trim().slice(0, 120)
          : "Scheduled task",
      kind: value.kind === "shell" ? "shell" : "orchestrator",
      summary: channelScheduleSummary({
        kind: value.kind,
        task: value.task,
      }),
      schedule: publicChannelSchedule(value.schedule),
      enabled: value.enabled === true,
      skip_next_run: value.skip_next_run === true,
      last_run_at:
        typeof value.last_run_at === "string" ? value.last_run_at : null,
      last_status:
        value.last_status === "success" ||
        value.last_status === "error" ||
        value.last_status === "skipped"
          ? value.last_status
          : null,
      updated_at:
        typeof value.updated_at === "string" ? value.updated_at : null,
    };
  };

  const resolveScheduleDeviceId = async (): Promise<string | null> => {
    // Prefer explicit request context first.
    const fromContext =
      typeof context.deviceId === "string" && context.deviceId.trim()
        ? context.deviceId.trim()
        : null;
    if (fromContext) return fromContext;

    // Fallback 1: connector device pinned in onboarding/user preferences.
    let preferredDeviceId: string | null = null;
    try {
      const { data: prefs } = await supabase
        .from("user_preferences")
        .select("onboarding_data")
        .eq("user_id", userId)
        .maybeSingle();
      const onboardingData =
        prefs?.onboarding_data && typeof prefs.onboarding_data === "object"
          ? (prefs.onboarding_data as Record<string, unknown>)
          : null;
      const rawPreferred =
        onboardingData && typeof onboardingData.connectorDeviceId === "string"
          ? onboardingData.connectorDeviceId.trim()
          : "";
      preferredDeviceId = rawPreferred || null;
    } catch {
      preferredDeviceId = null;
    }

    if (preferredDeviceId) {
      const { data: ownedPreferred } = await supabase
        .from("devices")
        .select("id")
        .eq("id", preferredDeviceId)
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();
      if (ownedPreferred?.id) return String(ownedPreferred.id);
    }

    // Fallback 2: most recently seen owned device (or most recently created if unseen).
    const { data: recentOwned } = await supabase
      .from("devices")
      .select("id")
      .eq("user_id", userId)
      .order("last_seen", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return recentOwned?.id ? String(recentOwned.id) : null;
  };

  const normalizeScheduledWhatsAppTargetValue = (raw: unknown): string => {
    if (typeof raw !== "string") return "";
    return raw.replace(/\s+/g, " ").trim().replace(/^['"`]+|['"`]+$/g, "").trim();
  };

  const isLikelyScheduledWhatsAppRecipientQuery = (raw: unknown): boolean => {
    const value = normalizeScheduledWhatsAppTargetValue(raw);
    if (!value || value.length < 2 || value.length > 96) return false;
    const lower = value.toLowerCase();
    if (
      lower === "whatsapp" ||
      lower === "whats app" ||
      lower === "group" ||
      lower === "chat" ||
      lower === "team" ||
      lower === "thread" ||
      lower === "channel" ||
      lower === "default group"
    ) {
      return false;
    }
    if (/^https?:\/\//i.test(value)) return false;
    return /[a-z]/i.test(value);
  };

  const extractScheduledWhatsAppRecipientQuery = (taskMessage: string): string => {
    const text = typeof taskMessage === "string" ? taskMessage : "";
    if (!text.trim()) return "";
    const patterns = [
      /(?:send|text|message|deliver|post|notify|share)[^.\n]{0,180}?\bto\b[^.\n]{0,20}?(?:"([^"\n]{2,96})"|'([^'\n]{2,96})'|`([^`\n]{2,96})`)\s+(?:on\s+)?(?:whatsapp|whats app|group|chat|team|thread|channel)\b/i,
      /(?:whatsapp|whats app)\s+(?:group|chat|team|thread|channel)\s+(?:named\s+)?(?:"([^"\n]{2,96})"|'([^'\n]{2,96})'|`([^`\n]{2,96})`)/i,
      /(?:send|text|message|deliver|post|notify|share)[^.\n]{0,180}?\bto\b\s+(?:the\s+)?([A-Z][A-Za-z0-9&().,'\/-]*(?:\s+[A-Za-z0-9&().,'\/-]+){0,6})\s+(?:on\s+)?(?:whatsapp|whats app|group|chat|team|thread|channel)\b/i,
      /(?:whatsapp|whats app)\s+(?:group|chat|team|thread|channel)\s+(?:named\s+)?([A-Z][A-Za-z0-9&().,'\/-]*(?:\s+[A-Za-z0-9&().,'\/-]+){0,6})/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      const candidate = normalizeScheduledWhatsAppTargetValue(
        match.slice(1).find((part) => typeof part === "string" && part.trim()) || ""
      );
      if (isLikelyScheduledWhatsAppRecipientQuery(candidate)) {
        return candidate;
      }
    }
    return "";
  };

  try {
    if (toolName === "schedule_create") {
      const deviceId = await resolveScheduleDeviceId();
      if (!deviceId) {
        return {
          success: false,
          error:
            "No paired connector device found for this account. Pair/start the Groovy Connector, then try scheduling again.",
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }
      const { data: ownedDevice, error: ownedDeviceErr } = await supabase
        .from("devices")
        .select("id")
        .eq("id", deviceId)
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();
      if (ownedDeviceErr) {
        return {
          success: false,
          error: `Failed to verify connector ownership: ${ownedDeviceErr.message}`,
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }
      if (!ownedDevice) {
        return {
          success: false,
          error:
            "The selected connector belongs to a different account. Re-pair the connector from this account and retry.",
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      const kind = typeof params.kind === "string" ? params.kind.trim() : "shell";
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const schedule = params.schedule as unknown;

      if (kind !== "shell" && kind !== "orchestrator") {
        return {
          success: false,
          error: `Invalid kind: ${kind}`,
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      const command =
        kind === "shell" && typeof params.command === "string" ? params.command.trim() : "";
      const cwd =
        kind === "shell" && typeof params.cwd === "string" && params.cwd.trim()
          ? params.cwd.trim()
          : null;
      const taskMessage =
        kind === "orchestrator" && typeof params.task === "string" ? params.task.trim() : "";
      const requiresWhatsAppDelivery =
        kind === "orchestrator" && taskMessage
          ? inferScheduledWhatsAppDeliveryIntent(taskMessage)
          : false;
      const scheduledWhatsAppRecipientQuery =
        kind === "orchestrator" && requiresWhatsAppDelivery && taskMessage
          ? extractScheduledWhatsAppRecipientQuery(taskMessage)
          : "";
      const scheduledModel =
        kind === "orchestrator" && typeof params.model === "string"
          ? params.model.trim()
          : "";
      const scheduledProvider = scheduledModel
        ? params.provider === "anthropic" || params.provider === "openai"
          ? params.provider
          : inferProviderForModelId(scheduledModel)
        : null;
      const scheduledReasoningEffort =
        scheduledModel && typeof params.reasoning_effort === "string"
          ? params.reasoning_effort.trim()
          : "";

      if (kind === "shell" && !command) {
        return {
          success: false,
          error: "Missing command for shell job",
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }
      if (kind === "orchestrator" && !taskMessage) {
        return {
          success: false,
          error: "Missing task for orchestrator job",
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      const explicitAgentId =
        typeof context.orchestratorAgentId === "string" && context.orchestratorAgentId.trim()
          ? context.orchestratorAgentId.trim()
          : null;
      const explicitSessionId =
        typeof context.orchestratorSessionId === "string" && context.orchestratorSessionId.trim()
          ? context.orchestratorSessionId.trim()
          : null;
      const resolvedAgentId =
        explicitAgentId || (await ensureOrchestratorRuntimeAgentId(supabase, userId));
      if (!resolvedAgentId) {
        return {
          success: false,
          error:
            "Failed to resolve schedule owner agent. Create/select an agent and retry scheduling.",
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      // Optional worker-agent target (Part B): the schedule runs on a specific
      // worker instead of an orchestrator round. Never for shell jobs.
      let targetAgentId: string | null = null;
      const workerRef =
        kind === "orchestrator" && typeof params.agent === "string" ? params.agent.trim() : "";
      if (workerRef) {
        const { resolveWorkerAgentByRef } = await import("@/lib/orchestrator/agentTasks");
        const resolvedWorker = await resolveWorkerAgentByRef(userId, workerRef);
        if (!resolvedWorker.ok) {
          return {
            success: false,
            error:
              resolvedWorker.error === "ambiguous"
                ? `Multiple worker agents match "${workerRef}": ${(resolvedWorker.candidates || []).join(", ")}. Use the exact name.`
                : `No worker agent named "${workerRef}". Omit the agent to schedule on the Orchestrator, or use list_agents for the roster.`,
            agent: "schedule",
            toolName,
            executionTime: Date.now() - startTime,
          };
        }
        if (!resolvedWorker.agent.deviceId) {
          return {
            success: false,
            error: `Worker agent "${resolvedWorker.agent.name}" has no connected device, so it cannot run scheduled tasks yet.`,
            agent: "schedule",
            toolName,
            executionTime: Date.now() - startTime,
          };
        }
        if (scheduledModel && scheduledProvider) {
          const expectedProvider =
            resolvedWorker.agent.harness === "codex" ? "openai" : "anthropic";
          if (scheduledProvider !== expectedProvider) {
            return {
              success: false,
              error: `Model "${scheduledModel}" uses ${scheduledProvider}, but worker "${resolvedWorker.agent.name}" runs ${resolvedWorker.agent.harness === "codex" ? "Codex" : "Claude Code"}. Choose a compatible model or omit model to use the worker default.`,
              agent: "schedule",
              toolName,
              executionTime: Date.now() - startTime,
            };
          }
        }
        targetAgentId = resolvedWorker.agent.id;
      }

      const insertPayload: Record<string, unknown> = {
        user_id: userId,
        device_id: deviceId,
        agent_id: resolvedAgentId,
        target_agent_id: targetAgentId,
        name: name || "Scheduled task",
        kind,
        command: kind === "shell" ? command : null,
        cwd,
        task:
          kind === "orchestrator"
            ? {
                message: taskMessage,
                orchestrator_agent_id: resolvedAgentId,
                ...(explicitSessionId
                  ? {
                      orchestrator_session_id: explicitSessionId,
                    }
                  : {}),
                ...(requiresWhatsAppDelivery || scheduledModel
                  ? {
                      options: {
                        ...(requiresWhatsAppDelivery
                          ? { requires_whatsapp_delivery: true }
                          : {}),
                        ...(requiresWhatsAppDelivery && scheduledWhatsAppRecipientQuery
                          ? {
                              whatsapp_recipient_query: scheduledWhatsAppRecipientQuery,
                            }
                          : {}),
                        ...(scheduledModel
                          ? {
                              model_name: scheduledModel,
                              model_provider: scheduledProvider,
                              ...(scheduledReasoningEffort
                                ? { reasoning_effort: scheduledReasoningEffort }
                                : {}),
                            }
                          : {}),
                      },
                    }
                  : {}),
              }
            : null,
        session_id: explicitSessionId,
        ...(teamChatChannelId ? { channel_id: teamChatChannelId } : {}),
        // A schedule created from a custom Mind stays bound to that exact
        // profile. Worker-targeted jobs use the worker's own harness instead.
        profile_id:
          kind === "orchestrator" && !targetAgentId
            ? context.harnessProfile?.id || null
            : null,
        schedule,
      };
      let insertResult = await supabase
        .from("scheduled_jobs")
        .insert(insertPayload)
        .select("*")
        .single();
      // Keep channel message delivery backward-compatible during the additive
      // migration rollout. The migration backfills this row through session_id.
      if (
        teamChatChannelId &&
        insertResult.error &&
        /channel_id|schema cache/i.test(insertResult.error.message || "")
      ) {
        delete insertPayload.channel_id;
        insertResult = await supabase
          .from("scheduled_jobs")
          .insert(insertPayload)
          .select("*")
          .single();
      }
      const { data, error } = insertResult;

      if (error) {
        const msg = error.message || "Failed to create schedule";
        // Supabase/PostgREST can return this when migrations haven't been applied yet
        // or when the schema cache hasn't reloaded.
        if (/Could not find the 'kind' column of 'scheduled_jobs'|schema cache/i.test(msg)) {
          return {
            success: false,
            error:
              "Scheduler v2 DB migration not applied (or schema cache not reloaded). Apply migration `20260126030000_scheduled_jobs_v2.sql` and reload PostgREST, then retry.",
            agent: "schedule",
            toolName,
            executionTime: Date.now() - startTime,
          };
        }
        if (/agent_id/i.test(msg)) {
          return {
            success: false,
            error:
              "Agent runtime migration not applied. Apply migration `20260228020000_agent_runtime_graph_and_branch_controller.sql` and retry scheduling.",
            agent: "schedule",
            toolName,
            executionTime: Date.now() - startTime,
          };
        }
        if (/profile_id/i.test(msg)) {
          return {
            success: false,
            error:
              "Harness profile migration not applied. Apply migration `20260723000000_orchestrator_profiles.sql` and retry scheduling.",
            agent: "schedule",
            toolName,
            executionTime: Date.now() - startTime,
          };
        }
        return {
          success: false,
          error: msg,
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      return {
        success: true,
        result: {
          ok: true,
          job: teamChatChannelId ? channelSafeJob(data) : data,
        },
        agent: "schedule",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "schedule_list") {
      const deviceFilter =
        typeof params.device_id === "string" && params.device_id.trim()
          ? params.device_id.trim()
          : null;
      const agentFilter =
        typeof params.agent_id === "string" && params.agent_id.trim()
          ? params.agent_id.trim()
          : null;

      let q = supabase
        .from("scheduled_jobs")
        .select(
          teamChatChannelId
            ? "id,name,kind,task,schedule,enabled,skip_next_run,last_run_at,last_status,updated_at"
            : "*",
        )
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(200);
      // Team Chat is a shared surface. Never expose the schedule owner's
      // unrelated personal jobs to channel participants.
      if (teamChatChannelId) q = q.eq("channel_id", teamChatChannelId);
      if (deviceFilter) q = q.eq("device_id", deviceFilter);
      if (agentFilter) q = q.eq("agent_id", agentFilter);

      const { data, error } = await q;
      if (error) {
        return {
          success: false,
          error: error.message || "Failed to list schedules",
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      return {
        success: true,
        result: {
          ok: true,
          jobs: teamChatChannelId
            ? (data || []).map((job) => channelSafeJob(job))
            : data || [],
        },
        agent: "schedule",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    const jobId = typeof params.job_id === "string" ? params.job_id.trim() : "";
    if (!jobId) {
      return {
        success: false,
        error: "Missing job_id",
        agent: "schedule",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "schedule_pause") {
      let q = supabase
        .from("scheduled_jobs")
        .update({ enabled: false, updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("user_id", userId);
      if (teamChatChannelId) q = q.eq("channel_id", teamChatChannelId);
      const { data, error } = await q.select("*").single();
      if (error) {
        return {
          success: false,
          error: error.message || "Failed to pause schedule",
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }
      return {
        success: true,
        result: {
          ok: true,
          job: teamChatChannelId ? channelSafeJob(data) : data,
        },
        agent: "schedule",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "schedule_resume") {
      let q = supabase
        .from("scheduled_jobs")
        .update({ enabled: true, updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("user_id", userId);
      if (teamChatChannelId) q = q.eq("channel_id", teamChatChannelId);
      const { data, error } = await q.select("*").single();
      if (error) {
        return {
          success: false,
          error: error.message || "Failed to resume schedule",
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }
      return {
        success: true,
        result: {
          ok: true,
          job: teamChatChannelId ? channelSafeJob(data) : data,
        },
        agent: "schedule",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "schedule_cancel_next") {
      let q = supabase
        .from("scheduled_jobs")
        .update({ skip_next_run: true, updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("user_id", userId);
      if (teamChatChannelId) q = q.eq("channel_id", teamChatChannelId);
      const { data, error } = await q.select("*").single();
      if (error) {
        return {
          success: false,
          error: error.message || "Failed to cancel next run",
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }
      return {
        success: true,
        result: {
          ok: true,
          job: teamChatChannelId ? channelSafeJob(data) : data,
        },
        agent: "schedule",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "schedule_delete") {
      let q = supabase
        .from("scheduled_jobs")
        .delete()
        .eq("id", jobId)
        .eq("user_id", userId);
      if (teamChatChannelId) q = q.eq("channel_id", teamChatChannelId);
      const { data, error } = await q.select("id").maybeSingle();
      if (error) {
        return {
          success: false,
          error: error.message || "Failed to delete schedule",
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }
      if (!data?.id) {
        return {
          success: false,
          error: "Scheduled job not found",
          agent: "schedule",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }
      return {
        success: true,
        result: { ok: true, deleted: true, job_id: data.id },
        agent: "schedule",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Unknown schedule tool: ${toolName}`,
      agent: "schedule",
      toolName,
      executionTime: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      agent: "schedule",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
}

/**
 * Execute semantic memory and structured Wiki tools.
 */
async function executeMemoryTool(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  const { 
    getGroovyMemoryConnection, 
    storeDurableLearning,
    queryMemoryDirect 
  } = await import("@/lib/memory/groovyMemory");
  const {
    fileLearningToWiki,
    readWikiKnowledge,
    searchWikiKnowledge,
  } = await import("@/lib/memory/wikiMemory");

  try {
    if (
      toolName === "wiki_search" ||
      toolName === "wiki_read" ||
      toolName === "wiki_file_learning"
    ) {
      if (!context.supabase) {
        return {
          success: false,
          error: "Wiki is not available in this runtime",
          agent: "memory",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      if (toolName === "wiki_search") {
        const matches = await searchWikiKnowledge(
          {
            supabase: context.supabase,
            userId: context.userId,
            profileId:
              context.toolPolicy?.memoryScope === "profile"
                ? context.toolPolicy.memoryScopeId || undefined
                : undefined,
          },
          String(params.query || ""),
          typeof params.limit === "number" ? params.limit : 5
        );
        return {
          success: true,
          result: { matches },
          agent: "memory",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      if (toolName === "wiki_read") {
        const file = await readWikiKnowledge(
          {
            supabase: context.supabase,
            userId: context.userId,
            profileId:
              context.toolPolicy?.memoryScope === "profile"
                ? context.toolPolicy.memoryScopeId || undefined
                : undefined,
          },
          String(params.path || "")
        );
        return {
          success: true,
          result: file,
          agent: "memory",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      const filed = await fileLearningToWiki({
        supabase: context.supabase,
        userId: context.userId,
        content: String(params.content || ""),
        label: typeof params.label === "string" ? params.label : undefined,
        source: "orchestrator wiki tool",
        target: {
          category:
            params.category === "entities" ||
            params.category === "concepts" ||
            params.category === "projects"
              ? params.category
              : undefined,
          page: typeof params.page === "string" ? params.page : undefined,
          title: typeof params.title === "string" ? params.title : undefined,
        },
        profileId:
          context.toolPolicy?.memoryScope === "profile"
            ? context.toolPolicy.memoryScopeId || undefined
            : undefined,
      });
      return {
        success: filed.filed || filed.reason === "duplicate",
        result: filed,
        error:
          !filed.filed && filed.reason !== "duplicate"
            ? filed.reason || "Failed to file Wiki learning"
            : undefined,
        agent: "memory",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "remember") {
      const content = params.content as string;
      const label = params.label as string | undefined;
      const connectionId =
        context.datagranConnectionId ||
        (await getGroovyMemoryConnection(
          context.userId,
          undefined,
          context.supabase,
          context.toolPolicy?.memoryScope === "profile"
            ? context.toolPolicy.memoryScopeId || undefined
            : undefined,
        ));
      const stored = await storeDurableLearning(connectionId || "", content, label, {
        wiki: context.supabase
          ? {
              supabase: context.supabase,
              userId: context.userId,
              source: "orchestrator remember tool",
              profileId:
                context.toolPolicy?.memoryScope === "profile"
                  ? context.toolPolicy.memoryScopeId || undefined
                  : undefined,
              target: {
                category:
                  params.wiki_category === "entities" ||
                  params.wiki_category === "concepts" ||
                  params.wiki_category === "projects"
                    ? params.wiki_category
                    : undefined,
                page:
                  typeof params.wiki_page === "string"
                    ? params.wiki_page
                    : undefined,
                title:
                  typeof params.wiki_title === "string"
                    ? params.wiki_title
                    : undefined,
              },
            }
          : undefined,
      });
      return {
        success: stored.stored,
        error: stored.stored
          ? undefined
          : stored.reason || "Failed to store in Datagran and Wiki",
        result: stored.stored
          ? {
              remembered: content,
              label,
              datagranStored: stored.datagranStored,
              wikiFiled: stored.wikiFiled,
              wikiPath: stored.wikiPath,
              wikiReason: stored.wikiReason,
            }
          : { error: stored.reason || "Failed to store in Datagran and Wiki" },
        agent: "memory",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "recall") {
      const rawQuery = params.query as string;
      const profileId =
        context.toolPolicy?.memoryScope === "profile"
          ? context.toolPolicy.memoryScopeId || undefined
          : undefined;
      const connectionId =
        context.datagranConnectionId ||
        (await getGroovyMemoryConnection(
          context.userId,
          undefined,
          context.supabase,
          profileId,
        ));
      if (!connectionId) {
        if (context.supabase) {
          const matches = await searchWikiKnowledge(
            {
              supabase: context.supabase,
              userId: context.userId,
              profileId,
            },
            rawQuery,
            8,
          );
          return {
            success: true,
            result: {
              context: matches
                .map((match) => `[${match.path}]\n${match.content}`)
                .join("\n\n"),
              data: null,
              source: "wiki",
              matches,
            },
            agent: "memory",
            toolName,
            executionTime: Date.now() - startTime,
          };
        }
        return {
          success: false,
          error: "Memory is not configured",
          agent: "memory",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }
      const query =
        context.toolPolicy?.memoryScope === "profile" && context.toolPolicy.memoryScopeId
          ? `Only use memories tagged [HARNESS_PROFILE:${context.toolPolicy.memoryScopeId}]. ${rawQuery}`
          : rawQuery;
      const memory = await queryMemoryDirect(connectionId, query);
      return {
        success: true,
        result: memory,
        agent: "memory",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Unknown memory tool: ${toolName}`,
      agent: "memory",
      toolName,
      executionTime: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Memory operation failed",
      agent: "memory",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
}

/**
 * Map tool provider to DB provider(s)
 */
function mapToolProviderToDbProviders(provider: string): string[] {
  switch (provider) {
    case "facebook":
      return ["facebook_ads", "facebook_leads"];
    case "tiktok":
      return ["tiktok", "tiktok_ads"];
    case "web_pixel":
      return ["web_pixel"];
    default:
      return [provider];
  }
}

/**
 * Execute data tools by DELEGATING to specialized Datagran agents.
 * Each agent has its own prompts, model, and capabilities.
 */
async function executeDataToolViaDelegation(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  const supabase = context.supabase;
  if (!supabase) {
    return {
      success: false,
      error: "Server misconfigured: Supabase client not available",
      agent: "data",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  try {
    if (toolName === "data_upready_readiness") {
      const daysRaw = params.days;
      const limitRaw = params.limit;
      const asInt = (value: unknown, fallback: number, min: number, max: number) => {
        const n = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(n)) return fallback;
        const i = Math.floor(n);
        if (i < min) return min;
        if (i > max) return max;
        return i;
      };
      const days = asInt(daysRaw, 30, 1, 120);
      const limit = asInt(limitRaw, 30, 1, 120);

      const readiness = await getUpreadyReadinessForFlowUser({
        supabase,
        flowUserId: context.userId,
        days,
        limit,
      });

      return {
        success: true,
        result: {
          connected: readiness.connected,
          upreadyUserId: readiness.upreadyUserId,
          upreadyEmail: readiness.upreadyEmail,
          days,
          points: readiness.points.map((p) => ({
            measured_at: p.measuredAt,
            score: p.score,
            load: p.load,
          })),
          summary: readiness.summary,
        },
        agent: "data",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "data_query") {
      const integrationOwnerUserId =
        context.integrationOwnerUserId || context.userId;
      const provider = params.provider as string;
      const query = params.query as string;
      const agentName = typeof params.agentName === "string" ? params.agentName.trim() : "";
      const pixelName = params.pixelName as string | undefined;

      logEvent(context, "data_query_delegating", {
        provider,
        query: query?.slice(0, 200),
        agentName: agentName || undefined,
        pixelName,
      });

      // Find user's Datagran agent for this provider
      const dbProviders = mapToolProviderToDbProviders(provider);
      
      const { data: configs, error: cfgErr } = await supabase
        .from("datagran_agent_configs")
        .select(
          "agent_id, provider, connection_id, updated_at, agents!datagran_agent_configs_agent_id_fkey(id, name, type)"
        )
        .eq("user_id", integrationOwnerUserId)
        .in("provider", dbProviders)
        .order("updated_at", { ascending: false })
        .limit(10);

      if (cfgErr) {
        logEvent(context, "data_query_config_error", { error: cfgErr.message });
        return {
          success: false,
          error: `Failed to find ${provider} agent: ${cfgErr.message}`,
          agent: "data",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      const allAgentConfigs = (configs || []).map((c: Record<string, unknown>) => {
        const connectionIdRaw = typeof c.connection_id === "string" ? c.connection_id : "";
        return {
          agentId: c.agent_id as string,
          provider: c.provider as string,
          connectionId: connectionIdRaw.trim(),
          agentName: ((c.agents as Record<string, unknown>)?.name as string) || "Data Agent",
          agentType: ((c.agents as Record<string, unknown>)?.type as string) || "datagran",
          updatedAt: c.updated_at as string,
        };
      });
      const assignmentState = await loadIntegrationAssignments({
        supabase,
        userId: integrationOwnerUserId,
        availableIntegrationIds: allAgentConfigs.map((agent) => agent.agentId),
        profileId: context.harnessProfile?.id || null,
      });
      const assignedIntegrationIds = new Set(assignmentState.assignments.orchestrator);
      const agentConfigs = allAgentConfigs.filter(
        (agent) =>
          agent.connectionId.length > 0 && assignedIntegrationIds.has(agent.agentId)
      );

      if (agentConfigs.length === 0) {
        const hasConfiguredAgent = allAgentConfigs.length > 0;
        const hasAssignedAgent = allAgentConfigs.some((agent) =>
          assignedIntegrationIds.has(agent.agentId)
        );
        return {
          success: false,
          error: hasConfiguredAgent && !hasAssignedAgent
            ? `No ${provider} integration is assigned to the orchestrator. Assign one in Settings → Integrations.`
            : hasConfiguredAgent
            ? `No active ${provider} connection found. Your agent exists but the connection is missing or invalid. Please reconnect ${provider} in the Data integrations panel.`
            : `No ${provider} agent configured. Please connect ${provider} in the Data integrations panel first.`,
          agent: "data",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      // For web_pixel, select by name if specified
      const availableAgents = agentConfigs.map((a) => ({
        id: a.agentId,
        name: a.agentName,
        provider: a.provider,
      }));
      const normalizeAgentSelector = (value: string) =>
        value.toLowerCase().replace(/\s+/g, " ").trim();

      let selectedAgent = agentConfigs[0];
      if (agentName) {
        const wanted = normalizeAgentSelector(agentName);
        const match = agentConfigs.find((a) => {
          const name = normalizeAgentSelector(a.agentName);
          const id = normalizeAgentSelector(a.agentId);
          return name === wanted || id === wanted || name.includes(wanted);
        });
        if (!match) {
          return {
            success: false,
            error: `No active ${provider} agent matched agentName "${agentName}".`,
            result: {
              provider,
              requestedAgentName: agentName,
              availableAgents,
            },
            agent: "data",
            toolName,
            executionTime: Date.now() - startTime,
          };
        }
        selectedAgent = match;
      } else if (provider === "web_pixel" && pixelName) {
        const match = agentConfigs.find(
          (a) => a.agentName.toLowerCase().includes(pixelName.toLowerCase())
        );
        if (match) selectedAgent = match;
      }

      logEvent(context, "data_query_agent_selected", {
        agentId: selectedAgent.agentId,
        agentName: selectedAgent.agentName,
        provider: selectedAgent.provider,
        availableAgents,
        agentNameRequested: agentName || undefined,
      });

      // Emit agent activity event for UI
      context.onAgentActivity?.({
        agentId: selectedAgent.agentId,
        agentName: selectedAgent.agentName,
        agentType: selectedAgent.agentType,
        provider: selectedAgent.provider,
        status: "starting",
        message: `Querying ${selectedAgent.agentName}...`,
        startedAt: new Date().toISOString(),
      });

      // Call the Datagran agent via internal API
      const baseUrl =
        context.appBaseUrl ||
        getAppUrl();
      const { data: delegatedSession, error: delegatedSessionErr } = await supabase
        .from("chat_sessions")
        .insert({
          user_id: context.userId,
          agent_id: selectedAgent.agentId,
          title: `Orchestrator data query: ${selectedAgent.agentName}`,
        })
        .select("id")
        .single();

      if (delegatedSessionErr || !delegatedSession?.id) {
        const msg =
          delegatedSessionErr?.message ||
          "Failed to create delegated data-agent chat session";
        logEvent(context, "data_query_session_create_error", {
          agentId: selectedAgent.agentId,
          agentName: selectedAgent.agentName,
          provider: selectedAgent.provider,
          error: msg,
        });
        return {
          success: false,
          error: msg,
          agent: "data",
          toolName,
          executionTime: Date.now() - startTime,
          delegatedTo: {
            agentId: selectedAgent.agentId,
            agentName: selectedAgent.agentName,
            provider: selectedAgent.provider,
          },
        };
      }

      const sessionId = String(delegatedSession.id);
      
      logEvent(context, "data_query_calling_agent", {
        agentId: selectedAgent.agentId,
        agentName: selectedAgent.agentName,
        sessionId,
        query: query?.slice(0, 200),
        baseUrl,
      });

      // Make internal call to /api/datagran/chat
      // Use AbortController so a stalled SSE stream doesn't block the orchestrator forever.
      // For scheduled runs, timeout is budget-aware: allow long calls when enough time remains,
      // but clamp to the round's remaining serverless budget.
      const configuredFromTask = Number(context.scheduledDataQueryTimeoutMs);
      const configuredFromEnv = Number(process.env.SCHEDULED_DATA_QUERY_TIMEOUT_MS);
      const defaultTimeoutMs = 5 * 60 * 1000;
      const requestedTimeoutMs = Number.isFinite(configuredFromTask)
        ? Math.trunc(configuredFromTask)
        : Number.isFinite(configuredFromEnv)
          ? Math.trunc(configuredFromEnv)
          : defaultTimeoutMs;
      let DATA_QUERY_TIMEOUT_MS = Math.max(30_000, Math.min(requestedTimeoutMs, 10 * 60 * 1000));
      if (
        context.scheduledMode &&
        typeof context.scheduledHardDeadlineAtMs === "number" &&
        Number.isFinite(context.scheduledHardDeadlineAtMs)
      ) {
        const guardRaw = Number(process.env.SCHEDULED_ROUND_GUARD_MS);
        const guardMs = Number.isFinite(guardRaw)
          ? Math.max(5_000, Math.min(Math.trunc(guardRaw), 120_000))
          : 15_000;
        const remainingBudgetMs = Math.trunc(context.scheduledHardDeadlineAtMs - Date.now() - guardMs);
        DATA_QUERY_TIMEOUT_MS = Math.max(
          30_000,
          Math.min(DATA_QUERY_TIMEOUT_MS, Math.max(remainingBudgetMs, 30_000))
        );
      }
      const chatUrl = `${baseUrl}/api/datagran/chat`;
      // This is a server-to-server call to our own route. Always include
      // internal auth so stale browser cookies cannot turn data_query into a
      // false 401 in long orchestrator runs. A valid device token still wins in
      // the target route when present.
      const internalAuthHeaders = buildInternalRouteAuthHeaders({
        userId: context.userId,
        scope: "datagran-chat",
      });
      const abortController = new AbortController();
      const abortTimeout = setTimeout(() => abortController.abort(), DATA_QUERY_TIMEOUT_MS);
      const abortFromTurn = () =>
        abortController.abort(
          context.abortSignal?.reason instanceof Error
            ? context.abortSignal.reason
            : new Error("orchestrator_run_aborted"),
        );
      if (context.abortSignal?.aborted) {
        abortFromTurn();
      } else {
        context.abortSignal?.addEventListener("abort", abortFromTurn, {
          once: true,
        });
      }
      const clearAbortGuards = () => {
        clearTimeout(abortTimeout);
        context.abortSignal?.removeEventListener("abort", abortFromTurn);
      };
      let response: Response;
      try {
        response = await fetch(chatUrl, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            "Content-Type": "application/json",
            // Forward cookies for auth
            ...(context.cookies ? { Cookie: context.cookies } : {}),
            // WhatsApp mode: forward device token so /api/datagran/chat can auth without cookies
            ...(context.deviceToken ? { "x-device-token": context.deviceToken } : {}),
            ...(context.localTimezone ? { "x-local-timezone": context.localTimezone } : {}),
            ...internalAuthHeaders,
          },
          body: JSON.stringify({
            agentId: selectedAgent.agentId,
            sessionId,
            turnId: context.turnId || undefined,
            orchestratorTraceId: context.traceId || undefined,
            messages: [{ role: "user", content: query }],
          }),
        });
        // Internal sub-agent routes can rotate Supabase cookies (refresh token exchange).
        // Keep context cookies current to avoid refresh_token_already_used on later calls.
        refreshContextCookiesFromResponse(context, response);
      } catch (err) {
        clearAbortGuards();
        const isAborted = abortController.signal.aborted;
        const msg = context.abortSignal?.aborted
          ? "data_query was stopped by a team member"
          : isAborted
          ? `data_query timed out after ${DATA_QUERY_TIMEOUT_MS / 1000}s`
          : err instanceof Error ? err.message : String(err);
        const cause =
          err && typeof err === "object" && "cause" in err
            ? (err as { cause?: unknown }).cause
            : undefined;
        const causeText =
          cause instanceof Error ? cause.message : cause ? String(cause) : "";

        logEvent(context, "data_query_agent_error", {
          agentId: selectedAgent.agentId,
          status: isAborted ? "timeout" : "fetch_failed",
          url: chatUrl,
          error: msg,
          cause: causeText,
        });

        return {
          success: false,
          error: `Internal fetch failed calling ${chatUrl}: ${msg}${
            causeText ? ` (cause: ${causeText})` : ""
          }. If you're in dev, Next may not be on :3000; we now use the request origin when available.`,
          agent: "data",
          toolName,
          executionTime: Date.now() - startTime,
          delegatedTo: {
            agentId: selectedAgent.agentId,
            agentName: selectedAgent.agentName,
            provider: selectedAgent.provider,
          },
        };
      }

      if (!response.ok) {
        clearAbortGuards();
        const errText = await response.text().catch(() => "Unknown error");
        const normalizedErr = errText.toLowerCase();
        const providerSupportsReauth = supportsDataProviderReauth(
          selectedAgent.provider
        );
        const isUnauthorized =
          response.status === 401 ||
          normalizedErr.includes("unauthorized") ||
          normalizedErr.includes("invalid refresh token") ||
          normalizedErr.includes("refresh_token_already_used");
        logEvent(context, "data_query_agent_error", {
          agentId: selectedAgent.agentId,
          status: response.status,
          error: errText.slice(0, 500),
        });

        context.onAgentActivity?.({
          agentId: selectedAgent.agentId,
          agentName: selectedAgent.agentName,
          agentType: selectedAgent.agentType,
          provider: selectedAgent.provider,
          status: "error",
          message: `Error: ${errText.slice(0, 200)}`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });

        const isPlainRouteUnauthorized =
          normalizedErr === '{"error":"unauthorized"}' ||
          normalizedErr === "unauthorized" ||
          normalizedErr.includes('"error":"unauthorized"');

        if (isUnauthorized && providerSupportsReauth && !isPlainRouteUnauthorized) {
          // Return structured reauth signal so the orchestrator can emit needs-reauth
          // and avoid retrying identical failing data_query calls.
          return {
            success: false,
            error: `${selectedAgent.agentName} requires re-authorization.`,
            result: {
              needsReauth: true,
              provider: selectedAgent.provider,
              agentId: selectedAgent.agentId,
            },
            agent: "data",
            toolName,
            executionTime: Date.now() - startTime,
            delegatedTo: {
              agentId: selectedAgent.agentId,
              agentName: selectedAgent.agentName,
              provider: selectedAgent.provider,
            },
          };
        }

        if (isUnauthorized) {
          // 401 on non-OAuth providers (e.g. postgres) is usually session/auth routing,
          // not a Datagran provider re-auth flow. Block further retries this run.
          return {
            success: false,
            error:
              "Data agent request was unauthorized (session/auth issue). This is not a provider re-auth flow.",
            result: {
              sessionUnauthorized: true,
              provider: selectedAgent.provider,
              agentId: selectedAgent.agentId,
              message:
                "Your app session appears unauthorized for data_query. Refresh/re-login, then retry.",
            },
            agent: "data",
            toolName,
            executionTime: Date.now() - startTime,
            delegatedTo: {
              agentId: selectedAgent.agentId,
              agentName: selectedAgent.agentName,
              provider: selectedAgent.provider,
            },
          };
        }

        return {
          success: false,
          error: `${selectedAgent.agentName} error: ${errText.slice(0, 500)}`,
          agent: "data",
          toolName,
          executionTime: Date.now() - startTime,
          delegatedTo: {
            agentId: selectedAgent.agentId,
            agentName: selectedAgent.agentName,
            provider: selectedAgent.provider,
          },
        };
      }

      // Parse SSE stream from agent
      const reader = response.body?.getReader();
      if (!reader) {
        return {
          success: false,
          error: "No response from agent",
          agent: "data",
          toolName,
          executionTime: Date.now() - startTime,
          delegatedTo: {
            agentId: selectedAgent.agentId,
            agentName: selectedAgent.agentName,
            provider: selectedAgent.provider,
          },
        };
      }

      const decoder = new TextDecoder();
      let fullText = "";
      const files: unknown[] = [];
      let lastStatus = "";
      let agentStreamError = "";
      let eventCount = 0;
      let textEventCount = 0;
      let sawDoneEvent = false;
      let needsReauthEvent: { provider: string; agentId: string; linkToken?: string; error?: string } | null = null;
      type DataQueryDoneDiagnostics = {
        apiErrors?: {
          total?: number;
          maxConsecutive?: number;
          consecutiveAtEnd?: number;
          circuitBreakerTriggered?: boolean;
          lastStatus?: number | null;
          sawNonRetryableApiError?: boolean;
          lastError?: string | null;
        };
        runPolicy?: {
          dataQueryRetryable?: boolean;
          reason?: string;
        };
      };
      let doneDiagnostics: DataQueryDoneDiagnostics | null = null;
      let runPolicySignal:
        | { dataQueryRetryable: boolean; reason?: string; message?: string }
        | null = null;
      let loggedFirstTextPreview = false;

      const buildNonRetryableResult = (reason: string, message: string): ToolResult => {
        console.warn(
          "[data_query_non_retryable_result]",
          JSON.stringify({
            traceId: context.traceId,
            provider: selectedAgent.provider,
            agentId: selectedAgent.agentId,
            reason,
            message,
            fullTextPreview: fullText.trim().slice(0, 300),
            diagnostics: doneDiagnostics || undefined,
          })
        );
        return {
          success: false,
          error: `${selectedAgent.agentName} encountered repeated non-retryable upstream API errors.`,
          result: {
            nonRetryable: true,
            retryable: false,
            reason,
            provider: selectedAgent.provider,
            agentId: selectedAgent.agentId,
            message,
            diagnostics: doneDiagnostics || undefined,
          },
          agent: "data",
          toolName,
          executionTime: Date.now() - startTime,
          delegatedTo: {
            agentId: selectedAgent.agentId,
            agentName: selectedAgent.agentName,
            provider: selectedAgent.provider,
          },
        };
      };

      // Read SSE events
      let buffer = "";
      try {
        while (true) {
          if (sawDoneEvent) break;
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              eventCount++;
              try {
                const event = JSON.parse(line.slice(6));
                if (event.type === "clear_text") {
                  // Agent started a new iteration — discard intermediate scaffolding
                  // so only the final response text is returned to the orchestrator.
                  fullText = "";
                  // Forward as a dedicated clear event so the orchestrator client resets.
                  context.onToolStream?.({
                    toolName: "__clear_text__",
                    text: "",
                  });
                } else if (event.type === "text") {
                  textEventCount++;
                  fullText += event.text;
                  if (!loggedFirstTextPreview && event.text.trim()) {
                    loggedFirstTextPreview = true;
                    console.log(
                      "[data_query_first_text]",
                      JSON.stringify({
                        traceId: context.traceId,
                        provider: selectedAgent.provider,
                        agentId: selectedAgent.agentId,
                        preview: event.text.trim().slice(0, 300),
                      })
                    );
                  }
                  // Stream text to orchestrator client in real-time
                  context.onToolStream?.({
                    toolName: "data_query",
                    text: event.text,
                  });
                  // Log every 20th text event to track progress without spamming
                  if (textEventCount % 20 === 1) {
                    logEvent(context, "data_query_agent_streaming", {
                      agentId: selectedAgent.agentId,
                      textEventCount,
                      totalTextLength: fullText.length,
                      lastChunk: event.text?.slice(0, 100),
                    });
                  }
                } else if (event.type === "status") {
                  lastStatus = event.text;
                  logEvent(context, "data_query_agent_status", {
                    agentId: selectedAgent.agentId,
                    status: lastStatus,
                  });
                  // Also stream status updates
                  context.onToolStream?.({
                    toolName: "data_query",
                    text: `\n[${lastStatus}]\n`,
                  });
                } else if (event.type === "file") {
                  files.push(event.file);
                  logEvent(context, "data_query_agent_file", {
                    agentId: selectedAgent.agentId,
                    file: event.file,
                  });
                } else if (event.type === "error") {
                  agentStreamError = String(event.error || "Unknown agent error");
                  logEvent(context, "data_query_agent_stream_error", {
                    agentId: selectedAgent.agentId,
                    error: agentStreamError,
                  });
                  // Surface error to the client stream immediately
                  context.onToolStream?.({
                    toolName: "data_query",
                    text: `\n[Error: ${agentStreamError}]\n`,
                  });
                } else if (event.type === "needs_reauth") {
                  // Connection requires re-authorization (OAuth token expired)
                  needsReauthEvent = {
                    provider: event.provider,
                    agentId: event.agentId,
                    linkToken: event.linkToken,
                    error: event.error,
                  };
                  logEvent(context, "data_query_needs_reauth", {
                    agentId: selectedAgent.agentId,
                    provider: event.provider,
                    hasLinkToken: !!event.linkToken,
                  });
                } else if (event.type === "run_policy") {
                  const retryable = event.dataQueryRetryable !== false;
                  runPolicySignal = {
                    dataQueryRetryable: retryable,
                    reason:
                      typeof event.reason === "string" ? event.reason : undefined,
                    message:
                      typeof event.message === "string" ? event.message : undefined,
                  };
                  doneDiagnostics = {
                    ...(doneDiagnostics || {}),
                    runPolicy: {
                      dataQueryRetryable: retryable,
                      reason:
                        typeof event.reason === "string" ? event.reason : undefined,
                    },
                    ...(event.apiErrors && typeof event.apiErrors === "object"
                      ? { apiErrors: event.apiErrors as DataQueryDoneDiagnostics["apiErrors"] }
                      : {}),
                  };
                  logEvent(context, "data_query_agent_run_policy", {
                    agentId: selectedAgent.agentId,
                    dataQueryRetryable: retryable,
                    reason:
                      typeof event.reason === "string" ? event.reason : undefined,
                  });
                } else if (event.type === "done") {
                  if (Array.isArray(event.files) && event.files.length > 0) {
                    // done.files is the authoritative final set; merge for safety.
                    for (const f of event.files) {
                      if (
                        !files.some(
                          (sf: unknown) => (sf as { file_id?: string }).file_id === f.file_id
                        )
                      ) {
                        files.push(f);
                      }
                    }
                  }
                  if (event.diagnostics && typeof event.diagnostics === "object") {
                    doneDiagnostics = event.diagnostics as DataQueryDoneDiagnostics;
                  }
                  sawDoneEvent = true;
                  logEvent(context, "data_query_agent_done_event", {
                    agentId: selectedAgent.agentId,
                    files: event.files,
                    containerId: event.containerId,
                    diagnostics: doneDiagnostics || undefined,
                  });
                }
              } catch (parseErr) {
                logEvent(context, "data_query_agent_parse_error", {
                  agentId: selectedAgent.agentId,
                  line: line.slice(0, 200),
                  error: String(parseErr),
                });
              }
              if (sawDoneEvent) break;
            }
          }
        }
      } catch (streamErr) {
        clearAbortGuards();
        if (abortController.signal.aborted && runPolicySignal?.dataQueryRetryable === false) {
          const reason = runPolicySignal.reason || "upstream_non_retryable_errors";
          const message =
            runPolicySignal.message ||
            "The delegated data agent reported repeated non-retryable upstream API errors before timeout. Do not retry the same data_query in this run.";
          return buildNonRetryableResult(reason, message);
        }
        throw streamErr;
      }

      // Safari-friendly: process any remaining buffer content after stream ends
      // (handles case where final SSE event doesn't end with newline)
      if (!sawDoneEvent && buffer.trim() && buffer.startsWith("data: ")) {
        eventCount++;
        try {
          const event = JSON.parse(buffer.slice(6));
          if (event.type === "text") {
            textEventCount++;
            fullText += event.text;
            context.onToolStream?.({
              toolName: "data_query",
              text: event.text,
            });
          } else if (event.type === "file") {
            files.push(event.file);
            logEvent(context, "data_query_agent_file_from_buffer", {
              agentId: selectedAgent.agentId,
              file: event.file,
            });
          } else if (event.type === "done") {
            if (Array.isArray(event.files) && event.files.length > 0) {
              // Merge any files from done event that weren't streamed individually
              for (const f of event.files) {
                if (!files.some((sf: unknown) => (sf as { file_id?: string }).file_id === f.file_id)) {
                  files.push(f);
                  logEvent(context, "data_query_agent_file_from_done_buffer", {
                    agentId: selectedAgent.agentId,
                    file: f,
                  });
                }
              }
            }
            if (event.diagnostics && typeof event.diagnostics === "object") {
              doneDiagnostics = event.diagnostics as DataQueryDoneDiagnostics;
            }
            sawDoneEvent = true;
          } else if (event.type === "run_policy") {
            const retryable = event.dataQueryRetryable !== false;
            runPolicySignal = {
              dataQueryRetryable: retryable,
              reason:
                typeof event.reason === "string" ? event.reason : undefined,
              message:
                typeof event.message === "string" ? event.message : undefined,
            };
            doneDiagnostics = {
              ...(doneDiagnostics || {}),
              runPolicy: {
                dataQueryRetryable: retryable,
                reason:
                  typeof event.reason === "string" ? event.reason : undefined,
              },
              ...(event.apiErrors && typeof event.apiErrors === "object"
                ? { apiErrors: event.apiErrors as DataQueryDoneDiagnostics["apiErrors"] }
                : {}),
            };
          } else if (event.type === "error") {
            agentStreamError = String(event.error || "Unknown agent error");
          } else if (event.type === "needs_reauth") {
            needsReauthEvent = {
              provider: event.provider,
              agentId: event.agentId,
              linkToken: event.linkToken,
              error: event.error,
            };
          }
        } catch (parseErr) {
          logEvent(context, "data_query_agent_buffer_parse_error", {
            agentId: selectedAgent.agentId,
            buffer: buffer.slice(0, 200),
            error: String(parseErr),
          });
        }
      }

      // We got an explicit terminal event; stop waiting for transport EOF.
      if (sawDoneEvent) {
        // Best-effort cancellation: do NOT await `reader.cancel()` (it can hang on some runtimes).
        // We already have the final payload from the explicit done event.
        try {
          abortController.abort();
        } catch {
          // ignore
        }
        try {
          void reader.cancel().catch(() => {});
        } catch {
          // ignore
        }
      }

      // SSE stream finished — clear the abort timeout.
      clearAbortGuards();

      // Handle re-authorization needed
      if (needsReauthEvent) {
        const providerLabel = needsReauthEvent.provider.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        return {
          success: false,
          error: `${providerLabel} connection requires re-authorization. The OAuth token may have expired or been revoked.`,
          result: {
            needsReauth: true,
            provider: needsReauthEvent.provider,
            agentId: needsReauthEvent.agentId,
            linkToken: needsReauthEvent.linkToken,
          },
          agent: "data",
          toolName,
          executionTime: Date.now() - startTime,
          delegatedTo: {
            agentId: selectedAgent.agentId,
            agentName: selectedAgent.agentName,
            provider: selectedAgent.provider,
          },
        };
      }

      logEvent(context, "data_query_agent_stream_complete", {
        agentId: selectedAgent.agentId,
        totalEvents: eventCount,
        textEvents: textEventCount,
        totalTextLength: fullText.length,
        filesCount: files.length,
        hadError: !!agentStreamError,
        diagnostics: doneDiagnostics || undefined,
      });

      // If the agent emitted an error event, treat this as a tool failure (even if HTTP was 200).
      if (agentStreamError) {
        return {
          success: false,
          error: `${selectedAgent.agentName} error: ${agentStreamError}`,
          agent: "data",
          toolName,
          executionTime: Date.now() - startTime,
          delegatedTo: {
            agentId: selectedAgent.agentId,
            agentName: selectedAgent.agentName,
            provider: selectedAgent.provider,
          },
        };
      }

      const nonRetryableUpstreamFailure =
        runPolicySignal?.dataQueryRetryable === false ||
        doneDiagnostics?.runPolicy?.dataQueryRetryable === false ||
        (doneDiagnostics?.apiErrors?.circuitBreakerTriggered === true &&
          doneDiagnostics?.apiErrors?.sawNonRetryableApiError === true);
      if (nonRetryableUpstreamFailure) {
        const reason =
          runPolicySignal?.reason ||
          doneDiagnostics?.runPolicy?.reason ||
          "upstream_non_retryable_errors";
        const message =
          runPolicySignal?.message ||
          "The delegated data agent encountered repeated non-retryable upstream API errors and triggered its circuit breaker. Do not retry data_query with the same provider/query in this run.";
        return buildNonRetryableResult(reason, message);
      }

      // If we got no text and no files, something went wrong (e.g. agent crashed before emitting text).
      if (!fullText.trim() && files.length === 0) {
        const hint = lastStatus ? ` Last status: ${lastStatus}` : "";
        return {
          success: false,
          error: `${selectedAgent.agentName} returned no output.${hint}`,
          agent: "data",
          toolName,
          executionTime: Date.now() - startTime,
          delegatedTo: {
            agentId: selectedAgent.agentId,
            agentName: selectedAgent.agentName,
            provider: selectedAgent.provider,
          },
        };
      }

      logEvent(context, "data_query_agent_complete", {
        agentId: selectedAgent.agentId,
        agentName: selectedAgent.agentName,
        responseLength: fullText.length,
        filesCount: files.length,
        responsePreview: fullText.slice(0, 300),
      });

      context.onAgentActivity?.({
        agentId: selectedAgent.agentId,
        agentName: selectedAgent.agentName,
        agentType: selectedAgent.agentType,
        provider: selectedAgent.provider,
        status: "complete",
        message: fullText.slice(0, 200) + (fullText.length > 200 ? "..." : ""),
        result: { text: fullText, files },
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      return {
        success: true,
        result: {
          agentResponse: fullText,
          // IMPORTANT:
          // - The dashboard needs URL/storage_path-based files to render clickable downloads.
          // Keep files URL-based. Do NOT inline base64 here; it can blow model context windows.
          files: files.length > 0 ? files : undefined,
          fromAgent: selectedAgent.agentName,
          queriedAgent: {
            agentId: selectedAgent.agentId,
            agentName: selectedAgent.agentName,
            provider: selectedAgent.provider,
          },
          availableAgents,
          coverage:
            agentConfigs.length > 1 && !agentName
              ? {
                  queriedCount: 1,
                  totalActiveConnections: agentConfigs.length,
                  warning: `Only queried ${selectedAgent.agentName}. Query each active ${provider} agent by agentName before claiming all accounts were checked.`,
                }
              : {
                  queriedCount: 1,
                  totalActiveConnections: agentConfigs.length,
                },
        },
        agent: "data",
        toolName,
        executionTime: Date.now() - startTime,
        delegatedTo: {
          agentId: selectedAgent.agentId,
          agentName: selectedAgent.agentName,
          provider: selectedAgent.provider,
        },
      };
    }

    if (toolName === "data_check_connection") {
      const integrationOwnerUserId =
        context.integrationOwnerUserId || context.userId;
      const provider = params.provider as string;
      const dbProviders = mapToolProviderToDbProviders(provider);

      const { data: rows, error } = await supabase
        .from("datagran_agent_configs")
        .select("agent_id, provider, connection_id, agents!datagran_agent_configs_agent_id_fkey(name)")
        .eq("user_id", integrationOwnerUserId)
        .in("provider", dbProviders)
        .limit(10);

      if (error) {
        return {
          success: true,
          result: { connected: false, error: error.message },
          agent: "data",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      const normalizedAgents = (rows || []).map((r: Record<string, unknown>) => ({
        agentId: r.agent_id,
        name: ((r.agents as Record<string, unknown>)?.name as string) || "Data Agent",
        provider: r.provider,
        hasConnection:
          typeof r.connection_id === "string" && r.connection_id.trim().length > 0,
      }));
      const assignmentState = await loadIntegrationAssignments({
        supabase,
        userId: integrationOwnerUserId,
        availableIntegrationIds: normalizedAgents.map((agent) => String(agent.agentId || "")),
        profileId: context.harnessProfile?.id || null,
      });
      const assignedIntegrationIds = new Set(assignmentState.assignments.orchestrator);
      const scopedAgents = normalizedAgents.filter((agent) =>
        assignedIntegrationIds.has(String(agent.agentId || ""))
      );
      const connectedAgents = scopedAgents.filter((a) => a.hasConnection);
      const connected = connectedAgents.length > 0;

      logEvent(context, "data_check_connection_result", {
        provider,
        connected,
        agents: scopedAgents,
      });

      return {
        success: true,
        result: {
          connected,
          // NOTE: This reflects connector/account config presence, not a full provider API health probe.
          checkType: "configured_connection_id",
          agents: scopedAgents,
          configuredAgentCount: normalizedAgents.length,
          activeConnectionCount: connectedAgents.length,
        },
        agent: "data",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Unknown data tool: ${toolName}`,
      agent: "data",
      toolName,
      executionTime: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Data operation failed",
      agent: "data",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
}

function isSensitiveLogKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes("key") ||
    k.includes("token") ||
    k.includes("secret") ||
    k.includes("password") ||
    k.includes("authorization") ||
    k.includes("cookie")
  );
}

function isSensitiveSignedUrl(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  try {
    const url = new URL(text);
    const path = url.pathname.toLowerCase();
    if (path.includes("/storage/v1/object/sign/")) return true;
    const sensitiveKeys = [
      "token",
      "sig",
      "signature",
      "expires",
      "expiry",
      "x-amz-signature",
      "x-amz-credential",
      "x-amz-security-token",
      "x-goog-signature",
      "x-goog-credential",
      "x-goog-expires",
    ];
    for (const key of url.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (sensitiveKeys.some((s) => lower.includes(s))) return true;
    }
  } catch {
    // Non-URL strings are ignored here.
  }
  return false;
}

function sanitizeForLog(
  value: unknown,
  keyHint: string | null,
  depth: number,
  seen: WeakSet<object>
): unknown {
  if (depth > 4) return "[omitted]";
  if (keyHint && isSensitiveLogKey(keyHint)) return "[redacted]";

  if (typeof value === "string") {
    if (isSensitiveSignedUrl(value)) return "[redacted_signed_url]";
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const cap = 20;
    const items = value
      .slice(0, cap)
      .map((item) => sanitizeForLog(item, keyHint, depth + 1, seen));
    if (value.length > cap) items.push(`[+${value.length - cap} more]`);
    return items;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeForLog(v, k, depth + 1, seen);
    }
    return out;
  }
  return String(value);
}

function truncateForLog(params: Record<string, unknown>): Record<string, unknown> {
  return sanitizeForLog(params, null, 0, new WeakSet<object>()) as Record<string, unknown>;
}

/**
 * Execute Files agent request for document creation/analysis
 * Delegates to the cloud-based Files agent with Anthropic Skills
 */
async function executeFilesAgentRequest(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  const request = params.request as string;

  logEvent(context, "files_agent_request", {
    request: request?.slice(0, 200),
    hasFilesAgent: !!context.filesAgent,
  });

  // Check if we have a Files agent session
  if (!context.filesAgent) {
    return {
      success: false,
      error: "No Files agent session available. Please upload a file first to establish a session, or configure a Files agent in settings.",
      agent: "files",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  const { agentId, sessionId } = context.filesAgent;

  // Emit agent activity event for UI
  context.onAgentActivity?.({
    agentId,
    agentName: "Files Agent",
    agentType: "files-agent",
    status: "starting",
    message: `Processing: ${request?.slice(0, 100)}...`,
    startedAt: new Date().toISOString(),
  });

  // Retry only when the user explicitly asks for downloadable artifacts.
  // Avoid broad "excel/spreadsheet" matches because they are often source context
  // (e.g. "from the Excel file, output SQL"), not a request to generate artifacts.
  const needsArtifacts =
    /\b(xlsx|png|chart|dashboard|visuali[sz]ation|plot|graph|workbook)\b/i.test(
      request || ""
    );

  const runOnce = async (reqText: string) => {
    // Load existing chat history from the Files agent session
    const supabase = context.supabase;
    if (!supabase) {
      throw new Error("Server misconfigured: Supabase client not available");
    }

    const { data: messages } = await supabase
      .from("chat_messages")
      .select("role, content, metadata")
      .eq("session_id", sessionId)
      .eq("user_id", context.userId)
      .order("created_at", { ascending: true });

    const history = (messages || [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // Reuse previously uploaded files (with anthropicFileId) from message metadata
    const priorFiles: Array<{ id: string; name: string; anthropicFileId?: string | null }> = [];
    for (const m of messages || []) {
      const meta = (m as unknown as { metadata?: unknown }).metadata;
      if (!meta || typeof meta !== "object") continue;
      const files = (meta as { files?: unknown }).files;
      if (!Array.isArray(files)) continue;
      for (const f of files) {
        if (!f || typeof f !== "object") continue;
        const fo = f as { id?: unknown; name?: unknown; anthropicFileId?: unknown };
        const id = typeof fo.id === "string" ? fo.id : "";
        const name = typeof fo.name === "string" ? fo.name : "";
        const anthropicFileId =
          typeof fo.anthropicFileId === "string" ? fo.anthropicFileId : null;
        if (id && name) priorFiles.push({ id, name, anthropicFileId });
      }
    }
    const uploadablePriorFiles = priorFiles.filter(
      (f) => typeof f.anthropicFileId === "string" && f.anthropicFileId.trim().length > 0
    );
    const MAX_FILES_AGENT_ATTACHMENTS = 16;
    const priorFilesForRequest = (() => {
      const dedupedRecent: Array<{ id: string; name: string; anthropicFileId?: string | null }> = [];
      const seen = new Set<string>();
      for (let i = uploadablePriorFiles.length - 1; i >= 0; i--) {
        const f = uploadablePriorFiles[i];
        const key = (f.anthropicFileId || "").trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        dedupedRecent.push(f);
        if (dedupedRecent.length >= MAX_FILES_AGENT_ATTACHMENTS) break;
      }
      return dedupedRecent.reverse();
    })();
    if (priorFiles.length !== priorFilesForRequest.length) {
      logEvent(context, "files_agent_attachments_trimmed", {
        originalCount: priorFiles.length,
        uploadableCount: uploadablePriorFiles.length,
        trimmedCount: priorFilesForRequest.length,
        droppedNonUploadable: Math.max(0, priorFiles.length - uploadablePriorFiles.length),
        maxAllowed: MAX_FILES_AGENT_ATTACHMENTS,
      });
    }

    // Call the Files agent API
    const baseUrl =
      context.appBaseUrl ||
      getAppUrl();
    const internalAuthHeaders = buildInternalRouteAuthHeaders({
      userId: context.userId,
      scope: "files-agent",
    });
    const res = await fetch(`${baseUrl}/api/files-agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(context.cookies ? { Cookie: context.cookies } : {}),
        ...(context.deviceToken ? { "x-device-token": context.deviceToken } : {}),
        ...internalAuthHeaders,
      },
      body: JSON.stringify({
        agentId,
        sessionId,
        messages: [...history, { role: "user", content: reqText }],
        // Pass prior uploads so /api/files-agent can attach container_upload blocks
        files: priorFilesForRequest,
      }),
    });
    // Keep cookies fresh across chained internal calls.
    refreshContextCookiesFromResponse(context, res);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(errText || `HTTP ${res.status}`);
    }

    // Read SSE response
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    const generatedFiles: Array<{ name: string; mediaType: string; url?: string }> = [];
    let lastStatus = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // Ignore malformed SSE payloads.
          continue;
        }
        if (data.type === "text") {
          fullText += String(data.text || "");
          context.onToolStream?.({
            toolName,
            text: String(data.text || ""),
          });
          continue;
        }
        if (data.type === "status") {
          const statusText = String(data.text || "").trim();
          if (statusText && statusText !== lastStatus) {
            lastStatus = statusText;
            context.onToolStream?.({
              toolName,
              text: `\n[${statusText}]\n`,
            });
          }
          continue;
        }
        if (data.type === "file" && data.file) {
          generatedFiles.push(data.file as { name: string; mediaType: string; url?: string });
          continue;
        }
        if (data.type === "error") {
          throw new Error(String(data.error || "Files agent error"));
        }
      }
    }

    // Safari-friendly: process any remaining buffer content after stream ends
    if (buffer.trim() && buffer.startsWith("data: ")) {
      const payload = buffer.slice(6);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        data = {};
      }
      if (data.type === "text") {
        fullText += String(data.text || "");
        context.onToolStream?.({
          toolName,
          text: String(data.text || ""),
        });
      } else if (data.type === "status") {
        const statusText = String(data.text || "").trim();
        if (statusText && statusText !== lastStatus) {
          lastStatus = statusText;
          context.onToolStream?.({
            toolName,
            text: `\n[${statusText}]\n`,
          });
        }
      } else if (data.type === "file" && data.file) {
        generatedFiles.push(data.file as { name: string; mediaType: string; url?: string });
      } else if (data.type === "error") {
        throw new Error(String(data.error || "Files agent error"));
      }
    }

    return { fullText, generatedFiles };
  };

  try {
    // First attempt
    let { fullText, generatedFiles } = await runOnce(request || "");

    // If the user asked for artifacts but none were produced, retry once with a hard requirement.
    if (needsArtifacts && generatedFiles.length === 0) {
      const forced = `${request}\n\nIMPORTANT: You MUST output real downloadable files: at least one PNG chart/dashboard and one XLSX spreadsheet. Do not just describe. If exact counts are missing, create a template using the steps/issues listed.`.trim();
      // reset stream buffer for retry
      context.onToolStream?.({ toolName, text: "\n\n(Generating downloadable files...)\n" });
      const second = await runOnce(forced);
      fullText = second.fullText;
      generatedFiles = second.generatedFiles;
    }

    context.onAgentActivity?.({
      agentId,
      agentName: "Files Agent",
      agentType: "files-agent",
      status: "complete",
      message: fullText.slice(0, 200) + (fullText.length > 200 ? "..." : ""),
      result: { text: fullText, files: generatedFiles },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    return {
      success: true,
      result: {
        response: fullText,
        generatedFiles: generatedFiles.length > 0 ? generatedFiles : undefined,
        // Keep files URL-based. Do NOT inline base64 here; it can blow model context windows.
        files: generatedFiles.length > 0 ? generatedFiles : undefined,
      },
      agent: "files",
      toolName,
      executionTime: Date.now() - startTime,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    context.onAgentActivity?.({
      agentId,
      agentName: "Files Agent",
      agentType: "files-agent",
      status: "error",
      message: errMsg,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    return {
      success: false,
      error: errMsg,
      agent: "files",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
}

/**
 * Execute browser task using Claude Computer Use
 * Returns a marker for the client to invoke the Computer Use agent loop
 */
async function executeBrowserTask(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  const task = params.task as string;
  const startUrl = params.start_url as string | undefined;

  logEvent(context, "browser_task_delegating", {
    task: task?.slice(0, 200),
    startUrl,
  });

  // Emit agent activity event for UI
  context.onAgentActivity?.({
    agentId: "browser-computer-use",
    agentName: "Browser Agent (Computer Use)",
    agentType: "browser",
    status: "starting",
    message: `Starting browser task: ${task?.slice(0, 100)}...`,
    startedAt: new Date().toISOString(),
  });

  // Return a marker that tells the client/connector to run the Computer Use loop locally.
  return {
    success: true,
    result: {
      __connector_execute__: true,
      type: "browser_task_run",
      params: {
        task,
        start_url: startUrl,
        app_url: context.appBaseUrl || "",
        profile_name: "default",
      },
      toolName,
      agent: "browser",
      message: `Starting browser task on local connector (Computer Use)…`,
    },
    agent: "browser",
    toolName,
    executionTime: Date.now() - startTime,
  };
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function normalizeWeekdayName(value: string): (typeof WEEKDAY_NAMES)[number] | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  for (const day of WEEKDAY_NAMES) {
    if (day.toLowerCase() === normalized) return day;
  }
  return null;
}

function getWeekdayNameInTimezone(now: Date, timezone?: string): (typeof WEEKDAY_NAMES)[number] | null {
  const tz = asNonEmptyString(timezone);
  if (!tz) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
    }).formatToParts(now);
    const weekday = parts.find((p) => p.type === "weekday")?.value || "";
    return normalizeWeekdayName(weekday);
  } catch {
    return null;
  }
}

function applyScheduledWhatsAppWeekdayGuard(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext
): {
  params: Record<string, unknown>;
  changed: boolean;
  replacements: number;
  actualWeekday: (typeof WEEKDAY_NAMES)[number] | null;
} {
  if (toolName !== "whatsapp_send_text" || context.scheduledMode !== true) {
    return { params, changed: false, replacements: 0, actualWeekday: null };
  }

  const rawText = typeof params.text === "string" ? params.text : "";
  if (!rawText || !/\bmarkets?\s+closed\b/i.test(rawText)) {
    return { params, changed: false, replacements: 0, actualWeekday: null };
  }
  const hasTodayContext = /\btoday(?:'s)?\b/i.test(rawText) || /\btoday'?s trades\b/i.test(rawText);
  if (!hasTodayContext) {
    return { params, changed: false, replacements: 0, actualWeekday: null };
  }

  const actualWeekday = getWeekdayNameInTimezone(new Date(), context.localTimezone);
  if (!actualWeekday) {
    return { params, changed: false, replacements: 0, actualWeekday: null };
  }

  const actualIsWeekend = actualWeekday === "Saturday" || actualWeekday === "Sunday";
  let replacements = 0;

  const replaceLine = (statedDayRaw: string, wrappedInParens: boolean): string => {
    const statedDay = normalizeWeekdayName(statedDayRaw);
    if (statedDay && statedDay === actualWeekday) {
      return wrappedInParens
        ? `(${statedDay} - markets closed)`
        : `${statedDay} - markets closed`;
    }
    replacements += 1;
    if (actualIsWeekend) {
      return wrappedInParens
        ? `(${actualWeekday} - markets closed)`
        : `${actualWeekday} - markets closed`;
    }
    return wrappedInParens ? `(${actualWeekday})` : `${actualWeekday}`;
  };

  let nextText = rawText.replace(
    /\((Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s*[—-]\s*markets?\s+closed\)/gi,
    (_match, statedDay) => replaceLine(String(statedDay || ""), true)
  );

  nextText = nextText.replace(
    /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s*[—-]\s*markets?\s+closed\b/gi,
    (_match, statedDay) => replaceLine(String(statedDay || ""), false)
  );

  if (replacements === 0 || nextText === rawText) {
    return { params, changed: false, replacements: 0, actualWeekday };
  }

  return {
    params: {
      ...params,
      text: nextText,
    },
    changed: true,
    replacements,
    actualWeekday,
  };
}

function inferFilenameFromStoragePath(storagePath: string): string | undefined {
  const last = storagePath.split("/").pop() || "";
  return last.trim() ? last.trim() : undefined;
}

function inferFilenameFromLocalPath(localPath: string): string | undefined {
  const normalized = localPath.replace(/\\/g, "/");
  const last = normalized.split("/").pop() || "";
  return last.trim() ? last.trim() : undefined;
}

function looksLikeConnectorLocalPath(rawPath: string): boolean {
  const value = rawPath.trim();
  if (!value) return false;
  if (/^[a-z]+:\/\//i.test(value)) return false;
  if (value.startsWith("~/") || value.startsWith("~\\")) return true;
  if (value.startsWith("/") || value.startsWith("\\")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return false;
}

type SessionGeneratedMediaRefs = {
  storagePaths: Set<string>;
  fileIds: Set<string>;
};

type ToolExecutionContextWithMediaCache = ToolExecutionContext & {
  __whatsappMediaRefsCache?: {
    sessionId: string;
    refs: SessionGeneratedMediaRefs;
  };
  __whatsappMediaTransientRefs?: SessionGeneratedMediaRefs;
};

function sanitizeFilenameForStorage(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function filenameExtension(value: string): string {
  const sanitized = sanitizeFilenameForStorage(value.trim()).toLowerCase();
  const dot = sanitized.lastIndexOf(".");
  if (dot <= 0 || dot === sanitized.length - 1) return "";
  return sanitized.slice(dot);
}

function filenamesAreCompatible(actualFilename: string, providedFilename: string): boolean {
  const baseNorm = sanitizeFilenameForStorage(actualFilename.trim()).toLowerCase();
  const providedNorm = sanitizeFilenameForStorage(providedFilename.trim()).toLowerCase();
  if (!baseNorm || !providedNorm) return false;
  return (
    baseNorm === providedNorm ||
    baseNorm.endsWith(`-${providedNorm}`) ||
    (filenameExtension(baseNorm) !== "" &&
      filenameExtension(baseNorm) === filenameExtension(providedNorm))
  );
}

function storagePathMatchesFilename(storagePath: string, filename: string): boolean {
  const base = inferFilenameFromStoragePath(storagePath);
  if (!base) return false;
  return filenamesAreCompatible(base, filename);
}

function extractChatUploadsStoragePathFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const markers = [
      "/storage/v1/object/sign/chat_uploads/",
      "/storage/v1/object/public/chat_uploads/",
      "/storage/v1/object/authenticated/chat_uploads/",
    ];
    for (const marker of markers) {
      const idx = parsed.pathname.indexOf(marker);
      if (idx < 0) continue;
      const encoded = parsed.pathname.slice(idx + marker.length).replace(/^\/+/, "");
      if (!encoded) continue;
      return decodeURIComponent(encoded);
    }
  } catch {
    // ignore malformed/foreign URLs
  }
  return null;
}

function extractSessionIdFromStoragePath(
  storagePath: string,
  userId: string
): string | null {
  if (!storagePath.startsWith(`${userId}/`)) return null;
  const remainder = storagePath.slice(userId.length + 1);
  const sessionId = remainder.split("/")[0] || "";
  return sessionId.trim() ? sessionId.trim() : null;
}

async function loadSessionGeneratedMediaRefs(
  context: ToolExecutionContext
): Promise<SessionGeneratedMediaRefs | null> {
  const sessionId = asNonEmptyString(context.orchestratorSessionId);
  if (!context.supabase || !sessionId) return null;
  const ctx = context as ToolExecutionContextWithMediaCache;
  const cached = ctx.__whatsappMediaRefsCache;
  if (cached && cached.sessionId === sessionId) return cached.refs;

  const refs: SessionGeneratedMediaRefs = {
    storagePaths: new Set<string>(),
    fileIds: new Set<string>(),
  };

  const { data: rows } = await context.supabase
    .from("orchestrator_messages")
    .select("metadata, created_at")
    .eq("user_id", context.userId)
    .eq("session_id", sessionId)
    .not("metadata", "is", null)
    .order("created_at", { ascending: false })
    .limit(1000);

  for (const row of rows || []) {
    const metadata =
      row && typeof row === "object" ? (row as { metadata?: unknown }).metadata : null;
    const metaRec =
      metadata && typeof metadata === "object"
        ? (metadata as Record<string, unknown>)
        : null;
    const generatedRaw = metaRec?.generated_files;
    if (!Array.isArray(generatedRaw)) continue;
    for (const rawFile of generatedRaw) {
      if (!rawFile || typeof rawFile !== "object") continue;
      const fileRec = rawFile as Record<string, unknown>;
      const storagePath =
        asNonEmptyString(fileRec.storage_path) ||
        asNonEmptyString(fileRec.storagePath);
      const fileId =
        asNonEmptyString(fileRec.file_id) ||
        asNonEmptyString(fileRec.fileId);
      if (storagePath) refs.storagePaths.add(storagePath);
      if (fileId) refs.fileIds.add(fileId);
    }
  }

  const transient = ctx.__whatsappMediaTransientRefs;
  if (transient) {
    for (const sp of transient.storagePaths) refs.storagePaths.add(sp);
    for (const fid of transient.fileIds) refs.fileIds.add(fid);
  }

  ctx.__whatsappMediaRefsCache = { sessionId, refs };
  return refs;
}

function recordTransientMediaRef(
  context: ToolExecutionContext,
  storagePath: string | null,
  fileId: string | null
): void {
  const sp = asNonEmptyString(storagePath);
  const fid = asNonEmptyString(fileId);
  if (!sp && !fid) return;

  const ctx = context as ToolExecutionContextWithMediaCache;
  if (!ctx.__whatsappMediaTransientRefs) {
    ctx.__whatsappMediaTransientRefs = {
      storagePaths: new Set<string>(),
      fileIds: new Set<string>(),
    };
  }
  if (sp) ctx.__whatsappMediaTransientRefs.storagePaths.add(sp);
  if (fid) ctx.__whatsappMediaTransientRefs.fileIds.add(fid);
  if (ctx.__whatsappMediaRefsCache) {
    if (sp) ctx.__whatsappMediaRefsCache.refs.storagePaths.add(sp);
    if (fid) ctx.__whatsappMediaRefsCache.refs.fileIds.add(fid);
  }
}

function captureMediaRefsFromToolResult(
  context: ToolExecutionContext,
  result: unknown
): void {
  if (!result || typeof result !== "object") return;
  const rec = result as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (Array.isArray(rec.files)) candidates.push(...rec.files);
  if (Array.isArray(rec.generatedFiles)) candidates.push(...rec.generatedFiles);
  if (Array.isArray(rec.generated_files)) candidates.push(...rec.generated_files);

  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue;
    const fileRec = raw as Record<string, unknown>;
    const storagePath =
      asNonEmptyString(fileRec.storage_path) ||
      asNonEmptyString(fileRec.storagePath);
    const fileId =
      asNonEmptyString(fileRec.file_id) ||
      asNonEmptyString(fileRec.fileId);
    recordTransientMediaRef(context, storagePath, fileId);
  }
}

function validateSessionMediaReference(args: {
  refs: SessionGeneratedMediaRefs | null;
  userId: string;
  allowedFilesSessionIds?: Set<string>;
  storagePath?: string | null;
  fileId?: string | null;
}): { ok: true } | { ok: false; error: string } {
  const { refs } = args;
  const storagePath = asNonEmptyString(args.storagePath);
  const fileId = asNonEmptyString(args.fileId);
  if (!refs) return { ok: true };

  const pathSessionId =
    storagePath && args.userId
      ? extractSessionIdFromStoragePath(storagePath, args.userId)
      : null;
  if (
    pathSessionId &&
    args.allowedFilesSessionIds &&
    args.allowedFilesSessionIds.has(pathSessionId)
  ) {
    return { ok: true };
  }

  const hasKnownRefs = refs.storagePaths.size > 0 || refs.fileIds.size > 0;
  if (!hasKnownRefs) {
    return {
      ok: false,
      error:
        "whatsapp_send_media blocked: this session has no generated file references to validate against. Regenerate the file in this conversation, then send.",
    };
  }
  if (fileId && refs.fileIds.has(fileId)) return { ok: true };
  if (storagePath && refs.storagePaths.has(storagePath)) return { ok: true };
  return {
    ok: false,
    error:
      "whatsapp_send_media blocked: media reference does not belong to the current conversation session.",
  };
}

async function resolveWhatsAppMediaParamsForConnector(
  params: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<{ ok: true; params: Record<string, unknown> } | { ok: false; error: string }> {
  const sessionIdScope = asNonEmptyString(context.orchestratorSessionId);
  const allowedFilesSessionIds = new Set<string>();
  const linkedFilesSessionId = asNonEmptyString(context.filesAgent?.sessionId);
  if (linkedFilesSessionId) allowedFilesSessionIds.add(linkedFilesSessionId);
  const sessionRefs = await loadSessionGeneratedMediaRefs(context);
  const directUrl = asNonEmptyString(params.url);
  if (directUrl) {
    const providedStoragePathRaw = asNonEmptyString(params.storage_path);
    const providedStoragePath =
      providedStoragePathRaw && !looksLikeConnectorLocalPath(providedStoragePathRaw)
        ? providedStoragePathRaw
        : null;
    const providedFileId = asNonEmptyString(params.file_id);
    if (providedStoragePath || providedFileId) {
      const explicitRefCheck = validateSessionMediaReference({
        refs: sessionRefs,
        userId: context.userId,
        allowedFilesSessionIds,
        storagePath: providedStoragePath,
        fileId: providedFileId,
      });
      if (!explicitRefCheck.ok) return explicitRefCheck;
      const providedFilename = asNonEmptyString(params.filename);
      if (
        providedStoragePath &&
        providedFilename &&
        !storagePathMatchesFilename(
          providedStoragePath,
          providedFilename
        )
      ) {
        return {
          ok: false,
          error:
            "whatsapp_send_media blocked: filename does not match the referenced stored file path.",
        };
      }
    }
    const inferredStoragePath = extractChatUploadsStoragePathFromUrl(directUrl);
    if (inferredStoragePath) {
      if (!inferredStoragePath.startsWith(`${context.userId}/`)) {
        return {
          ok: false,
          error: `whatsapp_send_media rejected URL path outside user scope: ${inferredStoragePath}`,
        };
      }
      const refCheck = validateSessionMediaReference({
        refs: sessionRefs,
        userId: context.userId,
        allowedFilesSessionIds,
        storagePath: inferredStoragePath,
        fileId: asNonEmptyString(params.file_id),
      });
      if (!refCheck.ok) return refCheck;
      const providedFilename = asNonEmptyString(params.filename);
      if (
        providedFilename &&
        !storagePathMatchesFilename(inferredStoragePath, providedFilename)
      ) {
        return {
          ok: false,
          error:
            "whatsapp_send_media blocked: filename does not match the referenced stored file path.",
        };
      }
    }
    return {
      ok: true,
      params: {
        ...params,
        url: directUrl,
        ...(sessionIdScope ? { orchestrator_session_id: sessionIdScope } : {}),
      },
    };
  }

  const explicitLocalPathEarly = asNonEmptyString(params.local_path);
  if (explicitLocalPathEarly && !looksLikeConnectorLocalPath(explicitLocalPathEarly)) {
    return {
      ok: false,
      error:
        "whatsapp_send_media local_path must be an absolute path (or ~/...) on the connector machine.",
    };
  }
  const storagePathEarly = asNonEmptyString(params.storage_path);
  const userIdForLocalCheck = asNonEmptyString(context.userId);
  const localPathFromStorageEarly =
    !explicitLocalPathEarly &&
    storagePathEarly &&
    looksLikeConnectorLocalPath(storagePathEarly) &&
    (!userIdForLocalCheck || !storagePathEarly.startsWith(`${userIdForLocalCheck}/`))
      ? storagePathEarly
      : null;
  const connectorLocalPathEarly = explicitLocalPathEarly || localPathFromStorageEarly;
  if (connectorLocalPathEarly) {
    const fallbackFilenameEarly = asNonEmptyString(params.filename);
    const inferredLocalFilenameEarly = inferFilenameFromLocalPath(connectorLocalPathEarly);
    if (
      fallbackFilenameEarly &&
      inferredLocalFilenameEarly &&
      !filenamesAreCompatible(inferredLocalFilenameEarly, fallbackFilenameEarly)
    ) {
      return {
        ok: false,
        error:
          "whatsapp_send_media blocked: filename does not match the referenced local file path.",
      };
    }
    const nextParams: Record<string, unknown> = {
      ...params,
      local_path: connectorLocalPathEarly,
      ...(sessionIdScope ? { orchestrator_session_id: sessionIdScope } : {}),
    };
    if (localPathFromStorageEarly) {
      delete nextParams.storage_path;
    }
    if (!asNonEmptyString(nextParams.filename)) {
      nextParams.filename = fallbackFilenameEarly || inferFilenameFromLocalPath(connectorLocalPathEarly);
    }
    return { ok: true, params: nextParams };
  }

  if (!context.supabase) {
    return {
      ok: false,
      error:
        "whatsapp_send_media needs url/local_path or storage_path/file_id, but Supabase context is unavailable for URL resolution.",
    };
  }

  const userId = asNonEmptyString(context.userId);
  if (!userId) {
    return {
      ok: false,
      error: "whatsapp_send_media cannot resolve media without a valid user id.",
    };
  }

  let storagePath = asNonEmptyString(params.storage_path);
  let fallbackFilename = asNonEmptyString(params.filename) || undefined;
  const fileId = asNonEmptyString(params.file_id);

  if (storagePath) {
    const preRefCheck = validateSessionMediaReference({
      refs: sessionRefs,
      userId: context.userId,
      allowedFilesSessionIds,
      storagePath,
      fileId,
    });
    if (!preRefCheck.ok) {
      return preRefCheck;
    }
  }

  if (!storagePath && fileId) {
    const { data: row, error: rowErr } = await context.supabase
      .from("chat_attachments")
      .select("storage_path, file_name, created_at")
      .eq("user_id", userId)
      .eq("anthropic_file_id", fileId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (rowErr) {
      return {
        ok: false,
        error: `whatsapp_send_media failed to resolve file_id (${fileId}): ${rowErr.message}`,
      };
    }
    const rowObj = row as { storage_path?: unknown; file_name?: unknown } | null;
    storagePath = asNonEmptyString(rowObj?.storage_path);
    if (!fallbackFilename) {
      fallbackFilename = asNonEmptyString(rowObj?.file_name) || undefined;
    }
    const postResolveRefCheck = validateSessionMediaReference({
      refs: sessionRefs,
      userId: context.userId,
      allowedFilesSessionIds,
      storagePath,
      fileId,
    });
    if (!postResolveRefCheck.ok) {
      return postResolveRefCheck;
    }
  }

  if (!storagePath) {
    return {
      ok: false,
      error:
        "whatsapp_send_media requires at least one resolvable media reference (url, local_path, storage_path, or file_id).",
    };
  }

  if (!storagePath.startsWith(`${userId}/`)) {
    return {
      ok: false,
      error: `whatsapp_send_media rejected storage_path outside user scope: ${storagePath}`,
    };
  }

  const providedFilename = asNonEmptyString(params.filename);
  if (providedFilename && !storagePathMatchesFilename(storagePath, providedFilename)) {
    return {
      ok: false,
      error:
        "whatsapp_send_media blocked: filename does not match the referenced stored file path.",
    };
  }

  const { data: signedData, error: signErr } = await context.supabase.storage
    .from("chat_uploads")
    .createSignedUrl(storagePath, 3600);
  if (signErr || !signedData?.signedUrl) {
    return {
      ok: false,
      error: `whatsapp_send_media failed to sign media URL for ${storagePath}: ${signErr?.message || "unknown_error"}`,
    };
  }

  const nextParams: Record<string, unknown> = {
    ...params,
    storage_path: storagePath,
    url: signedData.signedUrl,
    ...(sessionIdScope ? { orchestrator_session_id: sessionIdScope } : {}),
  };
  if (!asNonEmptyString(nextParams.filename)) {
    nextParams.filename = fallbackFilename || inferFilenameFromStoragePath(storagePath) || undefined;
  }
  return { ok: true, params: nextParams };
}

/**
 * Execute connector tools (browser, files, obsidian)
 * These require the local connector to be running
 */
async function executeConnectorTool(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  const agent = toolToAgent(toolName) || "unknown";

  // Hard guardrail: for generated sites under ~/.groovy/sites, keep all
  // file/system operations inside code_cli_run to avoid terminal verify loops.
  if (toolName === "terminal_exec") {
    const commandText = String(params.command || "");
    const cwdText = String(params.cwd || "");
    const combined = `${commandText}\n${cwdText}`.toLowerCase();
    const touchesSiteWorkspace =
      combined.includes("/.groovy/sites/") || combined.includes("~/.groovy/sites/");
    if (touchesSiteWorkspace) {
      return {
        success: false,
        error:
          "terminal_exec is disabled for ~/.groovy/sites/* workflows. Use code_cli_run (with Bash allowed) for scaffolding and edits, then use site_dev/site_publish.",
        agent,
        toolName,
        executionTime: Date.now() - startTime,
      };
    }
  }

  // Convenience: allow obsidian tools to omit vault_path and use the default from context.
  if (agent === "obsidian") {
    const p = params as Record<string, unknown>;
    const hasVault = typeof p.vault_path === "string" && p.vault_path.length > 0;
    const defaultVault =
      typeof context.obsidianVaultPath === "string" ? context.obsidianVaultPath : null;
    if (!hasVault && defaultVault) {
      params = { ...p, vault_path: defaultVault };
    }
  }

  if (toolName === "whatsapp_send_media") {
    const resolved = await resolveWhatsAppMediaParamsForConnector(params, context);
    if (!resolved.ok) {
      return {
        success: false,
        error: resolved.error,
        agent,
        toolName,
        executionTime: Date.now() - startTime,
      };
    }
    params = resolved.params;
  }

  const guarded = applyScheduledWhatsAppWeekdayGuard(toolName, params, context);
  if (guarded.changed) {
    params = guarded.params;
    logEvent(context, "whatsapp_send_text_weekday_guard_applied", {
      toolName,
      replacements: guarded.replacements,
      localTimezone: context.localTimezone || null,
      actualWeekday: guarded.actualWeekday,
    });
  }

  // For browser/files/obsidian tools, we return a special marker
  // The client will relay this to the connector and handle the result
  const connectorMsg = toolToConnectorMessage(toolName, params);
  if (!connectorMsg) {
    return {
      success: false,
      error: `Tool ${toolName} is not supported by the connector`,
      agent,
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  // Return a special result that tells the client to execute via connector
  // The client-side relay will handle the actual execution
  return {
    success: true,
    result: {
      __connector_execute__: true,
      type: connectorMsg.type,
      params: connectorMsg.params,
      toolName,
      agent,
      // Include a friendly message for the LLM
      message: getConnectorActionMessage(toolName, params),
    },
    agent,
    toolName,
    executionTime: Date.now() - startTime,
  };
}

/**
 * Generate a friendly message describing what the connector action will do
 */
function getConnectorActionMessage(
  toolName: string,
  params: Record<string, unknown>
): string | undefined {
  if (toolName === "code_terminal_step" || toolName === "code_cli_run") {
    return undefined;
  }
  if (toolName === "terminal_exec") return undefined;
  if (toolName === "browser_navigate") {
    return `Navigating to ${params.url}...`;
  }
  if (toolName === "browser_click") {
    return `Clicking element: ${params.selector}`;
  }
  if (toolName === "browser_type") {
    return `Typing "${String(params.text).slice(0, 30)}${String(params.text).length > 30 ? '...' : ''}" into ${params.selector}`;
  }
  if (toolName === "browser_extract") {
    return `Extracting ${params.instruction || 'content'} from page...`;
  }
  if (toolName === "browser_screenshot") {
    return `Taking screenshot...`;
  }
  if (toolName.startsWith("files_")) {
    return `File operation: ${toolName.replace("files_", "")} on ${params.path}`;
  }
  if (toolName.startsWith("obsidian_")) {
    return `Obsidian: ${toolName.replace("obsidian_", "")} (pending local connector result)`;
  }
  return `Executing ${toolName}...`;
}

// Keep old implementation for when we have direct relay access
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function executeConnectorToolWithRelay(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  const agent = toolToAgent(toolName) || "unknown";

  // Check if we have relay connection
  const relaySend = context.relaySend;
  if (!relaySend) {
    return {
      success: false,
      error:
        "Local connector not connected. Please ensure the Groovy Connector is running on your machine.",
      agent,
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  const guarded = applyScheduledWhatsAppWeekdayGuard(toolName, params, context);
  if (guarded.changed) {
    params = guarded.params;
    logEvent(context, "whatsapp_send_text_weekday_guard_applied", {
      toolName,
      replacements: guarded.replacements,
      localTimezone: context.localTimezone || null,
      actualWeekday: guarded.actualWeekday,
    });
  }

  // Convert tool to connector message format
  const connectorMsg = toolToConnectorMessage(toolName, params);
  if (!connectorMsg) {
    return {
      success: false,
      error: `Tool ${toolName} is not supported by the connector`,
      agent,
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  // Generate request ID
  const requestId = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Create promise that will be resolved when connector responds
  return new Promise((resolve) => {
    const timeoutMs = (() => {
      if (connectorMsg.type === "browser_credential_request" || toolName === "browser_credential_request") {
        return 120_000;
      }
      if (connectorMsg.type === "browser_task_run") {
        return 9 * 60 * 1000;
      }
      if (connectorMsg.type === "terminal_exec") {
        const requested = Number(connectorMsg.params.timeout_ms);
        if (Number.isFinite(requested) && requested > 0) {
          return Math.min(Math.max(30_000, requested + 10_000), 15 * 60 * 1000);
        }
        return 10 * 60 * 1000;
      }
      if (connectorMsg.type === "terminal_step") {
        const requested = Number(connectorMsg.params.max_wait_ms);
        if (Number.isFinite(requested) && requested > 0) {
          return Math.min(Math.max(30_000, requested + 10_000), 15 * 60 * 1000);
        }
        return 10 * 60 * 1000;
      }
      if (connectorMsg.type === "claude_run") {
        const requested = Number(connectorMsg.params.timeout_ms);
        if (Number.isFinite(requested) && requested > 0) {
          return Math.min(Math.max(30_000, requested + 10_000), 22 * 60 * 1000);
        }
        return 22 * 60 * 1000;
      }
      if (connectorMsg.type === "site_dev_start") {
        return 210_000;
      }
      if (connectorMsg.type === "site_deploy") {
        return 240_000;
      }
      return 30_000;
    })();
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({
        success: false,
        error: `Tool execution timed out (${Math.round(timeoutMs / 1000)}s). The connector may be busy or disconnected.`,
        agent,
        toolName,
        executionTime: Date.now() - startTime,
      });
    }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve,
      reject: () => {},
      timeout,
      toolName,
      startTime,
    });

    context.onWaitingForConnector?.(toolName);

    relaySend({
      type: connectorMsg.type,
      request_id: requestId,
      device_id: context.deviceId,
      ...connectorMsg.params,
    });
  });
}

/**
 * Execute AI agent delegate - call a user-configured AI chat agent
 */
async function executeAiAgentDelegate(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  const agentName = params.agentName as string;
  const message = params.message as string;

  if (!context.aiChatAgents || context.aiChatAgents.length === 0) {
    return {
      success: false,
      error: "No AI chat agents configured. Create one in the dashboard settings.",
      agent: "ai-chat",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  // Find the agent by name (case-insensitive)
  const agent = context.aiChatAgents.find(
    (a) => a.name.toLowerCase() === agentName.toLowerCase()
  );

  if (!agent) {
    const available = context.aiChatAgents.map((a) => a.name).join(", ");
    return {
      success: false,
      error: `Agent "${agentName}" not found. Available agents: ${available}`,
      agent: "ai-chat",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  const supabase = context.supabase;
  if (!supabase) {
    return {
      success: false,
      error: "Server misconfigured: Supabase client not available",
      agent: "ai-chat",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  // Emit activity
  context.onAgentActivity?.({
    agentId: agent.id,
    agentName: agent.name,
    agentType: "ai-chat",
    status: "starting",
    message: `Delegating to ${agent.name}: ${message?.slice(0, 100)}...`,
    startedAt: new Date().toISOString(),
  });

  try {
    // Create or get a session for this agent
    let sessionId: string;

    // Check for existing session
    const { data: existingSessions } = await supabase
      .from("chat_sessions")
      .select("id")
      .eq("user_id", context.userId)
      .eq("agent_id", agent.id)
      .order("updated_at", { ascending: false })
      .limit(1);

    if (existingSessions && existingSessions.length > 0) {
      sessionId = existingSessions[0].id;
    } else {
      // Create new session
      const { data: newSession, error: sessErr } = await supabase
        .from("chat_sessions")
        .insert({
          user_id: context.userId,
          agent_id: agent.id,
          title: message?.slice(0, 50) || "AI Agent Chat",
        })
        .select("id")
        .single();

      if (sessErr || !newSession) {
        throw new Error("Failed to create chat session");
      }
      sessionId = newSession.id;
    }

    // Load agent config (provider/model/system_prompt) and run it directly server-side.
    // We cannot call /api/chat here because WhatsApp requests have no cookie auth.
    const { data: agentRow, error: agentErr } = await supabase
      .from("agents")
      .select("id, user_id, provider, model, name, system_prompt, reasoning_effort, type")
      .eq("id", agent.id)
      .eq("user_id", context.userId)
      .single();
    if (agentErr || !agentRow) throw new Error("Agent not found");
    if ((agentRow as unknown as { type?: string }).type !== "ai-chat") {
      throw new Error("Agent type does not support chat");
    }

    const provider = ((agentRow as unknown as { provider?: string | null }).provider || "openai") as ProviderId;
    const modelName = (agentRow as unknown as { model?: string | null }).model || "gpt-4o";
    const systemPrompt =
      typeof (agentRow as unknown as { system_prompt?: unknown }).system_prompt === "string" &&
      (agentRow as unknown as { system_prompt?: string }).system_prompt?.trim()
        ? ((agentRow as unknown as { system_prompt?: string }).system_prompt as string).trim()
        : "You are a specialized AI agent. Be concise and return the result.";

    // Key mode: WhatsApp has no cookies, so default to user keys.
    let apiKey: string | null = null;
    const { data: userKeyRow, error: keyErr } = await supabase
      .from("user_api_keys")
      .select("api_key_enc")
      .eq("user_id", context.userId)
      .eq("provider", provider)
      .maybeSingle();
    if (keyErr) throw new Error(keyErr.message);
    if (userKeyRow?.api_key_enc) {
      try {
        apiKey = decryptLlmApiKey(userKeyRow.api_key_enc);
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : "Failed to decrypt API key");
      }
    }
    if (
      provider === "anthropic" &&
      apiKey &&
      isClaudeCliOAuthToken(apiKey) &&
      process.env.ANTHROPIC_API_KEY
    ) {
      console.warn(
        "[toolExecutor] Anthropic user key looks like Claude CLI OAuth token; using Groovy Anthropic key for ai_agent_delegate."
      );
      apiKey = null;
    }

    if (!apiKey && provider !== "anthropic" && provider !== "openai" && provider !== "google") {
      // If provider is unknown, fail explicitly.
      throw new Error(`Missing API key for provider: ${provider}`);
    }
    if (!apiKey && (provider === "anthropic" || provider === "openai" || provider === "google")) {
      // WhatsApp requests have no cookies, so historically this required a stored user key.
      // But for local/owned deployments it's common to rely on server env keys. Allow that fallback.
      const hasEnvKey = hasGroovyProviderKey(provider);
      if (!hasEnvKey) {
        throw new Error(
          `Missing ${provider} API key for ai_agent_delegate. Add it in Settings → API Keys, or set the server env var (e.g. OPENAI_API_KEY).`
        );
      }
    }

    let usingGroovyKey = !apiKey;
    const billingTraceId = context.traceId || `ai_agent_delegate-${Date.now()}`;
    const billingTurnId = context.turnId || billingTraceId;
    const ensureUsagePreflight = async () => {
      if (!context.billingWorkspaceId) return;
      const preflight = await preflightGroovyUsage({
        workspaceId: context.billingWorkspaceId,
        userId: context.userId,
        userEmail: null,
        traceId: billingTraceId,
        source: "ai_agent_delegate",
      });
      if (!preflight.allowed) {
        throw new Error(preflight.message);
      }
    };
    await ensureUsagePreflight();

    const modelMessages: ModelMessage[] = [{ role: "user", content: message }];
    let gen: Awaited<ReturnType<typeof generateText>>;
    try {
      const model = resolveChatModel(provider, modelName, apiKey ? { apiKey } : undefined);
      gen = await generateText({
        model,
        system: systemPrompt,
        messages: modelMessages,
        abortSignal: context.abortSignal,
      });
    } catch (err) {
      if (context.abortSignal?.aborted) throw err;
      if (!usingGroovyKey && isInvalidApiKeyError(err) && hasGroovyProviderKey(provider)) {
        console.warn("[toolExecutor] ai_agent_delegate user key invalid; retrying with Groovy key", {
          provider,
          modelName,
        });
        await ensureUsagePreflight();
        usingGroovyKey = true;
        apiKey = null;
        const fallbackModel = resolveChatModel(provider, modelName);
        gen = await generateText({
          model: fallbackModel,
          system: systemPrompt,
          messages: modelMessages,
          abortSignal: context.abortSignal,
        });
      } else {
        throw err;
      }
    }

    if (context.billingWorkspaceId) {
      const usageChargeType = usageChargeTypeForKeyMode(usingGroovyKey ? "groovy" : "user");
      insertBillingUsageEventBestEffort({
        workspaceId: context.billingWorkspaceId,
        userId: context.userId,
        turnId: billingTurnId,
        traceId: billingTraceId,
        source: "ai_agent_delegate",
        spanId: agent.id,
        provider,
        model: modelName,
        usage: (gen as unknown as { usage?: unknown }).usage,
        billable: true,
        chargeType: usageChargeType,
        meta: {
          agentId: agent.id,
          agentName: agent.name,
        },
      });
      await settleGroovyUsageDebitBestEffort({
        workspaceId: context.billingWorkspaceId,
        userId: context.userId,
        traceId: billingTraceId,
        turnId: billingTurnId,
        source: "ai_agent_delegate",
        spanId: agent.id,
        model: modelName,
        usage: (gen as unknown as { usage?: unknown }).usage,
        chargeType: usageChargeType,
        meta: {
          agentId: agent.id,
          agentName: agent.name,
        },
      }).catch(() => {});
    }

    const fullText = (gen.text || "").trim();
    const files = (gen.files || []).slice(0, 6).map((f) => ({
      mediaType: f.mediaType,
      base64: f.base64,
    }));

    // Persist to chat_messages (best-effort)
    await supabase.from("chat_messages").insert([
      {
        user_id: context.userId,
        session_id: sessionId,
        role: "user",
        content: message || "[request]",
        metadata: { agent_id: agent.id },
      },
      {
        user_id: context.userId,
        session_id: sessionId,
        role: "assistant",
        content: fullText || (files.length ? "[generated image]" : "[no response]"),
        metadata: {
          agent_id: agent.id,
          provider,
          model: modelName,
          files: files.length ? files : undefined,
        },
      },
    ]);

    context.onAgentActivity?.({
      agentId: agent.id,
      agentName: agent.name,
      agentType: "ai-chat",
      status: "complete",
      message: `Completed: ${(fullText || (files.length ? "[generated image]" : "")).slice(0, 100)}...`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    return {
      success: true,
      result: {
        agentName: agent.name,
        response: fullText,
        files,
      },
      agent: "ai-chat",
      toolName,
      executionTime: Date.now() - startTime,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    
    context.onAgentActivity?.({
      agentId: agent.id,
      agentName: agent.name,
      agentType: "ai-chat",
      status: "error",
      message: `Error: ${errMsg}`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    return {
      success: false,
      error: errMsg,
      agent: "ai-chat",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
}

/**
 * Server-side site builder tools: site_publish, site_attach_domain, site_verify_domain.
 * These call the Vercel API directly (not via connector).
 */
async function executeSiteServerTool(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  const emit = (text: string) =>
    context.onToolStream?.({ toolName, text });

  if (!context.appBaseUrl) {
    return {
      success: false,
      error: "appBaseUrl not available for site tools",
      agent: "pages",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  // All site server tools call our own /api/sites/* routes which handle Vercel API calls.
  // This keeps the Vercel token isolated to the server.
  const callSiteApi = async (endpoint: string, body: Record<string, unknown>) => {
    const url = `${context.appBaseUrl}/api/sites/${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...buildInternalRouteAuthHeaders({
        userId: context.userId,
        scope: `sites-${endpoint}`,
      }),
    };
    if (context.cookies) headers.cookie = context.cookies;
    if (context.deviceToken) headers["x-device-token"] = context.deviceToken;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return res.json() as Promise<Record<string, unknown>>;
  };

  try {
    if (toolName === "site_publish") {
      const slug = String(params.slug || "").trim();
      const siteId = typeof params.siteId === "string" ? params.siteId.trim() : "";

      if (!slug) {
        return { success: false, error: "slug is required", agent: "pages", toolName, executionTime: Date.now() - startTime };
      }

      emit(`Reading files from ~/.groovy/sites/${slug}...\n`);
      emit("Preparing deployment upload...\n");

      // `site_publish` is a server-side action that still needs local files.
      // We ask the connector to read files, then the dashboard callback posts
      // those files to /api/sites/deploy and returns that result to this tool call.
      return {
        success: true,
        result: {
          __connector_execute__: true,
          type: "site_read_files",
          params: { slug, siteId },
          toolName: "site_publish",
          agent: "pages",
          message: `Reading site files from ~/.groovy/sites/${slug} for deployment...`,
        },
        agent: "pages",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "site_attach_domain") {
      const siteId = typeof params.siteId === "string" ? params.siteId.trim() : "";
      const slug = typeof params.slug === "string" ? params.slug.trim() : "";
      const domain = String(params.domain || "").trim();

      if ((!siteId && !slug) || !domain) {
        return {
          success: false,
          error: "siteId or slug, and domain are required",
          agent: "pages",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      emit(`Attaching ${domain} to site ${slug || siteId}...\n`);
      const result = await callSiteApi("attach-domain", {
        ...(siteId ? { siteId } : {}),
        ...(slug ? { slug } : {}),
        domain,
      });

      if (result.ok) {
        const instructions = Array.isArray(result.instructions)
          ? (result.instructions as string[]).join("\n")
          : "";
        return {
          success: true,
          result: {
            domain,
            verified: result.verified,
            instructions,
            message: result.verified
              ? `${domain} is already verified and live!`
              : `Domain added. DNS instructions:\n${instructions}\n\nAfter adding the records, use site_verify_domain to verify.`,
          },
          agent: "pages",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      return {
        success: false,
        error: String(result.error || "Failed to attach domain"),
        agent: "pages",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "site_verify_domain") {
      const siteId = typeof params.siteId === "string" ? params.siteId.trim() : "";
      const slug = typeof params.slug === "string" ? params.slug.trim() : "";
      const domain = String(params.domain || "").trim();

      if ((!siteId && !slug) || !domain) {
        return {
          success: false,
          error: "siteId or slug, and domain are required",
          agent: "pages",
          toolName,
          executionTime: Date.now() - startTime,
        };
      }

      emit(`Verifying ${domain}...\n`);
      const result = await callSiteApi("verify-domain", {
        ...(siteId ? { siteId } : {}),
        ...(slug ? { slug } : {}),
        domain,
      });

      return {
        success: !!result.ok,
        result: {
          domain,
          verified: result.verified,
          message: result.message || (result.verified ? "Domain verified!" : "Not yet verified"),
        },
        error: result.ok ? undefined : String(result.error || result.message || "Verification failed"),
        agent: "pages",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "site_delete") {
      const siteId = String(params.siteId || "");
      if (!siteId) {
        return { success: false, error: "siteId required", agent: "pages", toolName, executionTime: Date.now() - startTime };
      }
      emit(`Deleting site...\n`);
      const result = await callSiteApi("delete", { siteId });
      return {
        success: !!result.ok,
        result: { message: result.ok ? `Site "${result.deleted}" permanently deleted.` : String(result.error) },
        error: result.ok ? undefined : String(result.error || "Delete failed"),
        agent: "pages",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    if (toolName === "site_unpublish") {
      const siteId = String(params.siteId || "");
      if (!siteId) {
        return { success: false, error: "siteId required", agent: "pages", toolName, executionTime: Date.now() - startTime };
      }
      emit(`Taking site offline...\n`);
      const result = await callSiteApi("unpublish", { siteId });
      return {
        success: !!result.ok,
        result: { message: String(result.message || (result.ok ? "Site unpublished." : result.error)) },
        error: result.ok ? undefined : String(result.error || "Unpublish failed"),
        agent: "pages",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    return { success: false, error: `Unknown site tool: ${toolName}`, agent: "pages", toolName, executionTime: Date.now() - startTime };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg, agent: "pages", toolName, executionTime: Date.now() - startTime };
  }
}

/**
 * Execute a handshake tool (agent-to-agent communication).
 * Sends a message to the partner session via the handshake API.
 */
async function executeHandshakeTool(
  toolName: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number
): Promise<ToolResult> {
  if (toolName !== "handshake_send") {
    return {
      success: false,
      error: `Unknown handshake tool: ${toolName}`,
      agent: "handshake",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  const handshakeId = context.activeHandshakeId;
  const partnerSessionId = context.handshakePartnerSessionId;
  const partnerName = context.handshakePartnerName || "Partner Agent";

  if (!handshakeId || !partnerSessionId) {
    return {
      success: false,
      error: "No active handshake connection. Connect to another agent pane first.",
      agent: "handshake",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  const message = typeof params.message === "string" ? params.message : "";
  const extraContext = typeof params.context === "string" ? params.context : "";
  const fullContent = extraContext ? `${message}\n\n---\nContext:\n${extraContext}` : message;

  if (!fullContent.trim()) {
    return {
      success: false,
      error: "Message content is required",
      agent: "handshake",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }

  try {
    const baseUrl = context.appBaseUrl || "";
    const res = await fetch(`${baseUrl}/api/handshake/${handshakeId}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(context.cookies ? { Cookie: context.cookies } : {}),
      },
      body: JSON.stringify({
        fromSessionId: context.orchestratorSessionId,
        partnerSessionId: context.handshakePartnerSessionId || undefined,
        content: fullContent,
        metadata: {
          fromAgent: "orchestrator",
          toolName,
        },
      }),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      return {
        success: false,
        error: `Handshake send failed (HTTP ${res.status}): ${errorBody}`,
        agent: "handshake",
        toolName,
        executionTime: Date.now() - startTime,
      };
    }

    const data = await res.json();
    return {
      success: true,
      result: {
        sent: true,
        toSessionId: data.toSessionId,
        partnerName,
        messageId: data.message?.id,
        message: `Message stored in ${partnerName}'s session: "${fullContent.slice(0, 200)}${fullContent.length > 200 ? "..." : ""}"`,
      },
      agent: "handshake",
      toolName,
      executionTime: Date.now() - startTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Handshake send error: ${msg}`,
      agent: "handshake",
      toolName,
      executionTime: Date.now() - startTime,
    };
  }
}

/**
 * Execute multiple tools in sequence
 */
export async function executeToolChain(
  toolCalls: Array<{ toolName: string; params: Record<string, unknown> }>,
  context: ToolExecutionContext,
  onToolComplete?: (result: ToolResult, index: number) => void
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const { toolName, params } = toolCalls[i];
    const result = await executeTool(toolName, params, context);
    results.push(result);
    onToolComplete?.(result, i);
  }

  return results;
}
