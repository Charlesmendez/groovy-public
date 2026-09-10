import type {
  HarnessProfile,
  HarnessProfileToolPolicy,
} from "./harnessProfiles";
import { HOME_DECISION_TOOLS, isHomeDataTool } from "../homeInbox/dataContracts";

/**
 * Runtime policy copied onto ToolExecutionContext. Keeping this as plain data
 * means every executor path (AI SDK, Agent SDK, and direct executeTool calls)
 * evaluates the same boundary.
 */
export type ToolPolicyExecutionContext = {
  profileId: string | null;
  surface: "internal" | "external";
  provider: string;
  policy: HarnessProfileToolPolicy;
  agentRoster: string[] | null;
  memoryScope: "shared" | "profile";
  memoryScopeId: string | null;
  /**
   * A trusted Team Chat entry point may let a workspace member manage the
   * current channel's schedules even when the channel uses an external Mind.
   * The schedule executor still revalidates the actor and channel in the DB.
   */
  canManageTeamChatSchedules: boolean;
  /** Workspace-wide grants require a freshly verified admin speaker. */
  canManageWorkspaceAssignments: boolean;
};

const EXTERNAL_DEFAULT_TOOLS = new Set([
  "web_search",
  "WebSearch",
  "files_agent_request",
  "remember",
  "recall",
  "wiki_search",
  "wiki_read",
  "wiki_file_learning",
]);

// Public/external profiles may narrow this catalog, but they may never expand
// beyond it. In particular, merely registering a dynamic extension tool must
// not make that tool reachable by adding its name to a profile allowlist.
const EXTERNAL_OPT_IN_TOOLS = new Set([
  ...EXTERNAL_DEFAULT_TOOLS,
  "data_query",
]);

const CHANNEL_AGENT_TOOLS = new Set([
  "list_agents",
  "assign_task",
  "consult_agent",
]);

const CHANNEL_SKILL_MANAGEMENT_TOOLS = new Set([
  "list_channel_skills",
  "create_channel_skill",
  "update_channel_skill_actions",
  "assign_channel_skill",
  "remove_channel_skill",
]);

const CHANNEL_SCHEDULE_MANAGEMENT_TOOLS = new Set([
  "schedule_create",
  "schedule_list",
  "schedule_update",
  "schedule_pause",
  "schedule_resume",
  "schedule_cancel_next",
  "schedule_delete",
]);

const WORKSPACE_SKILL_MANAGEMENT_TOOLS = new Set([
  "list_skills_and_docs",
  "assign_skill_or_doc",
  "remove_skill_or_doc_assignment",
  "list_workspace_secret_assignments",
  "set_workspace_secret_assignment",
]);

const EXTERNAL_HARD_BLOCKED_NAMES = new Set([
  "terminal_exec",
  "code_cli_run",
  "code_open_session",
  "browser_task",
  "computer_use_action",
  "handshake_send",
  "runtime_branch_parallel",
  "assign_skill_or_doc",
  "remove_skill_or_doc_assignment",
  "list_workspace_secret_assignments",
  "set_workspace_secret_assignment",
]);

const EXTERNAL_HARD_BLOCKED_PREFIXES = [
  "browser_",
  "chat_",
  "credential_",
  "email_",
  "obsidian_",
  "whatsapp_",
  "telegram_",
  "schedule_",
  "linkdb_",
  "sqlite_",
  "skill_",
  "site_",
  "start_twilio_",
  "coach_twilio_",
  "get_twilio_",
];

function normalizedAllowlist(policy: HarnessProfileToolPolicy): Set<string> | null {
  if (policy.mode !== "allowlist") return null;
  const allowed = new Set(
    policy.tools.map((name) => String(name).trim()).filter(Boolean),
  );
  // Anthropic exposes native search as `WebSearch` while the AI SDK wrapper
  // uses `web_search`; profile policy is capability-based, not SDK-name-based.
  if (allowed.has("web_search") || allowed.has("WebSearch")) {
    allowed.add("web_search");
    allowed.add("WebSearch");
  }
  return allowed;
}

