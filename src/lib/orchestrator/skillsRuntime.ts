import type { SupabaseClient } from "@supabase/supabase-js";

export type SkillRunner = "code_cli_run" | "terminal_exec";
export type SkillLifecycle = "draft" | "canary" | "stable" | "rollback" | "disabled";
export type SkillValidationStatus = "unvalidated" | "requested" | "passed" | "failed";

export type SkillRuntimeTool = {
  skillId: string;
  versionId: string;
  toolName: string;
  slug: string;
  name: string;
  description: string;
  lifecycle: "canary" | "stable" | "rollback";
  runner: SkillRunner;
  source: string;
  state: Record<string, unknown>;
};

export type SkillRegistryEntry = {
  skillId: string;
  slug: string;
  name: string;
  description: string;
  lifecycle: SkillLifecycle;
  runner: SkillRunner;
  activeVersionId: string | null;
  updatedAt: string | null;
};

export type SkillDraftVersion = {
  skillId: string;
  versionId: string;
  slug: string;
  name: string;
  description: string;
  lifecycle: SkillLifecycle;
  runner: SkillRunner;
  source: string;
  defaultState: Record<string, unknown>;
  validationStatus: SkillValidationStatus;
  validationTask: string | null;
  validationToken: string | null;
  validationOutputPreview: string | null;
  updatedAt: string | null;
};

const RESERVED_SKILL_SLUGS = new Set([
  "registry_list",
  "registry_create_draft",
  "registry_validate_draft",
  "registry_activate_draft",
]);

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNullableString(value: unknown): string | null {
  const trimmed = asTrimmed(value);
  return trimmed || null;
}

function asPositiveInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

export function sanitizeSkillSlug(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return normalized.slice(0, 44);
}

export function buildSkillToolName(slug: string): string {
  const safe = sanitizeSkillSlug(slug);
  return safe ? `skill_${safe}` : "skill_custom";
}

function isActiveLifecycle(value: unknown): value is "canary" | "stable" | "rollback" {
  return value === "canary" || value === "stable" || value === "rollback";
}

