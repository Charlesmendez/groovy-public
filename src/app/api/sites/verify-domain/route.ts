/**
 * POST /api/sites/verify-domain
 * Verify a custom domain after user has added DNS records.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyInternalRouteAuth } from "@/lib/internalRouteAuth";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import { verifyProjectDomain, getDomainConfig } from "@/lib/vercel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  siteId?: string;
  slug?: string;
  domain?: string;
};

function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

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
    const verifiedInternal = verified ? null : verifyInternalRouteAuth(req, "sites-verify-domain");
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
  const siteId = typeof body?.siteId === "string" ? body.siteId.trim() : "";
  const slug = normalizeSlug(body?.slug || "");
  const domain = (body?.domain || "").trim().toLowerCase();

  if ((!siteId && !slug) || !domain) {
    return NextResponse.json({ error: "siteId or slug, and domain are required" }, { status: 400 });
  }

  // Load site by id or slug
  let siteQuery = supabase
    .from("generated_sites")
    .select("id, slug, vercel_project_id")
    .eq("user_id", userId);
  siteQuery = siteId ? siteQuery.eq("id", siteId) : siteQuery.eq("slug", slug);
  const { data: site } = await siteQuery.maybeSingle();

  if (!site || !site.vercel_project_id) {
    return NextResponse.json({ error: "Site not found or not deployed" }, { status: 404 });
  }

  // Call Vercel verify
  let result;
  try {
    result = await verifyProjectDomain(site.vercel_project_id, domain);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Verification failed: ${msg}` }, { status: 502 });
  }

  // Update DNS config
  let dnsConfig = null;
  try {
    dnsConfig = await getDomainConfig(domain);
  } catch { /* non-critical */ }

  // Update our DB
  await supabase
    .from("generated_site_domains")
    .update({
      verified: result.verified,
      verification_challenge: result.verification || null,
      dns_config: dnsConfig,
      updated_at: new Date().toISOString(),
    })
    .eq("site_id", site.id)
    .eq("domain", domain);

  if (result.verified) {
    return NextResponse.json({
      ok: true,
      siteId: site.id,
      slug: site.slug,
      domain,
      verified: true,
      message: `${domain} is verified and live!`,
    });
  }

  return NextResponse.json({
    ok: false,
    siteId: site.id,
    slug: site.slug,
    domain,
    verified: false,
    message: "Domain not yet verified. Please check your DNS records and try again.",
    verification: result.verification || null,
    dnsConfig,
  });
}