export function buildToolPolicyExecutionContext(args: {
  profile?: HarnessProfile | null;
  provider?: string | null;
  memoryScopeId?: string | null;
  /**
   * Optional caller-owned roster boundary. When present, even an unrestricted
   * Mind can only discover or delegate to these worker ids. An empty array is
   * an explicit deny-all roster.
   */
  allowedAgentIds?: string[];
  /**
   * Team Chat owns its worker roster per channel. Other entry points retain
   * the safer default of intersecting the caller boundary with the Mind roster.
   */
  agentRosterMode?: "intersect" | "replace";
  canManageTeamChatSchedules?: boolean;
  canManageWorkspaceAssignments?: boolean;
}): ToolPolicyExecutionContext {
  const profile = args.profile ?? null;
  const profileId =
    profile?.id && profile.id !== "__default__" ? profile.id : null;
  const profileAgentRoster = profile?.agentRoster ?? null;
  const callerAgentRoster = Array.isArray(args.allowedAgentIds)
    ? Array.from(new Set(args.allowedAgentIds.map(String).filter(Boolean)))
    : null;
  const agentRoster =
    callerAgentRoster === null
      ? profileAgentRoster
      : args.agentRosterMode === "replace"
        ? callerAgentRoster
      : profileAgentRoster === null
        ? callerAgentRoster
        : profileAgentRoster.filter((agentId) =>
            callerAgentRoster.includes(agentId),
          );
  return {
    profileId,
    surface: profile?.surface === "external" ? "external" : "internal",
    provider: String(args.provider || "dashboard"),
    policy: profile?.toolPolicy ?? { mode: "all" },
    agentRoster,
    memoryScope: profile?.memoryScope === "profile" ? "profile" : "shared",
    memoryScopeId:
      profile?.memoryScope === "profile"
        ? args.memoryScopeId || profileId
        : null,
    canManageTeamChatSchedules:
      args.canManageTeamChatSchedules === true &&
      (args.provider === "team_chat" || args.provider === "team_chat_guest"),
    canManageWorkspaceAssignments:
      args.canManageWorkspaceAssignments === true,
  };
}

export function isConnectorToolName(toolName: string): boolean {
  if (toolName === "files_agent_request") return false;
  return (
    toolName === "run_skill_action" ||
    toolName.startsWith("terminal_") ||
    toolName.startsWith("code_") ||
    toolName === "computer_use_action" ||
    toolName === "site_dev" ||
    toolName === "site_publish" ||
    toolName === "site_read_files" ||
    toolName === "runtime_branch_parallel" ||
    toolName === "skill_registry_validate_draft" ||
    toolName.startsWith("browser_") ||
    toolName.startsWith("credential_") ||
    toolName.startsWith("files_") ||
    toolName.startsWith("obsidian_") ||
    toolName.startsWith("linkdb_") ||
    toolName.startsWith("sqlite_") ||
    toolName.startsWith("whatsapp_")
  );
}