function isRunner(value: unknown): value is SkillRunner {
  return value === "code_cli_run" || value === "terminal_exec";
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

function isValidationStatus(value: unknown): value is SkillValidationStatus {
  return (
    value === "unvalidated" ||
    value === "requested" ||
    value === "passed" ||
    value === "failed"
  );
}

function dbErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const record = error as { message?: unknown; details?: unknown; hint?: unknown };
  return [record.message, record.details, record.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function isMissingSkillValidationSchemaError(error: unknown): boolean {
  const message = dbErrorMessage(error);
  return (
    /validation_(status|task|token|output_preview|requested_at)|validated_at/i.test(message) &&
    /(does not exist|could not find|schema cache)/i.test(message)
  );
}

function skillValidationSchemaError(error: unknown): Error {
  const message = dbErrorMessage(error);
  return new Error(
    `Skill registry schema is missing validation columns. Apply migration ` +
      "`20260509010000_orchestrator_runtime_schema_repair.sql` and reload PostgREST, then retry." +
      (message ? ` Database error: ${message}` : "")
  );
}

function mapSkillRegistryRow(row: Record<string, unknown>): SkillRegistryEntry | null {
  const skillId = asTrimmed(row.id);
  const slug = sanitizeSkillSlug(asTrimmed(row.slug));
  const name = asTrimmed(row.name);
  const description = asTrimmed(row.description);
  const lifecycle = row.lifecycle;
  const runner = row.runner;
  if (!skillId || !slug || !name || !isLifecycle(lifecycle) || !isRunner(runner)) return null;
  return {
    skillId,
    slug,
    name,
    description,
    lifecycle,
    runner,
    activeVersionId: asNullableString(row.active_version_id),
    updatedAt: asNullableString(row.updated_at),
  };
}

function mapSkillDraftVersionRow(
  skill: SkillRegistryEntry,
  versionRow: Record<string, unknown>
): SkillDraftVersion | null {
  const versionId = asTrimmed(versionRow.id);
  const source = asTrimmed(versionRow.source);
  const validationStatus = versionRow.validation_status;
  if (!versionId || !source || !isValidationStatus(validationStatus)) return null;
  return {
    skillId: skill.skillId,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    lifecycle: skill.activeVersionId === versionId ? skill.lifecycle : "draft",
    runner: skill.runner,
    versionId,
    source,
    defaultState: asRecord(versionRow.default_state),
    validationStatus,
    validationTask: asNullableString(versionRow.validation_task),
    validationToken: asNullableString(versionRow.validation_token),
    validationOutputPreview: asNullableString(versionRow.validation_output_preview),
    updatedAt: asNullableString(versionRow.updated_at) || skill.updatedAt,
  };
}

function skillRefMatches(row: SkillRegistryEntry, skillRef: string): boolean {
  const ref = skillRef.trim().toLowerCase();
  if (!ref) return false;
  return (
    row.skillId.toLowerCase() === ref ||
    row.slug.toLowerCase() === ref ||
    row.name.trim().toLowerCase() === ref
  );
}

export function createSkillValidationToken(): string {
  return `sv_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function parseSkillValidationOutput(
  raw: string,
  token: string
): { matched: boolean; passed: boolean; reason?: string } {
  const marker = `__SKILL_VALIDATION__:${token}:`;
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = [...lines].reverse().find((candidate) => candidate.startsWith(marker));
  if (!line) return { matched: false, passed: false };
  const verdict = line.slice(marker.length).trim();
  if (verdict === "PASS") return { matched: true, passed: true };
  if (verdict.startsWith("FAIL")) {
    return {
      matched: true,
      passed: false,
      reason: verdict.replace(/^FAIL:?/i, "").trim() || "validation_failed",
    };
  }
  return { matched: true, passed: false, reason: verdict || "invalid_validation_marker" };
}

export async function listSkillRegistry(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
}): Promise<SkillRegistryEntry[]> {
  const { data, error } = await args.supabase
    .from("orchestrator_skills")
    .select("id,slug,name,description,lifecycle,runner,active_version_id,updated_at")
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .order("updated_at", { ascending: false });
  if (error) {
    console.warn("[skills-runtime] list registry failed:", error.message);
    return [];
  }
  return (data as Array<Record<string, unknown>> | null)
    ?.map((row) => mapSkillRegistryRow(row))
    .filter((row): row is SkillRegistryEntry => !!row) || [];
}

export async function createSkillDraft(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  runner: SkillRunner;
  source: string;
  defaultState?: Record<string, unknown> | null;
}): Promise<SkillDraftVersion> {
  const name = asTrimmed(args.name) || "Custom Skill";
  const slug = sanitizeSkillSlug(asTrimmed(args.slug) || name);
  if (!slug) {
    throw new Error("Skill slug is required.");
  }
  if (RESERVED_SKILL_SLUGS.has(slug)) {
    throw new Error(`Skill slug "${slug}" is reserved. Choose a different name.`);
  }
  const description = asTrimmed(args.description);
  const source = asTrimmed(args.source);
  if (!source) {
    throw new Error("Skill source is required.");
  }

  const registry = await listSkillRegistry({
    supabase: args.supabase,
    userId: args.userId,
    agentId: args.agentId,
  });
  const existing = registry.find((entry) => entry.slug === slug) || null;
  let skillId = existing?.skillId || null;
  if (existing && existing.runner !== args.runner) {
    throw new Error(
      `Skill "${existing.slug}" already exists with runner "${existing.runner}". Create a new skill instead of changing runners in place.`
    );
  }

  let createdSkillForDraft = false;
  let nextVersion = 1;
  if (skillId) {
    const { data: latestVersionRow, error: latestVersionErr } = await args.supabase
      .from("orchestrator_skill_versions")
      .select("version")
      .eq("user_id", args.userId)
      .eq("agent_id", args.agentId)
      .eq("skill_id", skillId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestVersionErr) {
      throw new Error(latestVersionErr.message || "Failed to load latest skill version.");
    }
    const currentVersion = asPositiveInteger(
      (latestVersionRow as Record<string, unknown> | null)?.version
    );
    nextVersion = currentVersion > 0 ? currentVersion + 1 : 1;
  }

  if (!skillId) {
    const { data: createdSkill, error: createErr } = await args.supabase
      .from("orchestrator_skills")
      .insert({
        user_id: args.userId,
        agent_id: args.agentId,
        slug,
        name,
        description,
        lifecycle: "draft",
        runner: args.runner,
        latest_version: nextVersion,
      })
      .select("id,lifecycle")
      .single();
    if (createErr || !createdSkill?.id) {
      throw new Error(createErr?.message || "Failed to create skill draft.");
    }
    skillId = String(createdSkill.id);
    createdSkillForDraft = true;
  }

  const { data: version, error: versionErr } = await args.supabase
    .from("orchestrator_skill_versions")
    .insert({
      user_id: args.userId,
      agent_id: args.agentId,
      skill_id: skillId,
      version: nextVersion,
      lifecycle: "draft",
      runner: args.runner,
      source,
      default_state: args.defaultState || {},
      validation_status: "unvalidated",
    })
    .select(
      "id,source,default_state,validation_status,validation_task,validation_token,validation_output_preview,updated_at"
    )
    .single();
  if (versionErr || !version?.id) {
    if (createdSkillForDraft && skillId) {
      await args.supabase
        .from("orchestrator_skills")
        .delete()
        .eq("id", skillId)
        .eq("user_id", args.userId)
        .eq("agent_id", args.agentId);
    }
    if (isMissingSkillValidationSchemaError(versionErr)) {
      throw skillValidationSchemaError(versionErr);
    }
    throw new Error(versionErr?.message || "Failed to create skill draft version.");
  }

  if (existing) {
    const { error: updateSkillErr } = await args.supabase
      .from("orchestrator_skills")
      .update({
        name,
        description,
        latest_version: nextVersion,
        updated_at: new Date().toISOString(),
      })
      .eq("id", skillId)
      .eq("user_id", args.userId)
      .eq("agent_id", args.agentId);
    if (updateSkillErr) {
      await args.supabase
        .from("orchestrator_skill_versions")
        .delete()
        .eq("id", version.id)
        .eq("user_id", args.userId)
        .eq("agent_id", args.agentId);
      throw new Error(updateSkillErr.message || "Failed to update skill draft metadata.");
    }
  }

  return {
    skillId,
    versionId: String(version.id),
    slug,
    name,
    description,
    lifecycle: "draft",
    runner: args.runner,
    source,
    defaultState: asRecord(version.default_state),
    validationStatus: "unvalidated",
    validationTask: null,
    validationToken: null,
    validationOutputPreview: null,
    updatedAt: asNullableString(version.updated_at),
  };
}

export async function resolveSkillDraftVersion(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  skillRef: string;
}): Promise<SkillDraftVersion | null> {
  const registry = await listSkillRegistry(args);
  const skill = registry.find((entry) => skillRefMatches(entry, args.skillRef));
  if (!skill) return null;

  const { data: versionRow, error } = await args.supabase
    .from("orchestrator_skill_versions")
    .select(
      "id,source,default_state,validation_status,validation_task,validation_token,validation_output_preview,updated_at"
    )
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .eq("skill_id", skill.skillId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingSkillValidationSchemaError(error)) {
      throw skillValidationSchemaError(error);
    }
    return null;
  }
  if (!versionRow) return null;
  return mapSkillDraftVersionRow(skill, versionRow as Record<string, unknown>);
}

export async function requestSkillDraftValidation(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  versionId: string;
  validationTask: string;
  token: string;
}) {
  const { error } = await args.supabase
    .from("orchestrator_skill_versions")
    .update({
      validation_status: "requested",
      validation_task: args.validationTask.trim(),
      validation_token: args.token,
      validation_output_preview: null,
      validation_requested_at: new Date().toISOString(),
      validated_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.versionId)
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId);
  if (error) {
    if (isMissingSkillValidationSchemaError(error)) {
      throw skillValidationSchemaError(error);
    }
    throw new Error(error.message || "Failed to request skill draft validation.");
  }
}

export async function activateSkillDraft(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  skillRef: string;
  validationOutput: string;
}): Promise<SkillDraftVersion> {
  const draft = await resolveSkillDraftVersion(args);
  if (!draft) {
    throw new Error(`Draft skill "${args.skillRef}" was not found.`);
  }
  if (!draft.validationToken) {
    throw new Error(`Skill "${draft.slug}" has not been validated yet.`);
  }

  const validation = parseSkillValidationOutput(args.validationOutput, draft.validationToken);
  const preview = String(args.validationOutput || "").trim().slice(0, 4000);
  const nowIso = new Date().toISOString();
  if (!validation.matched || !validation.passed) {
    const { error: markFailedErr } = await args.supabase
      .from("orchestrator_skill_versions")
      .update({
        validation_status: "failed",
        validation_output_preview: preview,
        validated_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", draft.versionId)
      .eq("user_id", args.userId)
      .eq("agent_id", args.agentId);
    if (markFailedErr) {
      if (isMissingSkillValidationSchemaError(markFailedErr)) {
        throw skillValidationSchemaError(markFailedErr);
      }
      throw new Error(
        `Validation failed for "${draft.slug}", and Groovy could not persist the failure: ${markFailedErr.message || "unknown_error"}`
      );
    }
    throw new Error(
      validation.matched
        ? `Validation failed for "${draft.slug}": ${validation.reason || "validation_failed"}`
        : `Validation marker missing for "${draft.slug}".`
    );
  }

  const { error: markPassedErr } = await args.supabase
    .from("orchestrator_skill_versions")
    .update({
      validation_status: "passed",
      validation_output_preview: preview,
      validated_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", draft.versionId)
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId);
  if (markPassedErr) {
    if (isMissingSkillValidationSchemaError(markPassedErr)) {
      throw skillValidationSchemaError(markPassedErr);
    }
    throw new Error(markPassedErr.message || `Failed to mark skill "${draft.slug}" as validated.`);
  }

  const { error: activateErr } = await args.supabase
    .from("orchestrator_skills")
    .update({
      lifecycle: "canary",
      active_version_id: draft.versionId,
      updated_at: nowIso,
    })
    .eq("id", draft.skillId)
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId);
  if (activateErr) {
    throw new Error(activateErr.message || `Failed to activate skill "${draft.slug}".`);
  }

  return {
    ...draft,
    lifecycle: "canary",
    validationStatus: "passed",
    validationOutputPreview: preview,
    updatedAt: nowIso,
  };
}

export async function loadActiveSkillRuntimeTools(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  epochId?: string | null;
  branchId?: string | null;
}): Promise<SkillRuntimeTool[]> {
  const { supabase, userId, agentId } = args;
  const epochId = asTrimmed(args.epochId || "") || null;
  const branchId = asTrimmed(args.branchId || "") || null;

  const { data: skillRows, error: skillErr } = await supabase
    .from("orchestrator_skills")
    .select("id,slug,name,description,lifecycle,runner,active_version_id")
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .in("lifecycle", ["canary", "stable", "rollback"]);
  if (skillErr) {
    console.warn("[skills-runtime] load skills failed:", skillErr.message);
    return [];
  }

  const activeRows = (skillRows || []).filter((row) => {
    const lifecycle = (row as { lifecycle?: unknown }).lifecycle;
    const activeVersion = (row as { active_version_id?: unknown }).active_version_id;
    return isActiveLifecycle(lifecycle) && typeof activeVersion === "string" && activeVersion.trim().length > 0;
  });
  if (activeRows.length === 0) return [];

  const versionIds = activeRows
    .map((row) => asTrimmed((row as { active_version_id?: unknown }).active_version_id))
    .filter((id): id is string => id.length > 0);
  if (versionIds.length === 0) return [];

  const { data: versionRows, error: versionErr } = await supabase
    .from("orchestrator_skill_versions")
    .select("id,skill_id,runner,source,default_state")
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .in("id", versionIds);
  if (versionErr) {
    console.warn("[skills-runtime] load versions failed:", versionErr.message);
    return [];
  }
  const versionById = new Map<
    string,
    { skillId: string; runner: SkillRunner; source: string; defaultState: Record<string, unknown> }
  >();
  for (const row of versionRows || []) {
    const id = asTrimmed((row as { id?: unknown }).id);
    const skillId = asTrimmed((row as { skill_id?: unknown }).skill_id);
    const source = asTrimmed((row as { source?: unknown }).source);
    const runnerRaw = (row as { runner?: unknown }).runner;
    if (!id || !skillId || !source || !isRunner(runnerRaw)) continue;
    versionById.set(id, {
      skillId,
      runner: runnerRaw,
      source,
      defaultState: asRecord((row as { default_state?: unknown }).default_state),
    });
  }
  if (versionById.size === 0) return [];

  let runtimeRows: Array<Record<string, unknown>> = [];
  if (epochId && branchId) {
    const { data } = await supabase
      .from("orchestrator_skill_runtime_state")
      .select("skill_version_id,state")
      .eq("user_id", userId)
      .eq("agent_id", agentId)
      .eq("epoch_id", epochId)
      .eq("branch_id", branchId)
      .in("skill_version_id", versionIds);
    runtimeRows = (data as Array<Record<string, unknown>> | null) || [];
  }
  const runtimeStateByVersion = new Map<string, Record<string, unknown>>();
  for (const row of runtimeRows) {
    const versionId = asTrimmed(row.skill_version_id);
    if (!versionId) continue;
    runtimeStateByVersion.set(versionId, asRecord(row.state));
  }

  const toolNameCounts = new Map<string, number>();
  const out: SkillRuntimeTool[] = [];

  for (const row of activeRows) {
    const skillId = asTrimmed((row as { id?: unknown }).id);
    const slug = sanitizeSkillSlug(asTrimmed((row as { slug?: unknown }).slug));
    const lifecycleRaw = (row as { lifecycle?: unknown }).lifecycle;
    const activeVersionId = asTrimmed((row as { active_version_id?: unknown }).active_version_id);
    if (!skillId || !slug || !activeVersionId || !isActiveLifecycle(lifecycleRaw)) continue;
    const version = versionById.get(activeVersionId);
    if (!version || version.skillId !== skillId) continue;

    const baseToolName = buildSkillToolName(slug);
    const seen = toolNameCounts.get(baseToolName) || 0;
    toolNameCounts.set(baseToolName, seen + 1);
    const toolName = seen === 0 ? baseToolName : `${baseToolName}_${seen + 1}`;

    const runtimeState = runtimeStateByVersion.get(activeVersionId) || {};
    out.push({
      skillId,
      versionId: activeVersionId,
      toolName,
      slug,
      name: asTrimmed((row as { name?: unknown }).name) || slug,
      description: asTrimmed((row as { description?: unknown }).description),
      lifecycle: lifecycleRaw,
      runner: version.runner,
      source: version.source,
      state: {
        ...version.defaultState,
        ...runtimeState,
      },
    });
  }

  return out;
}

export function extractSkillStatePatchFromText(raw: string): Record<string, unknown> | null {
  const text = String(raw || "");
  const marker = "__SKILL_STATE_PATCH__:";
  const idx = text.lastIndexOf(marker);
  if (idx < 0) return null;
  const maybeJson = text.slice(idx + marker.length).trim();
  if (!maybeJson.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(maybeJson);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

export async function applySkillStatePatch(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  skillVersionId: string;
  epochId?: string | null;
  branchId?: string | null;
  currentState: Record<string, unknown>;
  patch: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const merged = {
    ...(args.currentState || {}),
    ...(args.patch || {}),
  };

  const epochId = asTrimmed(args.epochId || "") || null;
  const branchId = asTrimmed(args.branchId || "") || null;
  if (!epochId || !branchId) return merged;

  await args.supabase.from("orchestrator_skill_runtime_state").upsert(
    {
      user_id: args.userId,
      agent_id: args.agentId,
      skill_version_id: args.skillVersionId,
      epoch_id: epochId,
      branch_id: branchId,
      state: merged,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,agent_id,skill_version_id,epoch_id,branch_id" }
  );

  return merged;
}
