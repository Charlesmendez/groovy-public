import { NextResponse } from "next/server";
import { requireWorkspaceSecretAdmin, workspaceSecretError } from "@/lib/workspace-secrets/context";

export const runtime = "nodejs";
type Params = { params: Promise<{ id: string }> };
const ids = (value: unknown) => Array.from(new Set(Array.isArray(value) ? value.map(String).filter(Boolean) : []));

export async function PUT(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { admin, user, workspaceId } = await requireWorkspaceSecretAdmin();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    const profileIds = ids(body.profileIds), agentIds = ids(body.agentIds), artifactIds = ids(body.artifactIds);
    const [profiles, agents, artifacts] = await Promise.all([
      profileIds.length ? admin.from("orchestrator_profiles").select("id").eq("workspace_id", workspaceId).in("id", profileIds) : Promise.resolve({ data: [], error: null }),
      agentIds.length ? admin.from("workspace_orchestrator_agents").select("agent_id").eq("workspace_id", workspaceId).in("agent_id", agentIds) : Promise.resolve({ data: [], error: null }),
      artifactIds.length ? admin.from("workspace_skill_artifacts").select("id").eq("workspace_id", workspaceId).eq("artifact_type", "skill").in("id", artifactIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (profiles.error || agents.error || artifacts.error) throw profiles.error || agents.error || artifacts.error;
    if ((profiles.data || []).length !== profileIds.length || (agents.data || []).length !== agentIds.length || (artifacts.data || []).length !== artifactIds.length) return NextResponse.json({ error: "Invalid assignment target" }, { status: 400 });
    const { data: secret } = await admin.from("workspace_secret_definitions").select("id").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
    if (!secret) return NextResponse.json({ error: "Secret not found" }, { status: 404 });
    const [currentProfiles, currentAgents, currentArtifacts] = await Promise.all([
      admin.from("workspace_secret_profile_grants").select("profile_id").eq("workspace_id", workspaceId).eq("secret_id", id),
      admin.from("workspace_secret_agent_grants").select("agent_id").eq("workspace_id", workspaceId).eq("secret_id", id),
      admin.from("workspace_secret_artifact_grants").select("artifact_id").eq("workspace_id", workspaceId).eq("secret_id", id),
    ]);
    for (const result of [currentProfiles, currentAgents, currentArtifacts]) if (result.error) throw result.error;
    const inserts = [
      profileIds.length ? admin.from("workspace_secret_profile_grants").upsert(profileIds.map((profile_id) => ({ workspace_id: workspaceId, secret_id: id, profile_id, created_by: user.id })), { onConflict: "secret_id,profile_id" }) : null,
      agentIds.length ? admin.from("workspace_secret_agent_grants").upsert(agentIds.map((agent_id) => ({ workspace_id: workspaceId, secret_id: id, agent_id, created_by: user.id })), { onConflict: "secret_id,agent_id" }) : null,
      artifactIds.length ? admin.from("workspace_secret_artifact_grants").upsert(artifactIds.map((artifact_id) => ({ workspace_id: workspaceId, secret_id: id, artifact_id, created_by: user.id })), { onConflict: "secret_id,artifact_id" }) : null,
    ].filter(Boolean);
    const results = await Promise.all(inserts); for (const result of results) if (result?.error) throw result.error;
    const removals = [
      ...((currentProfiles.data || []).map((row) => String(row.profile_id)).filter((value) => !profileIds.includes(value)).map((profileId) => admin.from("workspace_secret_profile_grants").delete().eq("secret_id", id).eq("profile_id", profileId))),
      ...((currentAgents.data || []).map((row) => String(row.agent_id)).filter((value) => !agentIds.includes(value)).map((agentId) => admin.from("workspace_secret_agent_grants").delete().eq("secret_id", id).eq("agent_id", agentId))),
      ...((currentArtifacts.data || []).map((row) => String(row.artifact_id)).filter((value) => !artifactIds.includes(value)).map((artifactId) => admin.from("workspace_secret_artifact_grants").delete().eq("secret_id", id).eq("artifact_id", artifactId))),
    ];
    const removalResults = await Promise.all(removals); for (const result of removalResults) if (result.error) throw result.error;
    return NextResponse.json({ ok: true });
  } catch (error) { const out = workspaceSecretError(error, "Failed to save assignments"); return NextResponse.json({ error: out.message }, { status: out.status }); }
}

export async function DELETE(_req: Request, { params }: Params) {
  try { const { id } = await params; const { admin, workspaceId } = await requireWorkspaceSecretAdmin(); const { data: configured, error: readinessError } = await admin.from("workspace_secret_device_readiness").select("device_id").eq("workspace_id", workspaceId).eq("secret_id", id).eq("configured", true); if (readinessError) throw readinessError; if (configured?.length) return NextResponse.json({ error: "Remove this secret from every configured Connector before deleting its declaration" }, { status: 409 }); const { error } = await admin.from("workspace_secret_definitions").delete().eq("workspace_id", workspaceId).eq("id", id); if (error) throw error; return NextResponse.json({ ok: true }); }
  catch (error) { const out = workspaceSecretError(error, "Failed to delete secret"); return NextResponse.json({ error: out.message }, { status: out.status }); }
}
