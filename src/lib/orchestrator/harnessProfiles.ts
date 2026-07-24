/**
 * Harness profiles ("Minds"): the configurable identity layer of the
 * orchestrator. A profile owns WHO the orchestrator is — persona, purpose,
 * tone, authorization stance, brain, tool policy, agent roster, memory scope.
 * The kernel (how tools, memory, compaction, and delegation mechanically work)
 * stays in code and is identical for every profile.
 *
 * Resolution is backed by `orchestrator_profiles`; installs with no rows use
 * the built-in profile below.
 */

export type HarnessProfileAuthorizationStance = "operator" | "restricted";

export type HarnessProfileModel = {
  provider: "anthropic" | "openai";
  model: string;
  reasoningEffort: string | null;
};

export type HarnessProfileToolPolicy =
  | { mode: "all" }
  | { mode: "allowlist"; tools: string[]; dataSources?: string[] };

export type HarnessProfile = {
  id: string;
  name: string;
  slug: string;
  /** Free-form identity + soul text. null = the built-in Groovy persona. */
  personaPrompt: string | null;
  purpose: string | null;
  tone: string | null;
  customInstructions: string | null;
  authorizationStance: HarnessProfileAuthorizationStance;
  /** null = fall back to the user's orchestrator model preference / env default. */
  model: HarnessProfileModel | null;
  toolPolicy: HarnessProfileToolPolicy;
  /** Agent ids this profile may see/delegate to. null = all of the user's agents. */
  agentRoster: string[] | null;
  memoryScope: "shared" | "profile";
  surface: "internal" | "external";
  widgetConfig: Record<string, unknown> | null;
  /** Include workspace-wide Flow skill/doc assignments before profile grants. */
  inheritWorkspaceSkills: boolean;
  /** Include the legacy workspace orchestrator integration assignment set. */
  inheritWorkspaceIntegrations: boolean;
  isDefault: boolean;
};

/**
 * The built-in profile. `personaPrompt: null` routes prompt building to the
 * verbatim historical persona text (see profilePrompt.ts), so a user with no
 * profile rows gets a byte-identical system prompt to the pre-profiles code.
 */
export type OrchestratorProfileRow = {
  id: string;
  workspace_id: string | null;
  user_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  persona_prompt: string | null;
  purpose: string | null;
  tone: string | null;
  custom_instructions: string | null;
  authorization_stance: string;
  model: unknown;
  tool_policy: unknown;
  agent_roster: unknown;
  memory_scope: string;
  surface: string;
  widget_config: unknown;
  inherit_workspace_skills?: boolean | null;
  inherit_workspace_integrations?: boolean | null;
  is_default: boolean;
  cloned_from: string | null;
};

function parseModel(value: unknown): HarnessProfileModel | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const provider = v.provider === "openai" ? "openai" : v.provider === "anthropic" ? "anthropic" : null;
  const model = typeof v.model === "string" ? v.model.trim() : "";
  if (!provider || !model) return null;
  return {
    provider,
    model,
    reasoningEffort: typeof v.reasoningEffort === "string" ? v.reasoningEffort : null,
  };
}

function parseToolPolicy(value: unknown): HarnessProfileToolPolicy {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v.mode === "allowlist" && Array.isArray(v.tools)) {
      return {
        mode: "allowlist",
        tools: v.tools.map((t) => String(t)).filter(Boolean),
        dataSources: Array.isArray(v.dataSources)
          ? v.dataSources.map((source) => String(source)).filter(Boolean)
          : undefined,
      };
    }
  }
  return { mode: "all" };
}

function parseAgentRoster(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((v) => String(v)).filter(Boolean);
}

export function profileRowToHarnessProfile(row: OrchestratorProfileRow): HarnessProfile {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    personaPrompt: row.persona_prompt,
    purpose: row.purpose,
    tone: row.tone,
    customInstructions: row.custom_instructions,
    authorizationStance: row.authorization_stance === "restricted" ? "restricted" : "operator",
    model: parseModel(row.model),
    toolPolicy: parseToolPolicy(row.tool_policy),
    agentRoster: parseAgentRoster(row.agent_roster),
    memoryScope: row.memory_scope === "profile" ? "profile" : "shared",
    surface: row.surface === "external" ? "external" : "internal",
    widgetConfig:
      row.widget_config && typeof row.widget_config === "object" && !Array.isArray(row.widget_config)
        ? (row.widget_config as Record<string, unknown>)
        : null,
    inheritWorkspaceSkills: row.inherit_workspace_skills !== false,
    inheritWorkspaceIntegrations: row.inherit_workspace_integrations !== false,
    isDefault: row.is_default,
  };
}

type SupabaseLike = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/**
 * Resolve which profile powers this turn. Order:
 *   1. explicitProfileId (UI switcher, channel binding, API key binding)
 *   2. the session's sticky profile_id
 *   3. the external thread's sticky profile_id (connector entry points)
 *   4. the current workspace's default profile
 *   5. the user's personal default profile
 *   6. null → caller falls back to DEFAULT_GROOVY_PROFILE (built-in persona)
 *
 * Ownership is checked explicitly (row.user_id match, or workspace membership)
 * so callers may pass either an RLS user client or a service-role client.
 */
