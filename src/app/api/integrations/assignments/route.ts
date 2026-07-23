import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  getOrCreateWorkspaceForUser,
  isWorkspaceOperatorRole,
} from "@/lib/workspaces";
import {
  loadIntegrationAssignments,
  saveIntegrationAssignments,
} from "@/lib/integrations/assignments";

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function loadCatalog(
  supabase: SupabaseClient,
  userId: string
) {
  const [{ data: configs, error: configError }, { data: workers, error: workerError }] =
    await Promise.all([
      supabase
        .from("datagran_agent_configs")
        .select("agent_id,provider,connection_id,agents!datagran_agent_configs_agent_id_fkey(name)")
        .eq("user_id", userId)
        .order("created_at", { ascending: true }),
      supabase
        .from("agents")
        .select("id,name")
        .eq("user_id", userId)
        .eq("type", "claude-code")
        .order("created_at", { ascending: true }),
    ]);
  if (configError) throw new Error(configError.message);
  if (workerError) throw new Error(workerError.message);
  const integrations = (configs || []).map((row) => {
    const relation = Array.isArray(row.agents) ? row.agents[0] : row.agents;
    return {
      id: String(row.agent_id || ""),
      name:
        relation && typeof relation === "object" && "name" in relation
          ? String((relation as { name?: unknown }).name || row.provider || "Data source")
          : String(row.provider || "Data source"),
      provider: String(row.provider || ""),
      connected: typeof row.connection_id === "string" && row.connection_id.trim().length > 0,
    };
  });
  return {
    integrations,
    workers: (workers || []).map((row) => ({ id: String(row.id), name: String(row.name) })),
  };
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const workspace = await getOrCreateWorkspaceForUser();
    if (!isWorkspaceOperatorRole(workspace.role)) {
      return NextResponse.json({ error: "Workspace member access required" }, { status: 403 });
    }
    const admin = createSupabaseAdminClient();
    const ownerUserId = workspace.billing_admin_user_id;
    const catalog = await loadCatalog(admin, ownerUserId);
    const loaded = await loadIntegrationAssignments({
      supabase: admin,
      userId: ownerUserId,
      availableIntegrationIds: catalog.integrations.map((integration) => integration.id),
    });
    return NextResponse.json({
      ...catalog,
      ...loaded,
      workspaceRole: workspace.role,
      canManage: workspace.role === "admin",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load assignments" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspaceForUser();
  if (workspace.role !== "admin") {
    return NextResponse.json(
      { error: "Only workspace admins can change integration assignments" },
      { status: 403 },
    );
  }
  const body = (await req.json().catch(() => null)) as {
    integrationId?: unknown;
    target?: unknown;
    workerId?: unknown;
    enabled?: unknown;
  } | null;
  const integrationId = asTrimmed(body?.integrationId);
  const target = asTrimmed(body?.target);
  const workerId = asTrimmed(body?.workerId);
  if (!integrationId || (target !== "orchestrator" && target !== "worker")) {
    return NextResponse.json({ error: "Invalid assignment" }, { status: 400 });
  }
  const admin = createSupabaseAdminClient();
  const ownerUserId = workspace.billing_admin_user_id;
  const catalog = await loadCatalog(admin, ownerUserId);
  if (!catalog.integrations.some((integration) => integration.id === integrationId)) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }
  if (target === "worker" && !catalog.workers.some((worker) => worker.id === workerId)) {
    return NextResponse.json({ error: "Worker not found" }, { status: 404 });
  }
  const loaded = await loadIntegrationAssignments({
    supabase: admin,
    userId: ownerUserId,
    availableIntegrationIds: catalog.integrations.map((integration) => integration.id),
  });
  const enabled = body?.enabled === true;
  const next = {
    ...loaded.assignments,
    orchestrator: [...loaded.assignments.orchestrator],
    workers: { ...loaded.assignments.workers },
  };
  const current =
    target === "orchestrator" ? next.orchestrator : [...(next.workers[workerId] || [])];
  const updated = enabled
    ? Array.from(new Set([...current, integrationId]))
    : current.filter((id) => id !== integrationId);
  if (target === "orchestrator") next.orchestrator = updated;
  else next.workers[workerId] = updated;
  try {
    await saveIntegrationAssignments({
      supabase: admin,
      userId: ownerUserId,
      assignments: next,
    });

    // Keep the original worker link table synchronized for older runtimes.
    if (target === "worker") {
      if (enabled) {
        await admin.from("worker_agent_integrations").upsert(
          {
            user_id: ownerUserId,
            agent_id: workerId,
            datagran_agent_id: integrationId,
            enabled: true,
          },
          { onConflict: "agent_id,datagran_agent_id" }
        );
      } else {
        await admin
          .from("worker_agent_integrations")
          .delete()
          .eq("user_id", ownerUserId)
          .eq("agent_id", workerId)
          .eq("datagran_agent_id", integrationId);
      }
    }
    return NextResponse.json({ success: true, assignments: next });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save assignment" },
      { status: 500 }
    );
  }
}
