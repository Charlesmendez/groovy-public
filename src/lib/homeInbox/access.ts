import type { SupabaseClient } from "@supabase/supabase-js";
import {
  profileRowToHarnessProfile,
  type HarnessProfile,
  type OrchestratorProfileRow,
} from "../orchestrator/harnessProfiles";
import { HomeInboxError, uuid } from "./contracts";
import { HOME_DECISION_TOOLS, HOME_DATA_TOOLS } from "./dataContracts";

export function decisionProfileIssues(profile: HarnessProfile): string[] {
  const issues: string[] = [];
  if (
    profile.surface !== "external" ||
    profile.authorizationStance !== "restricted" ||
    profile.memoryScope !== "profile"
  )
    issues.push("Use an external, restricted Mind with isolated memory.");
  if (profile.inheritWorkspaceIntegrations || profile.inheritWorkspaceSkills)
    issues.push(
      "Turn off inherited workspace integrations and skills for this project Mind.",
    );
  if (profile.toolPolicy.mode !== "allowlist")
    issues.push("Use an explicit tool allowlist.");
  // The existing data_query proxy can write or send. A natural-language
  // 'read only' instruction is not an operation-level authorization boundary.
  // Only the separate Home-granted adapter can provide decision data reads.
  if (
    profile.toolPolicy.mode === "allowlist" &&
    profile.toolPolicy.tools.some((tool) => !HOME_DECISION_TOOLS.includes(tool))
  )
    issues.push(
      "Use supplied inputs, optional web research and the Home data-read tools only. General data_query, actions and unverified adapters are not allowed in Inbox decisions.",
    );
  if (
    profile.toolPolicy.mode === "allowlist" &&
    HOME_DATA_TOOLS.some(
      (tool) =>
        profile.toolPolicy.mode === "allowlist" &&
        profile.toolPolicy.tools.includes(tool),
    ) &&
    !HOME_DATA_TOOLS.every(
      (tool) =>
        profile.toolPolicy.mode === "allowlist" &&
        profile.toolPolicy.tools.includes(tool),
    )
  )
    issues.push(
      "Enable both home_data_operations and home_data_read so this Mind can discover and use its Home grants.",
    );
  return issues;
}

export async function requireProfileAdmin(
  admin: SupabaseClient,
  profileId: string,
  userId: string,
) {
  if (!uuid(profileId) || !uuid(userId))
    throw new HomeInboxError("profile_unavailable", "Mind not found.", 404);
  const { data, error } = await admin
    .from("orchestrator_profiles")
    .select("*")
    .eq("id", profileId)
    .maybeSingle();
  if (error)
    throw new HomeInboxError(
      "profile_check_failed",
      "Could not verify Mind access.",
      503,
    );
  if (!data)
    throw new HomeInboxError("profile_unavailable", "Mind not found.", 404);
  const row = data as OrchestratorProfileRow;
  let allowed = row.user_id === userId;
  if (row.workspace_id) {
    const result = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", row.workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (result.error)
      throw new HomeInboxError(
        "profile_check_failed",
        "Could not verify workspace access.",
        503,
      );
    allowed = result.data?.role === "admin";
  }
  if (!allowed)
    throw new HomeInboxError(
      "profile_admin_required",
      "Only the personal Mind owner or a workspace administrator can manage this connection.",
      403,
    );
  return {
    profile: profileRowToHarnessProfile(row),
    workspaceId: row.workspace_id,
  };
}

export function requireDecisionProfile(profile: HarnessProfile) {
  const issues = decisionProfileIssues(profile);
  if (issues.length)
    throw new HomeInboxError("profile_not_ready", issues.join(" "));
}
