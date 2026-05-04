import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateObject } from "ai";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveChatModel, type ProviderId } from "@/lib/ai/modelResolver";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";
import { getOrCreateRuntimeSessionForAgent } from "@/lib/orchestrator/runtimeGraph";
import { getUpreadyReadinessForFlowUser } from "@/lib/upready/client";
import type {
  CellAgentOption,
  CellDetail,
  CellEfficiencySummary,
  CellKeyResultSummary,
  CellKrStatus,
  CellMemberEngagement,
  CellMemberHealthSignal,
  CellMemberSummary,
  CellModelUsageSummary,
  CellSignalStrength,
  CellSignalTypeSummary,
  CellSummary,
  CellTimelineItem,
} from "./types";

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 90;
const FRAMEWORK_MODEL_ANTHROPIC = "claude-sonnet-4.5";
const FRAMEWORK_MODEL_OPENAI = "gpt-5-mini-2025-08-07";
const CLASSIFIER_MODEL_ANTHROPIC = "claude-haiku-4.5";
const CLASSIFIER_MODEL_OPENAI = "gpt-5-mini-2025-08-07";
const KR_EVAL_MODEL_ANTHROPIC = "claude-sonnet-4.5";
const KR_EVAL_MODEL_OPENAI = "gpt-5-mini-2025-08-07";
const FRAMEWORK_VERSION = "cells_v1";
const CLASSIFICATION_VERSION = "cells_signal_v1";
const KR_EVAL_TTL_MS = 4 * 60 * 60 * 1000;
const STALE_SIGNAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_SIGNAL_TAXONOMY: Array<{ key: string; label: string; description: string }> = [
  {
    key: "new_context",
    label: "New Context",
    description: "Fresh information or business context that helps the agent act better.",
  },
  {
    key: "priority_shift",
    label: "Priority Shift",
    description: "A change in what matters most right now.",
  },
  {
    key: "constraint",
    label: "Constraint",
    description: "Limits, guardrails, or things the agent should avoid.",
  },
  {
    key: "approval_or_correction",
    label: "Approval Or Correction",
    description: "Human steering that confirms or corrects agent behavior.",
  },
];

const DEFAULT_KEY_RESULTS: Array<{
  label: string;
  description: string;
  measurementMode: "computed" | "hybrid" | "manual";
  evaluationMethod: string;
  targetValue: string;
  direction: "increase" | "decrease" | "maintain" | "binary";
}> = [
  {
    label: "Make visible progress toward the objective",
    description: "Track evidence that the cell is producing real forward motion.",
    measurementMode: "hybrid",
    evaluationMethod:
      "Use available artifacts and human review to determine whether the cell is advancing the objective.",
    targetValue: "Meaningful weekly progress",
    direction: "increase",
  },
  {
    label: "Maintain strong signal coverage",
    description: "Ensure humans are feeding enough signal for the agent to operate well.",
    measurementMode: "computed",
    evaluationMethod:
      "Look at commands, signal diversity, Gmail/Calendar coverage, and freshness of signal.",
    targetValue: "High signal coverage",
    direction: "increase",
  },
  {
    label: "Keep the agent efficient",
    description: "Reduce wasteful looping and focus spend on meaningful outcomes.",
    measurementMode: "computed",
    evaluationMethod:
      "Compare token usage, tool usage, and repetition against meaningful outcomes.",
    targetValue: "Low loop risk",
    direction: "decrease",
  },
];

type WorkspaceContext = {
  userId: string;
  userEmail: string | null;
  workspaceId: string;
  workspaceName: string;
  role: "admin" | "member";
};

type WorkspaceUserDirectoryEntry = {
  userId: string;
  email: string | null;
  role: "admin" | "member";
};

type CellRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  name: string;
  objective: string;
  objective_summary: string | null;
  owner_user_id: string;
  status: "active" | "paused" | "archived";
  privacy_mode: "workspace" | "admin_only";
  okr_generation_version: string | null;
  framework: Record<string, unknown> | null;
  analytics_cache: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type CellMemberRow = {
  cell_id: string;
  user_id: string;
  role: "leader" | "member";
  weight: number | null;
  created_at: string;
  updated_at: string;
};

type CellKeyResultRow = {
  id: string;
  cell_id: string;
  position: number;
  label: string;
  description: string | null;
  measurement_mode: "computed" | "hybrid" | "manual";
  evaluation_method: string | null;
  target_value: string | null;
  direction: "increase" | "decrease" | "maintain" | "binary";
  status: CellKrStatus;
  confidence: number | null;
  evaluation_cache: Record<string, unknown> | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
};

type HumanArtifact = {
  artifactType: "message" | "request";
  artifactId: string;
  userId: string;
  source: "human_command" | "team_request";
  createdAt: string;
  content: string;
};

type ClassificationRecord = {
  artifactType: "message" | "request";
  artifactId: string;
  userId: string;
  source: string;
  contentHash: string;
  summary: string;
  signalStrength: CellSignalStrength;
  signalTypes: Array<{ key: string; label: string; confidence: number }>;
};

type FrameworkResult = {
  objectiveSummary: string;
  signalTaxonomy: Array<{ key: string; label: string; description: string }>;
  keyResults: Array<{
    label: string;
    description: string;
    measurementMode: "computed" | "hybrid" | "manual";
    evaluationMethod: string;
    targetValue: string;
    direction: "increase" | "decrease" | "maintain" | "binary";
  }>;
  meta: {
    model: string | null;
    provider: ProviderId | null;
    generatedAt: string;
    version: string;
  };
};

