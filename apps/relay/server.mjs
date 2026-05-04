import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import crypto from "crypto";

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_SUPABASE_SERVICE_ROLE_KEY;
const RELAY_JWT_SECRET = process.env.RELAY_JWT_SECRET;

if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_ANON_KEY) throw new Error("Missing SUPABASE_ANON_KEY");
if (!SUPABASE_SERVICE_ROLE_KEY)
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
if (!RELAY_JWT_SECRET) throw new Error("Missing RELAY_JWT_SECRET");

const RELAY_ENC_KEY = process.env.RELAY_ENC_KEY || "";
const INTERNAL_AUTH_MAX_AGE_MS = 60_000;
const INTERNAL_USER_ID_HEADER = "x-groovy-internal-user-id";
const INTERNAL_AUTH_HEADER = "x-groovy-internal-auth";
const RELAY_CONNECTOR_RPC_SCOPE = "relay_connector_rpc";
const RELAY_AIYRA_RUNTIME_SCOPE = "relay_aiyra_runtime";

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function signInternalScope(scope, userId, ts) {
  return createHmac("sha256", RELAY_JWT_SECRET)
    .update(`${scope}:${userId}:${ts}`)
    .digest("base64url");
}

function verifyInternalRouteAuthHeaders(headers, scope) {
  const userId = trimmed(headers?.[INTERNAL_USER_ID_HEADER]);
  const rawAuth = trimmed(headers?.[INTERNAL_AUTH_HEADER]);
  const normalizedScope = trimmed(scope);
  if (!userId || !rawAuth || !normalizedScope) return null;
  const [ts, providedSig] = rawAuth.split(".");
  if (!ts || !providedSig) return null;
  const tsMs = Number(ts);
  if (!Number.isFinite(tsMs)) return null;
  if (Math.abs(Date.now() - tsMs) > INTERNAL_AUTH_MAX_AGE_MS) return null;
  const expectedSig = signInternalScope(normalizedScope, userId, ts);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return { userId };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 1_000_000) {
        reject(new Error("body_too_large"));
        try {
          req.destroy();
        } catch {}
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function base64urlEncode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b
    .toString("base64")
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function getAesKey() {
  if (!RELAY_ENC_KEY) return null;
  // Accept base64 or hex; otherwise treat as utf8 and hash to 32 bytes.
  try {
    const b64 = Buffer.from(RELAY_ENC_KEY, "base64");
    if (b64.length === 32) return b64;
  } catch {}
  try {
    const hex = Buffer.from(RELAY_ENC_KEY, "hex");
    if (hex.length === 32) return hex;
  } catch {}
  // fallback derivation
  return crypto.createHash("sha256").update(RELAY_ENC_KEY, "utf8").digest();
}

const AES_KEY = getAesKey();

function encryptPath(plain) {
  if (!AES_KEY) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", AES_KEY, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptPath({ enc, iv, tag }) {
  if (!AES_KEY) return null;
  try {
    const cipher = crypto.createDecipheriv(
      "aes-256-gcm",
      AES_KEY,
      Buffer.from(iv, "base64")
    );
    cipher.setAuthTag(Buffer.from(tag, "base64"));
    const dec = Buffer.concat([
      cipher.update(Buffer.from(enc, "base64")),
      cipher.final(),
    ]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

function base64urlDecode(str) {
  const pad = 4 - (str.length % 4 || 4);
  const b64 = str
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .concat("=".repeat(pad));
  return Buffer.from(b64, "base64");
}

function hmacSha256(secret, data) {
  return createHmac("sha256", secret).update(data).digest();
}

function signDeviceToken({ deviceId, userId }, ttlSeconds = 60 * 60 * 24 * 30) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: deviceId,
    user_id: userId,
    iat: now,
    exp: now + ttlSeconds,
  };
  const headerPart = base64urlEncode(JSON.stringify(header));
  const payloadPart = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${headerPart}.${payloadPart}`;
  const sig = base64urlEncode(hmacSha256(RELAY_JWT_SECRET, signingInput));
  return `${signingInput}.${sig}`;
}

function verifyDeviceToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts;
  const signingInput = `${headerPart}.${payloadPart}`;
  const expectedSig = base64urlEncode(hmacSha256(RELAY_JWT_SECRET, signingInput));
  const a = Buffer.from(sigPart);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(base64urlDecode(payloadPart).toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  if (payload?.exp && Number(payload.exp) < now) return null;
  if (!payload?.sub || !payload?.user_id) return null;
  return { deviceId: String(payload.sub), userId: String(payload.user_id) };
}

async function supabaseAuthGetUser(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) return null;
  return await res.json();
}

async function supabaseService(path, init = {}) {
  const url = `${SUPABASE_URL}${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  return res;
}

const CONNECTOR_EVENTS_RETENTION_MS = 30 * 24 * 60 * 60_000; // 30 days
const CONNECTOR_EVENTS_PRUNE_INTERVAL_MS = 6 * 60 * 60_000; // every 6 hours max
let lastConnectorEventsPruneAtMs = 0;

async function pruneOldConnectorEvents() {
  try {
    const cutoff = new Date(Date.now() - CONNECTOR_EVENTS_RETENTION_MS).toISOString();
    await supabaseService(`/rest/v1/connector_events?created_at=lt.${cutoff}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  } catch {
    // best-effort
  }
}

function truncateText(value, max = 4000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function deriveConnectorErrorCode(rawError, fallback = "unknown_error") {
  const text = String(rawError || "").toLowerCase();
  if (!text) return fallback;
  if (text.includes("invalid_device_token")) return "invalid_device_token";
  if (text.includes("device_token_user_mismatch")) return "device_token_user_mismatch";
  if (text.includes("missing_pairing_code_or_token")) return "missing_pairing_code_or_token";
  if (text.includes("invalid pairing code")) return "invalid_pairing_code";
  if (text.includes("already used")) return "pairing_code_already_used";
  if (text.includes("expired")) return "pairing_code_expired";
  if (text.includes("failed to look up device")) return "lookup_device_failed";
  if (text.includes("failed to look up pairing code")) return "lookup_pairing_code_failed";
  if (text.includes("failed to create device")) return "create_device_failed";
  if (text.includes("failed to mark pairing code consumed")) return "consume_pairing_code_failed";
  return fallback;
}

function normalizeConnectorEventType(eventType) {
  const value = truncateText(eventType, 64) || "";
  if (value === "auth_failure" || value === "pairing_failure" || value === "runtime_failure") {
    return value;
  }
  return "runtime_failure";
}

async function insertConnectorEvent({
  eventType,
  errorCode,
  detail = null,
  userId = null,
  deviceId = null,
  connectorVersion = null,
  metadata = null,
}) {
  try {
    const payload = {
      event_type: normalizeConnectorEventType(eventType),
      error_code: truncateText(errorCode, 128) || "unknown_error",
      detail: truncateText(detail, 4000),
      user_id: userId || null,
      device_id: truncateText(deviceId, 128),
      connector_version: truncateText(connectorVersion, 64),
      metadata: metadata && typeof metadata === "object" ? metadata : {},
    };
    const res = await supabaseService("/rest/v1/connector_events", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        "[relay] failed to persist connector event:",
        payload.event_type,
        payload.error_code,
        truncateText(body, 500) || "unknown_error"
      );
    }

    // 30-day retention (best-effort). Throttled to avoid write amplification.
    const nowMs = Date.now();
    if (nowMs - lastConnectorEventsPruneAtMs >= CONNECTOR_EVENTS_PRUNE_INTERVAL_MS) {
      lastConnectorEventsPruneAtMs = nowMs;
      pruneOldConnectorEvents().catch(() => {});
    }
  } catch (err) {
    console.warn(
      "[relay] connector event insert error:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

function normalizeTwilioSupervisorState(raw) {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  const update =
    root?.update && typeof root.update === "object" && !Array.isArray(root.update)
      ? root.update
      : root;
  if (!update) return null;
  const readString = (...values) => {
    for (const value of values) {
      const text = trimmed(value);
      if (text) return text;
    }
    return null;
  };
  const state = {
    id: readString(update.id),
    at: readString(update.at, update.updated_at),
    childConversationId: readString(
      update.childConversationId,
      update.child_conversation_id
    ),
    childKind: readString(update.childKind, update.child_kind),
    status: readString(update.status),
    stage: readString(update.stage),
    summary: readString(update.summary),
    rawText: readString(update.rawText, update.raw_text),
    callSid: readString(update.callSid, update.call_sid),
    messageSid: readString(update.messageSid, update.message_sid),
    speakSuggested:
      typeof update.speakSuggested === "boolean"
        ? update.speakSuggested
        : typeof update.speak_suggested === "boolean"
          ? update.speak_suggested
          : null,
  };
  return Object.values(state).some((value) => value !== null) ? state : null;
}

async function persistTwilioSupervisorStateForConversation({
  userId,
  conversationId,
  orchestratorSessionId,
  supervisorState,
}) {
  if (!userId || !conversationId || !supervisorState) return;
  try {
    const patch = {
      updated_at: new Date().toISOString(),
      ...(orchestratorSessionId
        ? { orchestrator_session_id: orchestratorSessionId }
        : {}),
      twilio_last_update_id: supervisorState.id,
      twilio_last_update_at: supervisorState.at,
      twilio_child_conversation_id: supervisorState.childConversationId,
      twilio_child_kind: supervisorState.childKind,
      twilio_child_status: supervisorState.status,
      twilio_child_stage: supervisorState.stage,
      twilio_child_summary: supervisorState.summary,
      twilio_child_raw_text: supervisorState.rawText,
      twilio_call_sid: supervisorState.callSid,
      twilio_message_sid: supervisorState.messageSid,
      twilio_speak_suggested: supervisorState.speakSuggested,
      twilio_supervisor_state: supervisorState,
    };
    const res = await supabaseService(
      `/rest/v1/aiyra_conversations?user_id=eq.${encodeURIComponent(
        userId
      )}&conversation_id=eq.${encodeURIComponent(conversationId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(patch),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        "[relay] failed to persist twilio supervisor state:",
        truncateText(conversationId, 128) || "unknown_conversation",
        truncateText(body, 500) || "unknown_error"
      );
    }
  } catch (err) {
    console.warn(
      "[relay] twilio supervisor persist error:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

async function persistAiyraVoiceHealthSnapshot({ deviceId, userId, health }) {
  if (!deviceId || !userId || !health || typeof health !== "object") return;

  const toSafeNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const toOptionalNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const conversationId =
    typeof health.conversation_id === "string" ? health.conversation_id : null;
  const orchestratorSessionId =
    typeof health.orchestrator_session_id === "string"
      ? health.orchestrator_session_id
      : null;
  const twilioSupervisorState = normalizeTwilioSupervisorState(
    health.twilio_supervisor_state
  );

  try {
    const payload = {
      device_id: deviceId,
      user_id: userId,
      status: truncateText(health.status, 32) || "unknown",
      reason: truncateText(health.reason, 256),
      detail: truncateText(health.detail, 4000),
      updated_at:
        typeof health.updated_at === "string" ? health.updated_at : new Date().toISOString(),
      last_healthy_at:
        typeof health.last_healthy_at === "string" ? health.last_healthy_at : null,
      last_failure_at:
        typeof health.last_failure_at === "string" ? health.last_failure_at : null,
      listening: health.listening === true,
      active: health.active === true,
      muted: health.muted === true,
      wake_word: truncateText(health.wake_word, 160),
      wake_sensitivity: toSafeNumber(health.wake_sensitivity, 0),
      idle_timeout_ms: Math.max(0, Math.trunc(toSafeNumber(health.idle_timeout_ms, 0))),
      wake_hits: Math.max(0, Math.trunc(toSafeNumber(health.wake_hits, 0))),
      wake_suppressed: Math.max(0, Math.trunc(toSafeNumber(health.wake_suppressed, 0))),
      missed_reports: Math.max(0, Math.trunc(toSafeNumber(health.missed_reports, 0))),
      false_trigger_reports: Math.max(
        0,
        Math.trunc(toSafeNumber(health.false_trigger_reports, 0))
      ),
      session_count: Math.max(0, Math.trunc(toSafeNumber(health.session_count, 0))),
      session_error_count: Math.max(
        0,
        Math.trunc(toSafeNumber(health.session_error_count, 0))
      ),
      reconnect_attempt_count: Math.max(
        0,
        Math.trunc(toSafeNumber(health.reconnect_attempt_count, 0))
      ),
      last_session_duration_ms: Math.max(
        0,
        Math.trunc(toSafeNumber(health.last_session_duration_ms, 0))
      ),
      last_metric_event: truncateText(health.last_metric_event, 128),
      last_metric_at:
        typeof health.last_metric_at === "string" ? health.last_metric_at : null,
      low_mic_gain_detected: health.low_mic_gain_detected === true,
      low_mic_gain_at:
        typeof health.low_mic_gain_at === "string" ? health.low_mic_gain_at : null,
      low_mic_gain_message: truncateText(health.low_mic_gain_message, 4000),
      low_mic_gain_max_energy_observed: toOptionalNumber(
        health.low_mic_gain_max_energy_observed
      ),
      low_mic_gain_threshold: toOptionalNumber(health.low_mic_gain_threshold),
      configured_mic_name: truncateText(health.configured_mic_name, 255),
      resolved_device_name: truncateText(health.resolved_device_name, 255),
      mic_selection_fallback_reason: truncateText(health.mic_selection_fallback_reason, 128),
      mic_input_level:
        toOptionalNumber(health.mic_input_level) === null
          ? null
          : Math.max(0, Math.min(1, Number(toOptionalNumber(health.mic_input_level)))),
      mic_input_updated_at:
        typeof health.mic_input_updated_at === "string"
          ? health.mic_input_updated_at
          : null,
      conversation_id: truncateText(conversationId, 255),
      orchestrator_session_id: truncateText(orchestratorSessionId, 255),
      twilio_supervisor_state: twilioSupervisorState,
    };

    const res = await supabaseService(
      "/rest/v1/connector_aiyra_voice_health?on_conflict=device_id",
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(payload),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        "[relay] failed to persist aiyra voice health:",
        truncateText(deviceId, 128) || "unknown_device",
        truncateText(body, 500) || "unknown_error"
      );
    }

    await persistTwilioSupervisorStateForConversation({
      userId,
      conversationId,
      orchestratorSessionId,
      supervisorState: twilioSupervisorState,
    });
  } catch (err) {
    console.warn(
      "[relay] aiyra voice health persist error:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

function buildAiyraRuntimeKey(userId, conversationId) {
  return `${trimmed(userId)}:${trimmed(conversationId)}`;
}

function normalizeAiyraBaseUrl(input) {
  return (trimmed(input) || "https://omnirion.ai").replace(/\/+$/, "");
}

function buildAiyraRuntimeHeaders(apiKey) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "x-aiyra-api-key": apiKey,
  };
}

async function callAiyraJson({ baseUrl, apiKey, path, body }) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const response = await fetch(`${normalizeAiyraBaseUrl(baseUrl)}${normalizedPath}`, {
    method: "POST",
    headers: buildAiyraRuntimeHeaders(apiKey),
    body: JSON.stringify(body || {}),
  });
  const text = await response.text().catch(() => "");
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  return {
    ok: response.ok,
    status: response.status,
    text,
    payload: payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {},
  };
}

function buildAiyraChatWsUrl(baseUrl, conversationId, wsTicket) {
  const parsed = new URL(normalizeAiyraBaseUrl(baseUrl));
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/ws/chat";
  parsed.search = "";
  parsed.searchParams.set("conversationId", conversationId);
  parsed.searchParams.set("wsTicket", wsTicket);
  return parsed.toString();
}

function isAiyraResponseStartedEvent(msg) {
  const type = trimmed(msg?.type);
  return (
    type === "response.created" ||
    type === "response.started" ||
    type === "response.in_progress" ||
    type === "stage_registered" ||
    type === "first_chunk"
  );
}

function isAiyraResponseFinishedEvent(msg) {
  const type = trimmed(msg?.type);
  return (
    type === "response.done" ||
    type === "response.completed" ||
    type === "response.failed" ||
    type === "response.cancelled"
  );
}

function collectAiyraTextFragments(value, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectAiyraTextFragments(item, depth + 1));
  }
  if (typeof value !== "object") return [];

  const out = [];
  for (const key of ["text", "delta", "transcript", "summary", "content"]) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim()) {
      out.push(candidate.trim());
    }
  }
  for (const key of ["response", "output", "items", "messages", "content", "message"]) {
    if (key in value) {
      out.push(...collectAiyraTextFragments(value[key], depth + 1));
    }
  }
  return out;
}

function extractAiyraAssistantText(msg) {
  const type = trimmed(msg?.type);
  const directText = collectAiyraTextFragments(msg).join(" ").trim();
  if (!type) return directText || "";
  if (type.includes("text") || type.includes("transcript")) {
    return directText;
  }
  if (type === "response.done" || type === "response.completed") {
    return directText;
  }
  return "";
}

function buildRelayAiyraVoiceHealth({
  prev,
  conversationId,
  orchestratorSessionId,
  supervisorState,
}) {
  const nowIso = trimmed(supervisorState?.at) || new Date().toISOString();
  const childStatus = trimmed(supervisorState?.status).toLowerCase();
  const isTerminal =
    childStatus === "completed" || childStatus === "failed" || childStatus === "ended";
  const detail =
    truncateText(
      trimmed(supervisorState?.summary) ||
        trimmed(supervisorState?.rawText) ||
        trimmed(prev?.detail) ||
        "Twilio supervisor update",
      4000
    ) || "Twilio supervisor update";
  return {
    ...(prev && typeof prev === "object" ? prev : {}),
    status: childStatus === "failed" ? "degraded" : "healthy",
    reason: "twilio_supervisor_update",
    detail,
    updated_at: nowIso,
    last_healthy_at: nowIso,
    last_failure_at: childStatus === "failed" ? nowIso : prev?.last_failure_at || null,
    listening: prev?.listening === true && !isTerminal,
    active: isTerminal ? false : true,
    conversation_id: truncateText(conversationId, 255),
    orchestrator_session_id: truncateText(orchestratorSessionId, 255),
    twilio_supervisor_state: supervisorState,
  };
}

async function publishRelayTwilioSupervisorState({
  userId,
  deviceId,
  conversationId,
  orchestratorSessionId,
  supervisorState,
}) {
  const normalized = normalizeTwilioSupervisorState(supervisorState);
  if (!userId || !conversationId || !normalized) return;

  await persistTwilioSupervisorStateForConversation({
    userId,
    conversationId,
    orchestratorSessionId,
    supervisorState: normalized,
  });

  if (!deviceId) return;
  const previous = healthByDevice.get(deviceId) || {};
  const previousAiyra =
    previous?.aiyra_voice && typeof previous.aiyra_voice === "object"
      ? previous.aiyra_voice
      : null;
  const nextAiyra = buildRelayAiyraVoiceHealth({
    prev: previousAiyra,
    conversationId,
    orchestratorSessionId,
    supervisorState: normalized,
  });
  const nextHealth = mergeConnectorHealthSnapshot(previous, {
    aiyra_voice: nextAiyra,
  });
  healthByDevice.set(deviceId, nextHealth);
  await persistAiyraVoiceHealthSnapshot({
    deviceId,
    userId,
    health: nextAiyra,
  });
  if (connectorByDevice.has(deviceId)) {
    const deviceOnlineMsg = buildDeviceOnlineMessage(deviceId);
    broadcastToUser(userId, deviceOnlineMsg);
    await broadcastToDeviceWorkspace(deviceId, deviceOnlineMsg);
  }
}

async function configureAiyraRuntimeConversation(session, args) {
  const twilioFrom = trimmed(args?.twilioFrom);
  const twilioTo = trimmed(args?.twilioTo);
  const payload = {
    apiKey: session.apiKey,
    conversationId: session.conversationId,
    channelMode: "mic_main",
    startupGreetingEnabled: false,
    tools: {
      twilio: {
        enabled: true,
        from: twilioFrom,
        to: twilioTo,
      },
    },
    ...(args?.useDedicatedTwilioTools
      ? {
          exposedTools: [
            "start_twilio_call",
            "start_twilio_sms",
            "get_twilio_child_status",
            "coach_twilio_child",
          ],
        }
      : {}),
  };
  const configRes = await callAiyraJson({
    baseUrl: session.baseUrl,
    apiKey: session.apiKey,
    path: "/api/aiyra/config",
    body: payload,
  });
  if (!configRes.ok) {
    const detail =
      trimmed(configRes?.payload?.error) ||
      trimmed(configRes?.payload?.message) ||
      trimmed(configRes.text) ||
      `status ${configRes.status}`;
    throw new Error(`aiyra_config_failed: ${detail}`);
  }
}

function clearAiyraPendingCommand(session) {
  const pending = session?.pendingCommand || null;
  if (pending?.timeoutId) {
    clearTimeout(pending.timeoutId);
  }
  if (session) {
    session.pendingCommand = null;
  }
  return pending;
}

function resolveAiyraPendingCommand(session, payload) {
  const pending = clearAiyraPendingCommand(session);
  if (!pending || pending.resolved) return;
  pending.resolved = true;
  pending.resolve(payload);
}

function rejectAiyraPendingCommand(session, error) {
  const pending = clearAiyraPendingCommand(session);
  if (!pending || pending.resolved) return;
  pending.resolved = true;
  pending.reject(error);
}

function attachAiyraRuntimeSocket(session, ws) {
  ws.on("message", (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    session.lastActivityAt = Date.now();
    const msgType = trimmed(msg?.type);
    const pending = session.pendingCommand || null;

    if (msgType === "twilio.supervisor.update") {
      const supervisorState = normalizeTwilioSupervisorState(msg);
      if (supervisorState) {
        session.lastSupervisorState = supervisorState;
        void publishRelayTwilioSupervisorState({
          userId: session.userId,
          deviceId: session.deviceId,
          conversationId: session.conversationId,
          orchestratorSessionId: session.orchestratorSessionId,
          supervisorState,
        }).catch(() => {});
        if (
          pending &&
          !pending.resolved &&
          (!pending.expectedSupervisorKind ||
            !trimmed(supervisorState.childKind) ||
            trimmed(supervisorState.childKind) === pending.expectedSupervisorKind)
        ) {
          resolveAiyraPendingCommand(session, {
            ok: true,
            dispatched: true,
            supervisorState,
            assistantText: pending.assistantText || "",
          });
          return;
        }
      }
    }

    if (pending && !pending.resolved) {
      if (isAiyraResponseStartedEvent(msg)) {
        pending.responseStarted = true;
      }
      const fragment = extractAiyraAssistantText(msg);
      if (fragment) {
        pending.assistantText = `${pending.assistantText} ${fragment}`.trim();
      }
      if (msgType === "error") {
        rejectAiyraPendingCommand(
          session,
          new Error(trimmed(msg?.error) || "aiyra_runtime_error")
        );
        return;
      }
      if (isAiyraResponseFinishedEvent(msg)) {
        resolveAiyraPendingCommand(session, {
          ok: true,
          dispatched: true,
          assistantText: pending.assistantText || "",
          ...(session.lastSupervisorState
            ? { supervisorState: session.lastSupervisorState }
            : {}),
        });
      }
    }
  });

  ws.on("error", (err) => {
    if (!session.connectReady) {
      session.connectReject?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  ws.on("close", (code, reason) => {
    const reasonText =
      reason && Buffer.isBuffer(reason) && reason.length ? reason.toString("utf8") : "";
    session.ws = null;
    session.connectPromise = null;
    session.connectResolve = null;
    session.connectReject = null;
    session.connectReady = false;
    if (session.pendingCommand) {
      rejectAiyraPendingCommand(
        session,
        new Error(
          reasonText
            ? `aiyra_runtime_closed:${reasonText}`
            : `aiyra_runtime_closed:${code || "unknown"}`
        )
      );
    }
  });
}

async function ensureAiyraRuntimeConnected(session) {
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    session.lastActivityAt = Date.now();
    return session;
  }
  if (session.connectPromise) {
    await session.connectPromise;
    return session;
  }

  session.connectPromise = new Promise(async (resolve, reject) => {
    session.connectResolve = resolve;
    session.connectReject = reject;
    session.connectReady = false;
    try {
      const ticketRes = await callAiyraJson({
        baseUrl: session.baseUrl,
        apiKey: session.apiKey,
        path: "/api/auth/ws-ticket",
        body: {
          conversationId: session.conversationId,
          ttlSeconds: 180,
          uses: 8,
        },
      });
      if (!ticketRes.ok) {
        const detail =
          trimmed(ticketRes?.payload?.error) ||
          trimmed(ticketRes?.payload?.message) ||
          trimmed(ticketRes.text) ||
          `status ${ticketRes.status}`;
        throw new Error(`aiyra_ticket_failed: ${detail}`);
      }
      const wsTicket =
        trimmed(ticketRes?.payload?.wsTicket) ||
        trimmed(ticketRes?.payload?.ws_ticket) ||
        trimmed(ticketRes?.payload?.ticket);
      if (!wsTicket) {
        throw new Error("aiyra_ticket_missing");
      }
      const wsUrl = buildAiyraChatWsUrl(
        session.baseUrl,
        session.conversationId,
        wsTicket
      );
      const ws = new WebSocket(wsUrl);
      const timeoutId = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("aiyra_connect_timeout"));
      }, AIYRA_RUNTIME_CONNECT_TIMEOUT_MS);
      ws.once("open", () => {
        clearTimeout(timeoutId);
        session.ws = ws;
        session.connectReady = true;
        session.lastActivityAt = Date.now();
        attachAiyraRuntimeSocket(session, ws);
        resolve(session);
      });
      ws.once("error", (err) => {
        clearTimeout(timeoutId);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  }).finally(() => {
    session.connectPromise = null;
    session.connectResolve = null;
    session.connectReject = null;
  });

  await session.connectPromise;
  return session;
}

function getOrCreateAiyraRuntimeSession(args) {
  const key = buildAiyraRuntimeKey(args.userId, args.conversationId);
  const existing = aiyraRuntimeByConversation.get(key);
  if (existing) {
    existing.baseUrl = normalizeAiyraBaseUrl(args.baseUrl);
    existing.apiKey = args.apiKey;
    existing.deviceId = trimmed(args.deviceId) || existing.deviceId || null;
    existing.orchestratorSessionId =
      trimmed(args.orchestratorSessionId) || existing.orchestratorSessionId || null;
    existing.lastActivityAt = Date.now();
    return existing;
  }
  const session = {
    key,
    userId: args.userId,
    deviceId: trimmed(args.deviceId) || null,
    conversationId: args.conversationId,
    orchestratorSessionId: trimmed(args.orchestratorSessionId) || null,
    baseUrl: normalizeAiyraBaseUrl(args.baseUrl),
    apiKey: args.apiKey,
    ws: null,
    connectPromise: null,
    connectResolve: null,
    connectReject: null,
    connectReady: false,
    pendingCommand: null,
    commandTail: Promise.resolve(),
    lastActivityAt: Date.now(),
    lastSupervisorState: null,
  };
  aiyraRuntimeByConversation.set(key, session);
  return session;
}

async function closeAiyraRuntimeSession(session, reason = "closed") {
  if (!session) return;
  aiyraRuntimeByConversation.delete(session.key);
  rejectAiyraPendingCommand(
    session,
    new Error(`aiyra_runtime_closed:${trimmed(reason) || "closed"}`)
  );
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    try {
      session.ws.close();
    } catch {}
  }
  session.ws = null;
}

async function queueAiyraRuntimeSend(session, args) {
  const previousTail = session.commandTail.catch(() => {});
  const nextTail = previousTail.then(async () => {
    session.deviceId = trimmed(args.deviceId) || session.deviceId || null;
    session.orchestratorSessionId =
      trimmed(args.orchestratorSessionId) || session.orchestratorSessionId || null;
    session.lastActivityAt = Date.now();

    await configureAiyraRuntimeConversation(session, args);
    await ensureAiyraRuntimeConnected(session);

    const ws = session.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("aiyra_runtime_not_connected");
    }

    return await new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timeoutMs = Number.isFinite(Number(args.timeoutMs))
        ? Math.max(5_000, Math.min(Math.trunc(Number(args.timeoutMs)), 120_000))
        : 20_000;
      const pending = {
        requestId,
        expectedSupervisorKind: trimmed(args.expectedSupervisorKind) || null,
        assistantText: "",
        responseStarted: false,
        resolved: false,
        timeoutId: setTimeout(() => {
          resolveAiyraPendingCommand(session, {
            ok: true,
            dispatched: true,
            warning: "aiyra_runtime_no_immediate_response",
            assistantText: pending.assistantText || "",
            ...(session.lastSupervisorState
              ? { supervisorState: session.lastSupervisorState }
              : {}),
          });
        }, timeoutMs),
        resolve,
        reject,
      };
      session.pendingCommand = pending;

      const initialSupervisorState = normalizeTwilioSupervisorState(
        args.initialSupervisorState
      );
      if (initialSupervisorState) {
        void publishRelayTwilioSupervisorState({
          userId: session.userId,
          deviceId: session.deviceId,
          conversationId: session.conversationId,
          orchestratorSessionId: session.orchestratorSessionId,
          supervisorState: initialSupervisorState,
        }).catch(() => {});
      }

      const sent = wsSend(
        ws,
        {
          type: "input.text",
          id: requestId,
          text: args.text,
        },
        () => {}
      );
      if (!sent) {
        rejectAiyraPendingCommand(session, new Error("aiyra_runtime_send_failed"));
      }
    });
  });
  session.commandTail = nextTail.catch(() => {});
  return nextTail;
}

