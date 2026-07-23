import { createHmac, randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  decryptLlmApiKey,
  encryptLlmApiKey,
  hashLlmApiKey,
} from "@/lib/crypto/llmKey";
import { getConfiguredAppUrl } from "@/lib/config/appConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MANAGED_MATERIAL_QUERY_TIMEOUT_MS = 120_000;
const MATERIAL_QUERY_TOOL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const AIYRA_CONFIG_AUTOLOAD_TIMEOUT_MS = 4_000;
const DEFAULT_TTS_SPEED = 1.03;
const TTS_SPEED_ERROR = "ttsSpeed must be a number between 0.5 and 2.0";

type TwilioToolBody = {
  enabled?: boolean;
  from?: string | null;
  to?: string | null;
};

type MaterialQueryToolBody = {
  toolEnabled?: boolean;
  endpoint?: string | null;
  timeoutMs?: number | null;
};

type PostBody = {
  apiKey?: string | null;
  clearApiKey?: boolean;
  autoLoadOnly?: boolean;
  conversationId?: string | null;
  channelMode?: string | null;
  personaPrompt?: string | null;
  voiceId?: string | null;
  ttsSpeed?: number | string | null;
  tts_speed?: number | string | null;
  tts?: {
    speed?: number | string | null;
  } | null;
  startupGreetingEnabled?: boolean | null;
  wakeWord?: string | null;
  wakeSensitivity?: number | null;
  idleTimeoutMs?: number | null;
  enabled?: boolean;
  tools?: {
    twilio?: TwilioToolBody | null;
    materialQuery?: MaterialQueryToolBody | null;
  } | null;
  exposedTools?: unknown;
};

type LocalSettingsRow = {
  api_key_enc?: unknown;
  enabled?: unknown;
  wake_word?: unknown;
  wake_sensitivity?: unknown;
  idle_timeout_ms?: unknown;
  tts_speed?: unknown;
  updated_at?: unknown;
};

type NormalizedRuntimeConfig = {
  source: string;
  configured: boolean;
  conversationId: string | null;
  channelMode: string;
  personaPrompt: string;
  voiceId: string;
  ttsSpeed: number | null;
  startupGreetingEnabled: boolean;
  tools: {
    twilio: {
      enabled: boolean;
      from: string;
      to: string;
    };
    materialQuery: {
      toolEnabled: boolean;
      endpoint: string;
      timeoutMs: number | null;
    };
  };
  exposedTools: string[];
  updatedAt: string | null;
};

