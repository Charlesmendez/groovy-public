/**
 * POST /api/sites/create
 * Creates a generated_sites row in draft status.
 * No Vercel project is created until first deploy.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  slug?: string;
  name?: string;
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

  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  const requestedSlug = normalizeSlug(body?.slug || "");
  const name = (body?.name || requestedSlug || "").trim().slice(0, 100);

  if (!requestedSlug) {
    return NextResponse.json({ error: "slug is required" }, { status: 400 });
  }

  // Per-user limit: max 5 sites
  const { count } = await supabase
    .from("generated_sites")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  if (typeof count === "number" && count >= 5) {
    return NextResponse.json(
      { error: "Site limit reached (max 5 sites). Delete an existing site to create a new one." },
      { status: 429 }
    );
  }

  // Allocate a unique per-user slug: slug, slug-2, slug-3...
  // Retry on race conditions where another request claims the same slug concurrently.
  let site: Record<string, unknown> | null = null;
  let resolvedSlug = requestedSlug;
  let lastInsertError: { code?: string; message?: string } | null = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      resolvedSlug = await resolveAvailableSlug(supabase, user.id, requestedSlug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to allocate slug";
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const localPath = `~/.groovy/sites/${resolvedSlug}`;
    const { data: inserted, error: insertErr } = await supabase
      .from("generated_sites")
      .insert({
        user_id: user.id,
        slug: resolvedSlug,
        name,
        local_path: localPath,
        status: "draft",
      })
      .select("*")
      .single();

    if (!insertErr) {
      site = (inserted as Record<string, unknown> | null) ?? null;
      break;
    }

    lastInsertError = { code: insertErr.code, message: insertErr.message };
    if (insertErr.code !== "23505") {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }
  }

  if (!site) {
    const msg =
      lastInsertError?.code === "23505"
        ? "Could not allocate a unique site slug after retries"
        : (lastInsertError?.message || "Failed to create site");
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    site,
    requestedSlug,
    resolvedSlug,
    slugAdjusted: resolvedSlug !== requestedSlug,
  });
}
