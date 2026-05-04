import { createHmac, randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const MANAGED_MATERIAL_QUERY_TIMEOUT_MS = 120_000;
const MATERIAL_QUERY_TOOL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MATERIAL_QUERY_TOOL_TOKEN_MIN_REMAINING_MS = 5 * 60 * 1000;
const DEFAULT_TTS_SPEED = 1.03;
const DEFAULT_IDLE_TIMEOUT_MS = 12_000;
const MATERIAL_QUERY_IDLE_TIMEOUT_FLOOR_MS = 60_000;

type DeviceSessionBody = {
  channelMode?: "mic_main" | "twilio_main";
  forceNewConversation?: boolean;
  conversationId?: string;
  conversation_id?: string;
};

type AiyraSettingsRow = {
  api_key_enc: string | null;
  wake_word: string | null;
  wake_sensitivity: number | null;
  idle_timeout_ms: number | null;
  enabled: boolean | null;
};

type MaterialQueryToolTokenPayload = {
  conversationId: string;
  exp: number;
};

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toBooleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function toNullableInteger(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
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
  const tts = asRecord(source.tts);
  return (
    coerceTtsSpeed(source.ttsSpeed) ??
    coerceTtsSpeed(source.tts_speed) ??
    coerceTtsSpeed(tts?.speed)
  );
}

function logAiyraEvent(event: string, fields: Record<string, unknown>) {
  try {
    console.info(
      JSON.stringify({
        event,
        ts: new Date().toISOString(),
        ...fields,
      })
    );
  } catch {
    // ignore logging failures
  }
}

function normalizeBaseUrl(input: string): string {
  const value = trimmed(input);
  if (!value) return "https://omnirion.ai";
  return value.replace(/\/+$/, "");
}

function normalizeOrigin(input: string): string {
  return trimmed(input).replace(/\/+$/, "");
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function getMaterialQueryAuthSecret(): string {
  const secret =
    trimmed(process.env.AIYRA_MATERIAL_QUERY_POLL_SECRET) ||
    trimmed(process.env.RELAY_JWT_SECRET) ||
    trimmed(process.env.AIYRA_MATERIAL_QUERY_BEARER) ||
    trimmed(process.env.AIYRA_MATERIAL_QUERY_AUTH_BEARER);
  if (!secret) {
    throw new Error("Missing material-query auth secret");
  }
  return secret;
}

function resolveManagedMaterialQueryOrigin(req: Request): string | null {
  const envOrigin = normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL || "");
  if (envOrigin) return envOrigin;

  const headerOrigin = normalizeOrigin(req.headers.get("origin") || "");
  if (headerOrigin) return headerOrigin;

  try {
    return normalizeOrigin(new URL(req.url).origin);
  } catch {
    return null;
  }
}

function buildManagedMaterialQueryEndpoint(
  req: Request,
  conversationId: string
): string | null {
  const origin = resolveManagedMaterialQueryOrigin(req);
  const normalizedConversationId = trimmed(conversationId);
  if (!origin || !normalizedConversationId) return null;
  const payload = {
    conversationId: normalizedConversationId,
    exp: Date.now() + MATERIAL_QUERY_TOOL_TOKEN_TTL_MS,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", getMaterialQueryAuthSecret())
    .update(encodedPayload)
    .digest("base64url");
  const token = `${encodedPayload}.${signature}`;
  return `${origin}/api/aiyra/material-query?token=${encodeURIComponent(token)}`;
}

function verifyMaterialQueryToolToken(
  token: string
): MaterialQueryToolTokenPayload | null {
  const [encodedPayload, encodedSignature] = token.split(".");
  if (!encodedPayload || !encodedSignature) return null;
  const expectedSignature = createHmac("sha256", getMaterialQueryAuthSecret())
    .update(encodedPayload)
    .digest("base64url");
  if (expectedSignature !== encodedSignature) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    const conversationId = trimmed(payload.conversationId);
    const exp = Number(payload.exp);
    if (!conversationId || !Number.isFinite(exp) || Date.now() >= exp) {
      return null;
    }
    return {
      conversationId,
      exp: Math.trunc(exp),
    };
  } catch {
    return null;
  }
}

function summarizeMaterialQueryEndpointForLog(
  endpoint: string | null | undefined
): string | null {
  const raw = trimmed(endpoint);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split("?")[0] || null;
  }
}

