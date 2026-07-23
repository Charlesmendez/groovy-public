/**
 * Groovy-managed Datagran Memory
 * 
 * Unified helper for all memory operations using Groovy's server-side Datagran API key.
 * This ensures consistent memory handling across orchestrator, ai-chat, and WhatsApp routes.
 */

import {
  datagranCreateMemoryConnection,
  datagranQueryBrain,
  datagranCompileRawText,
  type DatagranBrainResponse,
} from "@/lib/datagran/memory";
import {
  planMemoryQueries,
  shouldStoreMemory,
  type MemoryPlannerInput,
} from "./memoryPlanner";
import type { ProviderId } from "@/lib/ai/modelResolver";
import {
  containsSecretLikeMaterial,
  fileLearningToWiki,
  type WikiLearningResult,
  type WikiLearningTarget,
} from "./wikiMemory";
import type { SupabaseClient } from "@supabase/supabase-js";

const GROOVY_DATAGRAN_API_KEY = process.env.DATAGRAN_API_KEY || "";

// Cache memory connection IDs per user (in-memory, per-process)
const connectionCache = new Map<string, string>();
const noBrainLoggedConnections = new Set<string>();

type ConnectionSignalProbe = {
  ok: boolean;
  status: number | null;
  score: number;
  answerUseful: boolean;
  rawUseful: boolean;
  evidenceCount: number;
  debugOnly: boolean;
  answerPreview: string;
};

function isKnownDebugSeedTrace(rawText: string): boolean {
  const normalized = rawText.trim().toLowerCase();
  return (
    normalized.includes("trace_id: debug-init") ||
    (normalized.includes("agent_type: debug") &&
      normalized.includes("prompt:") &&
      normalized.includes("response:") &&
      normalized.includes("seed"))
  );
}

function isUsefulBrainAnswer(answer: string | null | undefined): boolean {
  if (!answer || typeof answer !== "string") return false;
  const trimmed = answer.trim();
  if (!trimmed) return false;
  if (/\bunsure\b/i.test(trimmed)) return false;
  if (/^no brain found\b/i.test(trimmed)) return false;
  if (/^none\.?$/i.test(trimmed)) return false;
  if (/to be determined based on the context provided/i.test(trimmed)) return false;
  if (/insufficient context/i.test(trimmed)) return false;
  if (/unable to determine/i.test(trimmed)) return false;
  // Datagran sometimes prefixes with "Question: ..." or "Answer (grounded...):"
  // Strip the prefix and check if there's real content after it.
  if (trimmed.startsWith("Question:")) {
    const afterPrefix = trimmed.replace(/^Question:\s*/i, "").trim();
    // If Datagran echoes the question back, treat it as non-answer.
    if (afterPrefix.endsWith("?")) return false;
    return afterPrefix.length > 20;
  }
  if (/^Answer\s*\(grounded[^)]*\)\s*:?\s*/i.test(trimmed)) {
    const afterPrefix = trimmed.replace(/^Answer\s*\(grounded[^)]*\)\s*:?\s*/i, "").trim();
    // If the content after the prefix is just "UNSURE" or empty, reject.
    if (!afterPrefix || /^\s*unsure\s*$/i.test(afterPrefix)) return false;
    return afterPrefix.length > 20;
  }
  return true;
}

/** Strip Datagran preamble prefixes from brain answer text. */
function stripBrainAnswerPrefix(answer: string): string {
  let cleaned = answer.trim();
  cleaned = cleaned.replace(/^Answer\s*\(grounded[^)]*\)\s*:?\s*/i, "");
  cleaned = cleaned.replace(/^Answer:\s*/i, "");
  return cleaned.trim();
}

