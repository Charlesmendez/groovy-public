// Input sanitization shared by the harness profile API routes.

export const PROFILE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EXTERNAL_PROFILE_TOOLS = new Set([
  "web_search",
  "WebSearch",
  "files_agent_request",
  "remember",
  "recall",
  "wiki_search",
  "wiki_read",
  "wiki_file_learning",
  "data_query",
]);

export function slugifyProfileName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function sanitizeProfilePatch(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 120);
  if (typeof body.slug === "string" && PROFILE_SLUG_RE.test(body.slug)) patch.slug = body.slug;
  for (const key of ["description", "persona_prompt", "purpose", "tone", "custom_instructions"] as const) {
    if (key in body) {
      const v = body[key];
      patch[key] = typeof v === "string" && v.trim() ? v : null;
    }
  }
  if (body.authorization_stance === "operator" || body.authorization_stance === "restricted") {
    patch.authorization_stance = body.authorization_stance;
  }
  if ("model" in body) {
    const m = body.model as Record<string, unknown> | null;
    if (
      m &&
      typeof m === "object" &&
      (m.provider === "anthropic" || m.provider === "openai") &&
      typeof m.model === "string" &&
      m.model.trim()
    ) {
      patch.model = {
        provider: m.provider,
        model: m.model.trim(),
        reasoningEffort: typeof m.reasoningEffort === "string" ? m.reasoningEffort : null,
      };
    } else {
      patch.model = null;
    }
  }
  if ("tool_policy" in body) {
    const tp = body.tool_policy as Record<string, unknown> | null;
    patch.tool_policy =
      tp && tp.mode === "allowlist" && Array.isArray(tp.tools)
        ? {
            mode: "allowlist",
            tools: tp.tools.map((t) => String(t)).filter(Boolean).slice(0, 200),
            dataSources: Array.isArray(tp.dataSources)
              ? tp.dataSources.map((source) => String(source)).filter(Boolean).slice(0, 200)
              : undefined,
          }
        : { mode: "all" };
  }
  if ("agent_roster" in body) {
    patch.agent_roster = Array.isArray(body.agent_roster)
      ? body.agent_roster.map((v) => String(v)).filter(Boolean).slice(0, 200)
      : null;
  }
  if (body.memory_scope === "shared" || body.memory_scope === "profile") {
    patch.memory_scope = body.memory_scope;
  }
  if (body.surface === "internal" || body.surface === "external") patch.surface = body.surface;
  if ("widget_config" in body) {
    patch.widget_config =
      body.widget_config && typeof body.widget_config === "object" ? body.widget_config : null;
  }
  if (typeof body.inherit_workspace_skills === "boolean") {
    patch.inherit_workspace_skills = body.inherit_workspace_skills;
  }
  if (typeof body.inherit_workspace_integrations === "boolean") {
    patch.inherit_workspace_integrations = body.inherit_workspace_integrations;
  }
  if (typeof body.is_default === "boolean") patch.is_default = body.is_default;
  // DB check constraint: external surface requires the restricted stance.
  if (patch.surface === "external") {
    patch.authorization_stance = "restricted";
    patch.memory_scope = "profile";
    patch.inherit_workspace_skills = false;
    patch.inherit_workspace_integrations = false;
    const toolPolicy =
      patch.tool_policy && typeof patch.tool_policy === "object"
        ? (patch.tool_policy as Record<string, unknown>)
        : null;
    patch.tool_policy = {
      mode: "allowlist",
      tools:
        toolPolicy?.mode === "allowlist" && Array.isArray(toolPolicy.tools)
          ? toolPolicy.tools
              .map(String)
              .filter((tool) => EXTERNAL_PROFILE_TOOLS.has(tool))
          : [
              "web_search",
              "files_agent_request",
              "remember",
              "recall",
              "wiki_search",
              "wiki_read",
              "wiki_file_learning",
            ],
      dataSources:
        toolPolicy?.mode === "allowlist" && Array.isArray(toolPolicy.dataSources)
          ? toolPolicy.dataSources.map(String).filter(Boolean).slice(0, 200)
          : undefined,
    };
  }
  return patch;
}
