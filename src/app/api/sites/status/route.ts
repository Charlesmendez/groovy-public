/**
 * GET /api/sites/status
 * Returns the site's effective runtime status resolved from Vercel.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getDeployment, listDeploymentsByProject, type VercelDeployment } from "@/lib/vercel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SiteRow = {
  id: string;
  slug: string;
  status: string;
  vercel_project_id: string | null;
  latest_deployment_id: string | null;
  latest_deployment_url: string | null;
  latest_deployment_status: string | null;
  last_build_error: string | null;
};

function normalizeDeploymentUrl(url?: string | null): string | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function deploymentHostFromUrl(url?: string | null): string | null {
  const normalized = normalizeDeploymentUrl(url);
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname;
  } catch {
    return null;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return false;
}

async function resolveEffectiveDeployment(
  site: SiteRow
): Promise<{
  status: "live" | "deploying" | "error" | "draft";
  latest_deployment_id: string | null;
  latest_deployment_url: string | null;
  latest_deployment_status: string;
  last_build_error: string | null;
} | null> {
  const projectId = typeof site.vercel_project_id === "string" ? site.vercel_project_id.trim() : "";
  const latestId = typeof site.latest_deployment_id === "string" ? site.latest_deployment_id.trim() : "";
  const latestUrlHost = deploymentHostFromUrl(site.latest_deployment_url);

  let latest: VercelDeployment | null = null;
  if (latestId) {
    try {
      latest = await getDeployment(latestId);
    } catch {
      // continue with project scan fallback
    }
  }
  if (!latest && latestUrlHost) {
    try {
      latest = await getDeployment(latestUrlHost);
    } catch {
      // continue with project scan fallback
    }
  }

  let readyFallback: VercelDeployment | null = null;
  if (projectId) {
    try {
      const recent = await listDeploymentsByProject(projectId, 20);
      if (!latest && recent.length > 0) {
        latest = recent[0];
      }
      readyFallback = recent.find((d) => d.readyState === "READY") || null;
    } catch {
      // best effort only
    }
  }

  if (latest?.readyState === "READY") {
    return {
      status: "live",
      latest_deployment_id: latest.id,
      latest_deployment_url: normalizeDeploymentUrl(latest.url),
      latest_deployment_status: latest.readyState,
      last_build_error: null,
    };
  }

  if (readyFallback) {
    return {
      status: "live",
      latest_deployment_id: readyFallback.id,
      latest_deployment_url: normalizeDeploymentUrl(readyFallback.url),
      latest_deployment_status: readyFallback.readyState,
      last_build_error: null,
    };
  }

  if (
    latest?.readyState === "QUEUED" ||
    latest?.readyState === "BUILDING" ||
    latest?.readyState === "INITIALIZING"
  ) {
    return {
      status: "deploying",
      latest_deployment_id: latest.id,
      latest_deployment_url: normalizeDeploymentUrl(latest.url),
      latest_deployment_status: latest.readyState,
      last_build_error: null,
    };
  }

  if (latest?.readyState === "ERROR" || latest?.readyState === "CANCELED") {
    return {
      status: "error",
      latest_deployment_id: latest.id,
      latest_deployment_url: normalizeDeploymentUrl(latest.url),
      latest_deployment_status: latest.readyState,
      last_build_error: site.last_build_error,
    };
  }

  if (site.latest_deployment_id || site.latest_deployment_url || site.vercel_project_id) {
    return {
      status: "draft",
      latest_deployment_id: null,
      latest_deployment_url: null,
      latest_deployment_status: "none",
      last_build_error: null,
    };
  }

  return null;
}

export async function GET(req: Request) {
  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const slugParam = searchParams.get("slug")?.trim() || "";
  const siteIdParam = searchParams.get("siteId")?.trim() || "";
  if (!slugParam && !siteIdParam) {
    return NextResponse.json({ error: "slug or siteId is required" }, { status: 400 });
  }

  let query = supabase
    .from("generated_sites")
    .select(
      "id, slug, status, vercel_project_id, latest_deployment_id, latest_deployment_url, latest_deployment_status, last_build_error"
    )
    .eq("user_id", user.id);
  if (siteIdParam) {
    query = query.eq("id", siteIdParam);
  } else {
    query = query.eq("slug", slugParam);
  }

  const { data: siteRaw, error: siteErr } = await query.maybeSingle();
  if (siteErr) {
    return NextResponse.json({ error: siteErr.message }, { status: 500 });
  }
  if (!siteRaw) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  const site = siteRaw as SiteRow;
  let nextSite: SiteRow = { ...site };

  try {
    const resolved = await resolveEffectiveDeployment(site);
    if (resolved) {
      const patch: Partial<SiteRow> = {};
      if (!sameValue(site.status, resolved.status)) patch.status = resolved.status;
      if (!sameValue(site.latest_deployment_id, resolved.latest_deployment_id)) {
        patch.latest_deployment_id = resolved.latest_deployment_id;
      }
      if (!sameValue(site.latest_deployment_url, resolved.latest_deployment_url)) {
        patch.latest_deployment_url = resolved.latest_deployment_url;
      }
      if (!sameValue(site.latest_deployment_status, resolved.latest_deployment_status)) {
        patch.latest_deployment_status = resolved.latest_deployment_status;
      }
      if (!sameValue(site.last_build_error, resolved.last_build_error)) {
        patch.last_build_error = resolved.last_build_error;
      }

      if (Object.keys(patch).length > 0) {
        const updatePayload: Record<string, unknown> = {
          ...patch,
          updated_at: new Date().toISOString(),
        };
        await supabase.from("generated_sites").update(updatePayload).eq("id", site.id);
        nextSite = {
          ...nextSite,
          ...(patch as Partial<SiteRow>),
        };
      }
    }
  } catch {
    // If Vercel resolution fails, return last known DB state.
  }

  return NextResponse.json({ ok: true, site: nextSite });
}