type ResolvedTtsSpeedInput = {
  hasField: boolean;
  value: number | null;
  error?: string;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function clampWakeSensitivity(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function clampIdleTimeoutMs(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(2000, Math.min(120000, Math.trunc(n)));
}

function toNullableInteger(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function toBooleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeTtsSpeed(value: number): number {
  return Math.round(Math.max(0.5, Math.min(2, value)) * 100) / 100;
}

function coerceTtsSpeed(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return normalizeTtsSpeed(n);
}

function readTtsSpeedValue(source: Record<string, unknown> | null): number | null {
  if (!source) return null;
  const ttsRaw = asRecord(source.tts);
  return (
    coerceTtsSpeed(source.ttsSpeed) ??
    coerceTtsSpeed(source.tts_speed) ??
    coerceTtsSpeed(ttsRaw?.speed)
  );
}

function resolveTtsSpeedInput(body: PostBody): ResolvedTtsSpeedInput {
  const ttsRaw = asRecord(body.tts);
  const hasField =
    "ttsSpeed" in body ||
    "tts_speed" in body ||
    (ttsRaw ? hasOwn(ttsRaw, "speed") : false);
  if (!hasField) {
    return { hasField: false, value: null };
  }

  const rawValue =
    "ttsSpeed" in body
      ? body.ttsSpeed
      : "tts_speed" in body
      ? body.tts_speed
      : ttsRaw?.speed;

  if (rawValue === null || rawValue === undefined) {
    return { hasField: true, value: null };
  }
  if (typeof rawValue === "string" && !rawValue.trim()) {
    return { hasField: true, value: null };
  }
  if (typeof rawValue === "boolean") {
    return { hasField: true, value: null, error: TTS_SPEED_ERROR };
  }

  const n = Number(rawValue);
  if (!Number.isFinite(n)) {
    return { hasField: true, value: null, error: TTS_SPEED_ERROR };
  }

  return {
    hasField: true,
    value: normalizeTtsSpeed(n),
  };
}

function normalizeBaseUrl(input: string): string {
  const value = asTrimmedString(input);
  return (value || "https://omnirion.ai").replace(/\/+$/, "");
}

function normalizeOrigin(input: string): string {
  return asTrimmedString(input).replace(/\/+$/, "");
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function getMaterialQueryAuthSecret(): string | null {
  const secret = asTrimmedString(process.env.AIYRA_MATERIAL_QUERY_POLL_SECRET);
  return secret || null;
}

function resolveManagedMaterialQueryOrigin(_req: Request): string | null {
  const envOrigin = normalizeOrigin(getConfiguredAppUrl() || "");
  if (envOrigin) return envOrigin;
  return null;
}

function buildManagedMaterialQueryEndpoint(
  req: Request,
  conversationId: string
): string | null {
  const origin = resolveManagedMaterialQueryOrigin(req);
  const normalizedConversationId = asTrimmedString(conversationId);
  if (!origin || !normalizedConversationId) return null;

  const secret = getMaterialQueryAuthSecret();
  if (!secret) {
    return `${origin}/api/aiyra/material-query`;
  }

  const payload = {
    conversationId: normalizedConversationId,
    exp: Date.now() + MATERIAL_QUERY_TOOL_TOKEN_TTL_MS,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  const token = `${encodedPayload}.${signature}`;
  return `${origin}/api/aiyra/material-query?token=${encodeURIComponent(token)}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeChannelMode(value: unknown): "mic_main" | "twilio_main" {
  return asTrimmedString(value) === "twilio_main" ? "twilio_main" : "mic_main";
}

function toLocalUiState(row: LocalSettingsRow | null) {
  const configured =
    typeof row?.api_key_enc === "string" && row.api_key_enc.trim().length > 0;
  return {
    configured,
    enabled: row?.enabled === true,
    wakeWord:
      typeof row?.wake_word === "string" && row.wake_word.trim()
        ? row.wake_word
        : "hey groovy",
    wakeSensitivity:
      Number.isFinite(Number(row?.wake_sensitivity)) &&
      Number(row?.wake_sensitivity) >= 0 &&
      Number(row?.wake_sensitivity) <= 1
        ? Number(row?.wake_sensitivity)
        : 0.5,
    idleTimeoutMs:
      Number.isFinite(Number(row?.idle_timeout_ms)) &&
      Number(row?.idle_timeout_ms) >= 2000
        ? Math.trunc(Number(row?.idle_timeout_ms))
        : 12000,
    ttsSpeed: coerceTtsSpeed(row?.tts_speed),
    updatedAt: typeof row?.updated_at === "string" ? row.updated_at : null,
  };
}

function emptyRuntimeConfig(configured = false): NormalizedRuntimeConfig {
  return {
    source: "local_only",
    configured,
    conversationId: null,
    channelMode: "",
    personaPrompt: "",
    voiceId: "",
    ttsSpeed: null,
    startupGreetingEnabled: false,
    tools: {
      twilio: {
        enabled: false,
        from: "",
        to: "",
      },
      materialQuery: {
        toolEnabled: false,
        endpoint: "",
        timeoutMs: null,
      },
    },
    exposedTools: [],
    updatedAt: null,
  };
}

function normalizeRuntimeConfigFromUpstream(payload: Record<string, unknown>): NormalizedRuntimeConfig {
  const configRaw = asRecord(payload.config);
  const aiyraRaw = asRecord(payload.aiyra);
  const aiyraConfigRaw = asRecord(payload.aiyraConfig);
  const metadataRaw = asRecord(payload.metadata);
  const metadataAiyraRaw = asRecord(metadataRaw?.aiyra);
  const toolsRaw =
    asRecord(configRaw?.tools) ||
    asRecord(payload.tools) ||
    asRecord(aiyraRaw?.tools) ||
    asRecord(aiyraConfigRaw?.tools) ||
    asRecord(metadataAiyraRaw?.tools);
  const twilioRaw = asRecord(toolsRaw?.twilio);
  const materialQueryRaw = asRecord(toolsRaw?.materialQuery);
  const startupGreetingEnabled =
    toBooleanOrNull(configRaw?.startupGreetingEnabled) ??
    toBooleanOrNull(configRaw?.startup_greeting_enabled) ??
    toBooleanOrNull(aiyraRaw?.startupGreetingEnabled) ??
    toBooleanOrNull(aiyraRaw?.startup_greeting_enabled) ??
    toBooleanOrNull(aiyraConfigRaw?.startupGreetingEnabled) ??
    toBooleanOrNull(aiyraConfigRaw?.startup_greeting_enabled) ??
    toBooleanOrNull(metadataAiyraRaw?.startupGreetingEnabled) ??
    toBooleanOrNull(metadataAiyraRaw?.startup_greeting_enabled) ??
    false;
  const ttsSpeed =
    readTtsSpeedValue(configRaw) ??
    readTtsSpeedValue(aiyraRaw) ??
    readTtsSpeedValue(aiyraConfigRaw) ??
    readTtsSpeedValue(metadataAiyraRaw) ??
    readTtsSpeedValue(payload);
  const configExposedTools = normalizeStringArray(configRaw?.exposedTools);
  const exposedTools =
    configExposedTools.length > 0
      ? configExposedTools
      : normalizeStringArray(aiyraRaw?.exposedTools);

  return {
    source: asTrimmedString(payload.source) || "upstream",
    configured: aiyraRaw?.configured === true,
    conversationId: asTrimmedString(configRaw?.conversationId) || null,
    channelMode:
      asTrimmedString(configRaw?.channelMode) ||
      asTrimmedString(aiyraRaw?.channelMode),
    personaPrompt:
      asTrimmedString(configRaw?.personaPrompt) ||
      asTrimmedString(aiyraRaw?.personaPrompt),
    voiceId:
      asTrimmedString(configRaw?.voiceId) ||
      asTrimmedString(aiyraRaw?.voiceId),
    ttsSpeed,
    startupGreetingEnabled,
    tools: {
      twilio: {
        enabled: twilioRaw?.enabled === true,
        from: asTrimmedString(twilioRaw?.from),
        to: asTrimmedString(twilioRaw?.to),
      },
      materialQuery: {
        toolEnabled: materialQueryRaw?.toolEnabled === true,
        endpoint: asTrimmedString(materialQueryRaw?.endpoint),
        timeoutMs: toNullableInteger(materialQueryRaw?.timeoutMs),
      },
    },
    exposedTools,
    updatedAt:
      asTrimmedString(aiyraRaw?.updatedAt) ||
      asTrimmedString(aiyraRaw?.updated_at) ||
      null,
  };
}

function buildMergedResponse(args: {
  localRow: LocalSettingsRow | null;
  runtimeConfig: NormalizedRuntimeConfig;
}) {
  const local = toLocalUiState(args.localRow);
  const runtime = args.runtimeConfig;
  const effectiveTtsSpeed = runtime.ttsSpeed ?? DEFAULT_TTS_SPEED;
  return {
    ok: true,
    source: runtime.source,
    config: {
      conversationId: runtime.conversationId,
      channelMode: runtime.channelMode,
      personaPrompt: runtime.personaPrompt,
      voiceId: runtime.voiceId,
      ttsSpeed: effectiveTtsSpeed,
      tts: {
        speed: effectiveTtsSpeed,
      },
      startupGreetingEnabled: runtime.startupGreetingEnabled,
      tools: runtime.tools,
      exposedTools: runtime.exposedTools,
    },
    aiyra: {
      configured: local.configured || runtime.configured,
      enabled: local.enabled,
      personaPrompt: runtime.personaPrompt,
      voiceId: runtime.voiceId,
      ttsSpeed: effectiveTtsSpeed,
      tts: {
        speed: effectiveTtsSpeed,
      },
      startupGreetingEnabled: runtime.startupGreetingEnabled,
      wakeWord: local.wakeWord,
      wakeSensitivity: local.wakeSensitivity,
      idleTimeoutMs: local.idleTimeoutMs,
      updatedAt: runtime.updatedAt || local.updatedAt,
      channelMode: runtime.channelMode,
      tools: runtime.tools,
      exposedTools: runtime.exposedTools,
    },
  };
}

async function loadLocalSettings(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string
) {
  const { data, error } = await supabase
    .from("user_aiyra_settings")
    .select("api_key_enc, enabled, wake_word, wake_sensitivity, idle_timeout_ms, tts_speed, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as LocalSettingsRow | null) || null) as LocalSettingsRow | null;
}

async function getOrCreateConfigConversationId(args: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  userId: string;
  channelMode: "mic_main" | "twilio_main";
}): Promise<string> {
  const nowIso = new Date().toISOString();
  const { data: existingRows, error: existingErr } = await args.supabase
    .from("aiyra_conversations")
    .select("conversation_id")
    .eq("user_id", args.userId)
    .eq("channel_mode", args.channelMode)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (existingErr) throw new Error(existingErr.message);

  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  const existingConversationId =
    existing && typeof existing === "object"
      ? asTrimmedString((existing as { conversation_id?: unknown }).conversation_id)
      : "";
  if (existingConversationId) {
    await args.supabase
      .from("aiyra_conversations")
      .update({ updated_at: nowIso })
      .eq("user_id", args.userId)
      .eq("conversation_id", existingConversationId);
    return existingConversationId;
  }

  const { data: sessionRow, error: sessionErr } = await args.supabase
    .from("orchestrator_sessions")
    .insert({
      user_id: args.userId,
      title: "Aiyra Voice",
    })
    .select("id")
    .single();
  if (sessionErr || !sessionRow?.id) {
    throw new Error(sessionErr?.message || "Failed to create orchestrator session");
  }

  const conversationId = `aiyra-${randomUUID()}`;
  const { error: insertErr } = await args.supabase.from("aiyra_conversations").insert({
    conversation_id: conversationId,
    user_id: args.userId,
    orchestrator_session_id: sessionRow.id,
    device_id: null,
    channel_mode: args.channelMode,
    updated_at: nowIso,
  });
  if (insertErr) throw new Error(insertErr.message);
  return conversationId;
}

async function upsertLocalUiSettings(args: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  userId: string;
  body: PostBody;
  apiKey?: string;
  ttsSpeedInput?: ResolvedTtsSpeedInput;
}) {
  const updates: Record<string, unknown> = {
    user_id: args.userId,
    updated_at: new Date().toISOString(),
  };

  if (args.body.clearApiKey === true) {
    updates.api_key_enc = null;
    updates.api_key_hash = null;
  } else if (args.apiKey) {
    updates.api_key_enc = encryptLlmApiKey(args.apiKey);
    updates.api_key_hash = hashLlmApiKey(args.apiKey);
  }

  if (typeof args.body.enabled === "boolean") {
    updates.enabled = args.body.enabled;
  }
  if ("wakeWord" in args.body) {
    updates.wake_word = asTrimmedString(args.body.wakeWord) || "hey groovy";
  }
  if ("wakeSensitivity" in args.body) {
    const sensitivity = clampWakeSensitivity(args.body.wakeSensitivity);
    if (sensitivity !== null) updates.wake_sensitivity = sensitivity;
  }
  if ("idleTimeoutMs" in args.body) {
    const timeoutMs = clampIdleTimeoutMs(args.body.idleTimeoutMs);
    if (timeoutMs !== null) updates.idle_timeout_ms = timeoutMs;
  }

  const { data, error } = await args.supabase
    .from("user_aiyra_settings")
    .upsert(updates, { onConflict: "user_id" })
    .select("api_key_enc, enabled, wake_word, wake_sensitivity, idle_timeout_ms, tts_speed, updated_at")
    .single();
  if (error) throw new Error(error.message);
  return ((data as LocalSettingsRow | null) || null) as LocalSettingsRow | null;
}

async function decryptStoredApiKey(row: LocalSettingsRow | null): Promise<string> {
  const encrypted = asTrimmedString(row?.api_key_enc);
  if (!encrypted) return "";
  try {
    return decryptLlmApiKey(encrypted);
  } catch {
    throw new Error("Failed to decrypt stored Aiyra API key");
  }
}

function hasRuntimeFieldInput(body: PostBody): boolean {
  const ttsRaw = asRecord(body.tts);
  return (
    "conversationId" in body ||
    "channelMode" in body ||
    "personaPrompt" in body ||
    "voiceId" in body ||
    "ttsSpeed" in body ||
    "tts_speed" in body ||
    (ttsRaw ? hasOwn(ttsRaw, "speed") : false) ||
    "startupGreetingEnabled" in body ||
    "tools" in body ||
    "exposedTools" in body
  );
}

function buildUpstreamPayload(
  body: PostBody,
  apiKey: string,
  managedMaterialQueryEndpoint: string | null = null,
  fallbackConversationId: string | null = null,
  ttsSpeedInput: ResolvedTtsSpeedInput | null = null
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    apiKey,
  };

  if (body.autoLoadOnly === true) {
    out.autoLoadOnly = true;
  }
  if (typeof body.enabled === "boolean") {
    out.enabled = body.enabled;
  }
  if ("wakeWord" in body) {
    out.wakeWord = asTrimmedString(body.wakeWord) || "hey groovy";
  }
  if ("wakeSensitivity" in body) {
    const sensitivity = clampWakeSensitivity(body.wakeSensitivity);
    if (sensitivity !== null) out.wakeSensitivity = sensitivity;
  }
  if ("idleTimeoutMs" in body) {
    const timeoutMs = clampIdleTimeoutMs(body.idleTimeoutMs);
    if (timeoutMs !== null) out.idleTimeoutMs = timeoutMs;
  }
  const explicitConversationId =
    "conversationId" in body ? asTrimmedString(body.conversationId) : "";
  if (explicitConversationId) {
    out.conversationId = explicitConversationId;
  } else if (fallbackConversationId) {
    out.conversationId = fallbackConversationId;
  }
  if ("channelMode" in body) {
    out.channelMode = asTrimmedString(body.channelMode);
  }
  if ("personaPrompt" in body) {
    out.personaPrompt = asTrimmedString(body.personaPrompt);
  }
  if ("voiceId" in body) {
    out.voiceId = asTrimmedString(body.voiceId);
  }
  const resolvedTtsSpeedInput = ttsSpeedInput || resolveTtsSpeedInput(body);
  if (resolvedTtsSpeedInput.hasField) {
    out.ttsSpeed = resolvedTtsSpeedInput.value;
  }
  if ("startupGreetingEnabled" in body) {
    const startupGreetingEnabled = toBooleanOrNull(body.startupGreetingEnabled);
    if (startupGreetingEnabled !== null) {
      out.startupGreetingEnabled = startupGreetingEnabled;
    }
  }

  const toolsRaw = asRecord(body.tools);
  const toolsOut: Record<string, unknown> = {};
  const twilioRaw = asRecord(toolsRaw?.twilio);
  if (twilioRaw) {
    const twilioOut: Record<string, unknown> = {};
    if (hasOwn(twilioRaw, "enabled") && typeof twilioRaw.enabled === "boolean") {
      twilioOut.enabled = twilioRaw.enabled;
    }
    if (hasOwn(twilioRaw, "from")) {
      twilioOut.from = asTrimmedString(twilioRaw.from);
    }
    if (hasOwn(twilioRaw, "to")) {
      twilioOut.to = asTrimmedString(twilioRaw.to);
    }
    toolsOut.twilio = twilioOut;
  }

  const materialQueryRaw = asRecord(toolsRaw?.materialQuery);
  const materialQueryOut: Record<string, unknown> = {};
  if (
    materialQueryRaw &&
    hasOwn(materialQueryRaw, "toolEnabled") &&
    typeof materialQueryRaw.toolEnabled === "boolean"
  ) {
    materialQueryOut.toolEnabled = materialQueryRaw.toolEnabled;
  } else if (managedMaterialQueryEndpoint) {
    materialQueryOut.toolEnabled = true;
  }
  if (managedMaterialQueryEndpoint) {
    materialQueryOut.endpoint = managedMaterialQueryEndpoint;
  } else if (materialQueryRaw && hasOwn(materialQueryRaw, "endpoint")) {
    materialQueryOut.endpoint = asTrimmedString(materialQueryRaw.endpoint);
  }
  if (materialQueryRaw && hasOwn(materialQueryRaw, "timeoutMs")) {
    const timeoutMs = toNullableInteger(materialQueryRaw.timeoutMs);
    if (timeoutMs !== null) materialQueryOut.timeoutMs = timeoutMs;
  } else if (managedMaterialQueryEndpoint) {
    materialQueryOut.timeoutMs = MANAGED_MATERIAL_QUERY_TIMEOUT_MS;
  }
  if (Object.keys(materialQueryOut).length > 0) {
    toolsOut.materialQuery = materialQueryOut;
  }

  if (Object.keys(toolsOut).length > 0) {
    out.tools = toolsOut;
  }

  const exposedTools = normalizeStringArray(body.exposedTools);
  if (exposedTools.length > 0) {
    out.exposedTools = exposedTools;
  }

  return out;
}

async function callUpstreamConfig(
  payload: Record<string, unknown>,
  apiKey: string,
  opts?: { timeoutMs?: number }
) {
  const baseUrl = normalizeBaseUrl(
    process.env.AIYRA_BASE_URL || process.env.OPENCLAW_BASE_URL || ""
  );
  const timeoutMs =
    typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1000, Math.trunc(opts.timeoutMs))
      : 0;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/aiyra/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-aiyra-api-key": apiKey,
      },
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to reach upstream Aiyra config endpoint";
    throw new Error(`Upstream Aiyra config request failed: ${message}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = text ? JSON.parse(text) : null;
    json = asRecord(parsed);
  } catch {
    json = null;
  }

  if (!res.ok) {
    const detail =
      asTrimmedString(json?.error) ||
      asTrimmedString(json?.message) ||
      text.slice(0, 800) ||
      `status ${res.status}`;
    return {
      ok: false as const,
      status: res.status,
      error: detail,
    };
  }

  if (!json) {
    return {
      ok: false as const,
      status: 502,
      error: "Upstream Aiyra config returned a non-JSON response",
    };
  }

  if (json.ok === false || json.success === false) {
    return {
      ok: false as const,
      status: 502,
      error:
        asTrimmedString(json.error) ||
        asTrimmedString(json.message) ||
        "Upstream Aiyra config returned ok=false",
    };
  }

  return {
    ok: true as const,
    payload: json,
  };
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const useLocalFallback = (() => {
      try {
        return new URL(req.url).searchParams.get("fallback") === "local";
      } catch {
        return false;
      }
    })();
    const localRow = await loadLocalSettings(supabase, user.id);
    const localFallbackResponse = () =>
      NextResponse.json(
        buildMergedResponse({
          localRow,
          runtimeConfig: emptyRuntimeConfig(toLocalUiState(localRow).configured),
        })
      );
    const storedApiKey = await decryptStoredApiKey(localRow);
    if (!storedApiKey) {
      return localFallbackResponse();
    }

    let upstream: Awaited<ReturnType<typeof callUpstreamConfig>>;
    try {
      upstream = await callUpstreamConfig(
        {
          apiKey: storedApiKey,
          autoLoadOnly: true,
          enabled: toLocalUiState(localRow).enabled,
        },
        storedApiKey,
        useLocalFallback ? { timeoutMs: AIYRA_CONFIG_AUTOLOAD_TIMEOUT_MS } : undefined
      );
    } catch (error) {
      if (useLocalFallback) return localFallbackResponse();
      throw error;
    }

    if (!upstream.ok) {
      if (useLocalFallback) return localFallbackResponse();
      return NextResponse.json(
        { error: upstream.error || "Failed to load Aiyra config from upstream" },
        { status: upstream.status || 502 }
      );
    }

    return NextResponse.json(
      buildMergedResponse({
        localRow,
        runtimeConfig: normalizeRuntimeConfigFromUpstream(upstream.payload),
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load Aiyra config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const managedMaterialQueryOrigin = resolveManagedMaterialQueryOrigin(req);
    const localRow = await loadLocalSettings(supabase, user.id);
    const bodyApiKey = asTrimmedString(body.apiKey);
    const storedApiKey = body.clearApiKey === true ? "" : await decryptStoredApiKey(localRow);
    const ttsSpeedInput = resolveTtsSpeedInput(body);
    if (ttsSpeedInput.error) {
      return NextResponse.json({ error: ttsSpeedInput.error }, { status: 400 });
    }

    if (body.autoLoadOnly === true) {
      if (!bodyApiKey) {
        return NextResponse.json(
          { error: "Aiyra API key is required for autoLoadOnly" },
          { status: 400 }
        );
      }

      const upstream = await callUpstreamConfig(
        buildUpstreamPayload(body, bodyApiKey, null, null, ttsSpeedInput),
        bodyApiKey
      );
      if (!upstream.ok) {
        return NextResponse.json(
          { error: upstream.error || "Failed to load Aiyra config from upstream" },
          { status: upstream.status || 502 }
        );
      }

      const savedLocalRow = await upsertLocalUiSettings({
        supabase,
        userId: user.id,
        body,
        apiKey: bodyApiKey,
        ttsSpeedInput,
      });

      return NextResponse.json({
        ...buildMergedResponse({
          localRow: savedLocalRow,
          runtimeConfig: normalizeRuntimeConfigFromUpstream(upstream.payload),
        }),
        autoLoadOnly: true,
      });
    }

    const shouldSaveRuntimeUpstream = hasRuntimeFieldInput(body);
    if (!shouldSaveRuntimeUpstream) {
      const savedLocalRow = await upsertLocalUiSettings({
        supabase,
        userId: user.id,
        body,
        apiKey: bodyApiKey || undefined,
        ttsSpeedInput,
      });
      const apiKey = bodyApiKey || storedApiKey;
      if (!apiKey) {
        return NextResponse.json(
          buildMergedResponse({
            localRow: savedLocalRow,
            runtimeConfig: emptyRuntimeConfig(toLocalUiState(savedLocalRow).configured),
          })
        );
      }

      const upstream = await callUpstreamConfig(
        {
          apiKey,
          autoLoadOnly: true,
          enabled: toLocalUiState(savedLocalRow).enabled,
        },
        apiKey
      );
      if (!upstream.ok) {
        return NextResponse.json(
          { error: upstream.error || "Failed to load Aiyra config from upstream" },
          { status: upstream.status || 502 }
        );
      }

      return NextResponse.json(
        buildMergedResponse({
          localRow: savedLocalRow,
          runtimeConfig: normalizeRuntimeConfigFromUpstream(upstream.payload),
        })
      );
    }

    const apiKey = bodyApiKey || storedApiKey;
    if (!apiKey) {
      return NextResponse.json({ error: "Missing Aiyra API key" }, { status: 400 });
    }

    let fallbackConversationId: string | null = null;
    if (
      managedMaterialQueryOrigin &&
      !("conversationId" in body)
    ) {
      const currentRuntime = await callUpstreamConfig(
        {
          apiKey,
          autoLoadOnly: true,
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        },
        apiKey
      );
      if (currentRuntime.ok) {
        fallbackConversationId =
          normalizeRuntimeConfigFromUpstream(currentRuntime.payload).conversationId;
      }
    }
    if (!fallbackConversationId && !("conversationId" in body)) {
      fallbackConversationId = await getOrCreateConfigConversationId({
        supabase,
        userId: user.id,
        channelMode: normalizeChannelMode(body.channelMode),
      });
    }

    const managedMaterialQueryEndpoint = buildManagedMaterialQueryEndpoint(
      req,
      ("conversationId" in body ? asTrimmedString(body.conversationId) : "") ||
        fallbackConversationId ||
        ""
    );

    const upstream = await callUpstreamConfig(
      buildUpstreamPayload(
        body,
        apiKey,
        managedMaterialQueryEndpoint,
        fallbackConversationId,
        ttsSpeedInput
      ),
      apiKey
    );
    if (!upstream.ok) {
      return NextResponse.json(
        { error: upstream.error || "Failed to save Aiyra config upstream" },
        { status: upstream.status || 502 }
      );
    }

    const savedLocalRow = await upsertLocalUiSettings({
      supabase,
      userId: user.id,
      body,
      apiKey: bodyApiKey || undefined,
      ttsSpeedInput,
    });

    return NextResponse.json(
      buildMergedResponse({
        localRow: savedLocalRow,
        runtimeConfig: normalizeRuntimeConfigFromUpstream(upstream.payload),
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save Aiyra config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
