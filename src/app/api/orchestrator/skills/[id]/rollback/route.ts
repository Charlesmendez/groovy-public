import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type RouteParams = { params: Promise<{ id: string }> };

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type Body = {
  toVersionId?: string;
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

  const body = (await req.json().catch(() => ({}))) as Body;
  const requestedVersionId = asTrimmed(body.toVersionId);

  const { data: skill } = await supabase
    .from("orchestrator_skills")
    .select("id,user_id,active_version_id,rollback_version_id")
    .eq("id", skillId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!skill?.id) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }

  let targetVersionId = requestedVersionId;
  if (!targetVersionId) {
    const rollbackVersion = asTrimmed((skill as { rollback_version_id?: unknown }).rollback_version_id);
    if (rollbackVersion) {
      targetVersionId = rollbackVersion;
    } else {
      const { data: versions } = await supabase
        .from("orchestrator_skill_versions")
        .select("id,lifecycle,version")
        .eq("skill_id", skillId)
        .eq("user_id", user.id)
        .order("version", { ascending: false })
        .limit(20);
      const currentActive = asTrimmed((skill as { active_version_id?: unknown }).active_version_id);
      const fallback = (versions || []).find((v) => {
        const vid = asTrimmed((v as { id?: unknown }).id);
        const lifecycle = asTrimmed((v as { lifecycle?: unknown }).lifecycle);
        if (!vid || vid === currentActive) return false;
        return lifecycle === "stable" || lifecycle === "canary" || lifecycle === "rollback";
      });
      targetVersionId = asTrimmed((fallback as { id?: unknown } | null)?.id);
    }
  }

  if (!targetVersionId) {
    return NextResponse.json({ error: "No rollback target available" }, { status: 400 });
  }

  const { data: targetVersion } = await supabase
    .from("orchestrator_skill_versions")
    .select("id")
    .eq("id", targetVersionId)
    .eq("skill_id", skillId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!targetVersion?.id) {
    return NextResponse.json({ error: "Rollback target not found" }, { status: 400 });
  }

  const nowIso = new Date().toISOString();
  await supabase
    .from("orchestrator_skill_versions")
    .update({ lifecycle: "rollback", updated_at: nowIso })
    .eq("id", targetVersionId)
    .eq("skill_id", skillId)
    .eq("user_id", user.id);

  const { data: updatedSkill, error: updateErr } = await supabase
    .from("orchestrator_skills")
    .update({
      lifecycle: "rollback",
      active_version_id: targetVersionId,
      rollback_version_id: targetVersionId,
      updated_at: nowIso,
    })
    .eq("id", skillId)
    .eq("user_id", user.id)
    .select(
      "id,agent_id,slug,name,description,lifecycle,runner,latest_version,active_version_id,rollback_version_id,created_at,updated_at"
    )
    .single();

  if (updateErr || !updatedSkill?.id) {
    return NextResponse.json(
      { error: updateErr?.message || "Failed to switch rollback version" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    skill: updatedSkill,
    rollbackToVersionId: targetVersionId,
  });
}