type KeyResultEvaluation = {
  id: string;
  currentValue: string | null;
  progressPercent: number | null;
  status: CellKrStatus;
  confidence: number | null;
  evidence: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringOrNull(value: unknown): string | null {
  const trimmed = asString(value).trim();
  return trimmed || null;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function coerceIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSignalKey(input: string, fallback: string): string {
  const key = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || fallback;
}

function coerceSignalStrength(value: unknown): CellSignalStrength {
  const normalized = asString(value).trim().toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  return "medium";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildArtifactLookupKey(artifactType: HumanArtifact["artifactType"], artifactId: string): string {
  return `${artifactType}:${artifactId}`;
}

function findArtifactByModelArtifactId(
  artifacts: HumanArtifact[],
  modelArtifactId: string
): HumanArtifact | null {
  const normalizedId = normalizeText(modelArtifactId);
  return (
    artifacts.find(
      (artifact) =>
        artifact.artifactId === normalizedId ||
        buildArtifactLookupKey(artifact.artifactType, artifact.artifactId) === normalizedId
    ) || null
  );
}

function buildFallbackClassificationRecord(args: {
  artifact: HumanArtifact;
  taxonomy: Array<{ key: string; label: string; description: string }>;
}): ClassificationRecord {
  return {
    artifactType: args.artifact.artifactType,
    artifactId: args.artifact.artifactId,
    userId: args.artifact.userId,
    source: args.artifact.source,
    contentHash: sha256(normalizeText(args.artifact.content)),
    summary: normalizeText(args.artifact.content).slice(0, 180),
    signalStrength: "medium",
    signalTypes: [
      {
        key: args.taxonomy[0]?.key || "new_context",
        label: args.taxonomy[0]?.label || "New Context",
        confidence: 0.35,
      },
    ],
  };
}

function chunkArray<T>(items: T[], size: number): T[][];
function chunkArray<T>(items: T[], size: number): Array<T[]> {
  const chunks: Array<T[]> = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function parseRange(searchParams: URLSearchParams | null | undefined): { fromIso: string; toIso: string } {
  const now = new Date();
  const toRaw = searchParams?.get("to") || "";
  const fromRaw = searchParams?.get("from") || "";
  let to = coerceIso(toRaw) ? new Date(toRaw) : now;
  let proposedFrom = coerceIso(fromRaw)
    ? new Date(fromRaw)
    : new Date(now.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  if (proposedFrom > to) {
    const swappedTo = proposedFrom;
    proposedFrom = to;
    to = swappedTo;
  }
  const maxFrom = new Date(to.getTime() - MAX_RANGE_DAYS * 24 * 60 * 60 * 1000);
  const from = proposedFrom < maxFrom ? maxFrom : proposedFrom;
  return {
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
  };
}

async function requireWorkspaceContext(
  supabase: SupabaseClient,
  opts?: { requireAdmin?: boolean }
): Promise<WorkspaceContext> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    throw new Error("Unauthorized");
  }

  const admin = createSupabaseAdminClient();
  const { data: membership } = await admin
    .from("workspace_members")
    .select("workspace_id, role, workspaces(name)")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  const workspaceId =
    typeof (membership as { workspace_id?: unknown } | null)?.workspace_id === "string"
      ? String((membership as { workspace_id?: string }).workspace_id)
      : null;
  const role =
    (membership as { role?: unknown } | null)?.role === "admin" ? "admin" : "member";
  const workspaceNameRaw = (membership as { workspaces?: unknown } | null)?.workspaces;
  const workspaceName = Array.isArray(workspaceNameRaw)
    ? asString((workspaceNameRaw[0] as { name?: unknown } | undefined)?.name) || "Workspace"
    : asString((workspaceNameRaw as { name?: unknown } | null)?.name) || "Workspace";

  if (!workspaceId) {
    throw new Error("Workspace not found");
  }
  if (opts?.requireAdmin && role !== "admin") {
    throw new Error("Admin access required");
  }

  return {
    userId: user.id,
    userEmail: user.email || null,
    workspaceId,
    workspaceName,
    role,
  };
}

async function getWorkspaceDirectory(workspaceId: string): Promise<WorkspaceUserDirectoryEntry[]> {
  const admin = createSupabaseAdminClient();
  const { data: members } = await admin
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId);

  const rows = Array.isArray(members) ? members : [];
  const out: WorkspaceUserDirectoryEntry[] = [];
  for (const row of rows) {
    const userId = typeof row.user_id === "string" ? row.user_id : "";
    const role = row.role === "admin" ? "admin" : "member";
    if (!userId) continue;
    let email: string | null = null;
    try {
      const { data } = await admin.auth.admin.getUserById(userId);
      email = data.user?.email || null;
    } catch {
      email = null;
    }
    out.push({ userId, email, role });
  }
  return out;
}

async function resolveModelForUser(userId: string, mode: "quality" | "fast") {
  const admin = createSupabaseAdminClient();
  const resolved = await resolveKeys(userId, admin, "");
  const anthropicAvailable =
    (resolved.keyModes.anthropic === "user" && !!resolved.userKeys.anthropic) ||
    (resolved.keyModes.anthropic !== "user" && !!process.env.ANTHROPIC_API_KEY);
  const openAiAvailable =
    (resolved.keyModes.openai === "user" && !!resolved.userKeys.openai) ||
    (resolved.keyModes.openai !== "user" && !!process.env.OPENAI_API_KEY);

  if (mode === "fast") {
    if (anthropicAvailable) {
      return {
        provider: "anthropic" as const,
        modelName: CLASSIFIER_MODEL_ANTHROPIC,
        apiKey: resolved.keyModes.anthropic === "user" ? resolved.userKeys.anthropic || null : null,
      };
    }
    if (openAiAvailable) {
      return {
        provider: "openai" as const,
        modelName: CLASSIFIER_MODEL_OPENAI,
        apiKey: resolved.keyModes.openai === "user" ? resolved.userKeys.openai || null : null,
      };
    }
  }

  if (anthropicAvailable) {
    return {
      provider: "anthropic" as const,
      modelName: FRAMEWORK_MODEL_ANTHROPIC,
      apiKey: resolved.keyModes.anthropic === "user" ? resolved.userKeys.anthropic || null : null,
    };
  }
  if (openAiAvailable) {
    return {
      provider: "openai" as const,
      modelName: mode === "quality" ? FRAMEWORK_MODEL_OPENAI : CLASSIFIER_MODEL_OPENAI,
      apiKey: resolved.keyModes.openai === "user" ? resolved.userKeys.openai || null : null,
    };
  }

  return null;
}

const frameworkSchema = z.object({
  objectiveSummary: z.string().min(1).max(220),
  signalTaxonomy: z.array(
    z.object({
      key: z.string().min(1).max(48),
      label: z.string().min(1).max(64),
      description: z.string().min(1).max(180),
    })
  ),
  keyResults: z.array(
    z.object({
      label: z.string().min(1).max(120),
      description: z.string().min(1).max(220),
      measurementMode: z.enum(["computed", "hybrid", "manual"]),
      evaluationMethod: z.string().min(1).max(220),
      targetValue: z.string().min(1).max(120),
      direction: z.enum(["increase", "decrease", "maintain", "binary"]),
    })
  ),
});

function finalizeFrameworkTaxonomy(
  items: Array<{ key: string; label: string; description: string }>
): Array<{ key: string; label: string; description: string }> {
  const usedKeys = new Set<string>();
  const normalized = items
    .map((item, index) => {
      let key = normalizeSignalKey(item.key, `signal_${index + 1}`);
      while (usedKeys.has(key)) key = `${key}_${usedKeys.size + 1}`;
      usedKeys.add(key);
      return {
        key,
        label: normalizeText(item.label).slice(0, 64),
        description: normalizeText(item.description).slice(0, 180),
      };
    })
    .filter((entry) => entry.key && entry.label && entry.description);

  for (const fallback of DEFAULT_SIGNAL_TAXONOMY) {
    if (normalized.length >= 4) break;
    let key = normalizeSignalKey(fallback.key, `signal_${normalized.length + 1}`);
    while (usedKeys.has(key)) key = `${key}_${usedKeys.size + 1}`;
    usedKeys.add(key);
    normalized.push({
      key,
      label: fallback.label,
      description: fallback.description,
    });
  }

  return normalized.slice(0, 8);
}

function finalizeFrameworkKeyResults(
  items: Array<{
    label: string;
    description: string;
    measurementMode: "computed" | "hybrid" | "manual";
    evaluationMethod: string;
    targetValue: string;
    direction: "increase" | "decrease" | "maintain" | "binary";
  }>
): Array<{
  label: string;
  description: string;
  measurementMode: "computed" | "hybrid" | "manual";
  evaluationMethod: string;
  targetValue: string;
  direction: "increase" | "decrease" | "maintain" | "binary";
}> {
  const normalized = items
    .map((kr) => ({
      label: normalizeText(kr.label).slice(0, 120),
      description: normalizeText(kr.description).slice(0, 220),
      measurementMode: kr.measurementMode,
      evaluationMethod: normalizeText(kr.evaluationMethod).slice(0, 220),
      targetValue: normalizeText(kr.targetValue).slice(0, 120),
      direction: kr.direction,
    }))
    .filter((kr) => kr.label && kr.description && kr.evaluationMethod && kr.targetValue);

  for (const fallback of DEFAULT_KEY_RESULTS) {
    if (normalized.length >= 3) break;
    normalized.push({ ...fallback });
  }

  return normalized.slice(0, 5);
}

async function generateCellFramework(args: {
  userId: string;
  cellName: string;
  objective: string;
  agentName: string;
  memberEmails: string[];
}): Promise<FrameworkResult> {
  const modelInfo = await resolveModelForUser(args.userId, "quality");
  if (!modelInfo) {
    return {
      objectiveSummary: normalizeText(args.objective).slice(0, 220),
      signalTaxonomy: finalizeFrameworkTaxonomy(DEFAULT_SIGNAL_TAXONOMY),
      keyResults: finalizeFrameworkKeyResults(DEFAULT_KEY_RESULTS),
      meta: {
        model: null,
        provider: null,
        generatedAt: new Date().toISOString(),
        version: FRAMEWORK_VERSION,
      },
    };
  }

  const model = resolveChatModel(modelInfo.provider, modelInfo.modelName, modelInfo.apiKey ? { apiKey: modelInfo.apiKey } : undefined);
  const result = await generateObject({
    model,
    schema: frameworkSchema,
    prompt: `You are designing a performance framework for a human + AI work cell.

Cell name: ${args.cellName}
Existing agent: ${args.agentName}
Objective: ${args.objective}
Humans in cell: ${args.memberEmails.length > 0 ? args.memberEmails.join(", ") : "unknown"}

Return:
1. A concise objective summary.
2. A signal taxonomy for the kinds of human inputs that matter for THIS objective.
3. 3-5 key results that are practical to evaluate from operational artifacts.

Rules:
- Do not use generic corporate filler.
- Signal taxonomy must be reusable and stable across future classifications.
- Key names should be concrete.
- Prefer computed or hybrid KRs when possible.
- Only use manual when the objective truly cannot be inferred from artifacts.
- Target values should be simple strings a human can understand.
- This is for an admin dashboard, so optimize for clarity and evaluability.`,
  });

  const objectiveSummary = normalizeText(result.object.objectiveSummary).slice(0, 220);
  const signalTaxonomy = finalizeFrameworkTaxonomy(result.object.signalTaxonomy);

  return {
    objectiveSummary,
    signalTaxonomy,
    keyResults: finalizeFrameworkKeyResults(result.object.keyResults),
    meta: {
      model: modelInfo.modelName,
      provider: modelInfo.provider,
      generatedAt: new Date().toISOString(),
      version: FRAMEWORK_VERSION,
    },
  };
}

const classificationSchema = z.object({
  artifacts: z.array(
    z.object({
      artifactId: z.string().min(1),
      summary: z.string().min(1).max(200),
      signalStrength: z.enum(["high", "medium", "low"]),
      signalTypes: z.array(
        z.object({
          key: z.string().min(1).max(48),
          label: z.string().min(1).max(64),
          confidence: z.number(),
        })
      ),
    })
  ),
});

async function classifyArtifacts(args: {
  userId: string;
  taxonomy: Array<{ key: string; label: string; description: string }>;
  artifacts: HumanArtifact[];
}): Promise<ClassificationRecord[]> {
  if (args.artifacts.length === 0) return [];
  const modelInfo = await resolveModelForUser(args.userId, "fast");
  if (!modelInfo) {
    return args.artifacts.map((artifact) =>
      buildFallbackClassificationRecord({
        artifact,
        taxonomy: args.taxonomy,
      })
    );
  }

  const model = resolveChatModel(modelInfo.provider, modelInfo.modelName, modelInfo.apiKey ? { apiKey: modelInfo.apiKey } : undefined);
  const results: ClassificationRecord[] = [];
  for (const batch of chunkArray(args.artifacts, 12)) {
    const response = await generateObject({
      model,
      schema: classificationSchema,
      prompt: `You classify human-provided signals for a work cell.

Available taxonomy:
${args.taxonomy.map((item) => `- ${item.key}: ${item.label} — ${item.description}`).join("\n")}

Classify each artifact into 1-3 taxonomy types.

Rules:
- Reuse the taxonomy keys exactly.
- "high" means the artifact materially changes what the agent should do.
- "medium" means useful but not decisive.
- "low" means lightweight steering or low-information signal.
- Keep summaries short and concrete.

Artifacts:
${batch.map((artifact, index) => `${index + 1}. artifactId=${artifact.artifactId}
artifactType=${artifact.artifactType}
source=${artifact.source}
content=${artifact.content}`).join("\n\n")}`,
    });

    for (const item of response.object.artifacts) {
      const source = findArtifactByModelArtifactId(batch, item.artifactId);
      if (!source) continue;
      results.push({
        artifactType: source.artifactType,
        artifactId: source.artifactId,
        userId: source.userId,
        source: source.source,
        contentHash: sha256(normalizeText(source.content)),
        summary: normalizeText(item.summary).slice(0, 200),
        signalStrength: item.signalStrength,
        signalTypes: (() => {
          const normalized = item.signalTypes
            .map((signal, index) => {
              const fallbackKey = args.taxonomy[index]?.key || args.taxonomy[0]?.key || "new_context";
              const normalizedKey = normalizeSignalKey(signal.key, fallbackKey);
              const taxonomyMatch =
                args.taxonomy.find((entry) => entry.key === normalizedKey) || args.taxonomy[0];
              return {
                key: taxonomyMatch?.key || fallbackKey,
                label: taxonomyMatch?.label || signal.label,
                confidence: clamp01(signal.confidence),
              };
            })
            .slice(0, 3);

          return normalized.length > 0
            ? normalized
            : [
                {
                  key: args.taxonomy[0]?.key || "new_context",
                  label: args.taxonomy[0]?.label || "New Context",
                  confidence: 0.35,
                },
              ];
        })(),
      });
    }
  }
  return results;
}

const krEvaluationSchema = z.object({
  keyResults: z.array(
    z.object({
      id: z.string().min(1),
      currentValue: z.string().max(140).nullable(),
      progressPercent: z.number().nullable(),
      status: z.enum(["on_track", "at_risk", "off_track", "not_enough_signal"]),
      confidence: z.number().nullable(),
      evidence: z.array(z.string().min(1).max(180)),
    })
  ),
});

async function evaluateKeyResultsWithModel(args: {
  userId: string;
  objective: string;
  objectiveSummary: string | null;
  keyResults: CellKeyResultRow[];
  signalSummary: string[];
  metricsSummary: string[];
  outcomeSummary: string[];
}): Promise<Map<string, KeyResultEvaluation>> {
  const modelInfo = await resolveModelForUser(args.userId, "quality");
  if (!modelInfo || args.keyResults.length === 0) return new Map<string, KeyResultEvaluation>();

  const modelName = modelInfo.provider === "anthropic" ? KR_EVAL_MODEL_ANTHROPIC : KR_EVAL_MODEL_OPENAI;
  const model = resolveChatModel(modelInfo.provider, modelName, modelInfo.apiKey ? { apiKey: modelInfo.apiKey } : undefined);
  const response = await generateObject({
    model,
    schema: krEvaluationSchema,
    prompt: `You evaluate key results for a human + AI work cell.

Objective: ${args.objective}
Objective summary: ${args.objectiveSummary || "(none)"}

Key results:
${args.keyResults.map((kr) => `- id=${kr.id}
label=${kr.label}
description=${kr.description || ""}
measurement_mode=${kr.measurement_mode}
evaluation_method=${kr.evaluation_method || ""}
target_value=${kr.target_value || ""}
direction=${kr.direction}`).join("\n\n")}

Metrics summary:
${args.metricsSummary.join("\n")}

Recent signal evidence:
${args.signalSummary.length > 0 ? args.signalSummary.join("\n") : "(none)"}

Operational outcome evidence:
${args.outcomeSummary.length > 0 ? args.outcomeSummary.join("\n") : "(none)"}

Rules:
- Use only the provided evidence.
- If evidence is weak, return not_enough_signal.
- currentValue should be a short human-readable phrase, not a paragraph.
- progressPercent should be null if there is not enough signal.
- evidence should be concrete and short.`,
  });

  const byId = new Map<string, KeyResultEvaluation>();
  for (const item of response.object.keyResults) {
    byId.set(item.id, {
      id: item.id,
      currentValue: item.currentValue ? normalizeText(item.currentValue).slice(0, 140) : null,
      progressPercent: item.progressPercent === null ? null : clamp(item.progressPercent, 0, 100),
      status: item.status,
      confidence: item.confidence === null ? null : clamp01(item.confidence),
      evidence: item.evidence
        .map((line) => normalizeText(line).slice(0, 180))
        .filter(Boolean)
        .slice(0, 4),
    });
  }
  return byId;
}

async function loadCellRows(workspaceId: string, cellId?: string): Promise<CellRow[]> {
  const admin = createSupabaseAdminClient();
  let query = admin
    .from("workspace_cells")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false });
  if (cellId) query = query.eq("id", cellId);
  const { data } = await query;
  return ((data || []) as CellRow[]).map((row) => ({
    ...row,
    framework: isObject(row.framework) ? row.framework : {},
    analytics_cache: isObject(row.analytics_cache) ? row.analytics_cache : {},
  }));
}

