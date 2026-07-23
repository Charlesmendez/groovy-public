import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normalizeIntegrationAssignments } from "@/lib/integrations/assignments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function supportsFlow(targets: unknown): boolean {
  if (!Array.isArray(targets)) return true;
  const normalized = targets.map(String);
  return normalized.includes("all") || normalized.includes("flow");
}

async function loadContext(id: string, requireWrite: boolean) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw Object.assign(new Error("Unauthorized"), { status: 401 });

  const admin = createSupabaseAdminClient();
  const { data: profile, error: profileError } = await admin
    .from("orchestrator_profiles")
    .select(
      "id,user_id,workspace_id,surface,inherit_workspace_skills,inherit_workspace_integrations",
    )
    .eq("id", id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) throw Object.assign(new Error("Mind not found"), { status: 404 });

  let workspaceId =
    typeof profile.workspace_id === "string" ? profile.workspace_id : null;
  let workspaceRole: string | null = null;
  if (workspaceId) {
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    workspaceRole = typeof membership?.role === "string" ? membership.role : null;
    if (!workspaceRole || workspaceRole === "guest") {
      throw Object.assign(new Error("Mind not found"), { status: 404 });
    }
    if (requireWrite && workspaceRole !== "admin") {
      throw Object.assign(new Error("Admin access required"), { status: 403 });
    }
  } else {
    if (profile.user_id !== user.id) {
      throw Object.assign(new Error("Mind not found"), { status: 404 });
    }
    const { data: membership } = await admin
      .from("workspace_members")
      .select("workspace_id,role")
      .eq("user_id", user.id)
      .neq("role", "guest")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    workspaceId =
      typeof membership?.workspace_id === "string" ? membership.workspace_id : null;
    workspaceRole = typeof membership?.role === "string" ? membership.role : null;
  }
  if (!workspaceId) {
    throw Object.assign(
      new Error("A workspace is required before capabilities can be assigned"),
      { status: 409 },
    );
  }

  const { data: workspace } = await admin
    .from("workspaces")
    .select("billing_admin_user_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!workspace) {
    throw Object.assign(new Error("Workspace not found"), { status: 404 });
  }

  return {
    admin,
    user,
    profile,
    workspaceId,
    workspaceRole,
    integrationOwnerId: String(workspace.billing_admin_user_id),
  };
}

