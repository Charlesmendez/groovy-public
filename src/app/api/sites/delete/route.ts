/**
 * POST /api/sites/delete
 * Delete a site: removes Vercel project + all deployments, custom domains, and DB rows.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyInternalRouteAuth } from "@/lib/internalRouteAuth";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import { deleteProject } from "@/lib/vercel";

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
    const verifiedInternal = verified ? null : verifyInternalRouteAuth(req, "sites-delete");
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

  // Load site (must be owned by user)
  const { data: site } = await supabase
    .from("generated_sites")
    .select("id, vercel_project_id, slug")
    .eq("id", siteId)
    .eq("user_id", userId)
    .single();

  if (!site) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  // Delete the Vercel project (cascades all deployments + domains on Vercel's side)
  if (site.vercel_project_id) {
    try {
      await deleteProject(site.vercel_project_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("404")) {
        return NextResponse.json({ error: `Failed to delete Vercel project: ${msg}` }, { status: 502 });
      }
    }
  }

  // Delete custom domains from our DB (cascade from site deletion handles this too,
  // but be explicit)
  await supabase
    .from("generated_site_domains")
    .delete()
    .eq("site_id", siteId);

  // Delete the site record
  const { error: delErr } = await supabase
    .from("generated_sites")
    .delete()
    .eq("id", siteId)
    .eq("user_id", userId);

  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, deleted: site.slug });
}