export function toolPolicyDenialReason(
  toolName: string,
  context?: ToolPolicyExecutionContext | null,
): string | null {
  const name = String(toolName || "").trim();
  if (!name) return "Harness tool policy blocked an unnamed tool.";
  if (isHomeDataTool(name) && context?.provider !== "home_inbox")
    return `Harness tool policy blocked "${name}": Home data requires a server-bound Inbox decision.`;

  // Inbox owns all cadence, messaging, transitions and side effects. Apply this
  // before the generic skill/delegation shortcuts, even if a Mind is later
  // edited into an internal/all-tools profile. data_query is not yet a proven
  // read-only boundary and must not provide an indirect sending escape hatch.
  if (context?.provider === "home_inbox") {
    const allowlist = normalizedAllowlist(context.policy);
    if (!HOME_DECISION_TOOLS.includes(name) || !allowlist?.has(name)) {
      return `Harness tool policy blocked "${name}": Home Inbox decisions cannot schedule, send, delegate or use unverified data adapters.`;
    }
    // These names have a stronger provider + explicit grant boundary above;
    // they must not fall through to the generic external capability catalog.
    if (isHomeDataTool(name)) return null;
  }

  if (name === "app_navigate") {
    if (
      !context ||
      context.surface !== "internal" ||
      context.provider !== "private_live_voice"
    ) {
      return `Harness tool policy blocked "${name}": in-app navigation is available only to authenticated Live voice turns.`;
    }
    return null;
  }

  // Cross-channel Chat resolution and sending are global app commands. They
  // must never be reachable from a channel Mind (including an internal one),
  // a guest turn, or an unscoped/public caller.
  if (name === "chat_resolve_channel" || name === "chat_send_message") {
    const trustedChatProvider =
      context?.provider === "dashboard" ||
      context?.provider === "private_live_voice";
    if (
      !context ||
      context.surface !== "internal" ||
      !trustedChatProvider
    ) {
      return `Harness tool policy blocked "${name}": Groovy Chat commands are available only to authenticated dashboard and Live voice turns.`;
    }
  }

  // Native Email tools use private per-user Gmail credentials. A Team Chat
  // round executes with the workspace billing owner's integrations, so even an
  // internal channel Mind must not receive this capability on behalf of a
  // different speaker. Keep the boundary exact and fail closed when unscoped.
  if (name.startsWith("email_")) {
    const trustedEmailProvider =
      context?.provider === "dashboard" ||
      context?.provider === "private_live_voice";
    if (!context || context.surface !== "internal" || !trustedEmailProvider) {
      return `Harness tool policy blocked "${name}": private Email workspace tools are available only to authenticated dashboard and Live voice turns.`;
    }
  }

  if (!context) return null;

  // Public API turns can never reach a connector, even if a profile is
  // accidentally changed back to an internal/all-tools policy.
  if (
    (context.provider === "api" || context.provider === "scheduler_cloud") &&
    isConnectorToolName(name)
  ) {
    return `Harness tool policy blocked "${name}": connector tools are unavailable to ${context.provider === "api" ? "public API" : "cloud scheduler"} turns.`;
  }

  // Skill bodies can only be resolved through a trusted, fail-closed
  // assignment scope. Reading an enabled skill is intrinsic to honoring that
  // assignment, including for custom allowlisted Minds.
  if (name === "read_skill_or_doc") return null;
  if (name === "run_skill_action") return null;

  if (CHANNEL_SKILL_MANAGEMENT_TOOLS.has(name)) {
    const isTeamChat =
      context.provider === "team_chat" ||
      context.provider === "team_chat_guest";
    return isTeamChat
      ? null
      : `Harness tool policy blocked "${name}": channel skill management is available only in Team Chat.`;
  }

  if (CHANNEL_SCHEDULE_MANAGEMENT_TOOLS.has(name)) {
    const isTeamChat =
      context.provider === "team_chat" ||
      context.provider === "team_chat_guest";
    if (isTeamChat && context.canManageTeamChatSchedules) return null;
  }

  if (
    WORKSPACE_SKILL_MANAGEMENT_TOOLS.has(name) &&
    (context.provider === "team_chat" ||
      context.provider === "team_chat_guest")
  ) {
    return context.canManageWorkspaceAssignments
      ? null
      : `Harness tool policy blocked "${name}": workspace-wide assignment management requires the current Team Chat speaker to be a workspace admin.`;
  }

  if (context.surface === "external") {
    // Team Chat is a local-machine operating surface, including channels that
    // contain guests. The connected Mind may use the owner's local shell just
    // as it can in the dashboard; connector execution still goes through the
    // same relay/device boundary and tool-level operating instructions.
    if (
      name === "terminal_exec" &&
      (context.provider === "team_chat" ||
        context.provider === "team_chat_guest")
    ) {
      return null;
    }

    if (
      EXTERNAL_HARD_BLOCKED_NAMES.has(name) ||
      EXTERNAL_HARD_BLOCKED_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      return `Harness tool policy blocked "${name}": external profiles cannot use this capability.`;
    }

    if (CHANNEL_AGENT_TOOLS.has(name)) {
      const isScopedTeamChat =
        (context.provider === "team_chat" ||
          context.provider === "team_chat_guest") &&
        Array.isArray(context.agentRoster);
      return isScopedTeamChat
        ? null
        : `Harness tool policy blocked "${name}": external profiles may delegate only to an explicit, admin-managed Team Chat channel roster.`;
    }

    if (!EXTERNAL_OPT_IN_TOOLS.has(name)) {
      return `Harness tool policy blocked "${name}": it is outside the external capability catalog.`;
    }

    const allowlist = normalizedAllowlist(context.policy);
    const allowed = allowlist ? allowlist.has(name) : EXTERNAL_DEFAULT_TOOLS.has(name);
    if (!allowed) {
      return `Harness tool policy blocked "${name}": external profiles are deny-by-default.`;
    }
    return null;
  }

  const allowlist = normalizedAllowlist(context.policy);
  if (allowlist && !allowlist.has(name)) {
    return `Harness tool policy blocked "${name}": it is not in this profile's allowlist.`;
  }
  return null;
}

export function toolPolicyParameterDenialReason(
  toolName: string,
  params: Record<string, unknown>,
  context?: ToolPolicyExecutionContext | null,
): string | null {
  if (!context || context.surface !== "external" || toolName !== "data_query") {
    return null;
  }
  const configured =
    context.policy.mode === "allowlist" && Array.isArray(context.policy.dataSources)
      ? context.policy.dataSources
      : [];
  const source =
    typeof params.provider === "string"
      ? params.provider.trim()
      : typeof params.source === "string"
        ? params.source.trim()
        : "";
  if (!source || !configured.includes(source)) {
    return `Harness tool policy blocked "data_query": data source "${source || "unspecified"}" is not enabled for this external profile.`;
  }
  return null;
}

export function isToolAllowed(
  toolName: string,
  context?: ToolPolicyExecutionContext | null,
): boolean {
  return toolPolicyDenialReason(toolName, context) === null;
}

export function filterToolsByPolicy<T extends Record<string, unknown>>(
  tools: T,
  context?: ToolPolicyExecutionContext | null,
): T {
  for (const name of Object.keys(tools)) {
    if (!isToolAllowed(name, context)) delete tools[name];
  }
  return tools;
}

export function filterAgentRoster<T extends { id: string }>(
  agents: T[],
  allowedAgentIds?: string[] | null,
): T[] {
  if (!Array.isArray(allowedAgentIds)) return agents;
  const allowed = new Set(allowedAgentIds);
  return agents.filter((agent) => allowed.has(agent.id));
}