export async function resolveHarnessProfile(
  supabase: SupabaseLike,
  opts: {
    userId: string;
    workspaceId?: string | null;
    explicitProfileId?: string | null;
    sessionProfileId?: string | null;
    provider?: string | null;
    threadKey?: string | null;
  },
): Promise<HarnessProfile | null> {
  const loadById = async (id: string): Promise<HarnessProfile | null> => {
    const { data, error } = await supabase
      .from("orchestrator_profiles")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as OrchestratorProfileRow;
    if (row.workspace_id) {
      const { data: member, error: memberError } = await supabase
        .from("workspace_members")
        .select("user_id,role")
        .eq("workspace_id", row.workspace_id)
        .eq("user_id", opts.userId)
        .maybeSingle();
      if (memberError) throw new Error(memberError.message);
      if (member && (member.role === "admin" || member.role === "member")) {
        return profileRowToHarnessProfile(row);
      }
      return null;
    }
    return row.user_id === opts.userId
      ? profileRowToHarnessProfile(row)
      : null;
  };

  if (opts.explicitProfileId) {
    // An explicit binding is an authorization decision. Never silently replace
    // an unavailable selection with a broader default profile.
    return loadById(opts.explicitProfileId);
  }
  if (opts.sessionProfileId) {
    // A sticky session binding is an authorization decision too. Falling
    // through would silently widen the session to the built-in all-tools
    // profile when the bound row becomes inaccessible.
    return loadById(opts.sessionProfileId);
  }
  if (opts.provider && opts.threadKey) {
    const { data: thread, error: threadError } = await supabase
      .from("orchestrator_external_threads")
      .select("profile_id")
      .eq("user_id", opts.userId)
      .eq("provider", opts.provider)
      .eq("thread_key", opts.threadKey)
      .maybeSingle();
    if (threadError) throw new Error(threadError.message);
    if (thread?.profile_id) {
      return loadById(String(thread.profile_id));
    }
  }
  let effectiveWorkspaceId = opts.workspaceId || null;
  if (!effectiveWorkspaceId) {
    let { data: preferences, error: preferencesError } = await supabase
      .from("user_preferences")
      .select("active_workspace_id,onboarding_data")
      .eq("user_id", opts.userId)
      .maybeSingle();
    if (
      preferencesError &&
      (preferencesError.code === "PGRST204" ||
        preferencesError.message.includes("active_workspace_id"))
    ) {
      const fallback = await supabase
        .from("user_preferences")
        .select("onboarding_data")
        .eq("user_id", opts.userId)
        .maybeSingle();
      preferences = fallback.data;
      preferencesError = fallback.error;
    }
    if (preferencesError) throw new Error(preferencesError.message);
    const onboardingData =
      preferences?.onboarding_data &&
      typeof preferences.onboarding_data === "object" &&
      !Array.isArray(preferences.onboarding_data)
        ? (preferences.onboarding_data as Record<string, unknown>)
        : null;
    const preferredWorkspaceId =
      typeof preferences?.active_workspace_id === "string"
        ? preferences.active_workspace_id
        : typeof onboardingData?.activeWorkspaceId === "string"
          ? onboardingData.activeWorkspaceId
          : null;
    const membershipQuery = supabase
      .from("workspace_members")
      .select("workspace_id,role")
      .eq("user_id", opts.userId)
      .in("role", ["admin", "member"]);
    const { data: membership, error: membershipError } =
      preferredWorkspaceId
        ? await membershipQuery
            .eq("workspace_id", preferredWorkspaceId)
            .maybeSingle()
        : await membershipQuery
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
    if (membershipError) throw new Error(membershipError.message);
    effectiveWorkspaceId =
      typeof membership?.workspace_id === "string"
        ? membership.workspace_id
        : null;
  }
  if (effectiveWorkspaceId) {
    const { data: workspaceDefault, error: workspaceDefaultError } = await supabase
      .from("orchestrator_profiles")
      .select("*")
      .eq("workspace_id", effectiveWorkspaceId)
      .eq("is_default", true)
      .maybeSingle();
    if (workspaceDefaultError) throw new Error(workspaceDefaultError.message);
    if (workspaceDefault) {
      const profile = await loadById(String(workspaceDefault.id));
      if (profile) return profile;
    }
  }
  const { data: personalDefault, error: personalDefaultError } = await supabase
    .from("orchestrator_profiles")
    .select("*")
    .eq("user_id", opts.userId)
    .is("workspace_id", null)
    .eq("is_default", true)
    .maybeSingle();
  if (personalDefaultError) throw new Error(personalDefaultError.message);
  if (personalDefault) {
    return profileRowToHarnessProfile(personalDefault as OrchestratorProfileRow);
  }
  return null;
}

export const DEFAULT_GROOVY_PROFILE: HarnessProfile = {
  id: "__default__",
  name: "Groovy",
  slug: "groovy",
  personaPrompt: null,
  purpose: null,
  tone: null,
  customInstructions: null,
  authorizationStance: "operator",
  model: null,
  toolPolicy: { mode: "all" },
  agentRoster: null,
  memoryScope: "shared",
  surface: "internal",
  widgetConfig: null,
  inheritWorkspaceSkills: true,
  inheritWorkspaceIntegrations: true,
  isDefault: true,
};
