import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import { isGroovyAdminEmail } from "@/lib/admin/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  title?: string;
  severity?: "low" | "medium" | "high" | "critical";
  affectedVersions?: string[];
  patchedVersions?: string[];
  summary?: string;
  advisoryUrl?: string | null;
  isPublic?: boolean;
};

function severity(value: unknown): "low" | "medium" | "high" | "critical" {
  return value === "low" || value === "high" || value === "critical" ? value : "medium";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !!item.trim())
    : [];
}

export async function GET() {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("security_advisories")
    .select("id, title, severity, affected_versions, patched_versions, summary, advisory_url, published_at")
    .eq("is_public", true)
    .order("published_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ advisories: data || [] });
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!isGroovyAdminEmail(user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
  if (!title || !summary) {
    return NextResponse.json({ error: "title and summary are required" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("security_advisories")
    .insert({
      title,
      severity: severity(body?.severity),
      affected_versions: stringArray(body?.affectedVersions),
      patched_versions: stringArray(body?.patchedVersions),
      summary,
      advisory_url: body?.advisoryUrl || null,
      is_public: body?.isPublic !== false,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, advisory: data });
}
