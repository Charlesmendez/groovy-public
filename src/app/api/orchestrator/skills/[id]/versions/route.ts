import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type RouteParams = { params: Promise<{ id: string }> };
type SkillLifecycle = "draft" | "canary" | "stable" | "rollback" | "disabled";
type SkillRunner = "code_cli_run" | "terminal_exec";

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isLifecycle(value: unknown): value is SkillLifecycle {
  return (
    value === "draft" ||
    value === "canary" ||
    value === "stable" ||
    value === "rollback" ||
    value === "disabled"
  );
}

function isRunner(value: unknown): value is SkillRunner {
  return value === "code_cli_run" || value === "terminal_exec";
}

export async function GET(_req: Request, { params }: RouteParams) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const skillId = asTrimmed(id);
  if (!skillId) {
    return NextResponse.json({ error: "Skill id required" }, { status: 400 });
  }

  const { data: versions, error } = await supabase
    .from("orchestrator_skill_versions")
    .select("id,skill_id,version,lifecycle,runner,source,default_state,metadata,created_at,updated_at")
    .eq("skill_id", skillId)
    .eq("user_id", user.id)
    .order("version", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, versions: versions || [] });
}

type PostBody = {
  source?: string;
  lifecycle?: SkillLifecycle;
  runner?: SkillRunner;
  defaultState?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  activate?: boolean;
};

export async function POST(req: Request, { params }: RouteParams) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const skillId = asTrimmed(id);
  if (!skillId) {
    return NextResponse.json({ error: "Skill id required" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const source = asTrimmed(body.source);
  if (!source) {
    return NextResponse.json({ error: "source is required" }, { status: 400 });
  }

  const { data: skill } = await supabase
    .from("orchestrator_skills")
    .select("id,user_id,agent_id,latest_version,runner")
    .eq("id", skillId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!skill?.id) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }

  const currentVersion = Number((skill as { latest_version?: unknown }).latest_version || 0);
  const nextVersion = Number.isFinite(currentVersion) && currentVersion > 0 ? currentVersion + 1 : 1;
  const runner: SkillRunner =
    isRunner(body.runner) ? body.runner : (isRunner((skill as { runner?: unknown }).runner) ? (skill as { runner: SkillRunner }).runner : "code_cli_run");
  const lifecycle: SkillLifecycle = isLifecycle(body.lifecycle) ? body.lifecycle : "draft";
  const nowIso = new Date().toISOString();

  const { data: version, error } = await supabase
    .from("orchestrator_skill_versions")
    .insert({
      user_id: user.id,
      agent_id: skill.agent_id,
      skill_id: skillId,
      version: nextVersion,
      lifecycle:
        lifecycle === "canary" || lifecycle === "stable" || lifecycle === "rollback"
          ? lifecycle
          : "draft",
      runner,
      source,
      default_state: asRecord(body.defaultState),
      metadata: asRecord(body.metadata),
      updated_at: nowIso,
    })
    .select("id,skill_id,version,lifecycle,runner,source,default_state,metadata,created_at,updated_at")
    .single();
  if (error || !version?.id) {
    return NextResponse.json(
      { error: error?.message || "Failed to create version" },
      { status: 500 }
    );
  }

  const shouldActivate =
    body.activate === true ||
    lifecycle === "canary" ||
    lifecycle === "stable" ||
    lifecycle === "rollback";
  const updates: Record<string, unknown> = {
    latest_version: nextVersion,
    runner,
    updated_at: nowIso,
  };
  if (shouldActivate) {
    updates.active_version_id = version.id;
    updates.lifecycle = lifecycle;
    if (lifecycle === "rollback") updates.rollback_version_id = version.id;
  }

  await supabase
    .from("orchestrator_skills")
    .update(updates)
    .eq("id", skillId)
    .eq("user_id", user.id);

  return NextResponse.json({ ok: true, version });
}