function hasUsableManagedMaterialQueryEndpoint(args: {
  endpoint: string | null | undefined;
  expectedEndpoint: string | null | undefined;
  conversationId: string;
  minRemainingMs?: number;
}): boolean {
  const rawEndpoint = trimmed(args.endpoint);
  const expectedSummary = summarizeMaterialQueryEndpointForLog(args.expectedEndpoint);
  if (!rawEndpoint || !expectedSummary) return false;
  if (summarizeMaterialQueryEndpointForLog(rawEndpoint) !== expectedSummary) {
    return false;
  }
  try {
    const token = trimmed(new URL(rawEndpoint).searchParams.get("token"));
    const payload = token ? verifyMaterialQueryToolToken(token) : null;
    if (!payload || payload.conversationId !== args.conversationId) {
      return false;
    }
    const minRemainingMs =
      args.minRemainingMs ?? MATERIAL_QUERY_TOOL_TOKEN_MIN_REMAINING_MS;
    return payload.exp - Date.now() >= minRemainingMs;
  } catch {
    return false;
  }
}

function buildAudioWsUrl(baseUrl: string, conversationId: string, wsTicket: string): string {
  const base = new URL(baseUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/ws/audio";
  base.searchParams.set("conversationId", conversationId);
  base.searchParams.set("wsTicket", wsTicket);
  return base.toString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeAutoConfigResponse(value: unknown) {
  const root = asRecord(value) || {};
  const config = asRecord(root.config) || root;
  const aiyra = asRecord(root.aiyra) || {};
  const aiyraConfig = asRecord(root.aiyraConfig) || {};
  const metadata = asRecord(root.metadata) || {};
  const metadataAiyra = asRecord(metadata.aiyra) || {};
  const tools =
    asRecord(config.tools) ||
    asRecord(root.tools) ||
    asRecord(aiyra.tools) ||
    asRecord(aiyraConfig.tools) ||
    asRecord(metadataAiyra.tools) ||
    {};
  const twilio = asRecord(tools.twilio) || {};
  const materialQuery = asRecord(tools.materialQuery) || {};
  const exposedTools = Array.isArray(config.exposedTools)
    ? config.exposedTools
    : Array.isArray(root.exposedTools)
      ? root.exposedTools
      : Array.isArray(aiyra.exposedTools)
        ? aiyra.exposedTools
        : Array.isArray(aiyraConfig.exposedTools)
          ? aiyraConfig.exposedTools
          : Array.isArray(metadataAiyra.exposedTools)
            ? metadataAiyra.exposedTools
            : [];
  const ttsSpeed =
    readTtsSpeedValue(config) ??
    readTtsSpeedValue(aiyra) ??
    readTtsSpeedValue(aiyraConfig) ??
    readTtsSpeedValue(metadataAiyra) ??
    readTtsSpeedValue(root);
  return {
    conversationId:
      trimmed(config.conversationId) ||
      trimmed(root.conversationId),
    channelMode:
      trimmed(config.channelMode) ||
      trimmed(root.channelMode),
    personaPrompt:
      trimmed(config.personaPrompt) ||
      trimmed(root.personaPrompt),
    voiceId:
      trimmed(config.voiceId) ||
      trimmed(root.voiceId),
    startupGreetingEnabled:
      toBooleanOrNull(config.startupGreetingEnabled) ??
      toBooleanOrNull(config.startup_greeting_enabled) ??
      toBooleanOrNull(aiyra.startupGreetingEnabled) ??
      toBooleanOrNull(aiyra.startup_greeting_enabled) ??
      toBooleanOrNull(aiyraConfig.startupGreetingEnabled) ??
      toBooleanOrNull(aiyraConfig.startup_greeting_enabled) ??
      toBooleanOrNull(metadataAiyra.startupGreetingEnabled) ??
      toBooleanOrNull(metadataAiyra.startup_greeting_enabled) ??
      false,
    ttsSpeed,
    materialQueryEndpoint:
      trimmed(materialQuery.endpoint),
    materialQueryToolEnabled:
      materialQuery.toolEnabled === true,
    materialQueryTimeoutMs:
      toNullableInteger(materialQuery.timeoutMs),
    twilioEnabled: twilio.enabled === true,
    twilioFrom: trimmed(twilio.from),
    twilioTo: trimmed(twilio.to),
    exposedTools: exposedTools
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

async function fetchAutoConfig(args: {
  baseUrl: string;
  apiKey: string;
  conversationId: string;
}) {
  const res = await fetch(`${args.baseUrl}/api/session/config/auto`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.apiKey}`,
      "x-aiyra-api-key": args.apiKey,
    },
    body: JSON.stringify({
      conversationId: args.conversationId,
    }),
  });
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return {
    ok: res.ok,
    status: res.status,
    text,
    json,
  };
}

async function patchUpstreamMaterialQueryConfig(args: {
  baseUrl: string;
  apiKey: string;
  conversationId: string;
  endpoint: string;
  timeoutMs: number;
  startupGreetingEnabled: boolean;
  twilioEnabled?: boolean;
  twilioFrom?: string | null;
  twilioTo?: string | null;
  exposedTools?: string[];
}) {
  const res = await fetch(`${args.baseUrl}/api/aiyra/config`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.apiKey}`,
      "x-aiyra-api-key": args.apiKey,
    },
    body: JSON.stringify({
      apiKey: args.apiKey,
      conversationId: args.conversationId,
      startupGreetingEnabled: args.startupGreetingEnabled,
      exposedTools: Array.isArray(args.exposedTools) ? args.exposedTools : undefined,
      tools: {
        twilio: {
          enabled: args.twilioEnabled === true,
          from: trimmed(args.twilioFrom),
          to: trimmed(args.twilioTo),
        },
        materialQuery: {
          toolEnabled: true,
          endpoint: args.endpoint,
          timeoutMs: args.timeoutMs,
        },
      },
    }),
  });
  const text = await res.text().catch(() => "");
  return {
    ok: res.ok,
    status: res.status,
    text,
  };
}

async function getOrCreateConversationBinding(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  deviceId: string;
  channelMode: "mic_main" | "twilio_main";
  forceNewConversation?: boolean;
  preferredConversationId?: string;
}) {
  const {
    supabase,
    userId,
    deviceId,
    channelMode,
    forceNewConversation,
    preferredConversationId,
  } = args;
  const nowIso = new Date().toISOString();
  const preferredId = trimmed(preferredConversationId);
  logAiyraEvent("aiyra.device_session.binding_lookup", {
    user_id: userId,
    device_id: deviceId,
    channel_mode: channelMode,
    preferred_conversation_id: preferredId || null,
    force_new_conversation: forceNewConversation === true,
  });

  if (!forceNewConversation) {
    if (preferredId) {
      const { data: preferredRows, error: preferredErr } = await supabase
        .from("aiyra_conversations")
        .select("conversation_id, orchestrator_session_id")
        .eq("user_id", userId)
        .eq("conversation_id", preferredId)
        .eq("channel_mode", channelMode)
        .limit(1);
      if (preferredErr) throw new Error(preferredErr.message);
      const preferred = Array.isArray(preferredRows) ? preferredRows[0] : null;
      const conversationId = trimmed(preferred?.conversation_id);
      const orchestratorSessionId = trimmed(preferred?.orchestrator_session_id);
      if (conversationId && orchestratorSessionId) {
        await supabase
          .from("aiyra_conversations")
          .update({ updated_at: nowIso, device_id: deviceId })
          .eq("user_id", userId)
          .eq("conversation_id", conversationId);
        logAiyraEvent("aiyra.device_session.binding_reused", {
          user_id: userId,
          device_id: deviceId,
          channel_mode: channelMode,
          binding_mode: "preferred",
          conversation_id: conversationId,
          orchestrator_session_id: orchestratorSessionId,
        });
        return { conversationId, orchestratorSessionId, bindingMode: "preferred" as const };
      }
      logAiyraEvent("aiyra.device_session.binding_preferred_miss", {
        user_id: userId,
        device_id: deviceId,
        channel_mode: channelMode,
        preferred_conversation_id: preferredId,
      });
    }

    const { data: existingRows, error: existingErr } = await supabase
      .from("aiyra_conversations")
      .select("conversation_id, orchestrator_session_id")
      .eq("user_id", userId)
      .eq("device_id", deviceId)
      .eq("channel_mode", channelMode)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (existingErr) throw new Error(existingErr.message);
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;
    const conversationId = trimmed(existing?.conversation_id);
    const orchestratorSessionId = trimmed(existing?.orchestrator_session_id);
    if (conversationId && orchestratorSessionId) {
      await supabase
        .from("aiyra_conversations")
        .update({ updated_at: nowIso, device_id: deviceId })
        .eq("user_id", userId)
        .eq("conversation_id", conversationId);
      logAiyraEvent("aiyra.device_session.binding_reused", {
        user_id: userId,
        device_id: deviceId,
        channel_mode: channelMode,
        binding_mode: "device",
        conversation_id: conversationId,
        orchestrator_session_id: orchestratorSessionId,
      });
      return { conversationId, orchestratorSessionId, bindingMode: "device" as const };
    }

    // Device ids can rotate on re-pair/reinstall. If there's exactly one active
    // mic_main conversation for this user, keep reusing it rather than creating
    // a new thread on every wake.
    const { data: fallbackRows, error: fallbackErr } = await supabase
      .from("aiyra_conversations")
      .select("conversation_id, orchestrator_session_id")
      .eq("user_id", userId)
      .eq("channel_mode", channelMode)
      .order("updated_at", { ascending: false })
      .limit(2);
    if (fallbackErr) throw new Error(fallbackErr.message);
    const fallback = Array.isArray(fallbackRows) && fallbackRows.length === 1
      ? fallbackRows[0]
      : null;
    logAiyraEvent("aiyra.device_session.binding_fallback_candidates", {
      user_id: userId,
      device_id: deviceId,
      channel_mode: channelMode,
      fallback_candidate_count: Array.isArray(fallbackRows) ? fallbackRows.length : 0,
    });
    const fallbackConversationId = trimmed(fallback?.conversation_id);
    const fallbackOrchestratorSessionId = trimmed(fallback?.orchestrator_session_id);
    if (fallbackConversationId && fallbackOrchestratorSessionId) {
      await supabase
        .from("aiyra_conversations")
        .update({ updated_at: nowIso, device_id: deviceId })
        .eq("user_id", userId)
        .eq("conversation_id", fallbackConversationId);
      return {
        conversationId: fallbackConversationId,
        orchestratorSessionId: fallbackOrchestratorSessionId,
        bindingMode: "fallback_single" as const,
      };
    }
  }

  const { data: sessionRow, error: sessionErr } = await supabase
    .from("orchestrator_sessions")
    .insert({
      user_id: userId,
      title: "Aiyra Voice",
    })
    .select("id")
    .single();

  if (sessionErr || !sessionRow?.id) {
    throw new Error(sessionErr?.message || "Failed to create orchestrator session");
  }

  const conversationId = `aiyra-${randomUUID()}`;
  const orchestratorSessionId = String(sessionRow.id);

  const { error: bindErr } = await supabase.from("aiyra_conversations").insert({
    conversation_id: conversationId,
    user_id: userId,
    orchestrator_session_id: orchestratorSessionId,
    device_id: deviceId,
    channel_mode: channelMode,
    updated_at: nowIso,
  });
  if (bindErr) throw new Error(bindErr.message);
  logAiyraEvent("aiyra.device_session.binding_created", {
    user_id: userId,
    device_id: deviceId,
    channel_mode: channelMode,
    binding_mode: "new",
    conversation_id: conversationId,
    orchestrator_session_id: orchestratorSessionId,
  });

  return { conversationId, orchestratorSessionId, bindingMode: "new" as const };
}

