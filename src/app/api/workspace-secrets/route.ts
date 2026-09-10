import { NextResponse } from "next/server";
import { requireWorkspaceSecretAdmin, workspaceSecretError } from "@/lib/workspace-secrets/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY_RE = /^[A-Z][A-Z0-9_]{1,127}$/;

async function loadPayload() {
  const { admin, user, workspaceId } = await requireWorkspaceSecretAdmin();
  const [secrets, profiles, agents, artifacts, devices, profileGrants, agentGrants, artifactGrants, readiness] = await Promise.all([
    admin.from("workspace_secret_definitions").select("id,name,key,description,created_at,updated_at").eq("workspace_id", workspaceId).order("name"),
    admin.from("orchestrator_profiles").select("id,name,surface").eq("workspace_id", workspaceId).order("name"),
    admin.from("workspace_orchestrator_agents").select("agent_id,agents!workspace_orchestrator_agents_agent_id_fkey(name)").eq("workspace_id", workspaceId),
    admin.from("workspace_skill_artifacts").select("id,name,artifact_type,relative_path,metadata,lifecycle").eq("workspace_id", workspaceId).eq("artifact_type", "skill").neq("lifecycle", "archived").order("name"),
    admin.from("devices").select("id,name,last_seen").eq("user_id", user.id).order("name"),
    admin.from("workspace_secret_profile_grants").select("secret_id,profile_id").eq("workspace_id", workspaceId),
    admin.from("workspace_secret_agent_grants").select("secret_id,agent_id").eq("workspace_id", workspaceId),
    admin.from("workspace_secret_artifact_grants").select("secret_id,artifact_id").eq("workspace_id", workspaceId),
    admin.from("workspace_secret_device_readiness").select("secret_id,device_id,configured,configured_at,updated_at").eq("workspace_id", workspaceId),
  ]);
  for (const result of [secrets, profiles, agents, artifacts, devices, profileGrants, agentGrants, artifactGrants, readiness]) if (result.error) throw result.error;
  const mapIds = (rows: Array<Record<string, unknown>>, id: string, target: string) => rows.reduce<Record<string, string[]>>((acc, row) => {
    const key = String(row[id]); (acc[key] ||= []).push(String(row[target])); return acc;
  }, {});
  return {
    workspaceId,
    secrets: secrets.data || [],
    profiles: profiles.data || [],
    agents: (agents.data || []).map((row) => { const rel = Array.isArray(row.agents) ? row.agents[0] : row.agents; return { id: String(row.agent_id), name: rel && typeof rel === "object" && "name" in rel ? String(rel.name) : "Agent" }; }),
    artifacts: artifacts.data || [],
    devices: devices.data || [],
    grants: {
      profiles: mapIds((profileGrants.data || []) as Array<Record<string, unknown>>, "secret_id", "profile_id"),
      agents: mapIds((agentGrants.data || []) as Array<Record<string, unknown>>, "secret_id", "agent_id"),
      artifacts: mapIds((artifactGrants.data || []) as Array<Record<string, unknown>>, "secret_id", "artifact_id"),
    },
    readiness: readiness.data || [],
  };
}

export async function GET() {
  try { return NextResponse.json(await loadPayload()); }
  catch (error) { const out = workspaceSecretError(error, "Failed to load secrets"); return NextResponse.json({ error: out.message }, { status: out.status }); }
}

export async function POST(req: Request) {
  try {
    const { admin, user, workspaceId } = await requireWorkspaceSecretAdmin();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const name = String(body?.name || "").trim();
    const key = String(body?.key || "").trim().toUpperCase();
    const description = String(body?.description || "").trim();
    if (!name || name.length > 120 || !KEY_RE.test(key) || description.length > 500) return NextResponse.json({ error: "Enter a valid name and uppercase secret key" }, { status: 400 });
    const { error } = await admin.from("workspace_secret_definitions").insert({ workspace_id: workspaceId, name, key, description, created_by: user.id });
    if (error) throw error;
    return NextResponse.json(await loadPayload(), { status: 201 });
  } catch (error) { const out = workspaceSecretError(error, "Failed to create secret"); return NextResponse.json({ error: out.message }, { status: out.status }); }
}