async function handleInternalAiyraRuntimeHttp(req, res) {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  const auth = verifyInternalRouteAuthHeaders(req.headers, RELAY_AIYRA_RUNTIME_SCOPE);
  if (!auth?.userId) {
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const code =
      error instanceof Error && error.message === "body_too_large" ? 413 : 400;
    writeJson(res, code, { error: error instanceof Error ? error.message : "invalid_json" });
    return;
  }

  const conversationId = trimmed(body?.conversationId);
  const apiKey = trimmed(body?.apiKey);
  const baseUrl = trimmed(body?.baseUrl);
  const text = trimmed(body?.text);
  const deviceId = trimmed(body?.deviceId) || null;
  const orchestratorSessionId = trimmed(body?.orchestratorSessionId) || null;
  const timeoutMs = Number(body?.timeoutMs);
  const initialSupervisorState =
    body?.initialSupervisorState &&
    typeof body.initialSupervisorState === "object" &&
    !Array.isArray(body.initialSupervisorState)
      ? body.initialSupervisorState
      : null;
  if (!conversationId) {
    writeJson(res, 400, { error: "missing_conversation_id" });
    return;
  }
  if (!apiKey) {
    writeJson(res, 400, { error: "missing_api_key" });
    return;
  }
  if (!baseUrl) {
    writeJson(res, 400, { error: "missing_base_url" });
    return;
  }
  if (!text) {
    writeJson(res, 400, { error: "missing_text" });
    return;
  }

  if (deviceId) {
    const allowed =
      (await canUseDevice(auth.userId, deviceId)) ||
      (await fetchDeviceOwner(deviceId).then((row) => row?.userId === auth.userId).catch(() => false));
    if (!allowed) {
      writeJson(res, 403, { error: "forbidden_device" });
      return;
    }
  }

  try {
    const session = getOrCreateAiyraRuntimeSession({
      userId: auth.userId,
      deviceId,
      conversationId,
      orchestratorSessionId,
      baseUrl,
      apiKey,
    });
    const result = await queueAiyraRuntimeSend(session, {
      deviceId,
      orchestratorSessionId,
      text,
      twilioFrom: trimmed(body?.twilioFrom),
      twilioTo: trimmed(body?.twilioTo),
      initialSupervisorState,
      expectedSupervisorKind: trimmed(body?.expectedSupervisorKind),
      useDedicatedTwilioTools: body?.useDedicatedTwilioTools === true,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : null,
    });
    writeJson(res, 200, {
      ok: true,
      conversationId,
      ...(result && typeof result === "object" ? result : {}),
    });
  } catch (error) {
    writeJson(res, 502, {
      error: error instanceof Error ? error.message : "aiyra_runtime_failed",
    });
  }
}

async function canUseDevice(userId, deviceId) {
  if (!userId || !deviceId) return false;
  const owner = userByDevice.get(deviceId);
  if (owner && owner === userId) return true;

  const res = await supabaseService(
    `/rest/v1/hosted_devices?device_id=eq.${deviceId}&select=workspace_id&limit=1`
  );
  if (!res.ok) return false;
  const rows = await res.json().catch(() => []);
  const workspaceId = rows?.[0]?.workspace_id;
  if (!workspaceId) return false;

  const res2 = await supabaseService(
    `/rest/v1/workspace_members?workspace_id=eq.${workspaceId}&user_id=eq.${userId}&select=user_id&limit=1`
  );
  if (!res2.ok) return false;
  const rows2 = await res2.json().catch(() => []);
  return Array.isArray(rows2) && rows2.length > 0;
}

async function getHostedWorkspaceIdForDevice(deviceId) {
  const res = await supabaseService(
    `/rest/v1/hosted_devices?device_id=eq.${deviceId}&select=workspace_id&limit=1`
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows?.[0]?.workspace_id || null;
}

async function broadcastToDeviceWorkspace(deviceId, msg) {
  const workspaceId = await getHostedWorkspaceIdForDevice(deviceId);
  if (!workspaceId) return;
  const res = await supabaseService(
    `/rest/v1/workspace_members?workspace_id=eq.${workspaceId}&select=user_id&limit=200`
  );
  if (!res.ok) return;
  const rows = await res.json().catch(() => []);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.user_id) broadcastToUser(String(row.user_id), msg);
  }
}

async function sendHostedDeviceStatusToUser(userId, ws) {
  const res = await supabaseService(
    `/rest/v1/workspace_members?user_id=eq.${userId}&select=workspace_id&limit=200`
  );
  if (!res.ok) return;
  const rows = await res.json().catch(() => []);
  const workspaceIds = Array.isArray(rows) ? rows.map((r) => r.workspace_id).filter(Boolean) : [];
  if (workspaceIds.length === 0) return;
  const qs = `workspace_id=in.(${workspaceIds.map(encodeURIComponent).join(",")})`;
  const res2 = await supabaseService(
    `/rest/v1/hosted_devices?${qs}&select=device_id&limit=200`
  );
  if (!res2.ok) return;
  const rows2 = await res2.json().catch(() => []);
  for (const row of Array.isArray(rows2) ? rows2 : []) {
    const deviceId = row?.device_id;
    if (!deviceId) continue;
    const connectorWs = connectorByDevice.get(deviceId);
    if (!connectorWs) continue;
    wsSend(ws, buildDeviceOnlineMessage(deviceId));
  }
}

function wsSend(ws, msg, onError) {
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(msg), (err) => {
      if (err && typeof onError === "function") onError(err);
    });
    return true;
  } catch (err) {
    if (typeof onError === "function") onError(err);
    return false;
  }
}

function parseClaudeDiffBlock(content) {
  const lines = String(content || "").split("\n");
  let filename = "file";
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const match = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (match) filename = match[1];
    } else if (line.startsWith("--- ") && filename === "file") {
      const match = line.match(/^--- (?:a\/)?(.+)$/);
      if (match && match[1] !== "/dev/null") filename = match[1];
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  return { filename, content, additions, deletions };
}

function extractClaudeDiffsFromContent(content) {
  const diffs = [];
  const diffBlockRegex = /```diff\n([\s\S]*?)```/g;
  let cleanContent = String(content || "");
  let match;

  while ((match = diffBlockRegex.exec(content)) !== null) {
    const diffContent = match[1].trim();
    if (diffContent) {
      diffs.push(parseClaudeDiffBlock(diffContent));
    }
  }

  cleanContent = cleanContent.replace(diffBlockRegex, "").trim();
  return { cleanContent, diffs };
}

