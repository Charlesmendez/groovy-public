/**
 * POST /api/sites/attach-domain
 * Attach a custom domain to a site's Vercel project.
 * Returns DNS instructions + TXT verification challenge.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyInternalRouteAuth } from "@/lib/internalRouteAuth";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import { addDomainToProject, getDomainConfig } from "@/lib/vercel";

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
    const verifiedInternal = verified ? null : verifyInternalRouteAuth(req, "sites-attach-domain");
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

  // Basic domain validation
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    return NextResponse.json({ error: "Invalid domain format" }, { status: 400 });
  }

  // Load site by id or slug
  let siteQuery = supabase
    .from("generated_sites")
    .select("id, slug, vercel_project_id, user_id")
    .eq("user_id", userId);
  siteQuery = siteId ? siteQuery.eq("id", siteId) : siteQuery.eq("slug", slug);
  const { data: site } = await siteQuery.maybeSingle();

  if (!site || !site.vercel_project_id) {
    return NextResponse.json({ error: "Site not found or not deployed yet" }, { status: 404 });
  }

  // Per-user domain limit
  const { count } = await supabase
    .from("generated_site_domains")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (typeof count === "number" && count >= 3) {
    return NextResponse.json({ error: "Domain limit reached (max 3)" }, { status: 429 });
  }

  // Add domain to Vercel project
  let domainResult;
  try {
    domainResult = await addDomainToProject(site.vercel_project_id, domain);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to add domain: ${msg}` }, { status: 502 });
  }

  // Get DNS configuration instructions
  let dnsConfig = null;
  try {
    dnsConfig = await getDomainConfig(domain);
  } catch {
    // Non-critical; we'll still have the verification challenge
  }

  // Store in our DB
  const { error: insertErr } = await supabase
    .from("generated_site_domains")
    .upsert({
      site_id: site.id,
      user_id: userId,
      domain,
      verified: domainResult.verified,
      verification_challenge: domainResult.verification || null,
      dns_config: dnsConfig,
      updated_at: new Date().toISOString(),
    }, { onConflict: "site_id,domain" });

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // Build human-readable DNS instructions
  const instructions: string[] = [];

  if (!domainResult.verified && domainResult.verification) {
    for (const v of domainResult.verification) {
      if (v.type === "TXT") {
        instructions.push(`Add TXT record: ${v.domain} → ${v.value}`);
      }
    }
  }

  if (dnsConfig) {
    if (dnsConfig.recommendedCNAME?.length) {
      const cname = dnsConfig.recommendedCNAME.find((c) => c.rank === 1);
      if (cname) instructions.push(`Add CNAME record: ${domain} → ${cname.value}`);
    } else if (dnsConfig.recommendedIPv4?.length) {
      const ips = dnsConfig.recommendedIPv4.find((i) => i.rank === 1);
      if (ips) {
        for (const ip of ips.value) {
          instructions.push(`Add A record: ${domain} → ${ip}`);
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    siteId: site.id,
    slug: site.slug,
    domain,
    verified: domainResult.verified,
    instructions,
    verification: domainResult.verification || null,
    dnsConfig,
  });
}