async function loadCapabilities(id: string) {
  const context = await loadContext(id, false);
  const {
    admin,
    profile,
    workspaceId,
    integrationOwnerId,
  } = context;
  const [
    artifactsResult,
    profileSkillResult,
    workspaceSkillResult,
    integrationsResult,
    profileIntegrationResult,
    preferencesResult,
  ] = await Promise.all([
    admin
      .from("workspace_skill_artifacts")
      .select(
        "id,artifact_type,name,description,relative_path,targets,lifecycle,updated_at",
      )
      .eq("workspace_id", workspaceId)
      .neq("lifecycle", "archived")
      .order("name", { ascending: true }),
    admin
      .from("workspace_skill_assignments")
      .select("id,artifact_id")
      .eq("workspace_id", workspaceId)
      .eq("profile_id", id)
      .eq("enabled", true)
      .in("target", ["all", "flow"]),
    admin
      .from("workspace_skill_assignments")
      .select("artifact_id")
      .eq("workspace_id", workspaceId)
      .is("profile_id", null)
      .is("agent_id", null)
      .eq("enabled", true)
      .in("target", ["all", "flow"]),
    admin
      .from("datagran_agent_configs")
      .select(
        "agent_id,provider,connection_id,agents!datagran_agent_configs_agent_id_fkey(name)",
      )
      .eq("user_id", integrationOwnerId)
      .order("created_at", { ascending: true }),
    admin
      .from("orchestrator_profile_integrations")
      .select("integration_agent_id")
      .eq("profile_id", id),
    admin
      .from("user_preferences")
      .select("onboarding_data")
      .eq("user_id", integrationOwnerId)
      .maybeSingle(),
  ]);
  for (const result of [
    artifactsResult,
    profileSkillResult,
    workspaceSkillResult,
    integrationsResult,
    profileIntegrationResult,
    preferencesResult,
  ]) {
    if (result.error) throw result.error;
  }

  const profileSkillIds = new Set(
    (profileSkillResult.data || []).map((row) => String(row.artifact_id)),
  );
  const workspaceSkillIds = new Set(
    (workspaceSkillResult.data || []).map((row) => String(row.artifact_id)),
  );
  const profileIntegrationIds = new Set(
    (profileIntegrationResult.data || []).map((row) =>
      String(row.integration_agent_id),
    ),
  );
  const onboardingData =
    preferencesResult.data?.onboarding_data &&
    typeof preferencesResult.data.onboarding_data === "object" &&
    !Array.isArray(preferencesResult.data.onboarding_data)
      ? (preferencesResult.data.onboarding_data as Record<string, unknown>)
      : {};
  const explicitIntegrationAssignments = normalizeIntegrationAssignments(
    onboardingData.integrationAssignments,
  );
  const inheritedIntegrationIds = new Set(
    explicitIntegrationAssignments
      ? explicitIntegrationAssignments.orchestrator
      : (integrationsResult.data || []).map((row) => String(row.agent_id)),
  );

  return {
    context,
    payload: {
      inheritWorkspaceSkills: profile.inherit_workspace_skills !== false,
      inheritWorkspaceIntegrations:
        profile.inherit_workspace_integrations !== false,
      skills: (artifactsResult.data || [])
        .filter((artifact) => supportsFlow(artifact.targets))
        .map((artifact) => ({
          id: String(artifact.id),
          type: artifact.artifact_type,
          name: artifact.name,
          description: artifact.description,
          relativePath: artifact.relative_path,
          granted: profileSkillIds.has(String(artifact.id)),
          inherited: workspaceSkillIds.has(String(artifact.id)),
        })),
      integrations: (integrationsResult.data || []).map((row) => {
        const relation = Array.isArray(row.agents) ? row.agents[0] : row.agents;
        return {
          id: String(row.agent_id),
          name:
            relation && typeof relation === "object" && "name" in relation
              ? String(
                  (relation as { name?: unknown }).name ||
                    row.provider ||
                    "Data integration",
                )
              : String(row.provider || "Data integration"),
          provider: String(row.provider || ""),
          connected:
            typeof row.connection_id === "string" &&
            row.connection_id.trim().length > 0,
          granted: profileIntegrationIds.has(String(row.agent_id)),
          inherited: inheritedIntegrationIds.has(String(row.agent_id)),
        };
      }),
    },
  };
}

export async function GET(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { payload } = await loadCapabilities(id);
    return NextResponse.json(payload);
  } catch (error) {
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? Number((error as { status: number }).status)
        : 500;
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load capabilities",
      },
      { status },
    );
  }
}

