import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Duplicating a harness = cloning a profile row. The clone keeps everything
// except is_default, gets a "-copy" slug, and records its lineage.
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { name?: unknown };

  const { data: source, error: loadError } = await supabase
    .from("orchestrator_profiles")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
  if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 120)
      : `${source.name} copy`;
  const baseSlug = `${source.slug}-copy`.slice(0, 55);

  // Try a few slug suffixes to dodge the unique index.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
    const { data, error } = await supabase
      .from("orchestrator_profiles")
      .insert({
        workspace_id: source.workspace_id,
        user_id: source.user_id,
        name,
        slug,
        description: source.description,
        persona_prompt: source.persona_prompt,
        purpose: source.purpose,
        tone: source.tone,
        custom_instructions: source.custom_instructions,
        authorization_stance: source.authorization_stance,
        model: source.model,
        tool_policy: source.tool_policy,
        agent_roster: source.agent_roster,
        memory_scope: source.memory_scope,
        surface: source.surface,
        widget_config: source.widget_config,
        inherit_workspace_skills: source.inherit_workspace_skills !== false,
        inherit_workspace_integrations:
          source.inherit_workspace_integrations !== false,
        is_default: false,
        cloned_from: source.id,
        created_by: user.id,
      })
      .select("*")
      .single();
    if (!error) {
      const admin = createSupabaseAdminClient();
      const [
        { data: skillAssignments, error: skillLoadError },
        { data: integrationAssignments, error: integrationLoadError },
      ] =
        await Promise.all([
          admin
            .from("workspace_skill_assignments")
            .select(
              "workspace_id,artifact_id,target,enabled,created_by_user_id,metadata",
            )
            .eq("profile_id", source.id),
          admin
            .from("orchestrator_profile_integrations")
            .select(
              "workspace_id,integration_agent_id,created_by",
            )
            .eq("profile_id", source.id),
        ]);
      if (skillLoadError || integrationLoadError) {
        await admin.from("orchestrator_profiles").delete().eq("id", data.id);
        return NextResponse.json(
          {
            error:
              skillLoadError?.message ||
              integrationLoadError?.message ||
              "Could not clone capabilities",
          },
          { status: 500 },
        );
      }
      if (Array.isArray(skillAssignments) && skillAssignments.length) {
        const { error: skillCopyError } = await admin
          .from("workspace_skill_assignments")
          .insert(
          skillAssignments.map((assignment) => ({
            ...assignment,
            profile_id: data.id,
            agent_id: null,
            scope: "profile",
            created_by_user_id: user.id,
          })),
        );
        if (skillCopyError) {
          await admin.from("orchestrator_profiles").delete().eq("id", data.id);
          return NextResponse.json(
            { error: skillCopyError.message },
            { status: 500 },
          );
        }
      }
      if (
        Array.isArray(integrationAssignments) &&
        integrationAssignments.length
      ) {
        const { error: integrationCopyError } = await admin
          .from("orchestrator_profile_integrations")
          .insert(
          integrationAssignments.map((assignment) => ({
            ...assignment,
            profile_id: data.id,
            created_by: user.id,
          })),
        );
        if (integrationCopyError) {
          await admin.from("orchestrator_profiles").delete().eq("id", data.id);
          return NextResponse.json(
            { error: integrationCopyError.message },
            { status: 500 },
          );
        }
      }
      return NextResponse.json({ profile: data }, { status: 201 });
    }
    if (error.code !== "23505") {
      const status = error.code === "42501" ? 403 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
  }
  return NextResponse.json({ error: "Could not find a free slug for the clone" }, { status: 409 });
}