async function persistClaudeRunResult({
  pending,
  resultPayload,
  forwardedDiffs,
  forwardedCostUsd,
}) {
  if (!pending?.agentId || !pending?.userId) return;

  const rawResult =
    typeof resultPayload?.result === "string"
      ? resultPayload.result
      : typeof resultPayload?.result === "object" && resultPayload.result !== null
        ? JSON.stringify(resultPayload.result)
        : "";
  const errorText = typeof resultPayload?.error === "string" ? resultPayload.error.trim() : "";
  const baseContent = rawResult.trim();
  const composedContent = errorText
    ? baseContent
      ? `${baseContent}\n\nError: ${errorText}`
      : `Error: ${errorText}`
    : baseContent || ((forwardedDiffs?.length || 0) > 0 ? "Completed. See file changes below." : "Completed.");
  const { cleanContent, diffs: textDiffs } = extractClaudeDiffsFromContent(composedContent);
  const streamDiffs = Array.isArray(forwardedDiffs)
    ? forwardedDiffs.map((diff) => parseClaudeDiffBlock(String(diff)))
    : [];
  const persistedDiffs = streamDiffs.length > 0 ? streamDiffs : textDiffs;
  const content = cleanContent || composedContent;

  const sessionId =
    typeof resultPayload?.session_id === "string" && resultPayload.session_id.trim()
      ? resultPayload.session_id.trim()
      : null;

  if (sessionId) {
    try {
      const res = await supabaseService(
        "/rest/v1/claude_code_cli_threads?on_conflict=user_id,claude_code_agent_id",
        {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            user_id: pending.userId,
            claude_code_agent_id: pending.agentId,
            claude_session_id: sessionId,
            updated_at: new Date().toISOString(),
          }),
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(
          "[relay] failed to persist claude session_id:",
          res.status,
          body || "(empty body)"
        );
      }
    } catch (err) {
      console.error("[relay] failed to persist claude session_id:", err?.message || err);
    }
  }

  try {
    const res = await supabaseService("/rest/v1/claude_code_cli_messages", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: pending.userId,
        claude_code_agent_id: pending.agentId,
        role: "assistant",
        content,
        diffs: persistedDiffs.length > 0 ? persistedDiffs : null,
        cost_usd: forwardedCostUsd,
        duration_ms:
          typeof resultPayload?.duration_ms === "number"
            ? resultPayload.duration_ms
            : null,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        "[relay] failed to persist claude_run_result:",
        res.status,
        body || "(empty body)"
      );
    }
  } catch (err) {
    console.error("[relay] failed to persist claude_run_result:", err?.message || err);
  }
}

const browsersByUser = new Map(); // userId -> Set<ws>
const connectorByDevice = new Map(); // deviceId -> ws
const userByDevice = new Map(); // deviceId -> userId
const versionByDevice = new Map(); // deviceId -> version string
const capabilitiesByDevice = new Map(); // deviceId -> { claudeCliInstalled: boolean, ... }
const healthByDevice = new Map(); // deviceId -> { whatsapp: { status, ... } }
const sessionInfo = new WeakMap(); // ws -> { kind, userId?, deviceId? }

const pendingRequests = new Map(); // requestId -> { type, browserWs, browserInstanceId?, persistResult?, userId, deviceId, terminalId?, timeoutId?, rpcType? }
const terminalSubs = new Map(); // terminalId -> Set<browserWs>
const terminalOwner = new Map(); // terminalId -> { deviceId, connectorWs, persist, connected }
const terminalCloseTimers = new Map(); // terminalId -> timeoutId
const webrtcSessions = new Map(); // `${terminalId}:${webrtcId}` -> { browserWs, userId, deviceId, terminalId, createdAt }
const webrtcConnectedBrowsersByTerminal = new Map(); // terminalId -> Set<browserWs>
const TERMINAL_BUFFER_MAX = 200_000; // last ~200KB of output per terminal
const terminalBuffers = new Map(); // terminalId -> string
const aiyraRuntimeByConversation = new Map(); // `${userId}:${conversationId}` -> managed ws/chat runtime
const AIYRA_RUNTIME_IDLE_CLOSE_MS = 30 * 60 * 1000;
const AIYRA_RUNTIME_CONNECT_TIMEOUT_MS = 15_000;

async function handleInternalConnectorRpcHttp(req, res) {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  const auth = verifyInternalRouteAuthHeaders(req.headers, RELAY_CONNECTOR_RPC_SCOPE);
  if (!auth?.userId) {
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const code =
      error instanceof Error && error.message === "body_too_large" ? 413 : 400;
    writeJson(res, code, { error: error instanceof Error ? error.message : "invalid_json" });
    return;
  }

  const deviceId = trimmed(body?.deviceId);
  const rpcType = trimmed(body?.rpcType);
  const payload =
    body?.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? body.payload
      : {};
  const timeoutRaw = Number(body?.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutRaw)
    ? Math.max(1000, Math.min(Math.trunc(timeoutRaw), 5 * 60 * 1000))
    : 30_000;

  if (!deviceId) {
    writeJson(res, 400, { error: "missing_device_id" });
    return;
  }
  if (!rpcType) {
    writeJson(res, 400, { error: "missing_rpc_type" });
    return;
  }

  const connectorWs = connectorByDevice.get(deviceId);
  const allowed = await canUseDevice(auth.userId, deviceId);
  if (!connectorWs || !allowed) {
    writeJson(res, 404, { error: "device_not_online" });
    return;
  }

  const requestId = randomUUID();
  const responsePromise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("relay_timeout"));
    }, timeoutMs);

    pendingRequests.set(requestId, {
      type: "connector_rpc_internal",
      userId: auth.userId,
      deviceId,
      rpcType,
      timeoutId,
      resolve,
      reject,
    });
  });

  const sent = wsSend(
    connectorWs,
    {
      ...payload,
      type: rpcType,
      request_id: requestId,
    },
    () => {}
  );

  if (!sent) {
    const pending = pendingRequests.get(requestId);
    pendingRequests.delete(requestId);
    if (pending?.timeoutId) clearTimeout(pending.timeoutId);
    writeJson(res, 502, { error: "connector_send_failed" });
    return;
  }

  try {
    const result = await responsePromise;
    writeJson(res, 200, result);
  } catch (error) {
    writeJson(res, 504, {
      error: error instanceof Error ? error.message : "relay_timeout",
    });
  }
}

function normalizeConnectorHealth(raw) {
  if (!raw || typeof raw !== "object") return null;
  const whatsappRaw =
    raw.whatsapp && typeof raw.whatsapp === "object" ? raw.whatsapp : null;
  const aiyraRaw =
    raw.aiyra_voice && typeof raw.aiyra_voice === "object"
      ? raw.aiyra_voice
      : null;
  if (!whatsappRaw && !aiyraRaw) return null;

  const statusRaw =
    typeof (whatsappRaw || aiyraRaw)?.status === "string"
      ? String((whatsappRaw || aiyraRaw).status).trim().toLowerCase()
      : "unknown";
  const allowed = new Set([
    "healthy",
    "degraded",
    "recovering",
    "disabled",
    "unknown",
  ]);
  const status = allowed.has(statusRaw) ? statusRaw : "unknown";
  const toSafeNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const normalizeStatus = (value) => {
    const s = typeof value === "string" ? String(value).trim().toLowerCase() : "unknown";
    return allowed.has(s) ? s : "unknown";
  };
  const toOptionalNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  const out = {};
  if (whatsappRaw) {
    out.whatsapp = {
      status: normalizeStatus(whatsappRaw.status) || status,
      reason: typeof whatsappRaw.reason === "string" ? whatsappRaw.reason : "",
      detail: typeof whatsappRaw.detail === "string" ? whatsappRaw.detail : "",
      updated_at:
        typeof whatsappRaw.updated_at === "string" ? whatsappRaw.updated_at : null,
      last_healthy_at:
        typeof whatsappRaw.last_healthy_at === "string"
          ? whatsappRaw.last_healthy_at
          : null,
      last_failure_at:
        typeof whatsappRaw.last_failure_at === "string"
          ? whatsappRaw.last_failure_at
          : null,
      consecutive_failures: toSafeNumber(whatsappRaw.consecutive_failures, 0),
      recent_failures: toSafeNumber(whatsappRaw.recent_failures, 0),
      auto_restart_pending: whatsappRaw.auto_restart_pending === true,
      auto_restart_count: toSafeNumber(whatsappRaw.auto_restart_count, 0),
    };
  }
  if (aiyraRaw) {
    const twilioSupervisorState = normalizeTwilioSupervisorState(
      aiyraRaw.twilio_supervisor_state
    );
    out.aiyra_voice = {
      status: normalizeStatus(aiyraRaw.status) || status,
      reason: typeof aiyraRaw.reason === "string" ? aiyraRaw.reason : "",
      detail: typeof aiyraRaw.detail === "string" ? aiyraRaw.detail : "",
      updated_at:
        typeof aiyraRaw.updated_at === "string" ? aiyraRaw.updated_at : null,
      last_healthy_at:
        typeof aiyraRaw.last_healthy_at === "string"
          ? aiyraRaw.last_healthy_at
          : null,
      last_failure_at:
        typeof aiyraRaw.last_failure_at === "string"
          ? aiyraRaw.last_failure_at
          : null,
      listening: aiyraRaw.listening === true,
      active: aiyraRaw.active === true,
      ...(typeof aiyraRaw.muted === "boolean" ? { muted: aiyraRaw.muted } : {}),
      wake_word: typeof aiyraRaw.wake_word === "string" ? aiyraRaw.wake_word : "",
      wake_sensitivity: toSafeNumber(aiyraRaw.wake_sensitivity, 0),
      ...(hasOwn(aiyraRaw, "openwakeword_threshold")
        ? {
            openwakeword_threshold: toOptionalNumber(
              aiyraRaw.openwakeword_threshold
            ),
          }
        : {}),
      idle_timeout_ms: toSafeNumber(aiyraRaw.idle_timeout_ms, 0),
      wake_hits: toSafeNumber(aiyraRaw.wake_hits, 0),
      wake_suppressed: toSafeNumber(aiyraRaw.wake_suppressed, 0),
      missed_reports: toSafeNumber(aiyraRaw.missed_reports, 0),
      false_trigger_reports: toSafeNumber(aiyraRaw.false_trigger_reports, 0),
      session_count: toSafeNumber(aiyraRaw.session_count, 0),
      session_error_count: toSafeNumber(aiyraRaw.session_error_count, 0),
      reconnect_attempt_count: toSafeNumber(aiyraRaw.reconnect_attempt_count, 0),
      last_session_duration_ms: toSafeNumber(aiyraRaw.last_session_duration_ms, 0),
      last_metric_event:
        typeof aiyraRaw.last_metric_event === "string"
          ? aiyraRaw.last_metric_event
          : "",
      last_metric_at:
        typeof aiyraRaw.last_metric_at === "string"
          ? aiyraRaw.last_metric_at
          : null,
      low_mic_gain_detected: aiyraRaw.low_mic_gain_detected === true,
      low_mic_gain_at:
        typeof aiyraRaw.low_mic_gain_at === "string"
          ? aiyraRaw.low_mic_gain_at
          : null,
      low_mic_gain_message:
        typeof aiyraRaw.low_mic_gain_message === "string"
          ? aiyraRaw.low_mic_gain_message
          : null,
      low_mic_gain_max_energy_observed: toOptionalNumber(
        aiyraRaw.low_mic_gain_max_energy_observed
      ),
      low_mic_gain_threshold: toOptionalNumber(aiyraRaw.low_mic_gain_threshold),
      ...(hasOwn(aiyraRaw, "configured_mic_name")
        ? {
            configured_mic_name:
              typeof aiyraRaw.configured_mic_name === "string"
                ? aiyraRaw.configured_mic_name
                : null,
          }
        : {}),
      ...(hasOwn(aiyraRaw, "resolved_device_name")
        ? {
            resolved_device_name:
              typeof aiyraRaw.resolved_device_name === "string"
                ? aiyraRaw.resolved_device_name
                : null,
          }
        : {}),
      ...(hasOwn(aiyraRaw, "mic_selection_fallback_reason")
        ? {
            mic_selection_fallback_reason:
              typeof aiyraRaw.mic_selection_fallback_reason === "string"
                ? aiyraRaw.mic_selection_fallback_reason
                : null,
          }
        : {}),
      ...(hasOwn(aiyraRaw, "mic_input_level")
        ? {
            mic_input_level:
              toOptionalNumber(aiyraRaw.mic_input_level) === null
                ? null
                : Math.max(
                    0,
                    Math.min(1, Number(toOptionalNumber(aiyraRaw.mic_input_level)))
                  ),
          }
        : {}),
      ...(hasOwn(aiyraRaw, "mic_input_updated_at")
        ? {
            mic_input_updated_at:
              typeof aiyraRaw.mic_input_updated_at === "string"
                ? aiyraRaw.mic_input_updated_at
                : null,
          }
        : {}),
      conversation_id:
        typeof aiyraRaw.conversation_id === "string"
          ? aiyraRaw.conversation_id
          : null,
      orchestrator_session_id:
        typeof aiyraRaw.orchestrator_session_id === "string"
          ? aiyraRaw.orchestrator_session_id
          : null,
      twilio_supervisor_state: twilioSupervisorState,
    };
  }
  return out;
}

function mergeAiyraVoiceHealth(prev, next) {
  if (!next) return prev || null;
  if (!prev) return next;
  const nextTwilioSupervisorState = normalizeTwilioSupervisorState(
    next.twilio_supervisor_state
  );
  const prevTwilioSupervisorState = normalizeTwilioSupervisorState(
    prev.twilio_supervisor_state
  );
  return {
    ...prev,
    ...next,
    conversation_id:
      (typeof next.conversation_id === "string" && next.conversation_id) ||
      (typeof prev.conversation_id === "string" && prev.conversation_id) ||
      null,
    orchestrator_session_id:
      (typeof next.orchestrator_session_id === "string" &&
        next.orchestrator_session_id) ||
      (typeof prev.orchestrator_session_id === "string" &&
        prev.orchestrator_session_id) ||
      null,
    twilio_supervisor_state:
      nextTwilioSupervisorState || prevTwilioSupervisorState || null,
  };
}

function mergeConnectorHealthSnapshot(prev, next) {
  if (!next) return prev || null;
  return {
    whatsapp: next.whatsapp ?? prev?.whatsapp ?? null,
    aiyra_voice: mergeAiyraVoiceHealth(prev?.aiyra_voice, next.aiyra_voice),
  };
}

function buildDeviceOnlineMessage(deviceId) {
  const version = versionByDevice.get(deviceId) || "0.0.0";
  const caps = capabilitiesByDevice.get(deviceId) || null;
  const health = healthByDevice.get(deviceId) || null;
  return {
    type: "device_online",
    device_id: deviceId,
    version,
    ...(caps ? { capabilities: caps } : {}),
    ...(health ? { health } : {}),
  };
}

function normalizePersistedConnectorConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw;
}

async function fetchPersistedConnectorConfig(deviceId) {
  if (!deviceId) return null;
  try {
    const res = await supabaseService(
      `/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}&select=connector_config&limit=1`
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    return normalizePersistedConnectorConfig(row?.connector_config);
  } catch {
    return null;
  }
}

async function hydratePersistedConnectorConfigToConnector(deviceId, connectorWs) {
  if (!deviceId || !connectorWs) return;
  const config = await fetchPersistedConnectorConfig(deviceId);
  if (!config || Object.keys(config).length === 0) return;
  wsSend(connectorWs, {
    type: "connector_configure",
    request_id: `relay-bootstrap-${randomUUID()}`,
    config,
    restart: false,
  });
}

function webrtcKey(terminalId, webrtcId) {
  return `${terminalId}:${webrtcId}`;
}

function addWebrtcConnectedBrowser(terminalId, ws) {
  const set = webrtcConnectedBrowsersByTerminal.get(terminalId) || new Set();
  set.add(ws);
  webrtcConnectedBrowsersByTerminal.set(terminalId, set);
}

function removeWebrtcConnectedBrowser(terminalId, ws) {
  const set = webrtcConnectedBrowsersByTerminal.get(terminalId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) webrtcConnectedBrowsersByTerminal.delete(terminalId);
}

function addBrowser(userId, ws) {
  const set = browsersByUser.get(userId) || new Set();
  set.add(ws);
  browsersByUser.set(userId, set);
}

function removeBrowser(userId, ws) {
  const set = browsersByUser.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) browsersByUser.delete(userId);
}

function broadcastToUser(userId, msg) {
  const set = browsersByUser.get(userId);
  if (!set) return;
  for (const ws of set) wsSend(ws, msg);
}

