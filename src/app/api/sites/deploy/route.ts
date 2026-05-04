/**
 * POST /api/sites/deploy
 * Deploys a site to Vercel.
 *
 * Expects `files` in the request body (from connector's site_read_files)
 * or the siteId to look up and deploy.
 *
 * Creates Vercel project on first deploy, then creates a production deployment.
 * Polls build logs and returns status.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyInternalRouteAuth } from "@/lib/internalRouteAuth";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import {
  createProject,
  createDeployment,
  getDeployment,
  listDeploymentsByProject,
  pollDeploymentUntilReady,
} from "@/lib/vercel";
import { sanitizeFiles } from "@/lib/vercel/sanitize";
import type { InlinedFile } from "@/lib/vercel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min for build polling

type Body = {
  siteId?: string;
  slug?: string;
  files?: InlinedFile[];
};

type VercelReadyState = "QUEUED" | "BUILDING" | "READY" | "ERROR" | "CANCELED" | "INITIALIZING";

function normalizeDeploymentUrl(url?: string | null): string | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function withNumericSuffix(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  const maxBaseLen = Math.max(1, 60 - suffix.length);
  return `${base.slice(0, maxBaseLen)}${suffix}`;
}

async function resolveAvailableSlug(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
  baseSlug: string
): Promise<string> {
  const { data, error } = await supabase
    .from("generated_sites")
    .select("slug")
    .eq("user_id", userId)
    .like("slug", `${baseSlug}%`);

  if (error) throw new Error(error.message);

  const used = new Set(
    (data || [])
      .map((row) => (row && typeof row.slug === "string" ? row.slug : ""))
      .filter(Boolean)
  );

  if (!used.has(baseSlug)) return baseSlug;
  for (let n = 2; n <= 9999; n++) {
    const candidate = withNumericSuffix(baseSlug, n);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique slug");
}

export async function POST(req: Request) {
  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  // Auth sources:
  // 1) Dashboard cookie session (default)
  // 2) WhatsApp/device-token session via X-Device-Token
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
    // fall through to device-token auth
  }

  if (!userId) {
    const deviceToken = req.headers.get("x-device-token")?.trim() || "";
    const relaySecret = process.env.RELAY_JWT_SECRET || "";
    const verified =
      deviceToken && relaySecret ? verifyRelayDeviceToken(deviceToken, relaySecret) : null;
    const verifiedInternal = verified ? null : verifyInternalRouteAuth(req, "sites-deploy");
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
  if ((!body?.siteId && !body?.slug) || !Array.isArray(body.files) || body.files.length === 0) {
    return NextResponse.json({ error: "siteId or slug, and files[] are required" }, { status: 400 });
  }

  const requestedSlug = normalizeSlug(body.slug || "");
  let siteId = (body.siteId || "").trim();
  let site = null as Record<string, unknown> | null;
  let siteErr = null as { code?: string; message?: string } | null;

  // Load site by id or slug
  if (siteId) {
    const siteRes = await supabase
      .from("generated_sites")
      .select("*")
      .eq("id", siteId)
      .eq("user_id", userId)
      .single();
    site = (siteRes.data as Record<string, unknown> | null) ?? null;
    siteErr = siteRes.error ? { code: siteRes.error.code, message: siteRes.error.message } : null;
  } else if (requestedSlug) {
    const siteRes = await supabase
      .from("generated_sites")
      .select("*")
      .eq("slug", requestedSlug)
      .eq("user_id", userId)
      .maybeSingle();
    site = (siteRes.data as Record<string, unknown> | null) ?? null;
    siteErr = siteRes.error ? { code: siteRes.error.code, message: siteRes.error.message } : null;
  }

  // Auto-create site row when missing and a slug is provided.
  // This now uses the same per-user slug allocator as /api/sites/create:
  // slug, slug-2, slug-3...
  if (!site && requestedSlug) {
    let createErr: { code?: string; message?: string } | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      let resolvedSlug = requestedSlug;
      try {
        resolvedSlug = await resolveAvailableSlug(supabase, userId!, requestedSlug);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to allocate slug";
        return NextResponse.json({ error: msg }, { status: 500 });
      }

      const createRes = await supabase
        .from("generated_sites")
        .insert({
          user_id: userId,
          slug: resolvedSlug,
          name: requestedSlug,
          local_path: `~/.groovy/sites/${resolvedSlug}`,
          status: "draft",
        })
        .select("*")
        .single();

      if (!createRes.error) {
        site = (createRes.data as Record<string, unknown> | null) ?? null;
        createErr = null;
        break;
      }

      createErr = { code: createRes.error.code, message: createRes.error.message };
      if (createRes.error.code !== "23505") {
        siteErr = createErr;
        break;
      }
    }

    if (!site && !siteErr && createErr) {
      siteErr = createErr;
    }
  }

  if (siteErr || !site) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  siteId = typeof site.id === "string" ? site.id : siteId;
  const deployCount = typeof site.deploy_count === "number" ? site.deploy_count : 0;
  const deployCountWindow =
    typeof site.deploy_count_window === "number" ? site.deploy_count_window : 0;
  const deployWindowStartedAtRaw =
    typeof site.deploy_window_started_at === "string" ? site.deploy_window_started_at : null;
  const previousDeploymentId =
    typeof site.latest_deployment_id === "string" ? site.latest_deployment_id : null;
  const previousDeploymentUrl =
    typeof site.latest_deployment_url === "string" ? site.latest_deployment_url : null;
  const nowMs = Date.now();
  const windowStartMs = deployWindowStartedAtRaw ? new Date(deployWindowStartedAtRaw).getTime() : 0;
  const windowExpired =
    !windowStartMs || Number.isNaN(windowStartMs) || nowMs - windowStartMs >= 24 * 60 * 60 * 1000;
  const effectiveWindowCount = windowExpired ? 0 : deployCountWindow;
  const nowIso = new Date().toISOString();

  // Rate limit: max 20 deploys per 24h window
  if (effectiveWindowCount >= 20) {
    return NextResponse.json(
      { error: "Deploy limit reached (20/day). Try again tomorrow." },
      { status: 429 }
    );
  }

  // Sanitize files (strip secrets, enforce static export, size limits)
  const { files: sanitized, warnings } = sanitizeFiles(body.files);

  if (sanitized.length === 0) {
    return NextResponse.json({ error: "No files to deploy after sanitization" }, { status: 400 });
  }

  // Create Vercel project on first deploy
  let vercelProjectId =
    typeof site.vercel_project_id === "string" ? site.vercel_project_id : null;
  let vercelProjectName =
    typeof site.vercel_project_name === "string" ? site.vercel_project_name : null;

  if (!vercelProjectId) {
    try {
      const siteSlug =
        typeof site.slug === "string" && site.slug.trim()
          ? site.slug.trim()
          : requestedSlug || "site";
      const projectName = `site-${userId!.slice(0, 8)}-${siteSlug}`.slice(0, 100);
      const project = await createProject(projectName);
      vercelProjectId = project.id;
      vercelProjectName = project.name;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `Failed to create Vercel project: ${msg}` }, { status: 502 });
    }
  }

  // Create deployment
  let deployment;
  try {
    deployment = await createDeployment({
      name: vercelProjectName!,
      project: vercelProjectId!,
      target: "production",
      files: sanitized,
      projectSettings: {
        framework: "nextjs",
        buildCommand: "next build",
        nodeVersion: "20.x",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Deployment failed: ${msg}` }, { status: 502 });
  }

  // Update site record
  await supabase
    .from("generated_sites")
    .update({
      vercel_project_id: vercelProjectId,
      vercel_project_name: vercelProjectName,
      latest_deployment_id: deployment.id,
      latest_deployment_status: deployment.readyState,
      status: "deploying",
      deploy_count: deployCount + 1,
      deploy_count_window: effectiveWindowCount + 1,
      deploy_window_started_at: windowExpired ? nowIso : deployWindowStartedAtRaw || nowIso,
      updated_at: nowIso,
    })
    .eq("id", siteId);

  // Poll build until ready or error
  const buildResult = await pollDeploymentUntilReady(deployment.id, {
    timeoutMs: 180_000,
  });

  // Resolve effective live state from Vercel.
  // If the latest deploy failed but a previous READY deployment is still active,
  // we should persist "live" with that deployment instead of forcing "error".
  let effectiveStatus: "live" | "deploying" | "error" = "error";
  let effectiveDeploymentId: string | null = null;
  let effectiveDeploymentUrl: string | null = null;
  let effectiveDeploymentState: VercelReadyState | "TIMEOUT" | "none" = "none";
  let effectiveErrorMessage: string | undefined;

  if (buildResult.status === "READY") {
    effectiveStatus = "live";
    effectiveDeploymentId = buildResult.deployment.id;
    effectiveDeploymentUrl = normalizeDeploymentUrl(buildResult.deployment.url);
    effectiveDeploymentState = buildResult.deployment.readyState;
  } else if (
    buildResult.deployment.readyState === "QUEUED" ||
    buildResult.deployment.readyState === "BUILDING" ||
    buildResult.deployment.readyState === "INITIALIZING"
  ) {
    effectiveStatus = "deploying";
    effectiveDeploymentId = buildResult.deployment.id;
    effectiveDeploymentUrl = normalizeDeploymentUrl(buildResult.deployment.url);
    effectiveDeploymentState = buildResult.deployment.readyState;
  } else {
    let liveFallbackDeployment:
      | {
          id: string;
          url: string;
          readyState: VercelReadyState;
        }
      | null = null;

    // First try the previously stored deployment id.
    if (previousDeploymentId) {
      try {
        const prev = await getDeployment(previousDeploymentId);
        if (prev.readyState === "READY") {
          liveFallbackDeployment = prev;
        }
      } catch {
        // Best effort; fall through to project scan.
      }
    }

    // If needed, scan recent project deployments for a READY one.
    if (!liveFallbackDeployment && vercelProjectId) {
      try {
        const recent = await listDeploymentsByProject(vercelProjectId, 20);
        const ready = recent.find((d) => d.readyState === "READY");
        if (ready) {
          liveFallbackDeployment = ready;
        }
      } catch {
        // If Vercel list fails, keep error state below.
      }
    }

    if (liveFallbackDeployment) {
      effectiveStatus = "live";
      effectiveDeploymentId = liveFallbackDeployment.id;
      effectiveDeploymentUrl = normalizeDeploymentUrl(liveFallbackDeployment.url);
      effectiveDeploymentState = liveFallbackDeployment.readyState;
      const tail = buildResult.errorLines.slice(-20).join("\n").trim();
      effectiveErrorMessage = tail || "Latest deploy failed, but previous production deployment is still live.";
    } else {
      effectiveStatus = "error";
      effectiveDeploymentId = null;
      effectiveDeploymentUrl = normalizeDeploymentUrl(previousDeploymentUrl);
      effectiveDeploymentState = buildResult.status;
      const tail = buildResult.errorLines.slice(-50).join("\n").trim();
      effectiveErrorMessage = tail || undefined;
    }
  }

  await supabase
    .from("generated_sites")
    .update({
      latest_deployment_id: effectiveDeploymentId,
      latest_deployment_url: effectiveDeploymentUrl,
      latest_deployment_status: effectiveDeploymentState,
      status: effectiveStatus,
      last_build_error: effectiveStatus === "live" ? null : effectiveErrorMessage?.slice(0, 5000) || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", siteId);

  if (effectiveStatus === "live") {
    return NextResponse.json({
      ok: true,
      url: effectiveDeploymentUrl,
      deploymentId: effectiveDeploymentId,
      effectiveStatus,
      latestDeployStatus: buildResult.status,
      warning:
        buildResult.status !== "READY"
          ? "Latest deploy failed, but previous production deployment is still live."
          : undefined,
      warnings,
    });
  }

  return NextResponse.json({
    ok: false,
    error: "build_failed",
    effectiveStatus,
    url: effectiveDeploymentUrl,
    buildStatus: buildResult.status,
    errorLines: buildResult.errorLines.slice(-100),
    deploymentId: buildResult.deployment.id,
    warnings,
  }, { status: 422 });
}
