import type {
  HarnessProfile,
  HarnessProfileToolPolicy,
} from "./harnessProfiles";

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
]);

const EXTERNAL_HARD_BLOCKED_PREFIXES = [
  "browser_",
  "credential_",
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
  };
}

export function isConnectorToolName(toolName: string): boolean {
  if (toolName === "files_agent_request") return false;
  return (
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
  if (!context) return null;
  const name = String(toolName || "").trim();
  if (!name) return "Harness tool policy blocked an unnamed tool.";

  // Public API turns can never reach a connector, even if a profile is
  // accidentally changed back to an internal/all-tools policy.
  if (
    (context.provider === "api" || context.provider === "scheduler_cloud") &&
    isConnectorToolName(name)
  ) {
    return `Harness tool policy blocked "${name}": connector tools are unavailable to ${context.provider === "api" ? "public API" : "cloud scheduler"} turns.`;
  }

  if (context.surface === "external") {
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