async function rebindScheduledJobsAfterPairFromSource({
  userId,
  newDeviceId,
  sourceDeviceId,
}) {
  const safeUserId = String(userId || "").trim();
  const safeNewDeviceId = String(newDeviceId || "").trim();
  const safeSourceDeviceId = String(sourceDeviceId || "").trim();
  if (!safeUserId || !safeNewDeviceId) {
    return { migratedCount: 0, reason: "missing_identity" };
  }

  if (!safeSourceDeviceId) {
    return { migratedCount: 0, reason: "no_source_device" };
  }

  if (safeSourceDeviceId === safeNewDeviceId) {
    return { migratedCount: 0, reason: "source_equals_new" };
  }

  // Do not steal jobs from a currently-online connector.
  if (connectorByDevice.has(safeSourceDeviceId)) {
    return { migratedCount: 0, reason: "source_device_connected" };
  }

  // If this newly paired device already has schedules, we should not move anything.
  const alreadyBoundQ = new URLSearchParams({
    user_id: `eq.${safeUserId}`,
    device_id: `eq.${safeNewDeviceId}`,
    select: "id",
    limit: "1",
  });
  const alreadyBoundRes = await supabaseService(
    `/rest/v1/scheduled_jobs?${alreadyBoundQ.toString()}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    }
  );
  if (!alreadyBoundRes.ok) {
    return {
      migratedCount: 0,
      reason: "lookup_new_device_jobs_failed",
      error: await alreadyBoundRes.text(),
    };
  }
  const alreadyBoundRows = await alreadyBoundRes.json().catch(() => []);
  if (Array.isArray(alreadyBoundRows) && alreadyBoundRows.length > 0) {
    return { migratedCount: 0, reason: "new_device_already_has_jobs" };
  }

  // Migrate only from the exact source device requested by the UI.
  const rebindQ = new URLSearchParams({
    user_id: `eq.${safeUserId}`,
    device_id: `eq.${safeSourceDeviceId}`,
    select: "id",
  });
  const rebindRes = await supabaseService(
    `/rest/v1/scheduled_jobs?${rebindQ.toString()}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        device_id: safeNewDeviceId,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  if (!rebindRes.ok) {
    return {
      migratedCount: 0,
      reason: "scheduled_jobs_rebind_failed",
      sourceDeviceId: safeSourceDeviceId,
      error: await rebindRes.text(),
    };
  }
  const reboundRows = await rebindRes.json().catch(() => []);
  const migratedCount = Array.isArray(reboundRows) ? reboundRows.length : 0;
  return {
    migratedCount,
    sourceDeviceId: safeSourceDeviceId,
    reason: migratedCount > 0 ? "ok" : "no_jobs_on_source_devices",
  };
}

async function fetchClaudeCodeAgentConfigsForDevice({
  userId,
  deviceId,
}) {
  const q = new URLSearchParams({
    user_id: `eq.${String(userId || "").trim()}`,
    device_id: `eq.${String(deviceId || "").trim()}`,
    select: "agent_id,user_id,device_id,workspace_id,terminal_id,created_at,updated_at",
    order: "updated_at.desc",
    limit: "200",
  });
  const res = await supabaseService(`/rest/v1/claude_code_agent_configs?${q.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return { error: await res.text(), configs: [] };
  const rows = await res.json().catch(() => []);
  return { configs: Array.isArray(rows) ? rows : [] };
}

async function rebindClaudeCodeAfterPairFromSource({
  userId,
  newDeviceId,
  sourceDeviceId,
}) {
  const safeUserId = String(userId || "").trim();
  const safeNewDeviceId = String(newDeviceId || "").trim();
  const safeSourceDeviceId = String(sourceDeviceId || "").trim();
  if (!safeUserId || !safeNewDeviceId) {
    return { migratedCount: 0, workspaceCount: 0, reason: "missing_identity" };
  }

  if (!safeSourceDeviceId) {
    return { migratedCount: 0, workspaceCount: 0, reason: "no_source_device" };
  }

  if (safeSourceDeviceId === safeNewDeviceId) {
    return { migratedCount: 0, workspaceCount: 0, reason: "source_equals_new" };
  }

  // Do not steal code sessions from a currently-online connector.
  if (connectorByDevice.has(safeSourceDeviceId)) {
    return { migratedCount: 0, workspaceCount: 0, reason: "source_device_connected" };
  }

  const { configs, error: configsError } = await fetchClaudeCodeAgentConfigsForDevice({
    userId: safeUserId,
    deviceId: safeSourceDeviceId,
  });
  if (configsError) {
    return {
      migratedCount: 0,
      workspaceCount: 0,
      sourceDeviceId: safeSourceDeviceId,
      reason: "lookup_claude_configs_failed",
      error: configsError,
    };
  }
  if (!Array.isArray(configs) || configs.length === 0) {
    return {
      migratedCount: 0,
      workspaceCount: 0,
      sourceDeviceId: safeSourceDeviceId,
      reason: "no_claude_configs_on_source_device",
    };
  }

  const workspaceIdMap = new Map();
  let workspaceCount = 0;
  for (const cfg of configs) {
    const sourceWorkspaceId = String(cfg?.workspace_id || "").trim();
    if (!sourceWorkspaceId || workspaceIdMap.has(sourceWorkspaceId)) continue;

    const sourceWorkspace = await fetchWorkspace({ workspaceId: sourceWorkspaceId });
    if (
      !sourceWorkspace ||
      sourceWorkspace.user_id !== safeUserId ||
      sourceWorkspace.device_id !== safeSourceDeviceId ||
      !sourceWorkspace.root_path
    ) {
      return {
        migratedCount: 0,
        workspaceCount,
        sourceDeviceId: safeSourceDeviceId,
        reason: "source_workspace_missing",
        error: `workspace ${sourceWorkspaceId} not found on source device`,
      };
    }

    const created = await createWorkspace({
      userId: safeUserId,
      deviceId: safeNewDeviceId,
      rootPath: sourceWorkspace.root_path,
      label: sourceWorkspace.label,
    });
    if (created.error || !created.workspace?.id) {
      return {
        migratedCount: 0,
        workspaceCount,
        sourceDeviceId: safeSourceDeviceId,
        reason: "create_workspace_failed",
        error: created.error || `failed to create workspace for ${sourceWorkspace.root_path}`,
      };
    }

    workspaceIdMap.set(sourceWorkspaceId, created.workspace.id);
    workspaceCount++;
  }

  const updatedAt = new Date().toISOString();
  let migratedCount = 0;
  for (const cfg of configs) {
    const agentId = String(cfg?.agent_id || "").trim();
    const sourceWorkspaceId = String(cfg?.workspace_id || "").trim();
    const newWorkspaceId = workspaceIdMap.get(sourceWorkspaceId);
    if (!agentId || !newWorkspaceId) continue;

    const patchQ = new URLSearchParams({
      agent_id: `eq.${agentId}`,
      user_id: `eq.${safeUserId}`,
      device_id: `eq.${safeSourceDeviceId}`,
      select: "agent_id",
    });
    const patchRes = await supabaseService(
      `/rest/v1/claude_code_agent_configs?${patchQ.toString()}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          device_id: safeNewDeviceId,
          workspace_id: newWorkspaceId,
          terminal_id: null,
          updated_at: updatedAt,
        }),
      }
    );
    if (!patchRes.ok) {
      return {
        migratedCount,
        workspaceCount,
        sourceDeviceId: safeSourceDeviceId,
        reason: "claude_config_rebind_failed",
        error: await patchRes.text(),
      };
    }
    const patchedRows = await patchRes.json().catch(() => []);
    migratedCount += Array.isArray(patchedRows) ? patchedRows.length : 0;
  }

  return {
    migratedCount,
    workspaceCount,
    sourceDeviceId: safeSourceDeviceId,
    reason: migratedCount > 0 ? "ok" : "no_claude_configs_on_source_device",
  };
}

