import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveRuntimeScope } from "@/lib/orchestrator/runtimeGraph";
import { sanitizeSkillSlug } from "@/lib/orchestrator/skillsRuntime";

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

async function resolveAgentId(args: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  userId: string;
  conversationId?: string | null;
  requestedAgentId?: string | null;
}): Promise<string | null> {
  const { supabase, userId } = args;
  const requestedAgentId = asTrimmed(args.requestedAgentId || "");
  const conversationId = asTrimmed(args.conversationId || "");

  if (requestedAgentId) {
    const { data: agent } = await supabase
      .from("agents")
      .select("id,type")
      .eq("id", requestedAgentId)
      .eq("type", "orchestrator-runtime")
      .maybeSingle();
    if (typeof agent?.id === "string" && agent.id) return agent.id;
  }

  if (!conversationId) return null;

  const { data: directAgent } = await supabase
    .from("agents")
    .select("id,type")
    .eq("id", conversationId)
    .eq("type", "orchestrator-runtime")
    .maybeSingle();
  if (typeof directAgent?.id === "string" && directAgent.id) {
    return directAgent.id;
  }

  const { data: runtime } = await supabase
    .from("orchestrator_session_runtime")
    .select("agent_id")
    .eq("session_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (typeof runtime?.agent_id === "string" && runtime.agent_id) return runtime.agent_id;

  const { data: session } = await supabase
    .from("orchestrator_sessions")
    .select("id,title")
    .eq("id", conversationId)
    .maybeSingle();
  if (!session?.id) return null;

  const title = asTrimmed(session.title) || "Groovy Agent";
  const { data: created } = await supabase
    .from("agents")
    .insert({
      user_id: userId,
      type: "orchestrator-runtime",
      name: title,
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
    })
    .select("id")
    .single();
  if (!created?.id) return null;

  await resolveRuntimeScope({
    supabase,
    userId,
    sessionId: conversationId,
    agentId: String(created.id),
  });

  return String(created.id);
}

async function resolveAgentOwnerUserId(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  agentId: string
): Promise<string | null> {
  const { data: agent } = await supabase
    .from("agents")
    .select("id,user_id,type")
    .eq("id", agentId)
    .eq("type", "orchestrator-runtime")
    .maybeSingle();
  const ownerUserId = asTrimmed((agent as { user_id?: unknown } | null)?.user_id);
  return ownerUserId || null;
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const conversationId = asTrimmed(searchParams.get("conversationId"));
  const requestedAgentId = asTrimmed(searchParams.get("agentId"));
  const agentId = await resolveAgentId({
    supabase,
    userId: user.id,
    conversationId: conversationId || null,
    requestedAgentId: requestedAgentId || null,
  });
  if (!agentId) {
    return NextResponse.json({ error: "agentId or conversationId required" }, { status: 400 });
  }

  const { data: skills, error: skillErr } = await supabase
    .from("orchestrator_skills")
    .select(
      "id,agent_id,slug,name,description,lifecycle,runner,latest_version,active_version_id,rollback_version_id,created_at,updated_at"
    )
    .eq("user_id", user.id)
    .eq("agent_id", agentId)
    .order("updated_at", { ascending: false });
  if (skillErr) {
    return NextResponse.json({ error: skillErr.message }, { status: 500 });
  }

  const skillIds = (skills || [])
    .map((s) => asTrimmed((s as { id?: unknown }).id))
    .filter((id): id is string => id.length > 0);
  let versions: Array<Record<string, unknown>> = [];
  if (skillIds.length > 0) {
    const { data: rows } = await supabase
      .from("orchestrator_skill_versions")
      .select("id,skill_id,version,lifecycle,runner,source,default_state,metadata,created_at,updated_at")
      .eq("user_id", user.id)
      .eq("agent_id", agentId)
      .in("skill_id", skillIds)
      .order("version", { ascending: false });
    versions = (rows as Array<Record<string, unknown>> | null) || [];
  }

  const versionsBySkill = new Map<string, Array<Record<string, unknown>>>();
  for (const row of versions) {
    const sid = asTrimmed(row.skill_id);
    if (!sid) continue;
    const arr = versionsBySkill.get(sid) || [];
    arr.push(row);
    versionsBySkill.set(sid, arr);
  }

  return NextResponse.json({
    ok: true,
    agentId,
    skills: (skills || []).map((skill) => {
      const id = asTrimmed((skill as { id?: unknown }).id);
      return {
        ...skill,
        versions: versionsBySkill.get(id) || [],
      };
    }),
  });
}

type CreateSkillBody = {
  conversationId?: string;
  agentId?: string;
  name?: string;
  slug?: string;
  description?: string;
  lifecycle?: SkillLifecycle;
  runner?: SkillRunner;
  source?: string;
  defaultState?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as CreateSkillBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const agentId = await resolveAgentId({
    supabase,
    userId: user.id,
    conversationId: asTrimmed(body.conversationId),
    requestedAgentId: asTrimmed(body.agentId),
  });
  if (!agentId) {
    return NextResponse.json({ error: "agentId or conversationId required" }, { status: 400 });
  }
  const ownerUserId = await resolveAgentOwnerUserId(supabase, agentId);
  if (!ownerUserId) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  if (ownerUserId !== user.id) {
    return NextResponse.json(
      { error: "Only the agent owner can create skills" },
      { status: 403 }
    );
  }

  const name = asTrimmed(body.name);
  const source = asTrimmed(body.source);
  if (!name || !source) {
    return NextResponse.json({ error: "name and source are required" }, { status: 400 });
  }
  const lifecycle: SkillLifecycle = isLifecycle(body.lifecycle) ? body.lifecycle : "draft";
  const runner: SkillRunner = isRunner(body.runner) ? body.runner : "code_cli_run";
  const slug = sanitizeSkillSlug(asTrimmed(body.slug) || name);
  if (!slug) {
    return NextResponse.json({ error: "Invalid skill slug" }, { status: 400 });
  }

  const nowIso = new Date().toISOString();
  const activeLifecycle = lifecycle === "canary" || lifecycle === "stable" || lifecycle === "rollback";

  const { data: createdSkill, error: createSkillErr } = await supabase
    .from("orchestrator_skills")
    .insert({
      user_id: ownerUserId,
      agent_id: agentId,
      slug,
      name,
      description: asTrimmed(body.description),
      lifecycle,
      runner,
      latest_version: 1,
      updated_at: nowIso,
    })
    .select(
      "id,agent_id,slug,name,description,lifecycle,runner,latest_version,active_version_id,rollback_version_id,created_at,updated_at"
    )
    .single();
  if (createSkillErr || !createdSkill?.id) {
    return NextResponse.json(
      { error: createSkillErr?.message || "Failed to create skill" },
      { status: 500 }
    );
  }

  const versionLifecycle = activeLifecycle ? lifecycle : "draft";
  const { data: createdVersion, error: createVersionErr } = await supabase
    .from("orchestrator_skill_versions")
    .insert({
      user_id: ownerUserId,
      agent_id: agentId,
      skill_id: createdSkill.id,
      version: 1,
      lifecycle: versionLifecycle,
      runner,
      source,
      default_state: asRecord(body.defaultState),
      metadata: asRecord(body.metadata),
      updated_at: nowIso,
    })
    .select("id,skill_id,version,lifecycle,runner,source,default_state,metadata,created_at,updated_at")
    .single();
  if (createVersionErr || !createdVersion?.id) {
    await supabase.from("orchestrator_skills").delete().eq("id", createdSkill.id).eq("user_id", ownerUserId);
    return NextResponse.json(
      { error: createVersionErr?.message || "Failed to create skill version" },
      { status: 500 }
    );
  }

  await supabase
    .from("orchestrator_skills")
    .update({
      active_version_id: activeLifecycle ? createdVersion.id : null,
      rollback_version_id: lifecycle === "rollback" ? createdVersion.id : null,
      updated_at: nowIso,
    })
    .eq("id", createdSkill.id)
    .eq("user_id", ownerUserId);

  return NextResponse.json({
    ok: true,
    skill: {
      ...createdSkill,
      active_version_id: activeLifecycle ? createdVersion.id : null,
      rollback_version_id: lifecycle === "rollback" ? createdVersion.id : null,
    },
    version: createdVersion,
  });
}

type UpdateSkillBody = {
  id?: string;
  name?: string;
  description?: string;
  lifecycle?: SkillLifecycle;
  activeVersionId?: string;
  rollbackToVersionId?: string;
  source?: string;
  runner?: SkillRunner;
  defaultState?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as UpdateSkillBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const skillId = asTrimmed(body.id);
  if (!skillId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const { data: skill } = await supabase
    .from("orchestrator_skills")
    .select("id,user_id,agent_id,latest_version,runner,lifecycle,active_version_id,rollback_version_id")
    .eq("id", skillId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!skill?.id) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }

  const nowIso = new Date().toISOString();
  const updates: Record<string, unknown> = { updated_at: nowIso };
  const nextName = asTrimmed(body.name);
  const nextDescription = asTrimmed(body.description);
  if (nextName) updates.name = nextName;
  if (typeof body.description === "string") updates.description = nextDescription;
  if (isLifecycle(body.lifecycle)) updates.lifecycle = body.lifecycle;

  const rollbackToVersionId = asTrimmed(body.rollbackToVersionId);
  if (rollbackToVersionId) {
    const { data: targetVersion } = await supabase
      .from("orchestrator_skill_versions")
      .select("id")
      .eq("id", rollbackToVersionId)
      .eq("skill_id", skillId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!targetVersion?.id) {
      return NextResponse.json({ error: "rollbackToVersionId not found for skill" }, { status: 400 });
    }
    updates.lifecycle = "rollback";
    updates.active_version_id = rollbackToVersionId;
    updates.rollback_version_id = rollbackToVersionId;
    await supabase
      .from("orchestrator_skill_versions")
      .update({ lifecycle: "rollback", updated_at: nowIso })
      .eq("id", rollbackToVersionId)
      .eq("skill_id", skillId)
      .eq("user_id", user.id);
  } else {
    const activeVersionId = asTrimmed(body.activeVersionId);
    if (activeVersionId) {
      const { data: targetVersion } = await supabase
        .from("orchestrator_skill_versions")
        .select("id")
        .eq("id", activeVersionId)
        .eq("skill_id", skillId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!targetVersion?.id) {
        return NextResponse.json({ error: "activeVersionId not found for skill" }, { status: 400 });
      }
      updates.active_version_id = activeVersionId;
      if (isLifecycle(body.lifecycle)) updates.lifecycle = body.lifecycle;
    }
  }

  const nextSource = asTrimmed(body.source);
  const requestedRunner = body.runner;
  const shouldCreateVersion =
    !!nextSource ||
    typeof requestedRunner === "string" ||
    typeof body.defaultState !== "undefined" ||
    typeof body.metadata !== "undefined";

  let createdVersion: Record<string, unknown> | null = null;
  if (shouldCreateVersion) {
    const currentVersion = Number((skill as { latest_version?: unknown }).latest_version || 0);
    const nextVersion = Number.isFinite(currentVersion) && currentVersion > 0 ? currentVersion + 1 : 1;
    const runner: SkillRunner =
      isRunner(requestedRunner) ? requestedRunner : (isRunner((skill as { runner?: unknown }).runner) ? (skill as { runner: SkillRunner }).runner : "code_cli_run");
    const lifecycleForVersion: SkillLifecycle = isLifecycle(body.lifecycle) ? body.lifecycle : "draft";
    const { data: insertedVersion, error: versionErr } = await supabase
      .from("orchestrator_skill_versions")
      .insert({
        user_id: user.id,
        agent_id: skill.agent_id,
        skill_id: skillId,
        version: nextVersion,
        lifecycle:
          lifecycleForVersion === "canary" ||
          lifecycleForVersion === "stable" ||
          lifecycleForVersion === "rollback"
            ? lifecycleForVersion
            : "draft",
        runner,
        source: nextSource || `# ${nextName || "Updated skill"}\n\nNo source provided.`,
        default_state: asRecord(body.defaultState),
        metadata: asRecord(body.metadata),
        updated_at: nowIso,
      })
      .select("id,skill_id,version,lifecycle,runner,source,default_state,metadata,created_at,updated_at")
      .single();
    if (versionErr || !insertedVersion?.id) {
      return NextResponse.json(
        { error: versionErr?.message || "Failed to create skill version" },
        { status: 500 }
      );
    }
    createdVersion = insertedVersion as Record<string, unknown>;
    updates.latest_version = nextVersion;
    updates.runner = runner;
    if (
      lifecycleForVersion === "canary" ||
      lifecycleForVersion === "stable" ||
      lifecycleForVersion === "rollback"
    ) {
      updates.lifecycle = lifecycleForVersion;
      updates.active_version_id = insertedVersion.id;
      if (lifecycleForVersion === "rollback") updates.rollback_version_id = insertedVersion.id;
    }
  }

  const { data: updatedSkill, error: updateErr } = await supabase
    .from("orchestrator_skills")
    .update(updates)
    .eq("id", skillId)
    .eq("user_id", user.id)
    .select(
      "id,agent_id,slug,name,description,lifecycle,runner,latest_version,active_version_id,rollback_version_id,created_at,updated_at"
    )
    .single();
  if (updateErr || !updatedSkill?.id) {
    return NextResponse.json(
      { error: updateErr?.message || "Failed to update skill" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    skill: updatedSkill,
    createdVersion,
  });
}