export async function PUT(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const context = await loadContext(id, true);
    const { admin, user, workspaceId, integrationOwnerId } = context;
    const isExternal = context.profile.surface === "external";
    const requestedSkillIds = stringIds(body.skillArtifactIds);
    const requestedIntegrationIds = stringIds(body.integrationIds);
    const inheritWorkspaceSkills =
      !isExternal && body.inheritWorkspaceSkills !== false;
    const inheritWorkspaceIntegrations =
      !isExternal && body.inheritWorkspaceIntegrations !== false;

    const [{ data: artifacts, error: artifactError }, { data: integrations, error: integrationError }] =
      await Promise.all([
        requestedSkillIds.length
          ? admin
              .from("workspace_skill_artifacts")
              .select("id,targets")
              .eq("workspace_id", workspaceId)
              .in("id", requestedSkillIds)
          : Promise.resolve({ data: [], error: null }),
        requestedIntegrationIds.length
          ? admin
              .from("datagran_agent_configs")
              .select("agent_id,connection_id")
              .eq("user_id", integrationOwnerId)
              .in("agent_id", requestedIntegrationIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
    if (artifactError) throw artifactError;
    if (integrationError) throw integrationError;

    const validSkillIds = new Set(
      (artifacts || [])
        .filter((artifact) => supportsFlow(artifact.targets))
        .map((artifact) => String(artifact.id)),
    );
    const validIntegrationIds = new Set(
      (integrations || [])
        .filter(
          (integration) =>
            typeof integration.connection_id === "string" &&
            integration.connection_id.trim().length > 0,
        )
        .map((integration) => String(integration.agent_id)),
    );
    if (
      validSkillIds.size !== requestedSkillIds.length ||
      validIntegrationIds.size !== requestedIntegrationIds.length
    ) {
      return NextResponse.json(
        { error: "One or more capabilities are invalid or disconnected" },
        { status: 400 },
      );
    }

    const [
      { data: currentSkills, error: currentSkillsError },
      { data: currentIntegrations, error: currentIntegrationsError },
    ] = await Promise.all([
      admin
        .from("workspace_skill_assignments")
        .select("id,artifact_id")
        .eq("workspace_id", workspaceId)
        .eq("profile_id", id),
      admin
        .from("orchestrator_profile_integrations")
        .select("integration_agent_id")
        .eq("profile_id", id),
    ]);
    if (currentSkillsError) throw currentSkillsError;
    if (currentIntegrationsError) throw currentIntegrationsError;

    const currentSkillIds = new Set(
      (currentSkills || []).map((row) => String(row.artifact_id)),
    );
    const currentIntegrationIds = new Set(
      (currentIntegrations || []).map((row) =>
        String(row.integration_agent_id),
      ),
    );

    const skillAdds = requestedSkillIds.filter(
      (artifactId) => !currentSkillIds.has(artifactId),
    );
    const skillRemovals = (currentSkills || []).filter(
      (row) => !validSkillIds.has(String(row.artifact_id)),
    );
    const integrationAdds = requestedIntegrationIds.filter(
      (integrationId) => !currentIntegrationIds.has(integrationId),
    );
    const integrationRemovals = Array.from(currentIntegrationIds).filter(
      (integrationId) => !validIntegrationIds.has(integrationId),
    );

    if (skillAdds.length) {
      const { error } = await admin.from("workspace_skill_assignments").insert(
        skillAdds.map((artifactId) => ({
          workspace_id: workspaceId,
          artifact_id: artifactId,
          agent_id: null,
          profile_id: id,
          target: "flow",
          scope: "profile",
          enabled: true,
          created_by_user_id: user.id,
        })),
      );
      if (error) throw error;
    }
    if (integrationAdds.length) {
      const { error } = await admin
        .from("orchestrator_profile_integrations")
        .insert(
          integrationAdds.map((integrationAgentId) => ({
            profile_id: id,
            integration_agent_id: integrationAgentId,
            workspace_id: workspaceId,
            created_by: user.id,
          })),
        );
      if (error) throw error;
    }
    if (skillRemovals.length) {
      const { error } = await admin
        .from("workspace_skill_assignments")
        .delete()
        .eq("workspace_id", workspaceId)
        .eq("profile_id", id)
        .in(
          "id",
          skillRemovals.map((row) => String(row.id)),
        );
      if (error) throw error;
    }
    if (integrationRemovals.length) {
      const { error } = await admin
        .from("orchestrator_profile_integrations")
        .delete()
        .eq("profile_id", id)
        .in("integration_agent_id", integrationRemovals);
      if (error) throw error;
    }

    const { error: profileUpdateError } = await admin
      .from("orchestrator_profiles")
      .update({
        inherit_workspace_skills: inheritWorkspaceSkills,
        inherit_workspace_integrations: inheritWorkspaceIntegrations,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (profileUpdateError) throw profileUpdateError;

    const { payload } = await loadCapabilities(id);
    return NextResponse.json(payload);
  } catch (error) {
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? Number((error as { status: number }).status)
        : 500;
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to save capabilities",
      },
      { status },
    );
  }
}