export async function POST(req: Request) {
  const requestStartedAtMs = Date.now();
  try {
    const relaySecret = trimmed(process.env.RELAY_JWT_SECRET);
    if (!relaySecret) {
      return NextResponse.json({ error: "Missing RELAY_JWT_SECRET" }, { status: 500 });
    }

    const token = req.headers.get("x-device-token") || req.headers.get("X-Device-Token") || "";
    const verified = verifyRelayDeviceToken(token, relaySecret);
    if (!verified?.userId || !verified?.deviceId) {
      logAiyraEvent("aiyra.device_session.unauthorized", {});
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as DeviceSessionBody;
    const channelMode = body?.channelMode === "twilio_main" ? "twilio_main" : "mic_main";
    const requestedConversationId =
      trimmed(body?.conversationId) || trimmed(body?.conversation_id);
    logAiyraEvent("aiyra.device_session.request", {
      user_id: verified.userId,
      device_id: verified.deviceId,
      channel_mode: channelMode,
      requested_conversation_id: requestedConversationId || null,
      force_new_conversation: body?.forceNewConversation === true,
    });

    const supabase = createSupabaseAdminClient();
    const { data: settings, error: settingsErr } = await supabase
      .from("user_aiyra_settings")
      .select("api_key_enc, wake_word, wake_sensitivity, idle_timeout_ms, enabled")
      .eq("user_id", verified.userId)
      .maybeSingle();

    if (settingsErr) {
      return NextResponse.json({ error: settingsErr.message }, { status: 500 });
    }
    const row = (settings || null) as AiyraSettingsRow | null;
    if (!row) {
      logAiyraEvent("aiyra.device_session.missing_settings", {
        user_id: verified.userId,
        device_id: verified.deviceId,
      });
      return NextResponse.json({ error: "Aiyra is not configured for this user" }, { status: 400 });
    }
    if (row.enabled !== true) {
      logAiyraEvent("aiyra.device_session.disabled", {
        user_id: verified.userId,
        device_id: verified.deviceId,
      });
      return NextResponse.json({ error: "Aiyra voice is disabled in settings" }, { status: 400 });
    }

    const apiKeyEnc = trimmed(row.api_key_enc);
    if (!apiKeyEnc) {
      return NextResponse.json({ error: "Missing Aiyra API key" }, { status: 400 });
    }

    let aiyraApiKey = "";
    try {
      aiyraApiKey = decryptLlmApiKey(apiKeyEnc);
    } catch {
      return NextResponse.json({ error: "Failed to decrypt Aiyra API key" }, { status: 500 });
    }
    if (!aiyraApiKey) {
      return NextResponse.json({ error: "Aiyra API key is empty" }, { status: 400 });
    }

    const { conversationId, orchestratorSessionId, bindingMode } =
      await getOrCreateConversationBinding({
      supabase,
      userId: verified.userId,
      deviceId: verified.deviceId,
      channelMode,
      forceNewConversation: body?.forceNewConversation === true,
      preferredConversationId: body?.conversationId || body?.conversation_id,
    });

    const aiyraBaseUrl = normalizeBaseUrl(
      process.env.AIYRA_BASE_URL || process.env.OPENCLAW_BASE_URL || ""
    );
    const managedMaterialQueryEndpoint = buildManagedMaterialQueryEndpoint(
      req,
      conversationId
    );
    const configStartedAtMs = Date.now();
    const initialAutoConfig = await fetchAutoConfig({
      baseUrl: aiyraBaseUrl,
      apiKey: aiyraApiKey,
      conversationId,
    });
    if (!initialAutoConfig.ok) {
      logAiyraEvent("aiyra.device_session.config_failed", {
        user_id: verified.userId,
        device_id: verified.deviceId,
        status: initialAutoConfig.status,
        latency_ms: Date.now() - configStartedAtMs,
      });
      return NextResponse.json(
        {
          error: "Failed to auto-configure Aiyra session",
          details: initialAutoConfig.text.slice(0, 800),
          status: initialAutoConfig.status,
        },
        { status: 502 }
      );
    }
    let resolvedConfig = normalizeAutoConfigResponse(initialAutoConfig.json);
    const managedMaterialQueryEndpointUsable = hasUsableManagedMaterialQueryEndpoint({
      endpoint: resolvedConfig.materialQueryEndpoint,
      expectedEndpoint: managedMaterialQueryEndpoint,
      conversationId,
    });
    if (
      managedMaterialQueryEndpoint &&
      (resolvedConfig.materialQueryToolEnabled !== true ||
        !managedMaterialQueryEndpointUsable ||
        resolvedConfig.materialQueryTimeoutMs !== MANAGED_MATERIAL_QUERY_TIMEOUT_MS ||
        resolvedConfig.startupGreetingEnabled !== false)
    ) {
      const repairStartedAtMs = Date.now();
      logAiyraEvent("aiyra.device_session.material_query_repair_started", {
        user_id: verified.userId,
        device_id: verified.deviceId,
        conversation_id: conversationId,
        previous_material_query_enabled: resolvedConfig.materialQueryToolEnabled,
        previous_material_query_endpoint: summarizeMaterialQueryEndpointForLog(
          resolvedConfig.materialQueryEndpoint
        ),
        previous_material_query_endpoint_signed:
          trimmed(resolvedConfig.materialQueryEndpoint).includes("token=") || undefined,
        previous_material_query_timeout_ms: resolvedConfig.materialQueryTimeoutMs,
        previous_startup_greeting_enabled: resolvedConfig.startupGreetingEnabled,
        desired_material_query_endpoint: summarizeMaterialQueryEndpointForLog(
          managedMaterialQueryEndpoint
        ),
        desired_material_query_endpoint_signed:
          trimmed(managedMaterialQueryEndpoint).includes("token=") || undefined,
        desired_material_query_timeout_ms: MANAGED_MATERIAL_QUERY_TIMEOUT_MS,
        desired_startup_greeting_enabled: false,
      });
      try {
        const repair = await patchUpstreamMaterialQueryConfig({
          baseUrl: aiyraBaseUrl,
          apiKey: aiyraApiKey,
          conversationId,
          endpoint: managedMaterialQueryEndpoint,
          timeoutMs: MANAGED_MATERIAL_QUERY_TIMEOUT_MS,
          startupGreetingEnabled: false,
          twilioEnabled: resolvedConfig.twilioEnabled,
          twilioFrom: resolvedConfig.twilioFrom,
          twilioTo: resolvedConfig.twilioTo,
          exposedTools: resolvedConfig.exposedTools,
        });
        if (!repair.ok) {
          logAiyraEvent("aiyra.device_session.material_query_repair_failed", {
            user_id: verified.userId,
            device_id: verified.deviceId,
            conversation_id: conversationId,
            status: repair.status,
            detail: repair.text.slice(0, 300),
            latency_ms: Date.now() - repairStartedAtMs,
          });
        } else {
          const repairedAutoConfig = await fetchAutoConfig({
            baseUrl: aiyraBaseUrl,
            apiKey: aiyraApiKey,
            conversationId,
          });
          if (repairedAutoConfig.ok) {
            resolvedConfig = normalizeAutoConfigResponse(repairedAutoConfig.json);
            logAiyraEvent("aiyra.device_session.material_query_repaired", {
              user_id: verified.userId,
              device_id: verified.deviceId,
              conversation_id: conversationId,
              material_query_enabled: resolvedConfig.materialQueryToolEnabled,
              material_query_endpoint: summarizeMaterialQueryEndpointForLog(
                resolvedConfig.materialQueryEndpoint
              ),
              material_query_endpoint_signed:
                trimmed(resolvedConfig.materialQueryEndpoint).includes("token=") || undefined,
              material_query_timeout_ms: resolvedConfig.materialQueryTimeoutMs,
              startup_greeting_enabled: resolvedConfig.startupGreetingEnabled,
              tts_speed: resolvedConfig.ttsSpeed ?? DEFAULT_TTS_SPEED,
              latency_ms: Date.now() - repairStartedAtMs,
            });
          } else {
            logAiyraEvent("aiyra.device_session.material_query_repair_reload_failed", {
              user_id: verified.userId,
              device_id: verified.deviceId,
              conversation_id: conversationId,
              status: repairedAutoConfig.status,
              detail: repairedAutoConfig.text.slice(0, 300),
              latency_ms: Date.now() - repairStartedAtMs,
            });
          }
        }
      } catch (error) {
        logAiyraEvent("aiyra.device_session.material_query_repair_failed", {
          user_id: verified.userId,
          device_id: verified.deviceId,
          conversation_id: conversationId,
          detail: error instanceof Error ? error.message : String(error),
          latency_ms: Date.now() - repairStartedAtMs,
        });
      }
    }
    const resolvedMaterialQueryTimeoutMs = resolvedConfig.materialQueryToolEnabled
      ? Number.isFinite(Number(resolvedConfig.materialQueryTimeoutMs)) &&
        Number(resolvedConfig.materialQueryTimeoutMs) > 0
        ? Math.trunc(Number(resolvedConfig.materialQueryTimeoutMs))
        : MANAGED_MATERIAL_QUERY_TIMEOUT_MS
      : null;

    const configuredIdleTimeoutMs =
      Number.isFinite(Number(row.idle_timeout_ms)) &&
      Number(row.idle_timeout_ms) >= 2000
        ? Math.trunc(Number(row.idle_timeout_ms))
        : DEFAULT_IDLE_TIMEOUT_MS;
    const shouldExtendIdleTimeoutForMaterialQuery =
      channelMode === "twilio_main" && resolvedConfig.materialQueryToolEnabled;
    const resolvedIdleTimeoutMs = shouldExtendIdleTimeoutForMaterialQuery
      ? Math.max(
          configuredIdleTimeoutMs,
          MATERIAL_QUERY_IDLE_TIMEOUT_FLOOR_MS,
          resolvedMaterialQueryTimeoutMs || 0
        )
      : configuredIdleTimeoutMs;

    logAiyraEvent("aiyra.device_session.config_resolved", {
      user_id: verified.userId,
      device_id: verified.deviceId,
      conversation_id: conversationId,
      orchestrator_session_id: orchestratorSessionId,
      binding_mode: bindingMode,
      requested_conversation_id: requestedConversationId || null,
      resolved_conversation_id: resolvedConfig.conversationId || null,
      resolved_channel_mode: resolvedConfig.channelMode || null,
      material_query_enabled: resolvedConfig.materialQueryToolEnabled,
      material_query_endpoint: summarizeMaterialQueryEndpointForLog(
        resolvedConfig.materialQueryEndpoint
      ),
      material_query_endpoint_signed:
        trimmed(resolvedConfig.materialQueryEndpoint).includes("token=") || undefined,
      material_query_timeout_ms: resolvedMaterialQueryTimeoutMs,
      startup_greeting_enabled: resolvedConfig.startupGreetingEnabled,
      tts_speed: resolvedConfig.ttsSpeed ?? DEFAULT_TTS_SPEED,
      idle_timeout_ms: resolvedIdleTimeoutMs,
      config_latency_ms: Date.now() - configStartedAtMs,
    });

    const ticketStartedAtMs = Date.now();
    const wsTicketRes = await fetch(`${aiyraBaseUrl}/api/auth/ws-ticket`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aiyraApiKey}`,
        "x-aiyra-api-key": aiyraApiKey,
      },
      body: JSON.stringify({
        conversationId,
        ttlSeconds: 180,
        uses: 4,
      }),
    });
    if (!wsTicketRes.ok) {
      const text = await wsTicketRes.text().catch(() => "");
      logAiyraEvent("aiyra.device_session.ticket_failed", {
        user_id: verified.userId,
        device_id: verified.deviceId,
        status: wsTicketRes.status,
        latency_ms: Date.now() - ticketStartedAtMs,
      });
      return NextResponse.json(
        {
          error: "Failed to mint Aiyra websocket ticket",
          details: text.slice(0, 800),
          status: wsTicketRes.status,
        },
        { status: 502 }
      );
    }

    const wsTicketJson = (await wsTicketRes.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const wsTicket =
      trimmed(wsTicketJson.wsTicket) ||
      trimmed(wsTicketJson.ws_ticket) ||
      trimmed(wsTicketJson.ticket);
    const wsExpiresAt =
      trimmed(wsTicketJson.expiresAt) ||
      trimmed(wsTicketJson.expires_at) ||
      trimmed(wsTicketJson.expireAt);
    if (!wsTicket) {
      return NextResponse.json(
        { error: "Aiyra ws-ticket response missing ticket" },
        { status: 502 }
      );
    }

    const wsUrl = buildAudioWsUrl(aiyraBaseUrl, conversationId, wsTicket);
    logAiyraEvent("aiyra.device_session.ok", {
      user_id: verified.userId,
      device_id: verified.deviceId,
      conversation_id: conversationId,
      orchestrator_session_id: orchestratorSessionId,
      channel_mode: resolvedConfig.channelMode || channelMode,
      binding_mode: bindingMode,
      requested_conversation_id: requestedConversationId || null,
      resolved_conversation_id: resolvedConfig.conversationId || null,
      material_query_enabled: resolvedConfig.materialQueryToolEnabled,
      material_query_endpoint: summarizeMaterialQueryEndpointForLog(
        resolvedConfig.materialQueryEndpoint
      ),
      material_query_endpoint_signed:
        trimmed(resolvedConfig.materialQueryEndpoint).includes("token=") || undefined,
      material_query_timeout_ms: resolvedMaterialQueryTimeoutMs,
      startup_greeting_enabled: resolvedConfig.startupGreetingEnabled,
      tts_speed: resolvedConfig.ttsSpeed ?? DEFAULT_TTS_SPEED,
      idle_timeout_ms: resolvedIdleTimeoutMs,
      config_latency_ms: Date.now() - configStartedAtMs,
      ticket_latency_ms: Date.now() - ticketStartedAtMs,
      total_latency_ms: Date.now() - requestStartedAtMs,
    });

    return NextResponse.json({
      ok: true,
      conversationId,
      orchestratorSessionId,
      bindingMode,
      channelMode: resolvedConfig.channelMode || null,
      wsTicket,
      wsUrl,
      expiresAt: wsExpiresAt || null,
      wakeWord: trimmed(row.wake_word) || "hey groovy",
      wakeSensitivity:
        Number.isFinite(Number(row.wake_sensitivity)) &&
        Number(row.wake_sensitivity) >= 0 &&
        Number(row.wake_sensitivity) <= 1
          ? Number(row.wake_sensitivity)
          : 0.5,
      idleTimeoutMs: resolvedIdleTimeoutMs,
      materialQueryEnabled: resolvedConfig.materialQueryToolEnabled,
      materialQueryTimeoutMs: resolvedMaterialQueryTimeoutMs,
      ttsSpeed: resolvedConfig.ttsSpeed ?? DEFAULT_TTS_SPEED,
      startupGreetingEnabled: resolvedConfig.startupGreetingEnabled,
      voiceId: resolvedConfig.voiceId,
      personaPrompt: resolvedConfig.personaPrompt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    logAiyraEvent("aiyra.device_session.error", {
      error: message,
      total_latency_ms: Date.now() - requestStartedAtMs,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
