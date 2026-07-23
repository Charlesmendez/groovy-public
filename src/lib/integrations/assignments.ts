import type { SupabaseClient } from "@supabase/supabase-js";

export type IntegrationAssignments = {
  version: 1;
  orchestrator: string[];
  workers: Record<string, string[]>;
};

function uniqueIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    )
  );
}

export function normalizeIntegrationAssignments(value: unknown): IntegrationAssignments | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawWorkers =
    record.workers && typeof record.workers === "object" && !Array.isArray(record.workers)
      ? (record.workers as Record<string, unknown>)
      : {};
  const workers: Record<string, string[]> = {};
  for (const [agentId, integrationIds] of Object.entries(rawWorkers)) {
    const cleanAgentId = agentId.trim();
    if (!cleanAgentId) continue;
    workers[cleanAgentId] = uniqueIds(integrationIds);
  }
  return {
    version: 1,
    orchestrator: uniqueIds(record.orchestrator),
    workers,
  };
}

export async function loadIntegrationAssignments(args: {
  supabase: SupabaseClient;
  userId: string;
  availableIntegrationIds?: string[];
  profileId?: string | null;
}): Promise<{ assignments: IntegrationAssignments; explicitlyConfigured: boolean }> {
  const { data } = await args.supabase
    .from("user_preferences")
    .select("onboarding_data")
    .eq("user_id", args.userId)
    .maybeSingle();
  const onboardingData =
    data?.onboarding_data && typeof data.onboarding_data === "object"
      ? (data.onboarding_data as Record<string, unknown>)
      : {};
  const explicit = normalizeIntegrationAssignments(onboardingData.integrationAssignments);
  const inheritedAssignments: IntegrationAssignments = explicit || {
    version: 1,
    orchestrator: uniqueIds(args.availableIntegrationIds || []),
    workers: {},
  };

  const profileId =
    typeof args.profileId === "string" && args.profileId.trim() && args.profileId !== "__default__"
      ? args.profileId.trim()
      : null;
  if (profileId) {
    const [{ data: profile, error: profileError }, { data: grants, error: grantError }] =
      await Promise.all([
        args.supabase
          .from("orchestrator_profiles")
          .select("inherit_workspace_integrations")
          .eq("id", profileId)
          .maybeSingle(),
        args.supabase
          .from("orchestrator_profile_integrations")
          .select("integration_agent_id")
          .eq("profile_id", profileId),
      ]);
    if (profileError) throw new Error(profileError.message);
    if (grantError) throw new Error(grantError.message);
    if (!profile) {
      throw new Error("Harness profile is unavailable for integration assignment resolution");
    }
    const grantedIds = uniqueIds(
      (grants || []).map((row) => row.integration_agent_id),
    );
    const inheritWorkspace = profile.inherit_workspace_integrations !== false;
    return {
      assignments: {
        version: 1,
        orchestrator: inheritWorkspace
          ? uniqueIds([...inheritedAssignments.orchestrator, ...grantedIds])
          : grantedIds,
        workers: inheritedAssignments.workers,
      },
      explicitlyConfigured: !inheritWorkspace || grantedIds.length > 0 || Boolean(explicit),
    };
  }

  if (explicit) return { assignments: explicit, explicitlyConfigured: true };

  // Backward compatibility: integrations used to be globally available to the
  // orchestrator. Preserve that behavior until the user edits assignments.
  return {
    assignments: {
      version: 1,
      orchestrator: inheritedAssignments.orchestrator,
      workers: {},
    },
    explicitlyConfigured: false,
  };
}

export async function saveIntegrationAssignments(args: {
  supabase: SupabaseClient;
  userId: string;
  assignments: IntegrationAssignments;
}): Promise<void> {
  const { data: existing } = await args.supabase
    .from("user_preferences")
    .select("onboarding_data")
    .eq("user_id", args.userId)
    .maybeSingle();
  const onboardingData =
    existing?.onboarding_data && typeof existing.onboarding_data === "object"
      ? (existing.onboarding_data as Record<string, unknown>)
      : {};
  const { error } = await args.supabase.from("user_preferences").upsert(
    {
      user_id: args.userId,
      onboarding_data: {
        ...onboardingData,
        integrationAssignments: args.assignments,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) throw new Error(error.message || "Failed to save integration assignments");
}

export async function ensureOrchestratorIntegrationAssignment(args: {
  supabase: SupabaseClient;
  userId: string;
  integrationId: string;
}): Promise<void> {
  const loaded = await loadIntegrationAssignments({
    supabase: args.supabase,
    userId: args.userId,
    availableIntegrationIds: [args.integrationId],
  });
  if (!loaded.explicitlyConfigured) return;
  if (loaded.assignments.orchestrator.includes(args.integrationId)) return;
  await saveIntegrationAssignments({
    supabase: args.supabase,
    userId: args.userId,
    assignments: {
      ...loaded.assignments,
      orchestrator: [...loaded.assignments.orchestrator, args.integrationId],
    },
  });
}