async function rebindConnectorConfigAfterPairFromSource({
  userId,
  newDeviceId,
  sourceDeviceId,
}) {
  const safeUserId = String(userId || "").trim();
  const safeNewDeviceId = String(newDeviceId || "").trim();
  const safeSourceDeviceId = String(sourceDeviceId || "").trim();
  if (!safeUserId || !safeNewDeviceId) {
    return { copied: false, reason: "missing_identity" };
  }

  if (!safeSourceDeviceId) {
    return { copied: false, reason: "no_source_device" };
  }

  if (safeSourceDeviceId === safeNewDeviceId) {
    return { copied: false, reason: "source_equals_new" };
  }

  if (connectorByDevice.has(safeSourceDeviceId)) {
    return { copied: false, reason: "source_device_connected" };
  }

  const sourceQ = new URLSearchParams({
    user_id: `eq.${safeUserId}`,
    id: `eq.${safeSourceDeviceId}`,
    select: "id,connector_config",
    limit: "1",
  });
  const sourceRes = await supabaseService(`/rest/v1/devices?${sourceQ.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!sourceRes.ok) {
    return { copied: false, reason: "lookup_source_device_failed", error: await sourceRes.text() };
  }
  const sourceRows = await sourceRes.json().catch(() => []);
  const sourceRow = Array.isArray(sourceRows) ? sourceRows[0] : null;
  const sourceConfig =
    sourceRow?.connector_config &&
    typeof sourceRow.connector_config === "object" &&
    !Array.isArray(sourceRow.connector_config)
      ? sourceRow.connector_config
      : null;
  if (!sourceConfig || Object.keys(sourceConfig).length === 0) {
    return { copied: false, reason: "no_source_config" };
  }

  const newQ = new URLSearchParams({
    user_id: `eq.${safeUserId}`,
    id: `eq.${safeNewDeviceId}`,
    select: "id,connector_config",
    limit: "1",
  });
  const newRes = await supabaseService(`/rest/v1/devices?${newQ.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!newRes.ok) {
    return { copied: false, reason: "lookup_new_device_failed", error: await newRes.text() };
  }
  const newRows = await newRes.json().catch(() => []);
  const newRow = Array.isArray(newRows) ? newRows[0] : null;
  const newConfig =
    newRow?.connector_config &&
    typeof newRow.connector_config === "object" &&
    !Array.isArray(newRow.connector_config)
      ? newRow.connector_config
      : null;
  if (newConfig && Object.keys(newConfig).length > 0) {
    return { copied: false, reason: "new_device_already_has_config" };
  }

  const patchRes = await supabaseService(`/rest/v1/devices?id=eq.${safeNewDeviceId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ connector_config: sourceConfig }),
  });
  if (!patchRes.ok) {
    return { copied: false, reason: "copy_connector_config_failed", error: await patchRes.text() };
  }

  return { copied: true, sourceDeviceId: safeSourceDeviceId, reason: "ok" };
}

async function fetchObsidianAgentConfigsForDevice({
  userId,
  deviceId,
}) {
  const q = new URLSearchParams({
    user_id: `eq.${String(userId || "").trim()}`,
    device_id: `eq.${String(deviceId || "").trim()}`,
    select: "agent_id,user_id,device_id,vault_workspace_id,claude_code_agent_id,vault_label,created_at,updated_at",
    order: "updated_at.desc",
    limit: "200",
  });
  const res = await supabaseService(`/rest/v1/obsidian_agent_configs?${q.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return { error: await res.text(), configs: [] };
  const rows = await res.json().catch(() => []);
  return { configs: Array.isArray(rows) ? rows : [] };
}

async function rebindObsidianConfigsAfterPairFromSource({
  userId,
  newDeviceId,
  sourceDeviceId,
}) {
  const safeUserId = String(userId || "").trim();
  const safeNewDeviceId = String(newDeviceId || "").trim();
  const safeSourceDeviceId = String(sourceDeviceId || "").trim();
  if (!safeUserId || !safeNewDeviceId) {
    return { migratedCount: 0, workspaceCount: 0, reason: "missing_identity" };
  }

  if (!safeSourceDeviceId) {
    return { migratedCount: 0, workspaceCount: 0, reason: "no_source_device" };
  }

  if (safeSourceDeviceId === safeNewDeviceId) {
    return { migratedCount: 0, workspaceCount: 0, reason: "source_equals_new" };
  }

  if (connectorByDevice.has(safeSourceDeviceId)) {
    return { migratedCount: 0, workspaceCount: 0, reason: "source_device_connected" };
  }

  const { configs, error: configsError } = await fetchObsidianAgentConfigsForDevice({
    userId: safeUserId,
    deviceId: safeSourceDeviceId,
  });
  if (configsError) {
    return {
      migratedCount: 0,
      workspaceCount: 0,
      sourceDeviceId: safeSourceDeviceId,
      reason: "lookup_obsidian_configs_failed",
      error: configsError,
    };
  }
  if (!Array.isArray(configs) || configs.length === 0) {
    return {
      migratedCount: 0,
      workspaceCount: 0,
      sourceDeviceId: safeSourceDeviceId,
      reason: "no_obsidian_configs_on_source_device",
    };
  }

  const workspaceIdMap = new Map();
  let workspaceCount = 0;
  for (const cfg of configs) {
    const sourceWorkspaceId = String(cfg?.vault_workspace_id || "").trim();
    if (!sourceWorkspaceId || workspaceIdMap.has(sourceWorkspaceId)) continue;

    const sourceWorkspace = await fetchWorkspace({ workspaceId: sourceWorkspaceId });
    if (
      !sourceWorkspace ||
      sourceWorkspace.user_id !== safeUserId ||
      sourceWorkspace.device_id !== safeSourceDeviceId ||
      !sourceWorkspace.root_path
    ) {
      return {
        migratedCount: 0,
        workspaceCount,
        sourceDeviceId: safeSourceDeviceId,
        reason: "source_vault_workspace_missing",
        error: `workspace ${sourceWorkspaceId} not found on source device`,
      };
    }

    const created = await createWorkspace({
      userId: safeUserId,
      deviceId: safeNewDeviceId,
      rootPath: sourceWorkspace.root_path,
      label: sourceWorkspace.label,
    });
    if (created.error || !created.workspace?.id) {
      return {
        migratedCount: 0,
        workspaceCount,
        sourceDeviceId: safeSourceDeviceId,
        reason: "create_vault_workspace_failed",
        error: created.error || `failed to create workspace for ${sourceWorkspace.root_path}`,
      };
    }

    workspaceIdMap.set(sourceWorkspaceId, created.workspace.id);
    workspaceCount++;
  }

  const updatedAt = new Date().toISOString();
  let migratedCount = 0;
  for (const cfg of configs) {
    const agentId = String(cfg?.agent_id || "").trim();
    const sourceWorkspaceId = String(cfg?.vault_workspace_id || "").trim();
    const newWorkspaceId = workspaceIdMap.get(sourceWorkspaceId);
    if (!agentId || !newWorkspaceId) continue;

    const patchQ = new URLSearchParams({
      agent_id: `eq.${agentId}`,
      user_id: `eq.${safeUserId}`,
      device_id: `eq.${safeSourceDeviceId}`,
      select: "agent_id",
    });
    const patchRes = await supabaseService(
      `/rest/v1/obsidian_agent_configs?${patchQ.toString()}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          device_id: safeNewDeviceId,
          vault_workspace_id: newWorkspaceId,
          updated_at: updatedAt,
        }),
      }
    );
    if (!patchRes.ok) {
      return {
        migratedCount,
        workspaceCount,
        sourceDeviceId: safeSourceDeviceId,
        reason: "obsidian_config_rebind_failed",
        error: await patchRes.text(),
      };
    }
    const patchedRows = await patchRes.json().catch(() => []);
    migratedCount += Array.isArray(patchedRows) ? patchedRows.length : 0;
  }

  return {
    migratedCount,
    workspaceCount,
    sourceDeviceId: safeSourceDeviceId,
    reason: migratedCount > 0 ? "ok" : "no_obsidian_configs_on_source_device",
  };
}

async function claimPairingCode({ code, deviceName, publicKey }) {
  const codeHash = sha256Hex(String(code));
  const q = new URLSearchParams({
    code_hash: `eq.${codeHash}`,
    select: "code_hash,user_id,expires_at,consumed_at,device_id,rebind_from_device_id",
    limit: "1",
  });
  let res = await supabaseService(`/rest/v1/device_pairing_codes?${q.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const firstErr = await res.text();
    // Backward-compat: if migration isn't applied yet, retry without the new column.
    if (/rebind_from_device_id|schema cache/i.test(firstErr)) {
      const fallbackQ = new URLSearchParams({
        code_hash: `eq.${codeHash}`,
        select: "code_hash,user_id,expires_at,consumed_at,device_id",
        limit: "1",
      });
      res = await supabaseService(`/rest/v1/device_pairing_codes?${fallbackQ.toString()}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } else {
      return {
        error: `Failed to look up pairing code: ${firstErr}`,
        errorCode: "lookup_pairing_code_failed",
      };
    }
  }
  if (!res.ok) {
    return {
      error: `Failed to look up pairing code: ${await res.text()}`,
      errorCode: "lookup_pairing_code_failed",
    };
  }
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { error: "Invalid pairing code", errorCode: "invalid_pairing_code" };
  if (row.consumed_at) {
    return {
      error: "Pairing code already used",
      errorCode: "pairing_code_already_used",
      userId: row.user_id || null,
    };
  }
  if (new Date(row.expires_at).getTime() < Date.now())
    return {
      error: "Pairing code expired",
      errorCode: "pairing_code_expired",
      userId: row.user_id || null,
    };

  const createDeviceRes = await supabaseService(`/rest/v1/devices?select=id,user_id,name`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      user_id: row.user_id,
      name: deviceName || "Device",
      public_key: publicKey || null,
    }),
  });
  if (!createDeviceRes.ok) {
    return {
      error: `Failed to create device: ${await createDeviceRes.text()}`,
      errorCode: "create_device_failed",
      userId: row.user_id || null,
    };
  }
  const created = await createDeviceRes.json();
  const device = Array.isArray(created) ? created[0] : null;
  if (!device?.id) {
    return {
      error: "Failed to create device",
      errorCode: "create_device_failed",
      userId: row.user_id || null,
    };
  }

  const nowIso = new Date().toISOString();
  const patchRes = await supabaseService(
    `/rest/v1/device_pairing_codes?code_hash=eq.${encodeURIComponent(codeHash)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        consumed_at: nowIso,
        device_id: device.id,
      }),
    }
  );
  if (!patchRes.ok) {
    // non-fatal for connector, but signal failure
    return {
      error: `Failed to mark pairing code consumed: ${await patchRes.text()}`,
      errorCode: "consume_pairing_code_failed",
      userId: row.user_id || null,
      deviceId: device.id,
    };
  }

  // best-effort last_seen
  await supabaseService(`/rest/v1/devices?id=eq.${device.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ last_seen: nowIso }),
  }).catch(() => {});

  // Best-effort: explicit re-pair flow can request migration of scheduled jobs
  // from a specific previous device id to this newly paired one.
  try {
    const rebinding = await rebindScheduledJobsAfterPairFromSource({
      userId: row.user_id,
      newDeviceId: device.id,
      sourceDeviceId: row.rebind_from_device_id,
    });
    if (rebinding.migratedCount > 0) {
      console.log("[relay] auto-rebound scheduled jobs after pair", {
        user_id: row.user_id,
        new_device_id: device.id,
        source_device_id: rebinding.sourceDeviceId,
        moved_jobs: rebinding.migratedCount,
      });
    } else if (rebinding.error) {
      console.warn("[relay] schedule auto-rebind skipped with error", {
        user_id: row.user_id,
        new_device_id: device.id,
        reason: rebinding.reason,
        error: rebinding.error,
      });
    }
  } catch (err) {
    console.warn("[relay] schedule auto-rebind failed", {
      user_id: row.user_id,
      new_device_id: device.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Best-effort: explicit re-pair flow can also migrate Claude Code agent bindings
  // onto the newly paired device by recreating referenced workspaces and clearing
  // stale terminal bindings.
  try {
    const codeRebinding = await rebindClaudeCodeAfterPairFromSource({
      userId: row.user_id,
      newDeviceId: device.id,
      sourceDeviceId: row.rebind_from_device_id,
    });
    if (codeRebinding.migratedCount > 0) {
      console.log("[relay] auto-rebound claude code configs after pair", {
        user_id: row.user_id,
        new_device_id: device.id,
        source_device_id: codeRebinding.sourceDeviceId,
        moved_configs: codeRebinding.migratedCount,
        workspace_count: codeRebinding.workspaceCount,
      });
    } else if (codeRebinding.error) {
      console.warn("[relay] claude code auto-rebind skipped with error", {
        user_id: row.user_id,
        new_device_id: device.id,
        reason: codeRebinding.reason,
        error: codeRebinding.error,
      });
    }
  } catch (err) {
    console.warn("[relay] claude code auto-rebind failed", {
      user_id: row.user_id,
      new_device_id: device.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Best-effort: carry forward persisted connector config so dashboard-selected
  // runtime preferences keep hydrating after an explicit re-pair.
  try {
    const configRebinding = await rebindConnectorConfigAfterPairFromSource({
      userId: row.user_id,
      newDeviceId: device.id,
      sourceDeviceId: row.rebind_from_device_id,
    });
    if (configRebinding.copied) {
      console.log("[relay] copied connector config after pair", {
        user_id: row.user_id,
        new_device_id: device.id,
        source_device_id: configRebinding.sourceDeviceId,
      });
    } else if (configRebinding.error) {
      console.warn("[relay] connector config copy skipped with error", {
        user_id: row.user_id,
        new_device_id: device.id,
        reason: configRebinding.reason,
        error: configRebinding.error,
      });
    }
  } catch (err) {
    console.warn("[relay] connector config copy failed", {
      user_id: row.user_id,
      new_device_id: device.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Best-effort: move Obsidian agent bindings to recreated vault workspaces on
  // the newly paired device.
  try {
    const obsidianRebinding = await rebindObsidianConfigsAfterPairFromSource({
      userId: row.user_id,
      newDeviceId: device.id,
      sourceDeviceId: row.rebind_from_device_id,
    });
    if (obsidianRebinding.migratedCount > 0) {
      console.log("[relay] auto-rebound obsidian configs after pair", {
        user_id: row.user_id,
        new_device_id: device.id,
        source_device_id: obsidianRebinding.sourceDeviceId,
        moved_configs: obsidianRebinding.migratedCount,
        workspace_count: obsidianRebinding.workspaceCount,
      });
    } else if (obsidianRebinding.error) {
      console.warn("[relay] obsidian auto-rebind skipped with error", {
        user_id: row.user_id,
        new_device_id: device.id,
        reason: obsidianRebinding.reason,
        error: obsidianRebinding.error,
      });
    }
  } catch (err) {
    console.warn("[relay] obsidian auto-rebind failed", {
      user_id: row.user_id,
      new_device_id: device.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const token = signDeviceToken({ deviceId: device.id, userId: row.user_id });
  return { deviceId: device.id, userId: row.user_id, token };
}

async function fetchDeviceOwner(deviceId) {
  const q = new URLSearchParams({
    id: `eq.${deviceId}`,
    select: "id,user_id,name",
    limit: "1",
  });
  const res = await supabaseService(`/rest/v1/devices?${q.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    return { error: `Failed to look up device: ${await res.text()}` };
  }
  const rows = await res.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.id) return { error: "Device not found" };
  return {
    deviceId: String(row.id),
    userId: row.user_id ? String(row.user_id) : "",
    name: row.name ? String(row.name) : "",
  };
}

async function fetchWorkspace({ workspaceId }) {
  const q = new URLSearchParams({
    id: `eq.${workspaceId}`,
    select:
      "id,user_id,device_id,label,root_path,root_path_enc,root_path_iv,root_path_tag",
    limit: "1",
  });
  const res = await supabaseService(`/rest/v1/device_workspaces?${q.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  // Decrypt if present
  if (row.root_path_enc && row.root_path_iv && row.root_path_tag && AES_KEY) {
    const dec = decryptPath({
      enc: row.root_path_enc,
      iv: row.root_path_iv,
      tag: row.root_path_tag,
    });
    if (dec) {
      row.root_path = dec;
    }
  }
  return row;
}

async function createWorkspace({ userId, deviceId, rootPath, label }) {
  const payload = {
    user_id: userId,
    device_id: deviceId,
    label: label || rootPath?.split("/")?.filter(Boolean)?.slice(-1)?.[0] || "Workspace",
  };
  if (AES_KEY) {
    const enc = encryptPath(rootPath);
    if (enc) {
      Object.assign(payload, {
        root_path_enc: enc.enc,
        root_path_iv: enc.iv,
        root_path_tag: enc.tag,
      });
    }
  } else {
    Object.assign(payload, { root_path: rootPath });
  }
  const res = await supabaseService(
    `/rest/v1/device_workspaces?select=id,device_id,label,root_path,root_path_enc,created_at,updated_at`,
    {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    // Handle duplicate key error - workspace already exists
    if (errText.includes("23505") || errText.includes("duplicate key")) {
      // Look up existing workspace by (user_id, device_id, root_path)
      const existing = await fetchWorkspaceByPath({ userId, deviceId, rootPath });
      if (existing) {
        return { workspace: existing, existed: true };
      }
    }
    return { error: errText };
  }
  const rows = await res.json();
  const ws = Array.isArray(rows) ? rows[0] : null;
  if (!ws?.id) return { error: "Failed to create workspace" };
  return { workspace: ws };
}

async function fetchWorkspaceByPath({ userId, deviceId, rootPath }) {
  // If using encryption, we can't query by root_path directly
  // We need to fetch all workspaces for this device and decrypt to match
  const q = new URLSearchParams({
    user_id: `eq.${userId}`,
    device_id: `eq.${deviceId}`,
    select: "id,user_id,device_id,label,root_path,root_path_enc,root_path_iv,root_path_tag,created_at,updated_at",
  });
  if (!AES_KEY) {
    // If no encryption, we can query directly
    q.append("root_path", `eq.${rootPath}`);
    q.append("limit", "1");
  }
  const res = await supabaseService(`/rest/v1/device_workspaces?${q.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // If not using encryption, return first match
  if (!AES_KEY) {
    return rows[0];
  }

  // With encryption, decrypt each and find match
  for (const row of rows) {
    if (row.root_path_enc && row.root_path_iv && row.root_path_tag) {
      const dec = decryptPath({
        enc: row.root_path_enc,
        iv: row.root_path_iv,
        tag: row.root_path_tag,
      });
      if (dec === rootPath) {
        row.root_path = dec;
        return row;
      }
    } else if (row.root_path === rootPath) {
      return row;
    }
  }
  return null;
}

async function fetchScheduledJobs({ deviceId }) {
  const q = new URLSearchParams({
    device_id: `eq.${deviceId}`,
    select:
      "id,user_id,device_id,kind,name,command,cwd,task,schedule,enabled,skip_next_run,last_run_at,last_status,last_exit_code,created_at,updated_at",
    order: "updated_at.desc",
    limit: "200",
  });
  const res = await supabaseService(`/rest/v1/scheduled_jobs?${q.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return { error: await res.text(), jobs: [] };
  const rows = await res.json();
  return { jobs: Array.isArray(rows) ? rows : [] };
}

async function fetchScheduledJobForDevice({ jobId, deviceId }) {
  const q = new URLSearchParams({
    id: `eq.${jobId}`,
    device_id: `eq.${deviceId}`,
    select: "id,user_id,device_id,skip_next_run,task",
    limit: "1",
  });
  const res = await supabaseService(`/rest/v1/scheduled_jobs?${q.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return { error: await res.text(), job: null };
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  return { job: row || null };
}

async function insertScheduledJobRun({
  userId,
  deviceId,
  jobId,
  status,
  exitCode,
  startedAt,
  finishedAt,
  durationMs,
  stdout,
  stderr,
  error,
}) {
  const res = await supabaseService(
    `/rest/v1/scheduled_job_runs?select=id,job_id,status,exit_code,started_at,finished_at,duration_ms,created_at`,
    {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: userId,
        device_id: deviceId,
        job_id: jobId,
        status,
        exit_code: exitCode ?? null,
        started_at: startedAt || new Date().toISOString(),
        finished_at: finishedAt || null,
        duration_ms: durationMs ?? null,
        stdout: stdout ?? null,
        stderr: stderr ?? null,
        error: error ?? null,
      }),
    }
  );
  if (!res.ok) return { error: await res.text(), run: null };
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  return { run: row || null };
}

/**
 * Prune old heartbeat runs (30-day retention).
 * Best-effort — errors are silently ignored.
 */
async function pruneOldHeartbeatRuns({ jobId }) {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    await supabaseService(
      `/rest/v1/scheduled_job_runs?job_id=eq.${jobId}&created_at=lt.${cutoff}`,
      { method: "DELETE", headers: { Prefer: "return=minimal" } }
    );
  } catch {
    // best-effort
  }
}

async function updateScheduledJobAfterRun({
  jobId,
  status,
  exitCode,
  finishedAt,
  consumeSkipNext,
  retryableError,
}) {
  const patch = {
    last_status: status || null,
    last_exit_code: exitCode ?? null,
    updated_at: new Date().toISOString(),
  };
  if (!retryableError) {
    patch.last_run_at = finishedAt || new Date().toISOString();
  }
  if (consumeSkipNext) patch.skip_next_run = false;

  const res = await supabaseService(`/rest/v1/scheduled_jobs?id=eq.${jobId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return { error: await res.text() };
  return { ok: true };
}

async function persistScheduledJobWhatsAppTarget({
  jobId,
  task,
  chatId,
  recipientQuery,
}) {
  const safeChatId = typeof chatId === "string" ? chatId.trim() : "";
  const safeRecipientQuery =
    typeof recipientQuery === "string" ? recipientQuery.trim() : "";
  if ((!safeChatId && !safeRecipientQuery) || !task || typeof task !== "object" || Array.isArray(task)) {
    return { ok: true, skipped: true };
  }
  const nextTask = { ...task };
  const nextOptions =
    nextTask.options &&
    typeof nextTask.options === "object" &&
    !Array.isArray(nextTask.options)
      ? { ...nextTask.options }
      : {};
  let changed = false;
  if (safeChatId && nextOptions.whatsapp_chat_id !== safeChatId) {
    nextOptions.whatsapp_chat_id = safeChatId;
    changed = true;
  }
  if (
    safeRecipientQuery &&
    nextOptions.whatsapp_recipient_query !== safeRecipientQuery
  ) {
    nextOptions.whatsapp_recipient_query = safeRecipientQuery;
    changed = true;
  }
  if (!changed) return { ok: true, skipped: true };
  nextTask.options = nextOptions;
  const res = await supabaseService(`/rest/v1/scheduled_jobs?id=eq.${jobId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      task: nextTask,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) return { error: await res.text() };
  return { ok: true };
}

const server = http.createServer((req, res) => {
  if (req.url === "/internal/connector-rpc") {
    void handleInternalConnectorRpcHttp(req, res);
    return;
  }
  if (req.url === "/internal/aiyra-runtime") {
    void handleInternalAiyraRuntimeHttp(req, res);
    return;
  }
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });
const HEARTBEAT_INTERVAL_MS = 30000;

// Keep devices.last_seen fresh while connected (for hosted Mac UX + admin tooling).
const lastSeenPatchedAtByDevice = new Map(); // deviceId -> ms
function patchLastSeen(deviceId) {
  if (!deviceId) return;
  const now = Date.now();
  const last = lastSeenPatchedAtByDevice.get(deviceId) || 0;
  // Rate-limit writes (avoid hammering Supabase).
  if (now - last < 25_000) return;
  lastSeenPatchedAtByDevice.set(deviceId, now);
  const nowIso = new Date(now).toISOString();
  supabaseService(`/rest/v1/devices?id=eq.${deviceId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ last_seen: nowIso }),
  }).catch(() => {});
}

function markAlive() {
  this.isAlive = true;
  const info = sessionInfo.get(this);
  if (info?.kind === "connector" && info.deviceId) {
    patchLastSeen(String(info.deviceId));
  }
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

// App-level keepalive: Fly.io proxy may drop idle connections even with WS ping/pong.
// Send actual data through the connection to keep it alive.
const APP_KEEPALIVE_INTERVAL_MS = 20000;
const appKeepalive = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue; // 1 = OPEN
    const info = sessionInfo.get(ws);
    if (!info || info.kind === "unknown") continue;
    // Send app_ping to authenticated clients (both browsers and connectors)
    wsSend(ws, { type: "app_ping", ts: Date.now() });
  }
}, APP_KEEPALIVE_INTERVAL_MS);

const aiyraRuntimeHousekeeping = setInterval(() => {
  const now = Date.now();
  for (const session of aiyraRuntimeByConversation.values()) {
    if (session?.ws && session.ws.readyState === WebSocket.OPEN) {
      try {
        session.ws.ping();
      } catch {}
    }
    if (
      !session?.pendingCommand &&
      Number.isFinite(Number(session?.lastActivityAt)) &&
      now - Number(session.lastActivityAt) > AIYRA_RUNTIME_IDLE_CLOSE_MS
    ) {
      void closeAiyraRuntimeSession(session, "idle_timeout");
    }
  }
}, 20_000);

wss.on("close", () => {
  clearInterval(heartbeat);
  clearInterval(appKeepalive);
  clearInterval(aiyraRuntimeHousekeeping);
});

wss.on("connection", (ws) => {
  console.log("[relay] NEW WebSocket connection opened");
  ws.isAlive = true;
  ws.on("pong", markAlive);
  ws.on("close", (code, reason) => {
    const reasonText =
      reason && Buffer.isBuffer(reason) && reason.length
        ? reason.toString("utf8")
        : "";
    console.log(
      "[relay] ws close",
      code ? `code=${code}` : "",
      reasonText ? `reason=${reasonText}` : ""
    );
  });
  ws.on("error", (err) => {
    console.warn("[relay] ws error", err?.message || String(err));
  });
  ws.on("message", async (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      wsSend(ws, { type: "error", error: "invalid_json" });
      return;
    }

    const info = sessionInfo.get(ws) || { kind: "unknown" };

    // ===== Browser auth =====
    if (msg?.type === "browser_hello") {
      const token = msg?.access_token;
      if (!token) {
        wsSend(ws, { type: "error", error: "missing_access_token" });
        ws.close();
        return;
      }
      const user = await supabaseAuthGetUser(token);
      if (!user?.id) {
        wsSend(ws, { type: "error", error: "invalid_access_token" });
        ws.close();
        return;
      }
      const browserInstanceId = trimmed(msg?.browser_instance_id) || null;
      sessionInfo.set(ws, { kind: "browser", userId: user.id, browserInstanceId });
      addBrowser(user.id, ws);
      for (const [requestId, pending] of pendingRequests.entries()) {
        if (!pending || pending.type !== "claude_run" || pending.userId !== user.id) continue;
        if (!browserInstanceId || pending.browserInstanceId !== browserInstanceId) continue;
        if (pending.browserWs === ws) continue;
        pending.browserWs = ws;
        pending.disconnectedAt = null;
        console.log("[relay] rebound pending claude_run to reconnected browser", {
          requestId,
          deviceId: pending.deviceId || null,
          browserInstanceId,
        });
      }
      wsSend(ws, { type: "browser_ready", user_id: user.id });

      // Notify about currently-online devices (owned)
      console.log("[relay] browser_hello: user=%s, connectorByDevice.size=%d, userByDevice.size=%d", user.id, connectorByDevice.size, userByDevice.size);
      for (const [deviceId, uId] of userByDevice.entries()) {
        console.log("[relay] checking device %s owned by %s (browser user=%s, match=%s)", deviceId, uId, user.id, uId === user.id);
        if (uId === user.id) {
          const msgOnline = buildDeviceOnlineMessage(deviceId);
          console.log(
            "[relay] sending device_online to browser: device=%s version=%s capabilities=%j health=%j",
            deviceId,
            msgOnline.version || "0.0.0",
            msgOnline.capabilities || null,
            msgOnline.health || null
          );
          wsSend(ws, msgOnline);
        }
      }

      // Also notify about hosted workspace devices the user can access
      await sendHostedDeviceStatusToUser(user.id, ws);
      return;
    }

    // ===== Connector auth =====
    if (msg?.type === "connector_hello") {
      const deviceName = msg?.device_name || "Device";
      const publicKey = msg?.public_key || null;
      const pairingCode = msg?.pairing_code || null;
      const deviceToken = msg?.device_token || null;
      const connectorVersion = msg?.version || "0.0.0";
      const connectorCapabilities = msg?.capabilities || null;

      if (deviceToken) {
        const verified = verifyDeviceToken(deviceToken);
        if (!verified) {
          await insertConnectorEvent({
            eventType: "auth_failure",
            errorCode: "invalid_device_token",
            detail: "connector_hello rejected: invalid device token",
            connectorVersion: String(connectorVersion || "0.0.0"),
            metadata: {
              has_device_token: true,
              has_pairing_code: !!pairingCode,
              device_name: String(deviceName || "Device"),
              capabilities:
                connectorCapabilities && typeof connectorCapabilities === "object"
                  ? connectorCapabilities
                  : null,
            },
          });
          wsSend(ws, { type: "error", error: "invalid_device_token" });
          ws.close();
          return;
        }
        const owner = await fetchDeviceOwner(verified.deviceId);
        if (owner.error) {
          await insertConnectorEvent({
            eventType: "auth_failure",
            errorCode: "lookup_device_failed",
            detail: owner.error,
            userId: verified.userId,
            deviceId: verified.deviceId,
            connectorVersion: String(connectorVersion || "0.0.0"),
            metadata: {
              has_device_token: true,
              has_pairing_code: !!pairingCode,
              token_user_id: verified.userId,
              device_id: verified.deviceId,
            },
          });
          wsSend(ws, { type: "error", error: "lookup_device_failed" });
          ws.close();
          return;
        }
        if (!owner.userId || owner.userId !== verified.userId) {
          await insertConnectorEvent({
            eventType: "auth_failure",
            errorCode: "device_token_user_mismatch",
            detail: "device token user does not match current device owner",
            userId: verified.userId,
            deviceId: verified.deviceId,
            connectorVersion: String(connectorVersion || "0.0.0"),
            metadata: {
              has_device_token: true,
              has_pairing_code: !!pairingCode,
              token_user_id: verified.userId,
              device_owner_user_id: owner.userId || null,
              device_id: verified.deviceId,
              device_name: owner.name || String(deviceName || "Device"),
            },
          });
          wsSend(ws, { type: "error", error: "device_token_user_mismatch" });
          ws.close();
          return;
        }
        // If this device is already connected, replace the old socket.
        const existing = connectorByDevice.get(verified.deviceId);
        if (existing && existing !== ws) {
          try {
            existing.terminate();
          } catch {
            // ignore
          }
        }
        sessionInfo.set(ws, {
          kind: "connector",
          deviceId: verified.deviceId,
          userId: verified.userId,
        });
        connectorByDevice.set(verified.deviceId, ws);
        userByDevice.set(verified.deviceId, verified.userId);
        versionByDevice.set(verified.deviceId, connectorVersion);
        if (connectorCapabilities) capabilitiesByDevice.set(verified.deviceId, connectorCapabilities);
        else capabilitiesByDevice.delete(verified.deviceId);
        console.log("[relay] connector_hello: device=%s user=%s version=%s capabilities=%j, maps: connectorByDevice.size=%d userByDevice.size=%d", verified.deviceId, verified.userId, connectorVersion, connectorCapabilities, connectorByDevice.size, userByDevice.size);

        // Rebind any persistent terminals for this device to the new connector socket.
        for (const [terminalId, owner] of terminalOwner.entries()) {
          if (owner.deviceId !== verified.deviceId) continue;
          if (owner.persist !== true) continue;
          terminalOwner.set(terminalId, { ...owner, connectorWs: ws, connected: true });
        }

        const nowIso = new Date().toISOString();
        await supabaseService(`/rest/v1/devices?id=eq.${verified.deviceId}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ last_seen: nowIso, name: deviceName }),
        }).catch(() => {});

        const refreshedDeviceToken = signDeviceToken({
          deviceId: verified.deviceId,
          userId: verified.userId,
        });

        wsSend(ws, {
          type: "connector_ready",
          device_id: verified.deviceId,
          user_id: verified.userId,
          device_token: refreshedDeviceToken,
        });
        void hydratePersistedConnectorConfigToConnector(verified.deviceId, ws);
        const deviceOnlineMsg = buildDeviceOnlineMessage(verified.deviceId);
        broadcastToUser(verified.userId, deviceOnlineMsg);
        await broadcastToDeviceWorkspace(verified.deviceId, deviceOnlineMsg);
        return;
      }

      if (!pairingCode) {
        await insertConnectorEvent({
          eventType: "auth_failure",
          errorCode: "missing_pairing_code_or_token",
          detail: "connector_hello rejected: missing pairing code and device token",
          connectorVersion: String(connectorVersion || "0.0.0"),
          metadata: {
            has_device_token: false,
            has_pairing_code: false,
            device_name: String(deviceName || "Device"),
            capabilities:
              connectorCapabilities && typeof connectorCapabilities === "object"
                ? connectorCapabilities
                : null,
          },
        });
        wsSend(ws, { type: "error", error: "missing_pairing_code_or_token" });
        ws.close();
        return;
      }

      const claimed = await claimPairingCode({
        code: String(pairingCode),
        deviceName: String(deviceName),
        publicKey: publicKey ? String(publicKey) : null,
      });
      if (claimed.error) {
        await insertConnectorEvent({
          eventType: "pairing_failure",
          errorCode: claimed.errorCode || deriveConnectorErrorCode(claimed.error, "pairing_failed"),
          detail: claimed.error,
          userId: claimed.userId || null,
          deviceId: claimed.deviceId || null,
          connectorVersion: String(connectorVersion || "0.0.0"),
          metadata: {
            has_pairing_code: true,
            device_name: String(deviceName || "Device"),
            capabilities:
              connectorCapabilities && typeof connectorCapabilities === "object"
                ? connectorCapabilities
                : null,
          },
        });
        wsSend(ws, { type: "error", error: claimed.error });
        ws.close();
        return;
      }

      // If this device is already connected, replace the old socket.
      const existing = connectorByDevice.get(claimed.deviceId);
      if (existing && existing !== ws) {
        try {
          existing.terminate();
        } catch {
          // ignore
        }
      }
      sessionInfo.set(ws, {
        kind: "connector",
        deviceId: claimed.deviceId,
        userId: claimed.userId,
      });
      connectorByDevice.set(claimed.deviceId, ws);
      userByDevice.set(claimed.deviceId, claimed.userId);
      versionByDevice.set(claimed.deviceId, connectorVersion);
      if (connectorCapabilities) capabilitiesByDevice.set(claimed.deviceId, connectorCapabilities);
      else capabilitiesByDevice.delete(claimed.deviceId);

      // Rebind any persistent terminals for this device to the new connector socket.
      for (const [terminalId, owner] of terminalOwner.entries()) {
        if (owner.deviceId !== claimed.deviceId) continue;
        if (owner.persist !== true) continue;
        terminalOwner.set(terminalId, { ...owner, connectorWs: ws, connected: true });
      }

      wsSend(ws, {
        type: "connector_ready",
        device_id: claimed.deviceId,
        user_id: claimed.userId,
        device_token: claimed.token,
      });
      void hydratePersistedConnectorConfigToConnector(claimed.deviceId, ws);
      const claimedDeviceOnlineMsg = buildDeviceOnlineMessage(claimed.deviceId);
      broadcastToUser(claimed.userId, claimedDeviceOnlineMsg);
      await broadcastToDeviceWorkspace(claimed.deviceId, claimedDeviceOnlineMsg);
      return;
    }

    // Require auth for everything below
    if (info.kind === "unknown") {
      wsSend(ws, { type: "error", error: "not_authenticated" });
      return;
    }

    // Lightweight app-level ping/pong (more reliable than WS ping/pong through some proxies).
    if (msg?.type === "app_ping") {
      const requestId = msg?.request_id ? String(msg.request_id) : null;
      wsSend(ws, {
        type: "app_pong",
        request_id: requestId,
        ts: Date.now(),
      });
      return;
    }

    // ===== Browser actions =====
    if (info.kind === "browser") {
      const userId = info.userId;

      if (msg?.type === "workspace_pick") {
        const deviceId = String(msg?.device_id || "");
        if (!deviceId) {
          wsSend(ws, { type: "error", error: "missing_device_id" });
          return;
        }
        const connectorWs = connectorByDevice.get(deviceId);
        const allowed = await canUseDevice(userId, deviceId);
        if (!connectorWs || !allowed) {
          wsSend(ws, { type: "error", error: "device_not_online" });
          return;
        }
        const requestId = msg?.request_id ? String(msg.request_id) : randomUUID();
        pendingRequests.set(requestId, {
          type: "workspace_pick",
          browserWs: ws,
          userId,
          deviceId,
        });
        wsSend(connectorWs, { type: "workspace_pick", request_id: requestId });
        wsSend(ws, { type: "workspace_pick_started", request_id: requestId });
        return;
      }

      if (msg?.type === "connector_restart") {
        const deviceId = String(msg?.device_id || "");
        if (!deviceId) {
          wsSend(ws, { type: "error", error: "missing_device_id" });
          return;
        }
        const connectorWs = connectorByDevice.get(deviceId);
        const allowed = await canUseDevice(userId, deviceId);
        if (!connectorWs || !allowed) {
          wsSend(ws, { type: "error", error: "device_not_online" });
          return;
        }
        wsSend(connectorWs, { type: "connector_restart" });
        wsSend(ws, { type: "connector_restart_sent", device_id: deviceId });
        return;
      }

      // Dashboard writes config to connector and optionally restarts.
      if (msg?.type === "connector_configure") {
        const deviceId = String(msg?.device_id || "");
        const requestId = msg?.request_id ? String(msg.request_id) : randomUUID();
        if (!deviceId) {
          wsSend(ws, {
            type: "connector_configure_ack",
            request_id: requestId,
            ok: false,
            error: "missing_device_id",
          });
          return;
        }
        const connectorWs = connectorByDevice.get(deviceId);
        const allowed = await canUseDevice(userId, deviceId);
        if (!connectorWs || !allowed) {
          wsSend(ws, {
            type: "connector_configure_ack",
            request_id: requestId,
            ok: false,
            error: "device_not_online",
          });
          return;
        }

        pendingRequests.set(requestId, {
          type: "connector_rpc",
          browserWs: ws,
          userId,
          deviceId,
          rpcType: "connector_configure",
        });
        const ok = wsSend(connectorWs, {
          type: "connector_configure",
          request_id: requestId,
          config: msg.config || {},
          restart: !!msg.restart,
        });
        if (!ok) {
          pendingRequests.delete(requestId);
          wsSend(ws, {
            type: "connector_configure_ack",
            request_id: requestId,
            ok: false,
            error: "connector_send_failed",
          });
        }
        return;
      }

      if (msg?.type === "connector_update") {
        const deviceId = String(msg?.device_id || "");
        if (!deviceId) {
          wsSend(ws, { type: "error", error: "missing_device_id" });
          return;
        }
        const connectorWs = connectorByDevice.get(deviceId);
        const allowed = await canUseDevice(userId, deviceId);
        if (!connectorWs || !allowed) {
          wsSend(ws, { type: "error", error: "device_not_online" });
          return;
        }
        wsSend(connectorWs, { type: "connector_update" });
        wsSend(ws, { type: "connector_update_sent", device_id: deviceId });
        return;
      }

      // ===== Claude CLI (headless) =====
      // Forward claude_run from browser to connector, route responses back
      if (msg?.type === "claude_discover_commands") {
        const requestId = msg?.request_id ? String(msg.request_id) : randomUUID();
        const deviceId = String(msg?.device_id || "");
        if (!deviceId) {
          wsSend(ws, {
            type: "claude_discover_commands_result",
            request_id: requestId,
            ok: false,
            error: "missing_device_id",
            commands: [],
          });
          return;
        }
        const connectorWs = connectorByDevice.get(deviceId);
        const allowed = await canUseDevice(userId, deviceId);
        if (!connectorWs || !allowed) {
          wsSend(ws, {
            type: "claude_discover_commands_result",
            request_id: requestId,
            ok: false,
            error: "device_not_online",
            commands: [],
          });
          return;
        }

        pendingRequests.set(requestId, {
          type: "claude_discover_commands",
          browserWs: ws,
          userId,
          deviceId,
        });

        wsSend(connectorWs, {
          type: "claude_discover_commands",
          request_id: requestId,
          cwd: msg?.cwd || "",
          api_key: msg?.api_key || "",
          cli_token: msg?.cli_token || "",
          timeout_ms: msg?.timeout_ms || 20000,
        });

        setTimeout(() => {
          const pending = pendingRequests.get(requestId);
          if (pending && pending.type === "claude_discover_commands") {
            pendingRequests.delete(requestId);
            wsSend(pending.browserWs, {
              type: "claude_discover_commands_result",
              request_id: requestId,
              ok: false,
              error: "relay_timeout",
              commands: [],
            });
          }
        }, (msg?.timeout_ms || 20000) + 5000);

        return;
      }

      if (msg?.type === "claude_run") {
        const requestId = msg?.request_id ? String(msg.request_id) : randomUUID();
        const deviceId = String(msg?.device_id || "");
        if (!deviceId) {
          wsSend(ws, {
            type: "claude_run_result",
            request_id: requestId,
            ok: false,
            error: "missing_device_id",
          });
          return;
        }
        const connectorWs = connectorByDevice.get(deviceId);
        const allowed = await canUseDevice(userId, deviceId);
        if (!connectorWs || !allowed) {
          wsSend(ws, {
            type: "claude_run_result",
            request_id: requestId,
            ok: false,
            error: "device_not_online",
          });
          return;
        }
        
        // Store pending request to route response back to browser
        const agentId = trimmed(msg?.agent_id);
        const browserInstanceId = trimmed(msg?.browser_instance_id) || null;
        const pendingEntry = {
          type: "claude_run",
          browserWs: ws,
          browserInstanceId,
          persistResult: msg?.persist_result !== false,
          userId,
          deviceId,
          agentId,
          disconnectedAt: null,
          timeoutId: null,
        };
        pendingRequests.set(requestId, pendingEntry);

        // Forward to connector with all relevant fields
        const forwardProvider =
          typeof msg?.provider === "string" && msg.provider.trim()
            ? msg.provider.trim()
            : "claude";
        const forwardModel =
          typeof msg?.model === "string" && msg.model.trim() ? msg.model.trim() : "";
        wsSend(connectorWs, {
          type: "claude_run",
          request_id: requestId,
          provider: forwardProvider,
          agent_id: agentId,
          prompt: msg?.prompt || "",
          cwd: msg?.cwd || "",
          api_key: msg?.api_key || "",
          cli_token: msg?.cli_token || "",
          allowed_tools: msg?.allowed_tools || "Read,Edit,Bash",
          timeout_ms: msg?.timeout_ms || 300000,
          session_id: msg?.session_id || "",
          plan_mode: msg?.plan_mode || false,
          ...(forwardModel ? { model: forwardModel } : {}),
        });

        // Timeout - clean up pending request if no response
        const timeoutId = setTimeout(() => {
          const pending = pendingRequests.get(requestId);
          if (pending && pending.type === "claude_run") {
            pendingRequests.delete(requestId);
            const pendingDeviceId = String(pending.deviceId || "");
            const connectorWsForCancel = pendingDeviceId ? connectorByDevice.get(pendingDeviceId) : null;
            if (connectorWsForCancel) {
              wsSend(connectorWsForCancel, {
                type: "claude_run_cancel",
                request_id: `relay-timeout-cancel-${requestId}`,
                target_request_id: requestId,
                agent_id: String(pending.agentId || ""),
                cancel_all_for_agent: !!pending.agentId,
              });
            }
            if (pending.browserWs) {
              wsSend(pending.browserWs, {
                type: "claude_run_result",
                request_id: requestId,
                ok: false,
                error: "relay_timeout",
              });
            }
          }
        }, (msg?.timeout_ms || 300000) + 10000);
        pendingEntry.timeoutId = timeoutId;

        return;
      }

      if (msg?.type === "claude_run_cancel") {
        const requestId = msg?.request_id ? String(msg.request_id) : randomUUID();
        const targetRequestId = trimmed(msg?.target_request_id);
        const targetAgentId = trimmed(msg?.agent_id);
        const explicitDeviceId = trimmed(msg?.device_id);
        const cancelAllForAgent = msg?.cancel_all_for_agent === true;
        if (!targetRequestId && !(cancelAllForAgent && (targetAgentId || explicitDeviceId))) {
          wsSend(ws, {
            type: "claude_run_cancel_result",
            request_id: requestId,
            ok: false,
            error: "missing_cancel_target",
          });
          return;
        }

        const pendingClaudeRun = targetRequestId ? pendingRequests.get(targetRequestId) : null;
        if (pendingClaudeRun && (pendingClaudeRun.type !== "claude_run" || pendingClaudeRun.userId !== userId)) {
          wsSend(ws, {
            type: "claude_run_cancel_result",
            request_id: requestId,
            ok: false,
            error: "request_not_found",
          });
          return;
        }

        let deviceId = pendingClaudeRun ? String(pendingClaudeRun.deviceId || "") : "";
        if (!deviceId && targetAgentId) {
          for (const pending of pendingRequests.values()) {
            if (
              pending?.type === "claude_run" &&
              pending?.userId === userId &&
              pending?.agentId === targetAgentId &&
              pending?.deviceId
            ) {
              deviceId = String(pending.deviceId || "");
              break;
            }
          }
        }
        if (!deviceId && explicitDeviceId) {
          const allowed = await canUseDevice(userId, explicitDeviceId);
          if (allowed) deviceId = explicitDeviceId;
        }
        if (!deviceId) {
          wsSend(ws, {
            type: "claude_run_cancel_result",
            request_id: requestId,
            ok: false,
            error: "request_not_found",
          });
          return;
        }

        const connectorWs = connectorByDevice.get(deviceId);
        if (!deviceId || !connectorWs) {
          wsSend(ws, {
            type: "claude_run_cancel_result",
            request_id: requestId,
            ok: false,
            error: "device_not_online",
          });
          return;
        }

        const timeoutId = setTimeout(() => {
          const pending = pendingRequests.get(requestId);
          if (!pending || pending.type !== "connector_rpc") return;
          pendingRequests.delete(requestId);
          wsSend(ws, {
            type: "claude_run_cancel_result",
            request_id: requestId,
            ok: false,
            error: "relay_timeout",
          });
        }, 10_000);

        pendingRequests.set(requestId, {
          type: "connector_rpc",
          browserWs: ws,
          userId,
          deviceId,
          rpcType: "claude_run_cancel",
          timeoutId,
        });

        const ok = wsSend(connectorWs, {
          type: "claude_run_cancel",
          request_id: requestId,
          target_request_id: targetRequestId,
          agent_id: targetAgentId,
          cancel_all_for_agent: cancelAllForAgent,
        });
        if (!ok) {
          pendingRequests.delete(requestId);
          clearTimeout(timeoutId);
          wsSend(ws, {
            type: "claude_run_cancel_result",
            request_id: requestId,
            ok: false,
            error: "connector_send_failed",
          });
        }
        return;
      }

      if (msg?.type === "terminal_open") {
        const deviceId = String(msg?.device_id || "");
        const workspaceId = String(msg?.workspace_id || "");
        // Device is always required
        if (!deviceId) {
          wsSend(ws, { type: "error", error: "missing_device" });
          return;
        }
        const connectorWs = connectorByDevice.get(deviceId);
        const allowed = await canUseDevice(userId, deviceId);
        if (!connectorWs || !allowed) {
          wsSend(ws, { type: "error", error: "device_not_online" });
          return;
        }

        // Workspace is optional - if provided, validate and use its root_path
        // If not provided, send empty cwd (connector will default to $HOME)
        let rootPath = "";
        if (workspaceId) {
          const wsRow = await fetchWorkspace({ workspaceId });
          if (!wsRow || wsRow.user_id !== userId || wsRow.device_id !== deviceId) {
            wsSend(ws, { type: "error", error: "workspace_not_found" });
            return;
          }
          if (!wsRow.root_path) {
            wsSend(ws, { type: "error", error: "workspace_root_path_missing" });
            return;
          }
          rootPath = wsRow.root_path;
        }

        const requestId = msg?.request_id ? String(msg.request_id) : randomUUID();
        const terminalId = msg?.terminal_id ? String(msg.terminal_id) : randomUUID();
        const persist = msg?.persist !== false; // default true for Claude Code-like sessions
        // If the connector is "stuck open" after sleep, the relay can still think
        // it's online but never get a response. Time out and fail fast so the UI
        // can retry, and force-close the connector socket to trigger reconnect.
        const timeoutId = setTimeout(() => {
          const pending = pendingRequests.get(requestId);
          if (!pending || pending.type !== "terminal_open") return;
          pendingRequests.delete(requestId);
          wsSend(pending.browserWs, {
            type: "terminal_open_failed",
            request_id: requestId,
            terminal_id: pending.terminalId || terminalId,
            error: "connector_timeout",
          });
          const current = connectorByDevice.get(deviceId);
          if (current && current === connectorWs) {
            try {
              current.terminate();
            } catch {
              // ignore
            }
          }
        }, 12_000);

        pendingRequests.set(requestId, {
          type: "terminal_open",
          browserWs: ws,
          userId,
          deviceId,
          terminalId,
          timeoutId,
          persist,
        });

        const ok = wsSend(
          connectorWs,
          {
          type: "terminal_open",
          request_id: requestId,
          terminal_id: terminalId,
          cwd: rootPath,
          start_claude: msg?.start_claude !== false,
          persist,
          },
          () => {
            // Best-effort: if send fails, fail the request immediately.
            const pending = pendingRequests.get(requestId);
            if (!pending || pending.type !== "terminal_open") return;
            pendingRequests.delete(requestId);
            if (pending.timeoutId) clearTimeout(pending.timeoutId);
            wsSend(ws, {
              type: "terminal_open_failed",
              request_id: requestId,
              terminal_id: terminalId,
              error: "connector_send_failed",
            });
            try {
              connectorWs.terminate();
            } catch {
              // ignore
            }
          }
        );
        if (!ok) {
          const pending = pendingRequests.get(requestId);
          pendingRequests.delete(requestId);
          if (pending?.timeoutId) clearTimeout(pending.timeoutId);
          wsSend(ws, {
            type: "terminal_open_failed",
            request_id: requestId,
            terminal_id: terminalId,
            error: "device_not_online",
          });
          return;
        }
        return;
      }

      if (msg?.type === "terminal_input") {
        const terminalId = String(msg?.terminal_id || "");
        const data = String(msg?.data || "");
        if (!terminalId || !data) return;
        const owner = terminalOwner.get(terminalId);
        if (!owner) return;
        if (owner.connected === false || !owner.connectorWs) {
          wsSend(ws, { type: "error", error: "device_not_online", terminal_id: terminalId });
          return;
        }
        const deviceId = owner.deviceId;
        if (!(await canUseDevice(userId, deviceId))) return;
        wsSend(owner.connectorWs, { type: "terminal_input", terminal_id: terminalId, data });
        return;
      }

      if (msg?.type === "terminal_subscribe") {
        const terminalId = String(msg?.terminal_id || "");
        if (!terminalId) return;
        const owner = terminalOwner.get(terminalId);
        if (!owner) {
          // Tell the browser this terminal no longer exists so the UI can recover.
          wsSend(ws, { type: "terminal_closed", terminal_id: terminalId });
          return;
        }
        if (!(await canUseDevice(userId, owner.deviceId))) {
          wsSend(ws, { type: "terminal_closed", terminal_id: terminalId });
          return;
        }

        const subs = terminalSubs.get(terminalId) || new Set();
        subs.add(ws);
        terminalSubs.set(terminalId, subs);

        // Send recent output so reopening the card can reconstruct the screen.
        const buf = terminalBuffers.get(terminalId);
        if (buf) {
          wsSend(ws, { type: "terminal_backlog", terminal_id: terminalId, data: buf });
        }

        const t = terminalCloseTimers.get(terminalId);
        if (t) {
          clearTimeout(t);
          terminalCloseTimers.delete(terminalId);
        }
        return;
      }

      if (msg?.type === "terminal_unsubscribe") {
        const terminalId = String(msg?.terminal_id || "");
        if (!terminalId) return;
        const owner = terminalOwner.get(terminalId);
        if (!owner) return;
        if (!(await canUseDevice(userId, owner.deviceId))) return;

        const subs = terminalSubs.get(terminalId);
        if (subs) subs.delete(ws);

        const size = subs ? subs.size : 0;
        if (size === 0) {
          // Delay closing to tolerate React StrictMode mount/unmount cycles.
          if (!terminalCloseTimers.has(terminalId)) {
            const timeoutId = setTimeout(() => {
              terminalCloseTimers.delete(terminalId);
              const currentOwner = terminalOwner.get(terminalId);
              if (!currentOwner) return;
              const currentSubs = terminalSubs.get(terminalId);
              if (currentSubs && currentSubs.size > 0) return; // got resubscribed
              if (currentOwner.connected === false || !currentOwner.connectorWs) return;
              // Only auto-close ephemeral terminals. Persistent terminals stay alive until explicitly terminated.
              if (currentOwner.persist) return;
              wsSend(currentOwner.connectorWs, { type: "terminal_close", terminal_id: terminalId });
            }, 1500);
            terminalCloseTimers.set(terminalId, timeoutId);
          }
        }
        return;
      }

      if (msg?.type === "terminal_resize") {
        const terminalId = String(msg?.terminal_id || "");
        const cols = Number(msg?.cols || 0);
        const rows = Number(msg?.rows || 0);
        if (!terminalId || !cols || !rows) return;
        const owner = terminalOwner.get(terminalId);
        if (!owner) return;
        if (owner.connected === false || !owner.connectorWs) return;
        const deviceId = owner.deviceId;
        if (!(await canUseDevice(userId, deviceId))) return;
        wsSend(owner.connectorWs, { type: "terminal_resize", terminal_id: terminalId, cols, rows });
        return;
      }

      if (msg?.type === "terminal_close") {
        const terminalId = String(msg?.terminal_id || "");
        if (!terminalId) return;
        const owner = terminalOwner.get(terminalId);
        if (!owner) return;
        const deviceId = owner.deviceId;
        if (!(await canUseDevice(userId, deviceId))) return;
        if (!owner.connectorWs) return;
        wsSend(owner.connectorWs, { type: "terminal_close", terminal_id: terminalId });
        return;
      }

      // ===== WebRTC signaling (browser -> connector via relay) =====
      if (msg?.type === "webrtc_offer") {
        const terminalId = String(msg?.terminal_id || "");
        const webrtcId = msg?.webrtc_id ? String(msg.webrtc_id) : randomUUID();
        const sdp = String(msg?.sdp || "");
        const sdpType = String(msg?.sdp_type || "offer");
        if (!terminalId || !sdp || sdpType !== "offer") {
          wsSend(ws, { type: "webrtc_error", terminal_id: terminalId, webrtc_id: webrtcId, error: "invalid_offer" });
          return;
        }

        const owner = terminalOwner.get(terminalId);
        if (!owner) {
          wsSend(ws, { type: "webrtc_error", terminal_id: terminalId, webrtc_id: webrtcId, error: "terminal_not_found" });
          return;
        }
        const deviceId = owner.deviceId;
        const connectorWs = owner.connectorWs;
        if (!connectorWs || !(await canUseDevice(userId, deviceId))) {
          wsSend(ws, { type: "webrtc_error", terminal_id: terminalId, webrtc_id: webrtcId, error: "device_not_online" });
          return;
        }

        webrtcSessions.set(webrtcKey(terminalId, webrtcId), {
          browserWs: ws,
          userId,
          deviceId,
          terminalId,
          createdAt: Date.now(),
        });

        wsSend(connectorWs, {
          type: "webrtc_offer",
          terminal_id: terminalId,
          webrtc_id: webrtcId,
          sdp,
          sdp_type: "offer",
        });
        return;
      }

      if (msg?.type === "webrtc_connected") {
        const terminalId = String(msg?.terminal_id || "");
        const webrtcId = String(msg?.webrtc_id || "");
        if (!terminalId || !webrtcId) return;

        const key = webrtcKey(terminalId, webrtcId);
        const sess = webrtcSessions.get(key);
        if (!sess) return;
        if (sess.browserWs !== ws || sess.userId !== userId) return;

        addWebrtcConnectedBrowser(terminalId, ws);
        return;
      }

      if (msg?.type === "webrtc_disconnected") {
        const terminalId = String(msg?.terminal_id || "");
        const webrtcId = String(msg?.webrtc_id || "");
        if (!terminalId) return;

        removeWebrtcConnectedBrowser(terminalId, ws);

        if (webrtcId) {
          webrtcSessions.delete(webrtcKey(terminalId, webrtcId));
        } else {
          // best-effort cleanup: drop any sessions for this ws+terminal
          for (const [key, sess] of webrtcSessions.entries()) {
            if (sess.terminalId === terminalId && sess.browserWs === ws) webrtcSessions.delete(key);
          }
        }
        return;
      }

      if (msg?.type === "webrtc_ice") {
        const terminalId = String(msg?.terminal_id || "");
        const webrtcId = String(msg?.webrtc_id || "");
        const candidate = msg?.candidate || null;
        if (!terminalId || !webrtcId || !candidate) return;

        const owner = terminalOwner.get(terminalId);
        if (!owner) return;
        const deviceId = owner.deviceId;
        if (!(await canUseDevice(userId, deviceId))) return;

        const connectorWs = owner.connectorWs;
        if (!connectorWs) return;

        // ensure session exists (browser might send ICE before offer arrives)
        const key = webrtcKey(terminalId, webrtcId);
        if (!webrtcSessions.has(key)) {
          webrtcSessions.set(key, {
            browserWs: ws,
            userId,
            deviceId,
            terminalId,
            createdAt: Date.now(),
          });
        }

        wsSend(connectorWs, {
          type: "webrtc_ice",
          terminal_id: terminalId,
          webrtc_id: webrtcId,
          candidate,
        });
        return;
      }

      // ===== Generic connector RPC (browser/files/obsidian/computer_use) =====
      // The dashboard sends messages like { type: "browser_init", request_id, device_id, ... }.
      // We forward those to the connector and route back the matching *_result via request_id.
      const msgType = msg?.type ? String(msg.type) : "";
      const isConnectorRpc =
        msgType.startsWith("browser_") ||
        msgType.startsWith("file_") ||
        msgType.startsWith("obsidian_") ||
        msgType.startsWith("computer_use_") ||
        msgType.startsWith("email_") ||
        msgType.startsWith("whatsapp_") ||
        msgType.startsWith("schedule_trigger") ||
        msgType.startsWith("site_") ||
        msgType.startsWith("skills_") ||
        msgType === "terminal_exec" ||
        msgType.startsWith("linkdb_") ||
        msgType.startsWith("sqlite_") ||
        msgType.startsWith("credential_") ||
        msgType.startsWith("aiyra_") ||
        msgType === "claude_plans_list";
      if (isConnectorRpc) {
        const deviceId = String(msg?.device_id || "");
        if (!deviceId) {
          const requestId = msg?.request_id ? String(msg.request_id) : randomUUID();
          wsSend(ws, {
            type: `${msgType}_result`,
            request_id: requestId,
            ok: false,
            error: "missing_device_id",
          });
          return;
        }
        const connectorWs = connectorByDevice.get(deviceId);
        const allowed = await canUseDevice(userId, deviceId);
        if (!connectorWs || !allowed) {
          const requestId = msg?.request_id ? String(msg.request_id) : randomUUID();
          wsSend(ws, {
            type: `${msgType}_result`,
            request_id: requestId,
            ok: false,
            error: "device_not_online",
          });
          return;
        }

        const requestId = msg?.request_id ? String(msg.request_id) : randomUUID();
        pendingRequests.set(requestId, {
          type: "connector_rpc",
          browserWs: ws,
          userId,
          deviceId,
          rpcType: msgType,
        });

        const ok = wsSend(connectorWs, { ...msg, request_id: requestId });
        if (!ok) {
          pendingRequests.delete(requestId);
          wsSend(ws, {
            type: `${msgType}_result`,
            request_id: requestId,
            ok: false,
            error: "connector_send_failed",
          });
        }
        return;
      }

      return;
    }

    // ===== Connector actions =====
    if (info.kind === "connector") {
      const deviceId = info.deviceId;
      const userId = info.userId;

      if (msg?.type === "connector_health") {
        const normalized = normalizeConnectorHealth(msg?.health);
        if (!normalized) return;
        const prev = healthByDevice.get(deviceId) || null;
        const merged = mergeConnectorHealthSnapshot(prev, normalized);
        const prevDigest = JSON.stringify(prev || {});
        const nextDigest = JSON.stringify(merged || {});
        if (prevDigest === nextDigest) return;
        healthByDevice.set(deviceId, merged);
        if (merged.aiyra_voice) {
          persistAiyraVoiceHealthSnapshot({
            deviceId,
            userId,
            health: merged.aiyra_voice,
          }).catch(() => {});
        }
        const deviceOnlineMsg = buildDeviceOnlineMessage(deviceId);
        broadcastToUser(userId, deviceOnlineMsg);
        await broadcastToDeviceWorkspace(deviceId, deviceOnlineMsg);
        return;
      }

      if (msg?.type === "schedule_sync_request") {
        const fetched = await fetchScheduledJobs({ deviceId });
        if (fetched.error) {
          wsSend(ws, { type: "schedule_sync", ok: false, error: fetched.error });
          return;
        }
        wsSend(ws, {
          type: "schedule_sync",
          ok: true,
          device_id: deviceId,
          jobs: fetched.jobs,
          server_time: new Date().toISOString(),
        });
        return;
      }

      if (msg?.type === "schedule_run_report") {
        const jobId = String(msg?.job_id || "");
        const status = String(msg?.status || "");
        if (!jobId || !status) return;

        const startedAt = msg?.started_at ? String(msg.started_at) : null;
        const finishedAt = msg?.finished_at ? String(msg.finished_at) : null;
        const durationMs =
          typeof msg?.duration_ms === "number" ? Number(msg.duration_ms) : null;
        const exitCode =
          typeof msg?.exit_code === "number" ? Number(msg.exit_code) : null;
        const stdout = typeof msg?.stdout === "string" ? msg.stdout : null;
        const stderr = typeof msg?.stderr === "string" ? msg.stderr : null;
        const errorText = typeof msg?.error === "string" ? msg.error : null;
        const consumeSkipNext = msg?.consume_skip_next === true;
        const retryableError = msg?.retryable_error === true;
        const whatsappTargetChatId =
          typeof msg?.whatsapp_target_chat_id === "string"
            ? msg.whatsapp_target_chat_id.trim()
            : "";
        const whatsappTargetRecipientQuery =
          typeof msg?.whatsapp_target_recipient_query === "string"
            ? msg.whatsapp_target_recipient_query.trim()
            : "";

        const lookedUp = await fetchScheduledJobForDevice({ jobId, deviceId });
        if (!lookedUp.job) {
          // Ignore reports for unknown jobs (may have been deleted)
          return;
        }
        if (lookedUp.job.user_id !== userId) return;

        const ins = await insertScheduledJobRun({
          userId,
          deviceId,
          jobId,
          status,
          exitCode,
          startedAt,
          finishedAt,
          durationMs,
          stdout,
          stderr,
          error: errorText,
        });

        await updateScheduledJobAfterRun({
          jobId,
          status,
          exitCode,
          finishedAt: finishedAt || startedAt || new Date().toISOString(),
          consumeSkipNext,
          retryableError,
        });
        if (
          (whatsappTargetChatId || whatsappTargetRecipientQuery) &&
          lookedUp.job?.task
        ) {
          const persistedTarget = await persistScheduledJobWhatsAppTarget({
            jobId,
            task: lookedUp.job.task,
            chatId: whatsappTargetChatId,
            recipientQuery: whatsappTargetRecipientQuery,
          });
          if (persistedTarget?.error) {
            console.warn("[relay] schedule whatsapp target persist failed", {
              jobId,
              error: persistedTarget.error,
            });
          }
        }

        // Heartbeat 30-day retention: prune old runs (best-effort, async)
        try {
          const taskRes = await supabaseService(
            `/rest/v1/scheduled_jobs?id=eq.${jobId}&select=task`,
            { method: "GET", headers: { Accept: "application/json" } }
          );
          if (taskRes.ok) {
            const taskRows = await taskRes.json();
            const taskObj = Array.isArray(taskRows) && taskRows[0]?.task;
            if (taskObj && typeof taskObj === "object" && taskObj.type === "heartbeat_v1") {
              pruneOldHeartbeatRuns({ jobId }).catch(() => {});
            }
          }
        } catch {
          // best-effort
        }

        // Notify browsers (UI) about the run.
        broadcastToUser(userId, {
          type: "schedule_run_report",
          device_id: deviceId,
          job_id: jobId,
          status,
          exit_code: exitCode,
          started_at: startedAt,
          finished_at: finishedAt,
          duration_ms: durationMs,
          run: ins.run,
        });
        return;
      }

      if (msg?.type === "workspace_pick_result") {
        const requestId = String(msg?.request_id || "");
        const pending = pendingRequests.get(requestId);
        if (!pending || pending.type !== "workspace_pick") return;
        pendingRequests.delete(requestId);

        if (pending.userId !== userId || pending.deviceId !== deviceId) return;

        // Broadcast to all of the user's browser sockets rather than the original
        // pending.browserWs — the OS folder picker steals focus, which can trigger
        // a reconnect in useRelay while the picker is open, leaving the original
        // socket closed by the time the reply arrives.
        const ok = Boolean(msg?.ok);
        if (!ok) {
          broadcastToUser(pending.userId, {
            type: "workspace_pick_result",
            request_id: requestId,
            ok: false,
            error: msg?.error || "cancelled",
          });
          return;
        }

        const rootPath = String(msg?.root_path || "");
        if (!rootPath) {
          broadcastToUser(pending.userId, {
            type: "workspace_pick_result",
            request_id: requestId,
            ok: false,
            error: "missing_root_path",
          });
          return;
        }

        const created = await createWorkspace({
          userId,
          deviceId,
          rootPath,
          label: msg?.label ? String(msg.label) : null,
        });
        if (created.error) {
          broadcastToUser(pending.userId, {
            type: "workspace_pick_result",
            request_id: requestId,
            ok: false,
            error: created.error,
          });
          return;
        }

        broadcastToUser(pending.userId, {
          type: "workspace_added",
          request_id: requestId,
          ok: true,
          workspace: created.workspace,
        });
        return;
      }

      // ===== Claude CLI responses from connector =====
      if (msg?.type === "claude_discover_commands_result") {
        const requestId = String(msg?.request_id || "");
        const pending = pendingRequests.get(requestId);
        if (!pending || pending.type !== "claude_discover_commands") return;
        pendingRequests.delete(requestId);
        if (pending.userId !== userId || pending.deviceId !== deviceId) return;

        wsSend(pending.browserWs, {
          type: "claude_discover_commands_result",
          request_id: requestId,
          ok: Boolean(msg?.ok),
          commands: Array.isArray(msg?.commands) ? msg.commands : [],
          error: msg?.error || null,
          duration_ms: msg?.duration_ms || null,
          discovered_at: msg?.discovered_at || null,
        });
        return;
      }

      if (msg?.type === "claude_run_progress") {
        const requestId = String(msg?.request_id || "");
        const pending = pendingRequests.get(requestId);
        if (!pending || pending.type !== "claude_run") return;
        if (pending.userId !== userId || pending.deviceId !== deviceId) return;

        // Forward progress to browser
        if (pending.browserWs) {
          wsSend(pending.browserWs, {
            type: "claude_run_progress",
            request_id: requestId,
            content: msg?.content || "",
            event_type: msg?.event_type || "assistant",
            tool_name: msg?.tool_name || null,
            tool_input: msg?.tool_input || null,
          });
        }
        return;
      }

      if (msg?.type === "claude_run_result") {
        const requestId = String(msg?.request_id || "");
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        if (pending.type === "connector_rpc_internal" || pending.type === "connector_rpc") {
          pendingRequests.delete(requestId);
          if (pending.timeoutId) clearTimeout(pending.timeoutId);
          if (pending.userId !== userId || pending.deviceId !== deviceId) return;
          if (pending.type === "connector_rpc_internal" && typeof pending.resolve === "function") {
            pending.resolve(msg && typeof msg === "object" ? msg : {});
          } else if (pending.browserWs) {
            wsSend(pending.browserWs, msg);
          }
          return;
        }
        if (pending.type !== "claude_run") return;
        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
          pending.timeoutId = null;
        }
        if (pending.userId !== userId || pending.deviceId !== deviceId) {
          pendingRequests.delete(requestId);
          return;
        }

        const resultObject =
          msg?.result && typeof msg.result === "object" && !Array.isArray(msg.result)
            ? msg.result
            : null;
        const usageObject =
          msg?.usage && typeof msg.usage === "object" && !Array.isArray(msg.usage)
            ? msg.usage
            : resultObject?.usage && typeof resultObject.usage === "object" && !Array.isArray(resultObject.usage)
              ? resultObject.usage
              : null;
        const pickFiniteNumber = (...values) => {
          for (const value of values) {
            const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
            if (Number.isFinite(n)) return n;
          }
          return null;
        };
        const forwardedDiffs = Array.isArray(msg?.diffs)
          ? msg.diffs
          : Array.isArray(msg?.result?.diffs)
            ? msg.result.diffs
            : null;
        const forwardedCostUsd =
          pickFiniteNumber(msg?.cost_usd, msg?.total_cost_usd, resultObject?.total_cost_usd, resultObject?.cost_usd);
        const forwardedInputTokens = pickFiniteNumber(
          msg?.input_tokens,
          resultObject?.input_tokens,
          usageObject?.input_tokens,
          usageObject?.inputTokens
        );
        const forwardedOutputTokens = pickFiniteNumber(
          msg?.output_tokens,
          resultObject?.output_tokens,
          usageObject?.output_tokens,
          usageObject?.outputTokens
        );
        const forwardedTotalTokens =
          pickFiniteNumber(
            msg?.total_tokens,
            resultObject?.total_tokens,
            usageObject?.total_tokens,
            usageObject?.totalTokens
          ) ??
          (typeof forwardedInputTokens === "number" && typeof forwardedOutputTokens === "number"
            ? forwardedInputTokens + forwardedOutputTokens
            : null);
        const forwardedModel =
          (typeof msg?.model === "string" && msg.model.trim()) ||
          (typeof resultObject?.model === "string" && resultObject.model.trim()) ||
          (typeof resultObject?.model_name === "string" && resultObject.model_name.trim()) ||
          null;

        // Forward result to browser
        const resultPayload = {
          type: "claude_run_result",
          request_id: requestId,
          ok: Boolean(msg?.ok),
          result: msg?.result?.result || msg?.result || null,
          session_id: msg?.session_id || msg?.result?.session_id || null,
          model: forwardedModel,
          total_cost_usd: forwardedCostUsd,
          cost_usd: forwardedCostUsd,
          input_tokens: forwardedInputTokens,
          output_tokens: forwardedOutputTokens,
          total_tokens: forwardedTotalTokens,
          usage: usageObject,
          duration_ms: msg?.duration_ms || null,
          error: msg?.error || null,
          diffs: forwardedDiffs,
        };
        const sent = pending.browserWs ? wsSend(pending.browserWs, resultPayload) : false;

        if (pending.persistResult !== false) {
          // PWA may suspend without processing — persist the final result so wake recovery
          // does not depend on a live socket.
          persistClaudeRunResult({
            pending,
            resultPayload,
            forwardedDiffs,
            forwardedCostUsd,
          }).catch((err) => {
            console.error("[relay] persistClaudeRunResult unhandled:", err?.message || err);
          });
        }
        if (!sent) {
          console.warn("[relay] claude_run_result browser send failed; relying on persisted recovery", {
            requestId,
            agentId: pending.agentId || null,
            browserInstanceId: pending.browserInstanceId || null,
          });
        }
        pendingRequests.delete(requestId);
        return;
      }

      if (msg?.type === "terminal_opened") {
        const requestId = String(msg?.request_id || "");
        const pending = pendingRequests.get(requestId);
        if (!pending || pending.type !== "terminal_open") return;
        pendingRequests.delete(requestId);
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        if (pending.userId !== userId || pending.deviceId !== deviceId) return;

        const terminalId = String(msg?.terminal_id || pending.terminalId || "");
        if (!terminalId) return;

        terminalOwner.set(terminalId, {
          deviceId,
          connectorWs: ws,
          persist: pending.persist !== false,
          connected: true,
        });
        terminalBuffers.set(terminalId, "");
        const subs = terminalSubs.get(terminalId) || new Set();
        subs.add(pending.browserWs);
        terminalSubs.set(terminalId, subs);

        const t = terminalCloseTimers.get(terminalId);
        if (t) {
          clearTimeout(t);
          terminalCloseTimers.delete(terminalId);
        }

        wsSend(pending.browserWs, {
          type: "terminal_opened",
          request_id: requestId,
          terminal_id: terminalId,
        });
        return;
      }

      if (msg?.type === "terminal_open_failed") {
        const requestId = String(msg?.request_id || "");
        const pending = pendingRequests.get(requestId);
        if (!pending || pending.type !== "terminal_open") return;
        pendingRequests.delete(requestId);
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        if (pending.userId !== userId || pending.deviceId !== deviceId) return;

        wsSend(pending.browserWs, {
          type: "terminal_open_failed",
          request_id: requestId,
          terminal_id: String(msg?.terminal_id || ""),
          error: String(msg?.error || "terminal_open_failed"),
        });
        return;
      }

      // ===== Generic connector RPC results =====
      // Forward any message that has a request_id matching a pending connector_rpc.
      if (msg?.request_id) {
        const requestId = String(msg.request_id || "");
        const pending = pendingRequests.get(requestId);
        if (pending && (pending.type === "connector_rpc" || pending.type === "connector_rpc_internal")) {
          pendingRequests.delete(requestId);
          if (pending.timeoutId) clearTimeout(pending.timeoutId);
          if (pending.userId !== userId || pending.deviceId !== deviceId) return;
          if (pending.type === "connector_rpc_internal") {
            if (typeof pending.resolve === "function") {
              pending.resolve(msg && typeof msg === "object" ? msg : {});
            }
            return;
          }
          wsSend(pending.browserWs, msg);
          return;
        }
      }

      if (msg?.type === "terminal_data") {
        const terminalId = String(msg?.terminal_id || "");
        const data = String(msg?.data || "");
        if (!terminalId || !data) return;

        // Append to terminal buffer (used to restore view on resubscribe)
        const prev = terminalBuffers.get(terminalId) || "";
        terminalBuffers.set(terminalId, (prev + data).slice(-TERMINAL_BUFFER_MAX));

        const subs = terminalSubs.get(terminalId);
        if (!subs) return;
        const connected = webrtcConnectedBrowsersByTerminal.get(terminalId);
        for (const bws of subs) {
          if (connected && connected.has(bws)) continue;
          wsSend(bws, { type: "terminal_data", terminal_id: terminalId, data });
        }
        return;
      }

      if (msg?.type === "terminal_closed") {
        const terminalId = String(msg?.terminal_id || "");
        if (!terminalId) return;
        const owner = terminalOwner.get(terminalId);
        const persist = owner?.persist === true;
        const subs = terminalSubs.get(terminalId);
        if (subs) {
          for (const bws of subs) {
            wsSend(bws, { type: "terminal_closed", terminal_id: terminalId });
          }
        }
        const t = terminalCloseTimers.get(terminalId);
        if (t) {
          clearTimeout(t);
          terminalCloseTimers.delete(terminalId);
        }
        terminalBuffers.delete(terminalId);
        webrtcConnectedBrowsersByTerminal.delete(terminalId);
        terminalSubs.delete(terminalId);
        terminalOwner.delete(terminalId);
        if (persist) {
          // If a persistent terminal closed, ensure any stale WebRTC sessions are cleaned up.
          for (const [key, sess] of webrtcSessions.entries()) {
            if (sess.terminalId === terminalId) webrtcSessions.delete(key);
          }
        }
        return;
      }

      // ===== WebRTC signaling (connector -> browser via relay) =====
      if (msg?.type === "webrtc_answer") {
        const terminalId = String(msg?.terminal_id || "");
        const webrtcId = String(msg?.webrtc_id || "");
        const sdp = String(msg?.sdp || "");
        const sdpType = String(msg?.sdp_type || "answer");
        if (!terminalId || !webrtcId || !sdp || sdpType !== "answer") return;

        const key = webrtcKey(terminalId, webrtcId);
        const sess = webrtcSessions.get(key);
        if (!sess) return;
        if (sess.deviceId !== deviceId || sess.userId !== userId) return;

        wsSend(sess.browserWs, {
          type: "webrtc_answer",
          terminal_id: terminalId,
          webrtc_id: webrtcId,
          sdp,
          sdp_type: "answer",
        });
        return;
      }

      if (msg?.type === "webrtc_ice") {
        const terminalId = String(msg?.terminal_id || "");
        const webrtcId = String(msg?.webrtc_id || "");
        const candidate = msg?.candidate || null;
        if (!terminalId || !webrtcId || !candidate) return;

        const key = webrtcKey(terminalId, webrtcId);
        const sess = webrtcSessions.get(key);
        if (!sess) return;
        if (sess.deviceId !== deviceId || sess.userId !== userId) return;

        wsSend(sess.browserWs, {
          type: "webrtc_ice",
          terminal_id: terminalId,
          webrtc_id: webrtcId,
          candidate,
        });
        return;
      }

      if (msg?.type === "webrtc_error") {
        const terminalId = String(msg?.terminal_id || "");
        const webrtcId = String(msg?.webrtc_id || "");
        const error = String(msg?.error || "webrtc_error");
        if (!terminalId || !webrtcId) return;

        const key = webrtcKey(terminalId, webrtcId);
        const sess = webrtcSessions.get(key);
        if (!sess) return;
        if (sess.deviceId !== deviceId || sess.userId !== userId) return;

        wsSend(sess.browserWs, {
          type: "webrtc_error",
          terminal_id: terminalId,
          webrtc_id: webrtcId,
          error,
        });
        return;
      }
    }
  });

  ws.on("close", async () => {
    const info = sessionInfo.get(ws);
    if (!info) return;
    if (info.kind === "browser") {
      removeBrowser(info.userId, ws);
      // Remove from any terminal subscriptions
      for (const subs of terminalSubs.values()) subs.delete(ws);
      // Remove from any WebRTC-connected terminal sets
      for (const [terminalId, subs] of webrtcConnectedBrowsersByTerminal.entries()) {
        subs.delete(ws);
        if (subs.size === 0) webrtcConnectedBrowsersByTerminal.delete(terminalId);
      }
      // Remove any WebRTC sessions owned by this browser ws
      for (const [key, sess] of webrtcSessions.entries()) {
        if (sess.browserWs === ws) webrtcSessions.delete(key);
      }

      // Drop pending requests owned by this browser ws.
      // For in-flight browser_task_run requests, also signal connector-side cancel
      // so long-running Playwright/Claude tasks do not continue after tab reload/close.
      for (const [requestId, pending] of pendingRequests.entries()) {
        if (pending?.browserWs !== ws) continue;
        if (pending?.type === "claude_run") {
          // Keep Claude runs alive across browser reconnects. The matching browser
          // instance can rebind on the next browser_hello, and the final result is
          // persisted server-side if the browser never comes back.
          pending.browserWs = null;
          pending.disconnectedAt = Date.now();
          continue;
        }
        pendingRequests.delete(requestId);
        if (pending?.timeoutId) {
          try {
            clearTimeout(pending.timeoutId);
          } catch {
            // ignore
          }
        }

        if (
          pending?.type === "connector_rpc" &&
          pending?.rpcType === "browser_task_run" &&
          pending?.deviceId
        ) {
          const connectorWs = connectorByDevice.get(String(pending.deviceId || ""));
          if (connectorWs) {
            wsSend(connectorWs, {
              type: "browser_task_cancel",
              request_id: `relay-cancel-${requestId}`,
              target_request_id: requestId,
            });
          }
        }
      }
      return;
    }
    if (info.kind === "connector") {
      // Only clear the device mapping if this ws is still the active connector.
      // Otherwise, an old connection closing could incorrectly knock a device offline.
      const current = connectorByDevice.get(info.deviceId);
      if (current === ws) {
        connectorByDevice.delete(info.deviceId);
        userByDevice.delete(info.deviceId);
        versionByDevice.delete(info.deviceId);
        capabilitiesByDevice.delete(info.deviceId);
        healthByDevice.delete(info.deviceId);
        broadcastToUser(info.userId, {
          type: "device_offline",
          device_id: info.deviceId,
        });
        await broadcastToDeviceWorkspace(info.deviceId, {
          type: "device_offline",
          device_id: info.deviceId,
        });
      }
      for (const [requestId, pending] of pendingRequests.entries()) {
        if (pending?.deviceId !== info.deviceId) continue;
        if (pending?.type !== "connector_rpc_internal" && pending?.type !== "connector_rpc") continue;
        pendingRequests.delete(requestId);
        if (pending?.timeoutId) {
          try {
            clearTimeout(pending.timeoutId);
          } catch {
            // ignore
          }
        }
        if (pending?.type === "connector_rpc" && pending?.browserWs) {
          wsSend(pending.browserWs, {
            type: `${String(pending.rpcType || "connector_rpc")}_result`,
            request_id: requestId,
            ok: false,
            error: "device_not_online",
          });
          continue;
        }
        if (typeof pending.reject === "function") {
          pending.reject(new Error("device_not_online"));
        }
      }
      // Remove any WebRTC sessions owned by this device
      for (const [key, sess] of webrtcSessions.entries()) {
        if (sess.deviceId === info.deviceId) webrtcSessions.delete(key);
      }
      // Close all terminals owned by this connector
      for (const [terminalId, owner] of terminalOwner.entries()) {
        if (owner.deviceId === info.deviceId) {
          // Persistent terminals should survive connector reconnects.
          if (owner.persist === true) {
            terminalOwner.set(terminalId, { ...owner, connectorWs: null, connected: false });
            // Keep buffers + subscriptions so the UI can reattach.
            continue;
          }

          const subs = terminalSubs.get(terminalId);
          if (subs) {
            for (const bws of subs) {
              wsSend(bws, { type: "terminal_closed", terminal_id: terminalId });
            }
          }
          terminalBuffers.delete(terminalId);
          webrtcConnectedBrowsersByTerminal.delete(terminalId);
          terminalSubs.delete(terminalId);
          terminalOwner.delete(terminalId);
        }
      }
    }
  });
});

const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, () => {
  console.log(`FLOW relay listening on :${PORT}`);
});