function extractRawTextLayer(layer: unknown): string | null {
  if (!layer || typeof layer !== "object") return null;
  const obj = layer as Record<string, unknown>;
  const raw = typeof obj.raw_text === "string" ? obj.raw_text : typeof obj.summary === "string" ? obj.summary : "";
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function extractUsefulMemoryContent(rawText: string, maxChars: number): string | null {
  if (!rawText || typeof rawText !== "string") return null;
  if (isKnownDebugSeedTrace(rawText)) return null;

  // Find where actual provider content starts.
  const providerMatch = rawText.match(/provider=memory\n\n/i);
  if (providerMatch && providerMatch.index !== undefined) {
    const content = rawText.slice(providerMatch.index).trim();
    if (content) return content.slice(0, maxChars);
  }

  // Skip templated placeholders with no real trace payload.
  if (rawText.includes("[list of entities]") && !rawText.includes("TRACE_ID:")) {
    return null;
  }

  const trimmed = rawText.trim();
  return trimmed ? trimmed.slice(0, maxChars) : null;
}

function isNonInformativePreferenceAnswer(answer: string | null | undefined): boolean {
  if (!answer || typeof answer !== "string") return true;
  const trimmed = answer.trim();
  if (!trimmed) return true;
  if (/^none\.?$/i.test(trimmed)) return true;
  if (/\bunsure\b/i.test(trimmed)) return true;
  if (/to be determined based on the context provided/i.test(trimmed)) return true;
  if (/insufficient context/i.test(trimmed)) return true;
  if (/unable to determine/i.test(trimmed)) return true;
  // Datagran occasionally returns just the echoed question.
  if (/^Question:\s*.+\?\s*$/i.test(trimmed)) return true;
  return false;
}

function isNoBrainFoundError(status: number | null | undefined, error: unknown): boolean {
  if (status !== 404) return false;
  const message = typeof error === "string" ? error : JSON.stringify(error ?? "");
  return /No brain found for this end user yet/i.test(message);
}

function isSessionScopedPersonaInstruction(message: string): boolean {
  const text = message.trim();
  if (!text) return false;

  // Roleplay/persona setup should stay local to the current chat session.
  if (/\b(roleplay|persona|character|stay in character)\b/i.test(text)) return true;

  const identityAssignment =
    /\b(you are|you're|your name is|call yourself|assume you are|assume you're|pretend to be|pretend you're|act as)\b/i;
  if (!identityAssignment.test(text)) return false;

  return /\b(name|named|called|from|origin|identity|nationality)\b/i.test(text);
}

type DatagranCreateConnectionResult = Awaited<ReturnType<typeof datagranCreateMemoryConnection>>;

function isRetryableCreateConnectionFailure(result: DatagranCreateConnectionResult): boolean {
  if (result.ok) return false;
  const status = typeof result.status === "number" ? result.status : null;
  if (status === null || status === 0) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  const resultError = (result as { error?: unknown }).error;
  const msg = typeof resultError === "string" ? resultError : JSON.stringify(resultError ?? "");
  return /(timeout|temporar|network|econn|aborted|rate limit|too many requests)/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createMemoryConnectionWithRetry(args: {
  apiKey: string;
  endUserExternalId: string;
  email?: string;
  userId: string;
  label: "primary" | "legacy";
  maxAttempts?: number;
}): Promise<DatagranCreateConnectionResult> {
  const maxAttempts = Math.max(1, args.maxAttempts || 3);
  let lastResult: DatagranCreateConnectionResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await datagranCreateMemoryConnection({
      apiKey: args.apiKey,
      endUserExternalId: args.endUserExternalId,
      email: args.email,
    });
    lastResult = result;

    if (result.ok) return result;

    const retryable = isRetryableCreateConnectionFailure(result);
    if (!retryable || attempt >= maxAttempts) {
      return result;
    }

    const delayMs = attempt === 1 ? 350 : attempt === 2 ? 900 : 1800;
    console.warn("[groovyMemory] datagranCreateMemoryConnection retrying:", {
      userId: args.userId,
      label: args.label,
      externalId: args.endUserExternalId,
      attempt,
      maxAttempts,
      status: result.status ?? null,
      delayMs,
    });
    await sleep(delayMs);
  }

  return (
    lastResult || {
      ok: false as const,
      status: 0,
      error: "Unknown connection creation error",
    }
  );
}

async function probeConnectionSignal(connectionId: string): Promise<ConnectionSignalProbe> {
  if (!GROOVY_DATAGRAN_API_KEY || !connectionId) {
    return {
      ok: false,
      status: null,
      score: -999,
      answerUseful: false,
      rawUseful: false,
      evidenceCount: 0,
      debugOnly: false,
      answerPreview: "",
    };
  }

  try {
    const probe = await datagranQueryBrain({
      apiKey: GROOVY_DATAGRAN_API_KEY,
      connectionId,
      question: "What did the user discuss most recently? Return one concrete detail.",
      mindState: "auto",
      providers: ["memory"],
      include: { evidence: true },
    });

    if (!probe.ok || !probe.data) {
      return {
        ok: false,
        status: typeof probe.status === "number" ? probe.status : null,
        score: -40,
        answerUseful: false,
        rawUseful: false,
        evidenceCount: 0,
        debugOnly: false,
        answerPreview: "",
      };
    }

    const brain = probe.data as Record<string, unknown>;
    const answer = typeof brain.answer === "string" ? brain.answer.trim() : "";
    const answerUseful = isUsefulBrainAnswer(answer);

    // Handle both old (object) and new (array of chunks) long_term format in probe.
    const rawFromLayers = [brain.short_term, brain.mid_term]
      .map((layer) => extractRawTextLayer(layer))
      .filter((raw): raw is string => Boolean(raw));

    // New format: long_term is array of chunks with snippets
    const longTermChunks = Array.isArray(brain.long_term)
      ? (brain.long_term as Array<{ snippet?: string }>).filter((c) => c && typeof c.snippet === "string" && c.snippet.trim())
      : [];
    const longTermRaw = longTermChunks.length > 0
      ? null // new format — snippets, not raw_text
      : extractRawTextLayer(brain.long_term); // old format fallback

    const rawCandidates = [...rawFromLayers, ...(longTermRaw ? [longTermRaw] : [])];

    const rawUseful = rawCandidates.some((raw) => Boolean(extractUsefulMemoryContent(raw, 600)))
      || longTermChunks.length > 0;
    const debugOnly =
      rawCandidates.length > 0 && rawCandidates.every((raw) => isKnownDebugSeedTrace(raw))
      && longTermChunks.length === 0;

    const citationCount = Array.isArray(brain.citations) ? (brain.citations as unknown[]).length : 0;
    const evidenceCount = (Array.isArray(brain.evidence) ? brain.evidence.length : 0) + citationCount;

    let score = 0;
    if (answerUseful) score += 40;
    if (rawUseful) score += 25;
    if (evidenceCount > 0) score += 10;
    if (!answerUseful && !rawUseful && evidenceCount === 0) score -= 20;
    if (/\bunsure\b/i.test(answer)) score -= 15;
    if (debugOnly) score -= 80;

    return {
      ok: true,
      status: null,
      score,
      answerUseful,
      rawUseful,
      evidenceCount,
      debugOnly,
      answerPreview: answer.slice(0, 120),
    };
  } catch {
    return {
      ok: false,
      status: null,
      score: -40,
      answerUseful: false,
      rawUseful: false,
      evidenceCount: 0,
      debugOnly: false,
      answerPreview: "",
    };
  }
}

export type MemoryLoadResult = {
  context: string;
  questions: string[];
  planning?: {
    questions: string[];
    reasoning?: string;
    provider?: string;
    model?: string;
    usage?: unknown;
  };
  queryResults: Array<{
    question: string;
    data: DatagranBrainResponse | null;
    chars: number;
  }>;
  totalChars: number;
  connectionId: string | null;
};

export type MemoryStoreResult = {
  stored: boolean;
  datagranStored?: boolean;
  wikiFiled?: boolean;
  wikiPath?: string;
  wikiReason?: string;
  memoryNote?: string;
  label?: string;
  reason?: string;
};

export type WikiMemorySyncOptions = {
  supabase: SupabaseClient;
  userId: string;
  source?: string;
  target?: WikiLearningTarget;
  profileId?: string;
};

const DEFAULT_PREFERENCE_QUERY =
  "What standing user preferences, constraints, and exclusions must Groovy follow right now? Include explicit do-not-update rules for emails or calendar events, communication style preferences, and ongoing constraints.";
const DEFAULT_HEARTBEAT_PREFERENCE_QUERY =
  "For heartbeat updates, what standing user preferences and exclusions must be enforced right now? Prioritize explicit do-not-mention / do-not-update rules for calendar events, email categories/senders/topics, and any ongoing communication constraints.";

type PreferenceLoadResult = {
  question: string;
  context: string;
  chars: number;
};

function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizePreferenceFallbackEntry(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const preferredFields = ["snippet", "text", "content", "summary", "note", "title", "value"];
  for (const key of preferredFields) {
    const field = obj[key];
    if (typeof field === "string" && field.trim()) {
      return field.trim();
    }
  }
  const fallback = stringifyCompact(value).trim();
  return fallback ? fallback : null;
}

function buildPreferenceFallbackContext(data: DatagranBrainResponse, maxContextChars: number): string {
  if (!data || typeof data !== "object") return "";

  const parts: string[] = [];
  const seen = new Set<string>();
  const addLine = (line: string) => {
    const normalized = line.trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(normalized);
  };

  const brain = data as Record<string, unknown>;
  const longTerm = brain.long_term;
  if (Array.isArray(longTerm)) {
    for (const chunk of longTerm) {
      const snippet = normalizePreferenceFallbackEntry(chunk);
      if (snippet) addLine(snippet);
      if (parts.length >= 8) break;
    }
  } else {
    const raw = extractRawTextLayer(longTerm);
    if (raw) {
      const useful = extractUsefulMemoryContent(raw, Math.min(1400, maxContextChars));
      if (useful) {
        for (const line of useful.split("\n")) {
          addLine(line);
          if (parts.length >= 8) break;
        }
      }
    }
  }

  const evidence = Array.isArray(brain.evidence) ? (brain.evidence as unknown[]) : [];
  for (const item of evidence.slice(0, 6)) {
    const line = normalizePreferenceFallbackEntry(item);
    if (line) addLine(line);
    if (parts.length >= 12) break;
  }

  const citations = Array.isArray(brain.citations) ? (brain.citations as unknown[]) : [];
  for (const item of citations.slice(0, 6)) {
    const line = normalizePreferenceFallbackEntry(item);
    if (line) addLine(line);
    if (parts.length >= 14) break;
  }

  if (parts.length === 0) return "";
  const joined = parts.join("\n");
  return joined.length > maxContextChars ? `${joined.slice(0, maxContextChars)}...` : joined;
}

/**
 * Get or create a Groovy-managed memory connection for a user.
 */
export async function getGroovyMemoryConnection(
  userId: string,
  email?: string,
  _supabase?: SupabaseClient,
  profileId?: string,
): Promise<string | null> {
  if (!GROOVY_DATAGRAN_API_KEY) {
    console.warn("[groovyMemory] DATAGRAN_API_KEY not configured, memory disabled");
    return null;
  }

  const normalizedProfileId =
    typeof profileId === "string" && /^[a-f0-9-]{16,64}$/i.test(profileId.trim())
      ? profileId.trim()
      : null;
  if (profileId && !normalizedProfileId) {
    console.error("[groovyMemory][SECURITY] rejected invalid profile memory scope", {
      userId,
      profileId,
    });
    return null;
  }
  if (normalizedProfileId) {
    const scopedCacheKey = `${userId}:profile:${normalizedProfileId}`;
    const cachedProfileConnection = connectionCache.get(scopedCacheKey);
    if (cachedProfileConnection) return cachedProfileConnection;

    // A distinct Datagran end-user connection is the isolation boundary.
    // Query-time instructions and note prefixes remain useful context, but are
    // deliberately not trusted to prevent cross-profile retrieval.
    const scopedExternalId = `flow_${userId}_profile_${normalizedProfileId}`;
    const scoped = await createMemoryConnectionWithRetry({
      apiKey: GROOVY_DATAGRAN_API_KEY,
      endUserExternalId: scopedExternalId,
      userId,
      label: "primary",
    });
    const returnedExternalId =
      scoped.ok && typeof scoped.data?.end_user_external_id === "string"
        ? scoped.data.end_user_external_id.trim()
        : null;
    if (
      !scoped.ok ||
      !scoped.data?.connection_id ||
      (returnedExternalId && returnedExternalId !== scopedExternalId)
    ) {
      console.error(
        "[groovyMemory][SECURITY] failed to establish isolated profile memory connection",
        {
          userId,
          profileId: normalizedProfileId,
          expectedExternalId: scopedExternalId,
          returnedExternalId,
        },
      );
      return null;
    }
    connectionCache.set(scopedCacheKey, scoped.data.connection_id);
    return scoped.data.connection_id;
  }

  // Fast path: only cached canonical selections (resolved below) are trusted.
  const cached = connectionCache.get(userId);
  if (cached) return cached;

  // Back-compat: we previously used raw userId as Datagran externalId.
  // New standard across the app is `flow_${userId}` (link tokens, integrations, etc).
  const flowExternalId = `flow_${userId}`;
  const legacyExternalId = userId;
  let shouldTryLegacyExternalId = false;
  let configuredConnectionId: string | null = null;
  let configuredExternalId: string | null = null;

  // Read existing DB mapping, but do not trust it blindly:
  // old rows can be stale if users previously had duplicate Datagran connections.
  if (_supabase) {
    try {
      const { data: cfg, error } = await _supabase
        .from("datagran_memory_configs")
        .select("connection_id,end_user_external_id")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        console.warn("[groovyMemory] failed to read datagran_memory_configs:", error.message);
      } else {
        configuredConnectionId =
          cfg && typeof cfg.connection_id === "string" && cfg.connection_id.trim()
            ? cfg.connection_id.trim()
            : null;
        configuredExternalId =
          cfg && typeof (cfg as { end_user_external_id?: unknown }).end_user_external_id === "string"
            ? String((cfg as { end_user_external_id: string }).end_user_external_id).trim() || null
            : null;

        if (
          configuredExternalId &&
          configuredExternalId !== flowExternalId &&
          configuredExternalId !== legacyExternalId
        ) {
          console.error("[groovyMemory][SECURITY] rejecting db memory connection due externalId mismatch", {
            userId,
            configuredExternalId,
            expected: [flowExternalId, legacyExternalId],
          });
          configuredConnectionId = null;
          configuredExternalId = null;
        } else if (configuredExternalId === legacyExternalId && !configuredConnectionId) {
          // Legacy users may have a legacy external id with missing connection_id.
          // Only in this case do we probe legacy below, to avoid creating duplicates.
          shouldTryLegacyExternalId = true;
        }
      }
    } catch (err) {
      console.warn(
        "[groovyMemory] error reading datagran_memory_configs:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  try {
    // First try the new standard externalId.
    const primary = await createMemoryConnectionWithRetry({
      apiKey: GROOVY_DATAGRAN_API_KEY,
      endUserExternalId: flowExternalId,
      email,
      userId,
      label: "primary",
    });

    const primaryReturnedExternalId =
      primary.ok && typeof primary.data?.end_user_external_id === "string"
        ? primary.data.end_user_external_id.trim()
        : null;
    const primaryConnectionId =
      primary.ok &&
      primary.data?.connection_id &&
      (!primaryReturnedExternalId || primaryReturnedExternalId === flowExternalId)
        ? primary.data.connection_id
        : null;
    if (
      primary.ok &&
      primary.data?.connection_id &&
      primaryReturnedExternalId &&
      primaryReturnedExternalId !== flowExternalId
    ) {
      console.error("[groovyMemory][SECURITY] rejected primary memory connection due externalId mismatch", {
        userId,
        expectedExternalId: flowExternalId,
        returnedExternalId: primaryReturnedExternalId,
        returnedConnectionId: primary.data.connection_id,
      });
    }

    // Important: avoid creating duplicate memory accounts for new users.
    // We only probe legacy external id when DB explicitly points to legacy external id.
    // Do not probe legacy just because canonical lookup failed.
    let legacy: Awaited<ReturnType<typeof datagranCreateMemoryConnection>> | null = null;
    if (shouldTryLegacyExternalId) {
      legacy = await createMemoryConnectionWithRetry({
        apiKey: GROOVY_DATAGRAN_API_KEY,
        endUserExternalId: legacyExternalId,
        email,
        userId,
        label: "legacy",
      });
    }

    const legacyReturnedExternalId =
      legacy?.ok && typeof legacy.data?.end_user_external_id === "string"
        ? legacy.data.end_user_external_id.trim()
        : null;
    const legacyConnectionId =
      legacy?.ok &&
      legacy.data?.connection_id &&
      (!legacyReturnedExternalId || legacyReturnedExternalId === legacyExternalId)
        ? legacy.data.connection_id
        : null;
    if (
      legacy?.ok &&
      legacy.data?.connection_id &&
      legacyReturnedExternalId &&
      legacyReturnedExternalId !== legacyExternalId
    ) {
      console.error("[groovyMemory][SECURITY] rejected legacy memory connection due externalId mismatch", {
        userId,
        expectedExternalId: legacyExternalId,
        returnedExternalId: legacyReturnedExternalId,
        returnedConnectionId: legacy.data.connection_id,
      });
    }

    const candidates: Array<{
      label: "configured" | "primary" | "legacy";
      externalId: string;
      connectionId: string;
    }> = [];

    if (configuredConnectionId) {
      candidates.push({
        label: "configured",
        externalId: configuredExternalId || flowExternalId,
        connectionId: configuredConnectionId,
      });
    }

    if (primaryConnectionId) {
      if (primaryConnectionId !== configuredConnectionId) {
        candidates.push({
          label: "primary",
          externalId: flowExternalId,
          connectionId: primaryConnectionId,
        });
      }
    }
    if (
      legacyConnectionId &&
      legacyConnectionId !== primaryConnectionId &&
      legacyConnectionId !== configuredConnectionId
    ) {
      candidates.push({
        label: "legacy",
        externalId: legacyExternalId,
        connectionId: legacyConnectionId,
      });
    }

    if (candidates.length > 0) {
      const probed = await Promise.all(
        candidates.map(async (candidate) => ({
          ...candidate,
          probe: await probeConnectionSignal(candidate.connectionId),
        }))
      );

      probed.sort((a, b) => {
        if (a.probe.score !== b.probe.score) return b.probe.score - a.probe.score;
        const labelRank: Record<"configured" | "primary" | "legacy", number> = {
          primary: 3,
          configured: 2,
          legacy: 1,
        };
        if (labelRank[a.label] !== labelRank[b.label]) return labelRank[b.label] - labelRank[a.label];
        return 0;
      });

      let chosen = probed[0];
      // Never prefer debug-seeded memory when we have any non-debug candidate.
      // This avoids pinning users to stale "debug-init / seed" traces.
      if (chosen?.probe.debugOnly) {
        const nonDebug = probed.find((c) => !c.probe.debugOnly);
        if (nonDebug) chosen = nonDebug;
      }
      connectionCache.set(userId, chosen.connectionId);
      // Best-effort: keep db mapping current when a row exists.
      if (_supabase) {
        try {
          await _supabase
            .from("datagran_memory_configs")
            .update({
              connection_id: chosen.connectionId,
              end_user_external_id: chosen.externalId,
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
        } catch {
          // ignore
        }
      }
      console.log("[groovyMemory] Selected memory connection:", {
        userId,
        chosen: {
          label: chosen.label,
          externalId: chosen.externalId,
          connectionId: chosen.connectionId,
          score: chosen.probe.score,
        },
        candidates: probed.map((c) => ({
          label: c.label,
          externalId: c.externalId,
          connectionId: c.connectionId,
          score: c.probe.score,
          ok: c.probe.ok,
          status: c.probe.status,
          answerUseful: c.probe.answerUseful,
          rawUseful: c.probe.rawUseful,
          evidenceCount: c.probe.evidenceCount,
          debugOnly: c.probe.debugOnly,
          answerPreview: c.probe.answerPreview,
        })),
      });
      return chosen.connectionId;
    }

    console.error("[groovyMemory] Failed to create connection:", {
      primary,
      legacy,
    });
    return null;
  } catch (err) {
    console.error("[groovyMemory] Error creating connection:", err);
    return null;
  }
}

/**
 * Query Datagran brain with a single question.
 * Always uses mind_state = "auto".
 */
async function queryBrain(
  connectionId: string,
  question: string
): Promise<{ context: string; data: DatagranBrainResponse | null; chars: number }> {
  if (!GROOVY_DATAGRAN_API_KEY || !connectionId) {
    return { context: "", data: null, chars: 0 };
  }

  try {
    console.log("[groovyMemory] Querying brain:", { connectionId, question: question.slice(0, 50) });
    
    const result = await datagranQueryBrain({
      apiKey: GROOVY_DATAGRAN_API_KEY,
      connectionId,
      question,
      mindState: "auto", // Always auto
      // Only pull from our memory traces/notes (avoid mixing in other Datagran providers).
      providers: ["memory"],
      include: { evidence: true },
    });

    console.log("[groovyMemory] Brain response:", {
      ok: result.ok,
      hasData: !!result.data,
      dataKeys: result.data ? Object.keys(result.data) : [],
      raw: result.data ? JSON.stringify(result.data).slice(0, 500) : "(no data)",
    });

    if (!result.ok || !result.data) {
      if (isNoBrainFoundError(result.status, result.error)) {
        if (!noBrainLoggedConnections.has(connectionId)) {
          console.log("[groovyMemory] Brain not initialized yet for this user; returning empty memory context", {
            connectionId,
            status: result.status,
          });
          noBrainLoggedConnections.add(connectionId);
        }
        return { context: "", data: null, chars: 0 };
      }
      console.warn("[groovyMemory] Brain query failed or empty:", result);
      return { context: "", data: null, chars: 0 };
    }

    const brain = result.data;
    const contextParts: string[] = [];

    // Detect debug-only short_term (old format object with raw_text)
    const shortTermRaw = extractRawTextLayer(brain.short_term);
    const midTermRaw = extractRawTextLayer(brain.mid_term);
    const rawCandidates = [shortTermRaw, midTermRaw].filter((raw): raw is string => Boolean(raw));
    const longTermHasSnippets = Array.isArray(brain.long_term)
      ? (brain.long_term as Array<{ snippet?: string }>).some(
          (c) => c && typeof c.snippet === "string" && c.snippet.trim().length > 0
        )
      : false;
    const debugOnly =
      rawCandidates.length > 0 && rawCandidates.every((raw) => isKnownDebugSeedTrace(raw)) && !longTermHasSnippets;

    if (debugOnly) {
      console.log("[groovyMemory] Debug-only memory payload ignored", { connectionId });
      return { context: "", data: brain, chars: 0 };
    }

    // The main answer from the brain (only if it's actually useful and not purely debug-seeded).
    if (brain.answer && typeof brain.answer === "string" && isUsefulBrainAnswer(brain.answer)) {
      contextParts.push(stripBrainAnswerPrefix(brain.answer));
    }

    // Short-term memory (raw_text format) - contains conversation traces
    if (shortTermRaw) {
      const useful = extractUsefulMemoryContent(shortTermRaw, 2000);
      if (useful) contextParts.push(`Recent conversations:\n${useful}`);
    }

    // Mid-term memory
    if (midTermRaw) {
      const useful = extractUsefulMemoryContent(midTermRaw, 1000);
      if (useful) contextParts.push(`Session context:\n${useful}`);
    }

    // Long-term memory — handle both old format (object with raw_text) and new format (array of chunks).
    if (brain.long_term) {
      if (Array.isArray(brain.long_term)) {
        // New Datagran format (2026-02-10+): array of { snippet, provider, relevance, ... }
        const chunks = (brain.long_term as Array<{ snippet?: string; provider?: string; relevance?: number; source_created_at?: string }>)
          .filter((c) => c && typeof c.snippet === "string" && c.snippet.trim())
          .slice(0, 8);
        if (chunks.length > 0) {
          const lines = chunks.map((c) => {
            const meta = [c.provider, c.source_created_at].filter(Boolean).join(" | ");
            return meta ? `[${meta}] ${c.snippet!.trim()}` : c.snippet!.trim();
          });
          contextParts.push(`Long-term context:\n${lines.join("\n")}`);
        }
      } else if (typeof brain.long_term === "object") {
        // Old format: object with raw_text/summary
        const rawText = extractRawTextLayer(brain.long_term);
        if (rawText) {
          const useful = extractUsefulMemoryContent(rawText, 1000);
          if (useful) contextParts.push(`Long-term context:\n${useful}`);
        }
      }
    }

    // Memory weights (new Datagran format) — ranked candidates with semantic/freshness/score.
    // Surface these so the consuming LLM can prioritize high-relevance, fresh memories.
    if (brain.memory_weights && typeof brain.memory_weights === "object") {
      const mw = brain.memory_weights as Record<string, unknown>;
      const formatCandidates = (tier: string, candidates: unknown): string[] => {
        if (!Array.isArray(candidates)) return [];
        return (candidates as Array<{ ref?: string; provider?: string; ts?: string; semantic?: number; freshness?: number; score?: number }>)
          .filter((c) => c && typeof c.ref === "string")
          .slice(0, 8)
          .map((c) => {
            const parts = [
              `ref=${c.ref}`,
              c.provider ? `provider=${c.provider}` : null,
              c.ts ? `ts=${c.ts}` : null,
              typeof c.semantic === "number" ? `semantic=${c.semantic.toFixed(2)}` : null,
              typeof c.freshness === "number" ? `freshness=${c.freshness.toFixed(2)}` : null,
              typeof c.score === "number" ? `score=${c.score.toFixed(2)}` : null,
            ].filter(Boolean).join(", ");
            return `  [${tier}] ${parts}`;
          });
      };

      const stCandidates = (mw.short_term as Record<string, unknown> | undefined)?.candidates;
      const ltCandidates = (mw.long_term as Record<string, unknown> | undefined)?.candidates;
      const weightLines = [
        ...formatCandidates("short_term", stCandidates),
        ...formatCandidates("long_term", ltCandidates),
      ];

      if (weightLines.length > 0) {
        // Include the weighting params so the LLM understands what the scores mean.
        const params = mw.params as Record<string, unknown> | undefined;
        const paramStr = params
          ? `Weighting params: freshness_half_life_days=${params.freshness_half_life_days ?? "?"}, short_term_top_k=${params.short_term_top_k ?? "?"}, long_term_top_k=${params.long_term_top_k ?? "?"}`
          : "";
        contextParts.push(
          `Memory relevance scores (higher score = more relevant and fresh):\n${paramStr ? paramStr + "\n" : ""}${weightLines.join("\n")}`
        );
      }
    }

    // Citations (new Datagran format) — scored references with provider + timestamp.
    if (brain.citations && Array.isArray(brain.citations) && brain.citations.length > 0) {
      const citationLines = (brain.citations as Array<{ kind?: string; ref?: string; provider?: string; ts?: string; score?: number; semantic?: number; freshness?: number }>)
        .filter((c) => c && typeof c.ref === "string")
        .slice(0, 8)
        .map((c) => {
          const parts = [
            c.ref,
            c.kind ? `kind=${c.kind}` : null,
            c.provider,
            c.ts,
            typeof c.score === "number" ? `score=${c.score.toFixed(2)}` : null,
            typeof c.semantic === "number" ? `semantic=${c.semantic.toFixed(2)}` : null,
            typeof c.freshness === "number" ? `freshness=${c.freshness.toFixed(2)}` : null,
          ].filter(Boolean);
          return `[${parts.join(" | ")}]`;
        });
      if (citationLines.length > 0) {
        contextParts.push(`Citations:\n${citationLines.join("\n")}`);
      }
    }

    // Evidence snippets (legacy format, kept for backward compat)
    if (brain.evidence && Array.isArray(brain.evidence) && brain.evidence.length > 0) {
      const evidenceText = brain.evidence
        .slice(0, 3)
        .map((e, i) => `[${i + 1}] ${typeof e === "string" ? e : JSON.stringify(e)}`)
        .join("\n");
      if (evidenceText.trim()) {
        contextParts.push(`Evidence:\n${evidenceText}`);
      }
    }

    const context = contextParts.join("\n\n");
    console.log("[groovyMemory] Parsed context:", { 
      parts: contextParts.length, 
      chars: context.length,
      preview: context.slice(0, 300) 
    });
    return { context, data: brain, chars: context.length };
  } catch (err) {
    console.error("[groovyMemory] Error querying brain:", err);
    return { context: "", data: null, chars: 0 };
  }
}

/**
 * Load memory context using AI-driven query planning.
 * 
 * 1. Calls the memory planner to decide what questions to ask
 * 2. Runs each question against Datagran brain
 * 3. Merges results into a unified context string
 */
export async function loadMemoryWithPlanner(
  userId: string,
  input: MemoryPlannerInput,
  options?: {
    userEmail?: string;
    maxContextChars?: number;
    llmApiKey?: string;
    llmProvider?: ProviderId;
    llmModel?: string;
    supabase?: SupabaseClient;
  }
): Promise<MemoryLoadResult> {
  const {
    userEmail,
    maxContextChars = 3000,
    llmApiKey,
    llmProvider,
    llmModel,
    supabase,
  } = options || {};

  // Get connection
  const connectionId = await getGroovyMemoryConnection(userId, userEmail, supabase);
  if (!connectionId) {
    return {
      context: "",
      questions: [],
      queryResults: [],
      totalChars: 0,
      connectionId: null,
    };
  }

  // Plan queries using AI
  const planning = await planMemoryQueries(input, {
    apiKey: llmApiKey,
    provider: llmProvider,
    model: llmModel,
  });
  const questions = planning.questions;

  if (questions.length === 0) {
    console.log("[groovyMemory] No memory queries planned");
    return {
      context: "",
      questions: [],
      planning,
      queryResults: [],
      totalChars: 0,
      connectionId,
    };
  }

  // Run queries in parallel
  const queryPromises = questions.map(async (question) => {
    const result = await queryBrain(connectionId, question);
    return { question, ...result };
  });

  const queryResults = await Promise.all(queryPromises);

  // Merge contexts, respecting size cap
  const contextParts: string[] = [];
  let totalChars = 0;

  for (const qr of queryResults) {
    if (!qr.context) continue;
    if (totalChars + qr.context.length > maxContextChars) {
      // Truncate if needed
      const remaining = maxContextChars - totalChars;
      if (remaining > 100) {
        contextParts.push(`[Q: ${qr.question}]\n${qr.context.slice(0, remaining)}...`);
        totalChars = maxContextChars;
      }
      break;
    }
    contextParts.push(`[Q: ${qr.question}]\n${qr.context}`);
    totalChars += qr.context.length;
  }

  const context = contextParts.join("\n\n");

  console.log("[groovyMemory] Loaded memory:", {
    questions: questions.length,
    totalChars,
    hasContent: context.length > 0,
  });

  return {
    context,
    questions,
    planning,
    queryResults,
    totalChars,
    connectionId,
  };
}

/**
 * Store a memory note (used by "remember" tool or AI-decided storage).
 */
export async function storeMemoryNote(
  connectionId: string,
  content: string,
  label?: string
): Promise<boolean> {
  if (!GROOVY_DATAGRAN_API_KEY || !connectionId || !content.trim()) {
    return false;
  }

  try {
    const timestamp = new Date().toISOString();
    const memoryId = `mem-${Date.now()}`;
    const rawText = `MEMORY_ID: ${memoryId}
TIMESTAMP: ${timestamp}
TYPE: explicit_memory
LABEL: ${label || "User Memory"}

CONTENT:
${content}
`;

    const result = await datagranCompileRawText({
      apiKey: GROOVY_DATAGRAN_API_KEY,
      connectionId,
      text: rawText,
      name: label || `memory-${memoryId}`,
      ref: memoryId,
    });

    if (result.ok) {
      console.log("[groovyMemory] Stored memory note:", memoryId, label);
      return true;
    }

    console.error("[groovyMemory] Failed to store memory:", result);
    return false;
  } catch (err) {
    console.error("[groovyMemory] Error storing memory:", err);
    return false;
  }
}

/**
 * Store a durable learning in semantic memory and, when configured, in the
 * user's structured private Wiki. Each backend is best-effort and independent.
 */
export async function storeDurableLearning(
  connectionId: string,
  content: string,
  label?: string,
  options?: { wiki?: WikiMemorySyncOptions }
): Promise<MemoryStoreResult> {
  const sensitiveMaterial = [
    content,
    label,
    options?.wiki?.target?.page,
    options?.wiki?.target?.title,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (containsSecretLikeMaterial(sensitiveMaterial)) {
    return {
      stored: false,
      datagranStored: false,
      wikiFiled: false,
      wikiReason: "secret_like_material_blocked",
      reason: "Sensitive secret-like material is not eligible for durable memory",
      label,
    };
  }

  const datagranContent = options?.wiki?.profileId
    ? `[HARNESS_PROFILE:${options.wiki.profileId}]\n${content}`
    : content;
  const datagranPromise = connectionId
    ? storeMemoryNote(connectionId, datagranContent, label)
    : Promise.resolve(false);
  const wikiPromise: Promise<WikiLearningResult | null> = options?.wiki
    ? fileLearningToWiki({
        supabase: options.wiki.supabase,
        userId: options.wiki.userId,
        content,
        label,
        source: options.wiki.source || "orchestrator memory",
        target: options.wiki.target,
        profileId: options.wiki.profileId,
      }).catch((error) => ({
        filed: false,
        reason: error instanceof Error ? error.message : String(error),
      }))
    : Promise.resolve(null);

  const [datagranStored, wikiResult] = await Promise.all([
    datagranPromise,
    wikiPromise,
  ]);
  const wikiKnown =
    wikiResult?.filed === true || wikiResult?.reason === "duplicate";

  return {
    stored: datagranStored || wikiKnown,
    datagranStored,
    wikiFiled: wikiResult?.filed === true,
    wikiPath: wikiResult?.path,
    wikiReason: wikiResult?.reason,
    memoryNote: content,
    label,
  };
}

export function formatDurableLearningConfirmation(
  content: string,
  result: MemoryStoreResult
): string {
  if (!result.stored) {
    return (
      result.reason ||
      "I could not save that to Datagran or the Wiki. Please try again later."
    );
  }

  const quotedContent = `"${content}"`;
  if (result.datagranStored && result.wikiFiled && result.wikiPath) {
    return `I've saved that to Datagran memory and filed it in ${result.wikiPath}: ${quotedContent}`;
  }
  if (result.datagranStored && result.wikiPath) {
    return `I've saved that to Datagran memory; it was already present in ${result.wikiPath}: ${quotedContent}`;
  }
  if (result.datagranStored) {
    return `I've saved that to Datagran memory, but Wiki filing did not complete: ${quotedContent}`;
  }
  if (result.wikiFiled && result.wikiPath) {
    return `I've filed that in ${result.wikiPath}, but Datagran semantic storage did not complete: ${quotedContent}`;
  }
  if (result.wikiPath) {
    return `That learning was already present in ${result.wikiPath}, but Datagran semantic storage did not complete: ${quotedContent}`;
  }
  return `I've saved that to durable memory: ${quotedContent}`;
}

/**
 * AI-decided memory storage: decide if conversation should be stored and do it.
 * Returns whether storage happened and details.
 */
export async function maybeStoreConversation(
  connectionId: string,
  userMessage: string,
  assistantResponse: string,
  existingMemoryContext?: string,
  options?: {
    llmApiKey?: string;
    llmProvider?: ProviderId;
    llmModel?: string;
    wiki?: WikiMemorySyncOptions;
  }
): Promise<MemoryStoreResult> {
  if (!connectionId || !userMessage.trim() || !assistantResponse.trim()) {
    return { stored: false, reason: "Missing required inputs" };
  }

  if (isSessionScopedPersonaInstruction(userMessage)) {
    return {
      stored: false,
      reason: "Session-scoped persona/identity instruction; skipping global memory write",
    };
  }

  // Ask AI if we should store
  const decision = await shouldStoreMemory(
    { userMessage, assistantResponse, existingMemoryContext },
    {
      apiKey: options?.llmApiKey,
      provider: options?.llmProvider,
      model: options?.llmModel,
    }
  );

  if (!decision.shouldStore || !decision.memoryNote) {
    console.log("[groovyMemory] AI decided not to store:", decision.reason);
    return { stored: false, reason: decision.reason };
  }

  const result = await storeDurableLearning(
    connectionId,
    decision.memoryNote,
    decision.label,
    {
      wiki: options?.wiki
        ? {
            ...options.wiki,
            target: decision.wikiTarget || options.wiki.target,
          }
        : undefined,
    }
  );

  return { ...result, reason: decision.reason };
}

/**
 * Deterministic preference recall (separate from planner-based memory retrieval).
 * This ensures user preferences are checked every run.
 */
export async function loadPreferenceMemoryContext(
  connectionId: string | null | undefined,
  options?: { question?: string; maxContextChars?: number; channel?: "interactive" | "heartbeat" }
): Promise<PreferenceLoadResult> {
  const baseQuestion =
    options?.question?.trim() ||
    (options?.channel === "heartbeat" ? DEFAULT_HEARTBEAT_PREFERENCE_QUERY : DEFAULT_PREFERENCE_QUERY);
  const maxContextChars = Math.max(200, options?.maxContextChars || 1800);

  if (!connectionId) {
    return { question: baseQuestion, context: "", chars: 0 };
  }

  // Preference retrieval asks Datagran directly with the caller-provided question.
  const question = baseQuestion;

  const result = await datagranQueryBrain({
    apiKey: GROOVY_DATAGRAN_API_KEY,
    connectionId,
    question,
    mindState: "auto",
    providers: ["memory"],
    include: { evidence: true, precision: true },
  });

  if (!result.ok || !result.data) {
    return { question: baseQuestion, context: "", chars: 0 };
  }

  const rawAnswer = typeof result.data.answer === "string" ? result.data.answer.trim() : "";
  const cleanedAnswer = stripBrainAnswerPrefix(rawAnswer).replace(/^Question:\s*/i, "").trim();
  const answerIsInformative =
    !isNonInformativePreferenceAnswer(rawAnswer) && !isNonInformativePreferenceAnswer(cleanedAnswer);
  const trimmedAnswer = answerIsInformative ? cleanedAnswer : "";
  const fallbackContext = buildPreferenceFallbackContext(result.data, maxContextChars);
  const shouldAppendFallback = !trimmedAnswer || trimmedAnswer.length < 220;

  const mergedContext = [trimmedAnswer, shouldAppendFallback ? fallbackContext : ""]
    .filter((part) => Boolean(part && part.trim()))
    .join("\n\n");

  if (!mergedContext.trim()) {
    return { question: baseQuestion, context: "", chars: 0 };
  }

  const context =
    mergedContext.length > maxContextChars
      ? `${mergedContext.slice(0, maxContextChars)}...`
      : mergedContext;
  return { question: baseQuestion, context, chars: context.length };
}

/**
 * Format memory context for injection into system prompt.
 */
export function formatMemoryForPrompt(memoryContext: string): string {
  if (!memoryContext.trim()) return "";

  return `
## MEMORY CONTEXT (CHECK BEFORE CALLING RETRIEVAL TOOLS)
The following is relevant context retrieved from the user's memory based on their request.
Use memory as supplemental context only.
- First resolve from current conversation turns and latest tool outputs.
- If memory conflicts with current-turn context/tool evidence, ignore memory.
- Only rely on memory when current-turn context is insufficient, and mention a fresh lookup is available on request.

Memory may include relevance scores and citations:
- "score" (0-1): overall relevance. Higher = more relevant to the query.
- "freshness" (0-1): how recent the memory is. Higher = more recent.
- "semantic" (0-1): how closely the memory matches the query meaning.
Prioritize memories with high score AND high freshness. Low-freshness memories may be outdated.

${memoryContext}

Use this context to provide informed, personalized responses. If the context seems incomplete or ambiguous, use your best judgment and, if useful, mention that a fresh lookup is available on request. Ask a question only when required input is missing.
`;
}

/**
 * Simple query for recall tool (single question, no planner).
 */
export async function queryMemoryDirect(
  connectionId: string,
  question: string
): Promise<{ context: string; data: DatagranBrainResponse | null }> {
  const result = await queryBrain(connectionId, question);
  return { context: result.context, data: result.data };
}
export { formatPreferenceForPrompt } from "./preferencePrompt";
