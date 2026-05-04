/**
 * POST /api/sites/unpublish
 * Take a site offline: deletes the latest Vercel deployment but keeps the project + DB row.
 * The user can redeploy later with site_publish.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyInternalRouteAuth } from "@/lib/internalRouteAuth";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import { deleteDeployment, listDeploymentsByProject } from "@/lib/vercel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  siteId?: string;
};

export async function POST(req: Request) {
  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  let userId: string | null = null;
  try {
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();
    if (!authErr && user?.id) {
      userId = user.id;
    }
  } catch {
    // fall through to device-token/internal auth
  }

  if (!userId) {
    const deviceToken = req.headers.get("x-device-token")?.trim() || "";
    const relaySecret = process.env.RELAY_JWT_SECRET || "";
    const verified =
      deviceToken && relaySecret ? verifyRelayDeviceToken(deviceToken, relaySecret) : null;
    const verifiedInternal = verified ? null : verifyInternalRouteAuth(req, "sites-unpublish");
    if (!verified?.userId && !verifiedInternal?.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = verified?.userId || verifiedInternal?.userId || null;
    try {
      supabase = createSupabaseAdminClient();
    } catch {
      return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
    }
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  const siteId = body?.siteId || "";

  if (!siteId) {
    return NextResponse.json({ error: "siteId required" }, { status: 400 });
  }

  // Load site
  const { data: site } = await supabase
    .from("generated_sites")
    .select("id, vercel_project_id, latest_deployment_id, latest_deployment_url, slug, status")
    .eq("id", siteId)
    .eq("user_id", userId)
    .single();

  if (!site) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  if (!site.vercel_project_id) {
    return NextResponse.json({ error: "Site has no Vercel project yet" }, { status: 409 });
  }

  // Delete all deployments for this project so no previous production alias remains live.
  const deploymentIds = new Set<string>();
  if (typeof site.latest_deployment_id === "string" && site.latest_deployment_id.trim()) {
    deploymentIds.add(site.latest_deployment_id.trim());
  }

  try {
    const deployments = await listDeploymentsByProject(site.vercel_project_id);
    for (const d of deployments) {
      if (typeof d.id === "string" && d.id.trim()) {
        deploymentIds.add(d.id.trim());
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to list deployments: ${msg}` }, { status: 502 });
  }

  if (deploymentIds.size === 0) {
    return NextResponse.json({ error: "No active deployment to unpublish" }, { status: 409 });
  }

  for (const deploymentId of deploymentIds) {
    try {
      await deleteDeployment(deploymentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("404")) {
        return NextResponse.json({ error: `Failed to delete deployment ${deploymentId}: ${msg}` }, { status: 502 });
      }
    }
  }

  // Update DB: clear deployment state, set status to draft
  await supabase
    .from("generated_sites")
    .update({
      latest_deployment_id: null,
      latest_deployment_url: null,
      latest_deployment_status: "none",
      status: "draft",
      updated_at: new Date().toISOString(),
    })
    .eq("id", siteId);

  return NextResponse.json({
    ok: true,
    slug: site.slug,
    message: `${site.slug} has been taken offline. You can redeploy anytime.`,
  });
}
