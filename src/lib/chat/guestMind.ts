export type GuestMindProfile = {
  surface?: unknown;
  authorization_stance?: unknown;
  authorizationStance?: unknown;
  memory_scope?: unknown;
  memoryScope?: unknown;
  inherit_workspace_skills?: unknown;
  inheritWorkspaceSkills?: unknown;
  inherit_workspace_integrations?: unknown;
  inheritWorkspaceIntegrations?: unknown;
} | null;

export const GUEST_SAFE_MIND_REQUIREMENT =
  "Guest channels require a Mind with the External & guests audience, Restricted authorization, isolated memory, and explicit capability grants.";

/**
 * Profiles returned directly from PostgREST use snake_case, while resolved
 * harness profiles use camelCase. Keep the security predicate identical at
 * every entry point.
 */
export function isGuestSafeMind(profile: GuestMindProfile): boolean {
  if (!profile) return false;
  const authorization =
    profile.authorization_stance ?? profile.authorizationStance;
  const memory = profile.memory_scope ?? profile.memoryScope;
  const inheritsSkills =
    profile.inherit_workspace_skills ?? profile.inheritWorkspaceSkills;
  const inheritsIntegrations =
    profile.inherit_workspace_integrations ??
    profile.inheritWorkspaceIntegrations;
  return (
    profile.surface === "external" &&
    authorization === "restricted" &&
    memory === "profile" &&
    inheritsSkills === false &&
    inheritsIntegrations === false
  );
}