async function loadCellMembers(cellIds: string[]): Promise<CellMemberRow[]> {
  if (cellIds.length === 0) return [];
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("workspace_cell_members")
    .select("*")
    .in("cell_id", cellIds)
    .order("created_at", { ascending: true });
  return (data || []) as CellMemberRow[];
}

async function loadCellKeyResults(cellIds: string[]): Promise<CellKeyResultRow[]> {
  if (cellIds.length === 0) return [];
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("workspace_cell_key_results")
    .select("*")
    .in("cell_id", cellIds)
    .order("position", { ascending: true });
  return (data || []) as CellKeyResultRow[];
}

async function loadAgentMap(agentIds: string[]): Promise<Map<string, { id: string; user_id: string; name: string }>> {
  const map = new Map<string, { id: string; user_id: string; name: string }>();
  if (agentIds.length === 0) return map;
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("agents")
    .select("id, user_id, name")
    .in("id", agentIds);
  for (const row of data || []) {
    const id = typeof row.id === "string" ? row.id : "";
    if (!id) continue;
    map.set(id, {
      id,
      user_id: typeof row.user_id === "string" ? row.user_id : "",
      name: typeof row.name === "string" ? row.name : "Groovy Agent",
    });
  }
  return map;
}

function buildHealthSignal(pointsSummary: {
  connected: boolean;
  latestScore: number | null;
  latestLoad: number | null;
  trendDelta7d: number | null;
  measuredAt: string | null;
  summary: string;
}): CellMemberHealthSignal {
  if (!pointsSummary.connected) {
    return {
      connected: false,
      latestScore: null,
      latestLoad: null,
      trendDelta7d: null,
      measuredAt: null,
      summary: "Upready not connected.",
      label: "unknown",
    };
  }
  const latestScore = pointsSummary.latestScore;
  const trend = pointsSummary.trendDelta7d;
  let label: CellMemberHealthSignal["label"] = "watch";
  if (latestScore === null) {
    label = "unknown";
  } else if (latestScore >= 75 && (trend === null || trend >= -2)) {
    label = "strong";
  } else if (latestScore < 55 || (trend !== null && trend <= -5)) {
    label = "strained";
  } else {
    label = "watch";
  }
  return {
    connected: true,
    latestScore,
    latestLoad: pointsSummary.latestLoad,
    trendDelta7d: trend,
    measuredAt: pointsSummary.measuredAt,
    summary: pointsSummary.summary,
    label,
  };
}

function firstLine(text: string): string {
  return normalizeText(String(text || "").split("\n")[0] || "");
}

function cleanEvidenceCell(value: string): string {
  return normalizeText(
    value
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`~>#]+/g, "")
  );
}

function extractEvidenceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => extractEvidenceText(item))
      .filter(Boolean)
      .join("\n");
  }
  if (isObject(value)) {
    const directFields = ["agentResponse", "response", "text", "message", "summary", "output"] as const;
    for (const field of directFields) {
      const direct = asStringOrNull(value[field]);
      if (direct) return direct;
    }
    const nestedFields = ["result", "data"] as const;
    for (const field of nestedFields) {
      if (!(field in value)) continue;
      const nested = extractEvidenceText(value[field]);
      if (nested) return nested;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return value === null || value === undefined ? "" : String(value);
}

function extractStructuredEvidenceLines(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^\|\s*:?-{2,}/.test(trimmed) || /^[-:|\s]+$/.test(trimmed)) continue;

    if (trimmed.includes("|")) {
      const cells = trimmed.split("|").map(cleanEvidenceCell).filter(Boolean);
      if (cells.length >= 2 && !cells.every((cell) => /^[:\-]+$/.test(cell)) && cells.some((cell) => /\d/.test(cell))) {
        const line = `${cells[0]}: ${cells.slice(1).join(" · ")}`.slice(0, 180);
        const key = line.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(line);
        }
      }
      continue;
    }

    const cleaned = cleanEvidenceCell(trimmed);
    if (!cleaned) continue;
    const looksMetricLike =
      /\d/.test(cleaned) ||
      /\b(users?|visitors?|sessions?|events?|rows?|records?|identified|created|updated|completed|scheduled|sent|drafted|generated|returned|found)\b/i.test(
        cleaned
      );
    if (!looksMetricLike) continue;
    const line = cleaned.slice(0, 180);
    const key = line.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(line);
    }
  }
  return out.slice(0, 6);
}

function isErrorLikeEvidenceText(text: string): boolean {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return true;
  return [
    "ngrok tunnel",
    "service unavailable",
    "service down",
    "tunnel error",
    "requires re-authorization",
    "not connected",
    "unauthorized",
    "failed",
    "unknown error",
    "non-retryable upstream api errors",
  ].some((needle) => normalized.includes(needle));
}

function looksLikeMeaningfulEvidenceText(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (extractStructuredEvidenceLines(text).length > 0) return true;
  if (isErrorLikeEvidenceText(normalized)) return false;
  const lower = normalized.toLowerCase();
  if (/\b(here are|i found|results?|today|total|count|completed|created|updated|generated|scheduled)\b/.test(lower) && /\d/.test(lower)) {
    return true;
  }
  return normalized.length >= 140 && !/^(let me|i'll|i will|working|checking|fetching|thinking)\b/.test(lower);
}

function summarizeEvidenceText(text: string, maxLen = 420): string {
  const facts = extractStructuredEvidenceLines(text);
  if (facts.length > 0) return facts.join("; ").slice(0, maxLen);
  return normalizeText(text).slice(0, maxLen);
}

function uniqueEvidenceLines(items: Array<string | null | undefined>, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = normalizeText(item || "");
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

async function ensureSignalClassificationCache(args: {
  cellId: string;
  userId: string;
  taxonomy: Array<{ key: string; label: string; description: string }>;
  artifacts: HumanArtifact[];
  refreshMissing?: boolean;
}): Promise<ClassificationRecord[]> {
  if (args.artifacts.length === 0) return [];
  const admin = createSupabaseAdminClient();
  const artifactIds = args.artifacts.map((artifact) => artifact.artifactId);
  const { data: existingRows } = await admin
    .from("workspace_cell_signal_classifications")
    .select("*")
    .eq("cell_id", args.cellId)
    .in("artifact_id", artifactIds);

  const existingMap = new Map<string, Record<string, unknown>>();
  for (const row of existingRows || []) {
    const artifactId = typeof row.artifact_id === "string" ? row.artifact_id : "";
    if (!artifactId) continue;
    existingMap.set(artifactId, row as unknown as Record<string, unknown>);
  }

  const needsClassification: HumanArtifact[] = [];
  const out: ClassificationRecord[] = [];

  for (const artifact of args.artifacts) {
    const expectedHash = sha256(normalizeText(artifact.content));
    const existing = existingMap.get(artifact.artifactId);
    const existingClassification = isObject(existing?.classification) ? existing?.classification : null;
    if (
      existing &&
      asString(existing.content_hash) === expectedHash &&
      existingClassification
    ) {
      const signalTypesRaw = Array.isArray(existingClassification.signalTypes)
        ? existingClassification.signalTypes
        : [];
      out.push({
        artifactType: artifact.artifactType,
        artifactId: artifact.artifactId,
        userId: artifact.userId,
        source: artifact.source,
        contentHash: expectedHash,
        summary: asString(existingClassification.summary) || normalizeText(artifact.content).slice(0, 180),
        signalStrength: coerceSignalStrength(existingClassification.signalStrength),
        signalTypes: signalTypesRaw
          .map((entry) => ({
            key: asString((entry as Record<string, unknown>)?.key),
            label: asString((entry as Record<string, unknown>)?.label),
            confidence: clamp01(asNumberOrNull((entry as Record<string, unknown>)?.confidence) || 0),
          }))
          .filter((entry) => entry.key && entry.label),
      });
      continue;
    }
    needsClassification.push(artifact);
  }

  if (needsClassification.length > 0 && args.refreshMissing === false) {
    out.push(
      ...needsClassification.map((artifact) =>
        buildFallbackClassificationRecord({
          artifact,
          taxonomy: args.taxonomy,
        })
      )
    );
  } else if (needsClassification.length > 0) {
    const classified = await classifyArtifacts({
      userId: args.userId,
      taxonomy: args.taxonomy,
      artifacts: needsClassification,
    });
    out.push(...classified);

    const upsertRows = classified.map((entry) => ({
      cell_id: args.cellId,
      artifact_type: entry.artifactType,
      artifact_id: entry.artifactId,
      user_id: entry.userId,
      source: entry.source,
      content_hash: entry.contentHash,
      classification: {
        version: CLASSIFICATION_VERSION,
        summary: entry.summary,
        signalStrength: entry.signalStrength,
        signalTypes: entry.signalTypes,
      },
      classified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    if (upsertRows.length > 0) {
      await admin
        .from("workspace_cell_signal_classifications")
        .upsert(upsertRows, { onConflict: "cell_id,artifact_type,artifact_id" });
    }
  }

  return out;
}

async function collectUsageForTraceIds(args: {
  workspaceId: string;
  traceIds: string[];
  fromIso: string;
  toIso: string;
}): Promise<{ usageEvents: Array<Record<string, unknown>>; toolEvents: Array<Record<string, unknown>> }> {
  const admin = createSupabaseAdminClient();
  const traceIds = Array.from(new Set(args.traceIds.filter(Boolean)));
  if (traceIds.length === 0) {
    return { usageEvents: [], toolEvents: [] };
  }

  const usageEvents: Array<Record<string, unknown>> = [];
  const toolEvents: Array<Record<string, unknown>> = [];
  for (const chunk of chunkArray(traceIds, 150)) {
    const { data: usageRows } = await admin
      .from("billing_usage_events")
      .select("*")
      .eq("workspace_id", args.workspaceId)
      .gte("created_at", args.fromIso)
      .lte("created_at", args.toIso)
      .in("trace_id", chunk);
    usageEvents.push(...((usageRows || []) as Array<Record<string, unknown>>));

    const { data: toolRows } = await admin
      .from("billing_tool_events")
      .select("*")
      .eq("workspace_id", args.workspaceId)
      .gte("created_at", args.fromIso)
      .lte("created_at", args.toIso)
      .in("trace_id", chunk);
    toolEvents.push(...((toolRows || []) as Array<Record<string, unknown>>));
  }
  return { usageEvents, toolEvents };
}

function buildUsageByModel(usageEvents: Array<Record<string, unknown>>): CellModelUsageSummary[] {
  const map = new Map<string, CellModelUsageSummary>();
  for (const event of usageEvents) {
    const provider = asStringOrNull(event.provider);
    const model = asStringOrNull(event.model);
    const key = `${provider || "unknown"}::${model || "unknown"}`;
    const current = map.get(key) || {
      provider,
      model,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      estimatedCalls: 0,
    };
    current.totalTokens += asNumberOrNull(event.total_tokens) || 0;
    current.inputTokens += asNumberOrNull(event.input_tokens) || 0;
    current.outputTokens += asNumberOrNull(event.output_tokens) || 0;
    current.calls += 1;
    current.estimatedCalls += event.estimated === true ? 1 : 0;
    map.set(key, current);
  }
  return Array.from(map.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

function computeEfficiency(args: {
  userCommands: number;
  assistantTurns: number;
  toolCalls: number;
  meaningfulOutcomes: number;
  totalTokens: number;
  repeatedAssistantMessages: number;
  rejectedOrFailedActions: number;
  totalActions: number;
}): CellEfficiencySummary {
  const tokensPerMeaningfulOutcome =
    args.meaningfulOutcomes > 0 ? Math.round(args.totalTokens / args.meaningfulOutcomes) : null;
  const assistantTurnsPerCommand =
    args.userCommands > 0 ? Number((args.assistantTurns / args.userCommands).toFixed(2)) : null;
  const toolCallsPerMeaningfulOutcome =
    args.meaningfulOutcomes > 0 ? Number((args.toolCalls / args.meaningfulOutcomes).toFixed(2)) : null;
  const repeatPatternRate =
    args.assistantTurns > 0 ? clamp01(args.repeatedAssistantMessages / args.assistantTurns) : 0;
  const stalledTraceRate =
    args.userCommands > 0 ? clamp01((args.userCommands - Math.min(args.userCommands, args.meaningfulOutcomes)) / args.userCommands) : 0;
  const reworkRate =
    args.totalActions > 0 ? clamp01(args.rejectedOrFailedActions / args.totalActions) : 0;

  const loopRisk = clamp01(
    repeatPatternRate * 0.38 +
      stalledTraceRate * 0.34 +
      reworkRate * 0.18 +
      ((assistantTurnsPerCommand || 0) > 2.8 ? 0.1 : 0)
  );

  let score = 100;
  if (tokensPerMeaningfulOutcome !== null) {
    score -= clamp(tokensPerMeaningfulOutcome / 2500, 0, 24);
  } else if (args.totalTokens > 0) {
    score -= 18;
  }
  score -= loopRisk * 38;
  score -= reworkRate * 18;
  if (args.meaningfulOutcomes === 0 && args.userCommands >= 3) score -= 18;
  score = clamp(score, 0, 100);

  const reasons: string[] = [];
  if (tokensPerMeaningfulOutcome !== null) {
    reasons.push(`${tokensPerMeaningfulOutcome.toLocaleString()} tokens per meaningful outcome`);
  } else {
    reasons.push("No clear outcome artifact yet");
  }
  if (assistantTurnsPerCommand !== null) {
    reasons.push(`${assistantTurnsPerCommand} assistant turns per user command`);
  }
  if (repeatPatternRate >= 0.2) {
    reasons.push(`${Math.round(repeatPatternRate * 100)}% repeated assistant patterns`);
  }
  if (reworkRate >= 0.15) {
    reasons.push(`${Math.round(reworkRate * 100)}% rework rate`);
  }

  let label: CellEfficiencySummary["label"] = "warming_up";
  if (args.userCommands < 3 && args.meaningfulOutcomes === 0) {
    label = "warming_up";
  } else if (loopRisk >= 0.62 || (repeatPatternRate >= 0.28 && args.meaningfulOutcomes === 0)) {
    label = "looping";
  } else if (score >= 72) {
    label = "efficient";
  } else if (args.meaningfulOutcomes > 0 && args.totalTokens > 0) {
    label = "expensive_but_productive";
  }

  return {
    label,
    score,
    loopRisk,
    tokensPerMeaningfulOutcome,
    assistantTurnsPerCommand,
    toolCallsPerMeaningfulOutcome,
    stalledTraceRate,
    repeatPatternRate,
    reworkRate,
    reasons,
  };
}

function rankSignalTypes(
  classifications: ClassificationRecord[],
  filterUserId?: string
): CellSignalTypeSummary[] {
  const map = new Map<string, { label: string; count: number; confidenceTotal: number; confidenceCount: number }>();
  for (const classification of classifications) {
    if (filterUserId && classification.userId !== filterUserId) continue;
    for (const signal of classification.signalTypes) {
      const current = map.get(signal.key) || {
        label: signal.label,
        count: 0,
        confidenceTotal: 0,
        confidenceCount: 0,
      };
      current.count += 1;
      current.confidenceTotal += signal.confidence;
      current.confidenceCount += 1;
      map.set(signal.key, current);
    }
  }
  return Array.from(map.entries())
    .map(([key, value]) => ({
      key,
      label: value.label,
      count: value.count,
      confidenceAvg: value.confidenceCount > 0 ? Number((value.confidenceTotal / value.confidenceCount).toFixed(2)) : null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function buildKeyResultSummary(row: CellKeyResultRow, evaluation?: KeyResultEvaluation | null): CellKeyResultSummary {
  const cache = isObject(row.evaluation_cache) ? row.evaluation_cache : {};
  const evaluationEvidence = Array.isArray(evaluation?.evidence)
    ? evaluation.evidence.map((item) => normalizeText(asString(item))).filter(Boolean)
    : [];
  const cachedEvidence = Array.isArray(cache.evidence)
    ? cache.evidence.map((item) => normalizeText(asString(item))).filter(Boolean)
    : [];
  const evidence = uniqueEvidenceLines(
    evaluationEvidence.length > 0 ? [...evaluationEvidence, ...cachedEvidence] : cachedEvidence,
    4
  );
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    measurementMode: row.measurement_mode,
    evaluationMethod: row.evaluation_method,
    targetValue: row.target_value,
    direction: row.direction,
    status: evaluation?.status || row.status,
    confidence: evaluation?.confidence ?? row.confidence ?? asNumberOrNull(cache.confidence),
    progressPercent: evaluation?.progressPercent ?? asNumberOrNull(cache.progressPercent),
    currentValue: evaluation?.currentValue ?? asStringOrNull(cache.currentValue),
    evidence,
    updatedAt: row.updated_at,
  };
}

async function updateKeyResultEvaluations(
  rows: CellKeyResultRow[],
  evaluations: Map<string, KeyResultEvaluation>
): Promise<void> {
  if (rows.length === 0 || evaluations.size === 0) return;
  const admin = createSupabaseAdminClient();
  const updates = rows
    .map((row) => {
      const evaluation = evaluations.get(row.id);
      if (!evaluation) return null;
      const cache = isObject(row.evaluation_cache) ? row.evaluation_cache : {};
      const cachedEvidence = Array.isArray(cache.evidence)
        ? cache.evidence.map((item) => normalizeText(asString(item))).filter(Boolean)
        : [];
      const evidence = uniqueEvidenceLines(
        evaluation.evidence.length > 0
          ? [...evaluation.evidence, ...cachedEvidence]
          : cachedEvidence,
        4
      );
      return {
        id: row.id,
        status: evaluation.status,
        confidence: evaluation.confidence,
        evaluation_cache: {
          status: evaluation.status,
          currentValue: evaluation.currentValue,
          progressPercent: evaluation.progressPercent,
          confidence: evaluation.confidence,
          evidence,
          evaluatedAt: new Date().toISOString(),
          version: FRAMEWORK_VERSION,
        },
        updated_at: new Date().toISOString(),
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);

  for (const update of updates) {
    const { error } = await admin
      .from("workspace_cell_key_results")
      .update({
        status: update.status,
        confidence: update.confidence,
        evaluation_cache: update.evaluation_cache,
        updated_at: update.updated_at,
      })
      .eq("id", update.id);
    if (error) {
      throw new Error(`Failed to persist key result evaluation ${update.id}: ${error.message}`);
    }
  }
}

function average(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (filtered.length === 0) return null;
  return Number((filtered.reduce((sum, value) => sum + value, 0) / filtered.length).toFixed(1));
}

function computeEngagement(opts: {
  commandCount: number;
  requestCount: number;
  signalDiversity: number;
  highSignalCount: number;
  mediumSignalCount: number;
  integrations: { gmail: boolean; calendar: boolean; heartbeat: boolean; upready: boolean };
  isStale: boolean;
  healthScore: number | null;
  rangeDays: number;
}): CellMemberEngagement {
  const integrationCount = [opts.integrations.gmail, opts.integrations.calendar, opts.integrations.heartbeat, opts.integrations.upready].filter(Boolean).length;
  const totalInteractions = opts.commandCount + opts.requestCount;
  const dailyRate = opts.rangeDays > 0 ? totalInteractions / opts.rangeDays : 0;

  const agentInteraction = clamp(Math.round(dailyRate >= 3 ? 100 : dailyRate >= 1 ? 75 : dailyRate >= 0.3 ? 50 : totalInteractions > 0 ? 25 : 0), 0, 100);
  const integrationBreadth = clamp(Math.round((integrationCount / 4) * 100), 0, 100);
  const signalQuality = clamp(
    Math.round(opts.signalDiversity * 12 + opts.highSignalCount * 8 + opts.mediumSignalCount * 4),
    0,
    100,
  );
  const recency = opts.isStale ? 0 : 100;
  const wellbeing = opts.healthScore !== null ? clamp(Math.round(opts.healthScore), 0, 100) : 50;

  const score = clamp(
    Math.round(agentInteraction * 0.35 + integrationBreadth * 0.15 + signalQuality * 0.2 + recency * 0.15 + wellbeing * 0.15),
    0,
    100,
  );
  const label: CellMemberEngagement["label"] =
    score >= 70 ? "high" : score >= 40 ? "moderate" : score > 0 ? "low" : "disengaged";

  return { score, label, breakdown: { agentInteraction, integrationBreadth, signalQuality, recency, wellbeing } };
}

function isSignalStale(lastSignalAt: string | null, toIso: string): boolean {
  if (!lastSignalAt) return true;
  const signalMs = new Date(lastSignalAt).getTime();
  const cutoffMs = new Date(toIso).getTime() - STALE_SIGNAL_WINDOW_MS;
  if (!Number.isFinite(signalMs) || !Number.isFinite(cutoffMs)) return true;
  return signalMs < cutoffMs;
}

function readCachedKeyResultEvaluation(row: CellKeyResultRow): KeyResultEvaluation | null {
  const cache = isObject(row.evaluation_cache) ? row.evaluation_cache : {};
  const evidenceRaw = Array.isArray(cache.evidence) ? cache.evidence : [];
  const evaluatedAt = coerceIso(cache.evaluatedAt);
  const currentValue = asStringOrNull(cache.currentValue);
  const rawProgressPercent = asNumberOrNull(cache.progressPercent);
  const rawConfidence = asNumberOrNull(cache.confidence);
  const progressPercent = rawProgressPercent === null ? null : clamp(rawProgressPercent, 0, 100);
  const confidence = rawConfidence === null ? null : clamp01(rawConfidence);
  const status = asString(cache.status) as CellKrStatus;
  if (!evaluatedAt && !currentValue && progressPercent === null && confidence === null) {
    return null;
  }
  return {
    id: row.id,
    currentValue,
    progressPercent,
    status:
      status === "on_track" || status === "at_risk" || status === "off_track" || status === "not_enough_signal"
        ? status
        : row.status,
    confidence,
    evidence: evidenceRaw.map((item) => normalizeText(asString(item))).filter(Boolean),
  };
}

function shouldRefreshKeyResultEvaluations(rows: CellKeyResultRow[], latestEvidenceAt: string | null): boolean {
  if (rows.length === 0) return false;
  const now = Date.now();
  const latestEvidenceMs = latestEvidenceAt ? new Date(latestEvidenceAt).getTime() : Number.NaN;
  for (const row of rows) {
    const cache = isObject(row.evaluation_cache) ? row.evaluation_cache : {};
    const evaluatedAt = coerceIso(cache.evaluatedAt);
    if (!evaluatedAt) return true;
    const evaluatedMs = new Date(evaluatedAt).getTime();
    const ageMs = now - evaluatedMs;
    if (!Number.isFinite(ageMs) || ageMs >= KR_EVAL_TTL_MS) return true;
    if (Number.isFinite(latestEvidenceMs) && latestEvidenceMs > evaluatedMs) return true;
  }
  return false;
}

function summarizeHealthLabel(avgScore: number | null, avgTrend: number | null): "strong" | "watch" | "strained" | "unknown" {
  if (avgScore === null) return "unknown";
  if (avgScore >= 75 && (avgTrend === null || avgTrend >= -2)) return "strong";
  if (avgScore < 55 || (avgTrend !== null && avgTrend <= -5)) return "strained";
  return "watch";
}

async function buildCellAnalytics(args: {
  workspaceContext: WorkspaceContext;
  cell: CellRow;
  members: CellMemberRow[];
  keyResults: CellKeyResultRow[];
  directory: WorkspaceUserDirectoryEntry[];
  agentName: string;
  fromIso: string;
  toIso: string;
  includeTimeline?: boolean;
  evaluateKeyResults?: boolean;
  refreshSignalClassifications?: boolean;
}): Promise<CellDetail> {
  const admin = createSupabaseAdminClient();
  const memberIds = args.members.map((member) => member.user_id);
  const directoryByUserId = new Map(args.directory.map((entry) => [entry.userId, entry]));

  const { data: runtimeRows } = await admin
    .from("orchestrator_session_runtime")
    .select("session_id,user_id")
    .eq("agent_id", args.cell.agent_id)
    .in("user_id", memberIds);
  const sessionIds = (runtimeRows || [])
    .map((row) => (typeof row.session_id === "string" ? row.session_id : ""))
    .filter(Boolean);

  const [userMessagesRes, assistantMessagesRes, inboxActionsRes, requestsRes, integrationsRes, heartbeatJobsRes, activityRes] = await Promise.all([
    admin
      .from("orchestrator_messages")
      .select("id,user_id,content,created_at,trace_id")
      .eq("agent_id", args.cell.agent_id)
      .eq("role", "user")
      .in("user_id", memberIds)
      .gte("created_at", args.fromIso)
      .lte("created_at", args.toIso)
      .order("created_at", { ascending: false })
      .limit(160),
    admin
      .from("orchestrator_messages")
      .select("id,user_id,content,created_at,trace_id")
      .eq("agent_id", args.cell.agent_id)
      .eq("role", "assistant")
      .gte("created_at", args.fromIso)
      .lte("created_at", args.toIso)
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("inbox_actions")
      .select("id,user_id,status,recommended_action,subject,snippet,created_at,executed_at")
      .eq("agent_id", args.cell.agent_id)
      .in("user_id", memberIds)
      .gte("created_at", args.fromIso)
      .lte("created_at", args.toIso)
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("workspace_orchestrator_requests")
      .select("id,requested_by_user_id,requested_user_id,status,request,result,last_error,created_at,updated_at")
      .eq("workspace_id", args.workspaceContext.workspaceId)
      .eq("agent_id", args.cell.agent_id)
      .gte("created_at", args.fromIso)
      .lte("created_at", args.toIso)
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("datagran_agent_configs")
      .select("user_id,provider,connection_id")
      .in("user_id", memberIds)
      .in("provider", ["gmail", "google_calendar"]),
    admin
      .from("scheduled_jobs")
      .select("user_id,enabled,task,last_run_at,last_status")
      .in("user_id", memberIds)
      .eq("kind", "orchestrator"),
    sessionIds.length > 0
      ? admin
          .from("activity_log")
          .select("id,session_id,trace_id,agent,action,detail,status,metadata,created_at")
          .in("session_id", sessionIds)
          .gte("created_at", args.fromIso)
          .lte("created_at", args.toIso)
          .order("created_at", { ascending: false })
          .limit(250)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ]);

  const userMessages = (userMessagesRes.data || []) as Array<Record<string, unknown>>;
  const assistantMessages = (assistantMessagesRes.data || []) as Array<Record<string, unknown>>;
  const inboxActions = (inboxActionsRes.data || []) as Array<Record<string, unknown>>;
  const requests = (requestsRes.data || []) as Array<Record<string, unknown>>;
  const integrations = (integrationsRes.data || []) as Array<Record<string, unknown>>;
  const heartbeatJobs = (heartbeatJobsRes.data || []) as Array<Record<string, unknown>>;
  const activityRows = (activityRes.data || []) as Array<Record<string, unknown>>;

  const traceIds = Array.from(
    new Set(
      [...userMessages, ...assistantMessages]
        .map((row) => asString(row.trace_id).trim())
        .filter(Boolean)
    )
  );
  const { usageEvents, toolEvents } = await collectUsageForTraceIds({
    workspaceId: args.workspaceContext.workspaceId,
    traceIds,
    fromIso: args.fromIso,
    toIso: args.toIso,
  });
  const usageByModel = buildUsageByModel(usageEvents);
  const totalTokens = usageByModel.reduce((sum, item) => sum + item.totalTokens, 0);

  const framework = isObject(args.cell.framework) ? args.cell.framework : {};
  const taxonomyRaw = Array.isArray(framework.signalTaxonomy) ? framework.signalTaxonomy : [];
  const taxonomy = taxonomyRaw
    .map((entry, index) => {
      const obj = isObject(entry) ? entry : {};
      const key = normalizeSignalKey(asString(obj.key), `signal_${index + 1}`);
      const label = normalizeText(asString(obj.label)) || key;
      const description = normalizeText(asString(obj.description)) || label;
      return { key, label, description };
    })
    .filter((entry) => entry.key);

  const messageArtifacts: HumanArtifact[] = userMessages.map((row) => ({
    artifactType: "message" as const,
    artifactId: asString(row.id),
    userId: asString(row.user_id),
    source: "human_command" as const,
    createdAt: asString(row.created_at),
    content: normalizeText(asString(row.content)),
  }));
  const requestArtifacts: HumanArtifact[] = requests.flatMap((row) => {
      const requestObj = isObject(row.request) ? row.request : {};
      const message = normalizeText(asString(requestObj.message));
      if (!message) return [];
      return [
        {
          artifactType: "request" as const,
          artifactId: asString(row.id),
          userId: asString(row.requested_by_user_id),
          source: "team_request" as const,
          createdAt: asString(row.created_at),
          content: message,
        },
      ];
    });
  const artifacts: HumanArtifact[] = [...messageArtifacts, ...requestArtifacts];
  const artifactByLookupKey = new Map(
    artifacts.map((artifact) => [buildArtifactLookupKey(artifact.artifactType, artifact.artifactId), artifact])
  );

  const classifications = await ensureSignalClassificationCache({
    cellId: args.cell.id,
    userId: args.workspaceContext.userId,
    taxonomy: taxonomy.length > 0
      ? taxonomy
      : [
          { key: "new_context", label: "New Context", description: "Useful new information." },
          { key: "priority_shift", label: "Priority Shift", description: "Priority or focus changes." },
          { key: "constraint", label: "Constraint", description: "Guardrails and constraints." },
          { key: "approval_or_correction", label: "Approval Or Correction", description: "Human steering." },
        ],
    artifacts,
    refreshMissing: args.refreshSignalClassifications !== false,
  });

  const integrationsByUser = new Map<string, { gmail: boolean; calendar: boolean }>();
  for (const entry of integrations) {
    const userId = asString(entry.user_id);
    if (!userId) continue;
    const current = integrationsByUser.get(userId) || { gmail: false, calendar: false };
    if (entry.provider === "gmail" && asString(entry.connection_id)) current.gmail = true;
    if (entry.provider === "google_calendar" && asString(entry.connection_id)) current.calendar = true;
    integrationsByUser.set(userId, current);
  }

  const heartbeatByUser = new Map<
    string,
    { enabled: boolean; lastRunAt: string | null; lastStatus: string | null }
  >();
  for (const row of heartbeatJobs) {
    const userId = asString(row.user_id);
    const task = isObject(row.task) ? row.task : {};
    if (!userId) continue;
    if (task.type === "heartbeat_v1") {
      const current = heartbeatByUser.get(userId) || {
        enabled: false,
        lastRunAt: null,
        lastStatus: null,
      };
      const lastRunAt = coerceIso(row.last_run_at);
      heartbeatByUser.set(userId, {
        enabled: current.enabled || row.enabled === true,
        lastRunAt:
          current.lastRunAt && (!lastRunAt || current.lastRunAt > lastRunAt)
            ? current.lastRunAt
            : lastRunAt,
        lastStatus: asStringOrNull(row.last_status) || current.lastStatus,
      });
    }
  }

  const upreadyByUser = new Map<string, CellMemberHealthSignal>();
  await Promise.all(
    memberIds.map(async (memberUserId) => {
      const context = await getUpreadyReadinessForFlowUser({
        supabase: admin,
        flowUserId: memberUserId,
        days: 14,
        limit: 14,
      });
      const latest = context.points[0];
      const latestScore = typeof latest?.score === "number" ? latest.score : null;
      const latestLoad = typeof latest?.load === "number" ? latest.load : null;
      const scores = context.points
        .map((point) => (typeof point.score === "number" ? point.score : null))
        .filter((value): value is number => typeof value === "number");
      const currentAvg =
        scores.slice(0, 7).length > 0
          ? scores.slice(0, 7).reduce((sum, value) => sum + value, 0) / scores.slice(0, 7).length
          : null;
      const previousAvg =
        scores.slice(7, 14).length > 0
          ? scores.slice(7, 14).reduce((sum, value) => sum + value, 0) / scores.slice(7, 14).length
          : null;
      upreadyByUser.set(
        memberUserId,
        buildHealthSignal({
          connected: context.connected,
          latestScore,
          latestLoad,
          trendDelta7d:
            currentAvg !== null && previousAvg !== null
              ? Number((currentAvg - previousAvg).toFixed(1))
              : null,
          measuredAt: latest?.measuredAt || null,
          summary: context.summary,
        })
      );
    })
  );

  const messageCountByUser = new Map<string, number>();
  const requestCountByUser = new Map<string, number>();
  const lastSignalByUser = new Map<string, string>();
  for (const row of userMessages) {
    const userId = asString(row.user_id);
    if (!userId) continue;
    messageCountByUser.set(userId, (messageCountByUser.get(userId) || 0) + 1);
    const current = lastSignalByUser.get(userId);
    const next = asString(row.created_at);
    if (!current || next > current) lastSignalByUser.set(userId, next);
  }
  for (const row of requests) {
    const userId = asString(row.requested_by_user_id);
    if (!userId) continue;
    requestCountByUser.set(userId, (requestCountByUser.get(userId) || 0) + 1);
    const current = lastSignalByUser.get(userId);
    const next = asString(row.created_at);
    if (!current || next > current) lastSignalByUser.set(userId, next);
  }

  const memberSummaries: CellMemberSummary[] = args.members.map((member) => {
    const directoryEntry = directoryByUserId.get(member.user_id);
    const integrationState = integrationsByUser.get(member.user_id) || { gmail: false, calendar: false };
    const heartbeatMeta = heartbeatByUser.get(member.user_id) || {
      enabled: false,
      lastRunAt: null,
      lastStatus: null,
    };
    const healthSignal = upreadyByUser.get(member.user_id) || buildHealthSignal({
      connected: false,
      latestScore: null,
      latestLoad: null,
      trendDelta7d: null,
      measuredAt: null,
      summary: "Upready not connected.",
    });
    const signalTypes = rankSignalTypes(classifications, member.user_id);
    const diversity = signalTypes.length;
    const commandCount = messageCountByUser.get(member.user_id) || 0;
    const requestCount = requestCountByUser.get(member.user_id) || 0;
    const lastSignalAt = lastSignalByUser.get(member.user_id) || null;
    const highSignalCount = classifications.filter(
      (item) => item.userId === member.user_id && item.signalStrength === "high"
    ).length;
    const mediumSignalCount = classifications.filter(
      (item) => item.userId === member.user_id && item.signalStrength === "medium"
    ).length;
    const signalStrengthScore = clamp(
      commandCount * 9 + requestCount * 7 + diversity * 8 + highSignalCount * 6 + mediumSignalCount * 3,
      0,
      100
    );
    const stale = isSignalStale(lastSignalAt, args.toIso);
    const rangeDays = Math.max(1, Math.round((new Date(args.toIso).getTime() - new Date(args.fromIso).getTime()) / (24 * 60 * 60 * 1000)));
    const engagement = computeEngagement({
      commandCount,
      requestCount,
      signalDiversity: diversity,
      highSignalCount,
      mediumSignalCount,
      integrations: {
        gmail: integrationState.gmail,
        calendar: integrationState.calendar,
        heartbeat: heartbeatMeta.enabled,
        upready: healthSignal.connected,
      },
      isStale: stale,
      healthScore: healthSignal.latestScore,
      rangeDays,
    });

    return {
      userId: member.user_id,
      email: directoryEntry?.email || null,
      role: member.role,
      integrations: {
        gmailConnected: integrationState.gmail,
        calendarConnected: integrationState.calendar,
        heartbeatEnabled: heartbeatMeta.enabled,
        upreadyConnected: healthSignal.connected,
      },
      healthSignal,
      engagement,
      commandCount,
      requestCount,
      lastSignalAt,
      lastHeartbeatRunAt: heartbeatMeta.lastRunAt,
      isStale: stale,
      signalDiversity: diversity,
      signalStrengthScore,
      topSignalTypes: signalTypes,
    };
  });

  const assistantOutcomeTraceIds = new Set(
    assistantMessages
      .filter((row) => looksLikeMeaningfulEvidenceText(asString(row.content)))
      .map((row) => asString(row.trace_id).trim())
      .filter(Boolean)
  );
  const toolOutcomeTraceIds = new Set(
    activityRows
      .filter((row) => {
        const status = asString(row.status).toLowerCase();
        if (status === "error" || status === "failed") return false;
        const metadata = isObject(row.metadata) ? row.metadata : {};
        const evidenceText = extractEvidenceText(metadata.result) || asString(metadata.summary);
        return looksLikeMeaningfulEvidenceText(evidenceText);
      })
      .map((row) => asString(row.trace_id).trim())
      .filter(Boolean)
  );
  const completedRequests = requests.filter((request) => {
    const status = asString(request.status).toLowerCase();
    if (status === "complete") return true;
    return looksLikeMeaningfulEvidenceText(extractEvidenceText(request.result));
  }).length;
  const meaningfulOutcomes =
    inboxActions.filter((action) => asString(action.status) === "done").length +
    completedRequests +
    new Set([...assistantOutcomeTraceIds, ...toolOutcomeTraceIds]).size;
  const pendingInboxActions = inboxActions.filter((action) => {
    const status = asString(action.status);
    return status === "pending" || status === "approved" || status === "executing";
  }).length;

  const normalizedAssistantFingerprints = new Set<string>();
  let repeatedAssistantMessages = 0;
  for (const row of assistantMessages) {
    const fingerprint = normalizeText(asString(row.content))
      .toLowerCase()
      .replace(/\b\d+\b/g, "#")
      .slice(0, 220);
    if (!fingerprint) continue;
    if (normalizedAssistantFingerprints.has(fingerprint)) {
      repeatedAssistantMessages += 1;
    } else {
      normalizedAssistantFingerprints.add(fingerprint);
    }
  }

  const rejectedOrFailedActions = inboxActions.filter((action) => {
    const status = asString(action.status);
    return status === "rejected" || status === "failed";
  }).length;
  const failedActivityCount = activityRows.filter((row) => {
    const status = asString(row.status).toLowerCase();
    return status === "error" || status === "failed";
  }).length;
  const errorRate =
    activityRows.length > 0 ? Number((failedActivityCount / activityRows.length).toFixed(2)) : null;
  const lastAiActionAt =
    [
      ...assistantMessages.map((row) => asString(row.created_at)),
      ...activityRows.map((row) => asString(row.created_at)),
    ]
      .filter(Boolean)
      .sort()
      .at(-1) || null;
  const lastHeartbeatAt =
    Array.from(heartbeatByUser.values())
      .map((entry) => entry.lastRunAt || "")
      .filter(Boolean)
      .sort()
      .at(-1) || null;

  const efficiency = computeEfficiency({
    userCommands: userMessages.length,
    assistantTurns: assistantMessages.length,
    toolCalls: toolEvents.length,
    meaningfulOutcomes,
    totalTokens,
    repeatedAssistantMessages,
    rejectedOrFailedActions,
    totalActions: inboxActions.length,
  });

  const metricsSummary = [
    `user_commands=${userMessages.length}`,
    `assistant_turns=${assistantMessages.length}`,
    `tool_calls=${toolEvents.length}`,
    `meaningful_outcomes=${meaningfulOutcomes}`,
    `assistant_outcome_traces=${assistantOutcomeTraceIds.size}`,
    `tool_result_outcome_traces=${toolOutcomeTraceIds.size}`,
    `completed_requests=${completedRequests}`,
    `pending_inbox_actions=${pendingInboxActions}`,
    `total_tokens=${totalTokens}`,
    `gmail_connected=${memberSummaries.filter((member) => member.integrations.gmailConnected).length}/${memberSummaries.length}`,
    `calendar_connected=${memberSummaries.filter((member) => member.integrations.calendarConnected).length}/${memberSummaries.length}`,
    `heartbeat_enabled=${memberSummaries.filter((member) => member.integrations.heartbeatEnabled).length}/${memberSummaries.length}`,
    `upready_connected=${memberSummaries.filter((member) => member.integrations.upreadyConnected).length}/${memberSummaries.length}`,
    `stale_members=${memberSummaries.filter((member) => member.isStale).length}`,
    `error_rate=${errorRate !== null ? errorRate.toFixed(2) : "n/a"}`,
    `efficiency_label=${efficiency.label}`,
    `efficiency_score=${efficiency.score}`,
    `loop_risk=${efficiency.loopRisk.toFixed(2)}`,
  ];

  const recentSignalsForPrompt = classifications
    .slice()
    .sort((a, b) => {
      const aAt =
        artifactByLookupKey.get(buildArtifactLookupKey(a.artifactType, a.artifactId))?.createdAt || "";
      const bAt =
        artifactByLookupKey.get(buildArtifactLookupKey(b.artifactType, b.artifactId))?.createdAt || "";
      return bAt.localeCompare(aAt) || b.artifactId.localeCompare(a.artifactId);
    })
    .slice(0, 24)
    .map((classification) => {
      const actor = directoryByUserId.get(classification.userId)?.email || classification.userId.slice(0, 8);
      return `${actor}: ${classification.summary} [${classification.signalTypes.map((type) => type.label).join(", ")}; strength=${classification.signalStrength}]`;
    });

  const outcomeEvidenceForPrompt = uniqueEvidenceLines(
    [
      ...assistantMessages
        .slice()
        .sort((a, b) => asString(b.created_at).localeCompare(asString(a.created_at)))
        .map((row) => {
          const raw = asString(row.content);
          if (!looksLikeMeaningfulEvidenceText(raw)) return null;
          return `assistant_output: ${summarizeEvidenceText(raw)}`;
        }),
      ...activityRows
        .slice()
        .sort((a, b) => asString(b.created_at).localeCompare(asString(a.created_at)))
        .map((row) => {
          const status = asString(row.status).toLowerCase();
          if (status === "error" || status === "failed") return null;
          const metadata = isObject(row.metadata) ? row.metadata : {};
          const raw = extractEvidenceText(metadata.result) || asString(metadata.summary);
          if (!looksLikeMeaningfulEvidenceText(raw)) return null;
          return `${asString(row.agent)} ${asString(row.action)}: ${summarizeEvidenceText(raw)}`;
        }),
      ...requests.map((row) => {
        const raw = extractEvidenceText(row.result);
        if (!looksLikeMeaningfulEvidenceText(raw)) return null;
        return `team_request_result: ${summarizeEvidenceText(raw)}`;
      }),
    ],
    14
  );
  const latestEvidenceAt =
    [
      ...userMessages.map((row) => asString(row.created_at)),
      ...assistantMessages.map((row) => asString(row.created_at)),
      ...requests.map((row) => asString(row.updated_at || row.created_at)),
      ...inboxActions.map((row) => asString(row.executed_at || row.created_at)),
      ...activityRows.map((row) => asString(row.created_at)),
    ]
      .filter(Boolean)
      .sort()
      .at(-1) || null;

  let evaluations = new Map<string, KeyResultEvaluation>();
  if (args.evaluateKeyResults && shouldRefreshKeyResultEvaluations(args.keyResults, latestEvidenceAt)) {
    try {
      evaluations = await evaluateKeyResultsWithModel({
        userId: args.workspaceContext.userId,
        objective: args.cell.objective,
        objectiveSummary: args.cell.objective_summary,
        keyResults: args.keyResults,
        signalSummary: recentSignalsForPrompt,
        metricsSummary,
        outcomeSummary: outcomeEvidenceForPrompt,
      });
      await updateKeyResultEvaluations(args.keyResults, evaluations);
    } catch (error) {
      console.error("[cells-key-result-evaluation]", {
        cellId: args.cell.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const keyResultSummaries = args.keyResults.map((row) =>
    buildKeyResultSummary(row, evaluations.get(row.id) || readCachedKeyResultEvaluation(row))
  );

  const avgLatestScore = average(memberSummaries.map((member) => member.healthSignal.latestScore));
  const avgTrend = average(memberSummaries.map((member) => member.healthSignal.trendDelta7d));
  const healthLabel = summarizeHealthLabel(avgLatestScore, avgTrend);

  const topSignalBreakdown = rankSignalTypes(classifications);

  const summary: CellSummary = {
    id: args.cell.id,
    name: args.cell.name,
    objective: args.cell.objective,
    objectiveSummary: args.cell.objective_summary,
    status: args.cell.status,
    agentId: args.cell.agent_id,
    agentName: args.agentName,
    ownerUserId: args.cell.owner_user_id,
    ownerEmail: directoryByUserId.get(args.cell.owner_user_id)?.email || null,
    members: memberSummaries,
    keyResults: keyResultSummaries,
    signalCoverage: {
      humans: memberSummaries.length,
      gmailConnected: memberSummaries.filter((member) => member.integrations.gmailConnected).length,
      calendarConnected: memberSummaries.filter((member) => member.integrations.calendarConnected).length,
      heartbeatEnabled: memberSummaries.filter((member) => member.integrations.heartbeatEnabled).length,
      upreadyConnected: memberSummaries.filter((member) => member.integrations.upreadyConnected).length,
      staleMembers: memberSummaries.filter((member) => member.isStale).length,
    },
    healthSignal: {
      connectedHumans: memberSummaries.filter((member) => member.integrations.upreadyConnected).length,
      avgLatestScore,
      avgTrendDelta7d: avgTrend,
      label: healthLabel,
    },
    activity: {
      lastActivityAt:
        [
          ...userMessages.map((row) => asString(row.created_at)),
          ...assistantMessages.map((row) => asString(row.created_at)),
          ...activityRows.map((row) => asString(row.created_at)),
        ]
          .filter(Boolean)
          .sort()
          .at(-1) || null,
      lastAiActionAt,
      lastHeartbeatAt,
      userCommands: userMessages.length,
      assistantTurns: assistantMessages.length,
      toolCalls: toolEvents.length,
      meaningfulOutcomes,
      pendingInboxActions,
      errorRate,
    },
    efficiency,
    updatedAt: args.cell.updated_at,
  };

  const recentSignals = classifications
    .map((classification) => {
      const artifact = artifactByLookupKey.get(
        buildArtifactLookupKey(classification.artifactType, classification.artifactId)
      );
      return {
        artifactId: classification.artifactId,
        artifactType: classification.artifactType,
        at: artifact?.createdAt || args.cell.updated_at,
        actorLabel: directoryByUserId.get(classification.userId)?.email || null,
        preview: classification.summary || firstLine(artifact?.content || ""),
        signalStrength: classification.signalStrength,
        signalTypes: classification.signalTypes.map((signal) => ({
          key: signal.key,
          label: signal.label,
          count: 1,
          confidenceAvg: signal.confidence,
        })),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);

  const timeline: CellTimelineItem[] = [];
  if (args.includeTimeline) {
    timeline.push(
      ...userMessages.slice(0, 20).map((row) => ({
        id: `message:${asString(row.id)}`,
        at: asString(row.created_at),
        type: "human_command" as const,
        actorLabel: directoryByUserId.get(asString(row.user_id))?.email || null,
        title: "Human Command",
        detail: firstLine(asString(row.content)),
        status: null,
      }))
    );
    timeline.push(
      ...assistantMessages.slice(0, 16).map((row) => ({
        id: `assistant:${asString(row.id)}`,
        at: asString(row.created_at),
        type: "assistant_output" as const,
        actorLabel: args.agentName,
        title: "Agent Output",
        detail: firstLine(asString(row.content)),
        status: null,
      }))
    );
    timeline.push(
      ...requests.slice(0, 16).map((row) => {
        const requestObj = isObject(row.request) ? row.request : {};
        return {
          id: `request:${asString(row.id)}`,
          at: asString(row.created_at),
          type: "team_request" as const,
          actorLabel: directoryByUserId.get(asString(row.requested_by_user_id))?.email || null,
          title: "Team Request",
          detail: firstLine(asString(requestObj.message)),
          status: asStringOrNull(row.status),
        };
      })
    );
    timeline.push(
      ...inboxActions.slice(0, 16).map((row) => ({
        id: `inbox:${asString(row.id)}`,
        at: asString(row.executed_at || row.created_at),
        type: "inbox_action" as const,
        actorLabel: directoryByUserId.get(asString(row.user_id))?.email || null,
        title: "Inbox Action",
        detail: `${asString(row.recommended_action)} · ${firstLine(asString(row.subject) || asString(row.snippet))}`,
        status: asStringOrNull(row.status),
      }))
    );
    timeline.push(
      ...memberSummaries
        .filter((member) => member.lastHeartbeatRunAt)
        .map((member) => {
          const heartbeatMeta = heartbeatByUser.get(member.userId);
          return {
            id: `heartbeat:${member.userId}`,
            at: member.lastHeartbeatRunAt || args.cell.updated_at,
            type: "heartbeat_run" as const,
            actorLabel: member.email,
            title: "Heartbeat Run",
            detail: heartbeatMeta?.enabled
              ? `Heartbeat enabled${heartbeatMeta.lastStatus ? ` · ${heartbeatMeta.lastStatus}` : ""}`
              : "Heartbeat run",
            status: heartbeatMeta?.lastStatus || null,
          };
        })
    );
    timeline.push(
      ...memberSummaries
        .filter((member) => member.healthSignal.connected && member.healthSignal.measuredAt)
        .map((member) => ({
          id: `health:${member.userId}`,
          at: member.healthSignal.measuredAt || args.cell.updated_at,
          type: "health_signal" as const,
          actorLabel: member.email,
          title: "Health Signal",
          detail:
            member.healthSignal.latestScore !== null
              ? `Readiness ${Math.round(member.healthSignal.latestScore)}${member.healthSignal.trendDelta7d !== null ? ` · trend ${member.healthSignal.trendDelta7d >= 0 ? "+" : ""}${member.healthSignal.trendDelta7d}` : ""}`
              : "Readiness connected",
          status: member.healthSignal.label,
        }))
    );
    timeline.push(
      ...activityRows.slice(0, 16).map((row) => ({
        id: `activity:${asString(row.id)}`,
        at: asString(row.created_at),
        type: "tool_activity" as const,
        actorLabel: args.agentName,
        title: `${asString(row.agent)} · ${asString(row.action)}`,
        detail: firstLine(asString(row.detail)),
        status: asStringOrNull(row.status),
      }))
    );
  }

  return {
    summary,
    range: {
      from: args.fromIso,
      to: args.toIso,
    },
    signalTaxonomy: taxonomy,
    signalBreakdown: topSignalBreakdown,
    usageByModel,
    recentSignals,
    timeline: timeline.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60),
    generatedFrameworkMeta: {
      model: asStringOrNull((framework.meta as Record<string, unknown> | undefined)?.model),
      generatedAt: asStringOrNull((framework.meta as Record<string, unknown> | undefined)?.generatedAt),
      generationVersion: args.cell.okr_generation_version || asStringOrNull((framework.meta as Record<string, unknown> | undefined)?.version),
    },
  };
}

export async function listCellAgentOptions(supabase: SupabaseClient): Promise<{
  workspace: { id: string; name: string };
  agents: CellAgentOption[];
}> {
  const context = await requireWorkspaceContext(supabase, { requireAdmin: true });
  const admin = createSupabaseAdminClient();

  const [visibleAgentsRes, sharedRes, assignedRes] = await Promise.all([
    supabase
      .from("agents")
      .select("id,user_id,name,type,updated_at")
      .in("type", ["orchestrator-runtime", "claude-code"])
      .order("updated_at", { ascending: false })
      .limit(100),
    admin
      .from("workspace_orchestrator_agents")
      .select("agent_id")
      .eq("workspace_id", context.workspaceId),
    admin
      .from("workspace_cells")
      .select("id,agent_id")
      .eq("workspace_id", context.workspaceId),
  ]);

  const sharedAgentIds = new Set(
    (sharedRes.data || []).map((row) => asString((row as Record<string, unknown>).agent_id)).filter(Boolean)
  );
  const assignedByAgent = new Map<string, string>();
  for (const row of assignedRes.data || []) {
    const agentId = asString((row as Record<string, unknown>).agent_id);
    const cellId = asString((row as Record<string, unknown>).id);
    if (agentId && cellId) assignedByAgent.set(agentId, cellId);
  }

  const directory = await getWorkspaceDirectory(context.workspaceId);
  const emailByUserId = new Map(directory.map((entry) => [entry.userId, entry.email]));

  const agents = (visibleAgentsRes.data || []) as Array<Record<string, unknown>>;
  const codeAgentIds = agents
    .filter((row) => asString(row.type) === "claude-code")
    .map((row) => asString(row.id))
    .filter(Boolean);
  const configuredCodeAgentIds = new Set<string>();
  if (codeAgentIds.length > 0) {
    const { data: codeConfigs } = await admin
      .from("claude_code_agent_configs")
      .select("agent_id")
      .in("agent_id", codeAgentIds);
    for (const row of codeConfigs || []) {
      const agentId = asString((row as Record<string, unknown>).agent_id);
      if (agentId) configuredCodeAgentIds.add(agentId);
    }
  }
  const options: CellAgentOption[] = [];
  for (const row of agents) {
    const agentId = asString(row.id);
    const ownerUserId = asString(row.user_id);
    const agentType = asString(row.type) === "claude-code" ? "claude-code" : "orchestrator-runtime";
    if (!agentId || !ownerUserId) continue;
    if (agentType === "claude-code" && !configuredCodeAgentIds.has(agentId)) continue;
    const { count } = await admin
      .from("orchestrator_messages")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agentId);
    const { data: lastMessage } = await admin
      .from("orchestrator_messages")
      .select("created_at")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    options.push({
      agentId,
      name: asString(row.name) || "Groovy Agent",
      agentType,
      shared: sharedAgentIds.has(agentId),
      ownedByCurrentUser: ownerUserId === context.userId,
      ownerUserId,
      ownerEmail: emailByUserId.get(ownerUserId) || null,
      lastActivityAt:
        asStringOrNull((lastMessage as Record<string, unknown> | null)?.created_at) ||
        asStringOrNull(row.updated_at),
      messageCount: Number.isFinite(Number(count)) ? Number(count) : 0,
      assignedCellId: assignedByAgent.get(agentId) || null,
    });
  }

  return {
    workspace: { id: context.workspaceId, name: context.workspaceName },
    agents: options,
  };
}

function ensureUniqueMemberIds(memberUserIds: string[]): string[] {
  return Array.from(new Set(memberUserIds.map((id) => id.trim()).filter(Boolean)));
}

async function ensureAgentVisibleToWorkspace(args: {
  workspaceContext: WorkspaceContext;
  agentId: string;
}): Promise<{ id: string; user_id: string; name: string; type: "orchestrator-runtime" | "claude-code" }> {
  const admin = createSupabaseAdminClient();
  const { data: agent } = await admin
    .from("agents")
    .select("id,user_id,name,type")
    .eq("id", args.agentId)
    .in("type", ["orchestrator-runtime", "claude-code"])
    .maybeSingle();
  if (!agent?.id) {
    throw new Error("Agent not found");
  }

  const agentType = asString((agent as Record<string, unknown>).type) === "claude-code"
    ? "claude-code"
    : "orchestrator-runtime";
  if (agentType === "claude-code") {
    const { data: codeConfig } = await admin
      .from("claude_code_agent_configs")
      .select("agent_id")
      .eq("agent_id", args.agentId)
      .maybeSingle();
    if (!codeConfig?.agent_id) {
      throw new Error("Claude Code agent is not configured");
    }
  }

  const agentOwnerId = asString((agent as Record<string, unknown>).user_id);
  const { data: shared } = await admin
    .from("workspace_orchestrator_agents")
    .select("agent_id")
    .eq("workspace_id", args.workspaceContext.workspaceId)
    .eq("agent_id", args.agentId)
    .maybeSingle();

  if (!shared?.agent_id) {
    if (agentOwnerId !== args.workspaceContext.userId) {
      throw new Error("Agent is not shared to this workspace");
    }

    const { error: shareErr } = await admin
      .from("workspace_orchestrator_agents")
      .insert({
        workspace_id: args.workspaceContext.workspaceId,
        agent_id: args.agentId,
        created_by_user_id: args.workspaceContext.userId,
      });
    if (shareErr && shareErr.code !== "23505") {
      throw new Error(shareErr.message || "Failed to share agent to workspace");
    }

    if (agentType === "orchestrator-runtime") {
      const runtimeSessionId = await getOrCreateRuntimeSessionForAgent({
        supabase: admin,
        userId: args.workspaceContext.userId,
        agentId: args.agentId,
        title: asString((agent as Record<string, unknown>).name) || "Groovy Agent",
      });
      if (runtimeSessionId) {
        await admin
          .from("workspace_orchestrator_sessions")
          .insert({
            workspace_id: args.workspaceContext.workspaceId,
            session_id: runtimeSessionId,
            created_by_user_id: args.workspaceContext.userId,
          });
      }
    }
  }

  return {
    id: asString(agent.id),
    user_id: agentOwnerId,
    name: asString(agent.name) || "Groovy Agent",
    type: agentType,
  };
}

export async function createCell(
  supabase: SupabaseClient,
  body: {
    agentId: string;
    name: string;
    objective: string;
    memberUserIds: string[];
  }
): Promise<{ cellId: string }> {
  const context = await requireWorkspaceContext(supabase, { requireAdmin: true });
  const admin = createSupabaseAdminClient();
  const memberUserIds = ensureUniqueMemberIds(body.memberUserIds);
  if (memberUserIds.length === 0) {
    throw new Error("At least one human is required");
  }
  const name = normalizeText(body.name).slice(0, 120);
  const objective = normalizeText(body.objective);
  if (!name) throw new Error("Cell name is required");
  if (!objective) throw new Error("Objective is required");

  const directory = await getWorkspaceDirectory(context.workspaceId);
  const directoryByUserId = new Map(directory.map((entry) => [entry.userId, entry]));
  for (const memberUserId of memberUserIds) {
    if (!directoryByUserId.has(memberUserId)) {
      throw new Error("One or more selected humans are not in this workspace");
    }
  }

  const agent = await ensureAgentVisibleToWorkspace({
    workspaceContext: context,
    agentId: body.agentId,
  });

  const framework = await generateCellFramework({
    userId: context.userId,
    cellName: name,
    objective,
    agentName: agent.name,
    memberEmails: memberUserIds
      .map((id) => directoryByUserId.get(id)?.email)
      .filter((email): email is string => typeof email === "string" && !!email),
  });

  const { data: inserted, error: insertErr } = await admin
    .from("workspace_cells")
    .insert({
      workspace_id: context.workspaceId,
      agent_id: body.agentId,
      name,
      objective,
      objective_summary: framework.objectiveSummary,
      owner_user_id: context.userId,
      status: "active",
      privacy_mode: "workspace",
      okr_generation_version: framework.meta.version,
      framework,
      analytics_cache: {},
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (insertErr || !inserted?.id) {
    throw new Error(insertErr?.message || "Failed to create cell");
  }

  const cellId = String(inserted.id);
  const leaderId = memberUserIds.includes(context.userId) ? context.userId : memberUserIds[0];
  await admin.from("workspace_cell_members").insert(
    memberUserIds.map((userId) => ({
      cell_id: cellId,
      user_id: userId,
      role: userId === leaderId ? "leader" : "member",
      updated_at: new Date().toISOString(),
    }))
  );

  await admin.from("workspace_cell_key_results").insert(
    framework.keyResults.map((kr, index) => ({
      cell_id: cellId,
      position: index,
      label: kr.label,
      description: kr.description,
      measurement_mode: kr.measurementMode,
      evaluation_method: kr.evaluationMethod,
      target_value: kr.targetValue,
      direction: kr.direction,
      status: "not_enough_signal",
      confidence: null,
      evaluation_cache: {},
      created_by_user_id: context.userId,
      updated_at: new Date().toISOString(),
    }))
  );

  return { cellId };
}

export async function updateCell(
  supabase: SupabaseClient,
  cellId: string,
  body: {
    name?: string;
    objective?: string;
    status?: "active" | "paused" | "archived";
    memberUserIds?: string[];
    regenerateFramework?: boolean;
    keyResults?: Array<{
      id?: string;
      label: string;
      description?: string | null;
      measurementMode: "computed" | "hybrid" | "manual";
      evaluationMethod?: string | null;
      targetValue?: string | null;
      direction: "increase" | "decrease" | "maintain" | "binary";
    }>;
  }
): Promise<{ cellId: string }> {
  const context = await requireWorkspaceContext(supabase, { requireAdmin: true });
  const admin = createSupabaseAdminClient();
  const cellRows = await loadCellRows(context.workspaceId, cellId);
  const cell = cellRows[0];
  if (!cell) throw new Error("Cell not found");
  const existingMembers = await loadCellMembers([cellId]);

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  let nextObjective = cell.objective;
  if (typeof body.name === "string" && normalizeText(body.name)) {
    updates.name = normalizeText(body.name).slice(0, 120);
  }
  if (typeof body.status === "string") {
    updates.status = body.status;
  }
  if (typeof body.objective === "string" && normalizeText(body.objective)) {
    nextObjective = normalizeText(body.objective);
    updates.objective = nextObjective;
  }

  const directory = await getWorkspaceDirectory(context.workspaceId);
  const directoryByUserId = new Map(directory.map((entry) => [entry.userId, entry]));
  const memberUserIds = Array.isArray(body.memberUserIds)
    ? ensureUniqueMemberIds(body.memberUserIds)
    : null;
  if (memberUserIds && memberUserIds.length === 0) {
    throw new Error("At least one human is required");
  }
  if (memberUserIds) {
    for (const memberUserId of memberUserIds) {
      if (!directoryByUserId.has(memberUserId)) {
        throw new Error("One or more selected humans are not in this workspace");
      }
    }
  }

  if (body.regenerateFramework === true || updates.objective) {
    const frameworkMemberIds =
      memberUserIds && memberUserIds.length > 0
        ? memberUserIds
        : existingMembers
            .filter((member) => member.cell_id === cellId)
            .map((member) => member.user_id);
    const framework = await generateCellFramework({
      userId: context.userId,
      cellName: asString(updates.name) || cell.name,
      objective: nextObjective,
      agentName: (await ensureAgentVisibleToWorkspace({ workspaceContext: context, agentId: cell.agent_id })).name,
      memberEmails: frameworkMemberIds
        .map((id) => directoryByUserId.get(id)?.email)
        .filter((email): email is string => typeof email === "string" && !!email),
    });
    updates.objective_summary = framework.objectiveSummary;
    updates.framework = framework;
    updates.okr_generation_version = framework.meta.version;

    await admin.from("workspace_cell_key_results").delete().eq("cell_id", cellId);
    await admin.from("workspace_cell_key_results").insert(
      framework.keyResults.map((kr, index) => ({
        cell_id: cellId,
        position: index,
        label: kr.label,
        description: kr.description,
        measurement_mode: kr.measurementMode,
        evaluation_method: kr.evaluationMethod,
        target_value: kr.targetValue,
        direction: kr.direction,
        status: "not_enough_signal",
        confidence: null,
        evaluation_cache: {},
        created_by_user_id: context.userId,
        updated_at: new Date().toISOString(),
      }))
    );
  } else if (Array.isArray(body.keyResults) && body.keyResults.length > 0) {
    await admin.from("workspace_cell_key_results").delete().eq("cell_id", cellId);
    await admin.from("workspace_cell_key_results").insert(
      body.keyResults.map((kr, index) => ({
        cell_id: cellId,
        position: index,
        label: normalizeText(kr.label).slice(0, 120),
        description: kr.description ? normalizeText(kr.description).slice(0, 220) : null,
        measurement_mode: kr.measurementMode,
        evaluation_method: kr.evaluationMethod ? normalizeText(kr.evaluationMethod).slice(0, 220) : null,
        target_value: kr.targetValue ? normalizeText(kr.targetValue).slice(0, 120) : null,
        direction: kr.direction,
        status: "not_enough_signal",
        confidence: null,
        evaluation_cache: {},
        created_by_user_id: context.userId,
        updated_at: new Date().toISOString(),
      }))
    );
  }

  if (Object.keys(updates).length > 0) {
    await admin.from("workspace_cells").update(updates).eq("id", cellId);
  }

  if (memberUserIds) {
    await admin.from("workspace_cell_members").delete().eq("cell_id", cellId);
    const leaderId = memberUserIds.includes(context.userId) ? context.userId : memberUserIds[0];
    await admin.from("workspace_cell_members").insert(
      memberUserIds.map((userId) => ({
        cell_id: cellId,
        user_id: userId,
        role: userId === leaderId ? "leader" : "member",
        updated_at: new Date().toISOString(),
      }))
    );
  }

  return { cellId };
}

export async function listCells(
  supabase: SupabaseClient,
  searchParams?: URLSearchParams | null
): Promise<{
  workspace: { id: string; name: string };
  range: { from: string; to: string };
  cells: CellSummary[];
}> {
  const context = await requireWorkspaceContext(supabase, { requireAdmin: true });
  const range = parseRange(searchParams);
  const cells = await loadCellRows(context.workspaceId);
  const members = await loadCellMembers(cells.map((cell) => cell.id));
  const keyResults = await loadCellKeyResults(cells.map((cell) => cell.id));
  const directory = await getWorkspaceDirectory(context.workspaceId);
  const agentMap = await loadAgentMap(cells.map((cell) => cell.agent_id));

  const summaries: CellSummary[] = [];
  for (const cell of cells) {
    const detail = await buildCellAnalytics({
      workspaceContext: context,
      cell,
      members: members.filter((member) => member.cell_id === cell.id),
      keyResults: keyResults.filter((kr) => kr.cell_id === cell.id),
      directory,
      agentName: agentMap.get(cell.agent_id)?.name || "Groovy Agent",
      fromIso: range.fromIso,
      toIso: range.toIso,
      includeTimeline: false,
      evaluateKeyResults: false,
      refreshSignalClassifications: false,
    });
    summaries.push(detail.summary);
  }

  return {
    workspace: { id: context.workspaceId, name: context.workspaceName },
    range: { from: range.fromIso, to: range.toIso },
    cells: summaries,
  };
}

export async function getCellDetail(
  supabase: SupabaseClient,
  cellId: string,
  searchParams?: URLSearchParams | null
): Promise<CellDetail> {
  const context = await requireWorkspaceContext(supabase, { requireAdmin: true });
  const range = parseRange(searchParams);
  const cells = await loadCellRows(context.workspaceId, cellId);
  const cell = cells[0];
  if (!cell) throw new Error("Cell not found");
  const [members, keyResults, directory, agentMap] = await Promise.all([
    loadCellMembers([cell.id]),
    loadCellKeyResults([cell.id]),
    getWorkspaceDirectory(context.workspaceId),
    loadAgentMap([cell.agent_id]),
  ]);

  return buildCellAnalytics({
    workspaceContext: context,
    cell,
    members: members.filter((member) => member.cell_id === cell.id),
    keyResults: keyResults.filter((kr) => kr.cell_id === cell.id),
    directory,
    agentName: agentMap.get(cell.agent_id)?.name || "Groovy Agent",
    fromIso: range.fromIso,
    toIso: range.toIso,
    includeTimeline: true,
    evaluateKeyResults: true,
    refreshSignalClassifications: true,
  });
}
