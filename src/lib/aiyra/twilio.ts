import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import { sendAiyraRuntimeTextViaRelay } from "@/lib/relay/aiyraRuntime";

type ChannelMode = "mic_main" | "twilio_main" | "twilio_parent";

export type AiyraTwilioSupervisorState = {
  id: string | null;
  at: string | null;
  childConversationId: string | null;
  childKind: string | null;
  status: string | null;
  stage: string | null;
  summary: string | null;
  rawText: string | null;
  callSid: string | null;
  messageSid: string | null;
  speakSuggested: boolean | null;
};

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeBaseUrl(input: string): string {
  return (trimmed(input) || "https://omnirion.ai").replace(/\/+$/, "");
}

function toNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = trimmed(value);
    if (text) return text;
  }
  return null;
}

function resolveEffectiveTwilioFromNumber(args: {
  requestedFrom: string | null;
  requestedTo: string | null;
  configuredFrom: string | null;
}): string | null {
  const requestedFrom = firstNonEmptyString(args.requestedFrom);
  const requestedTo = firstNonEmptyString(args.requestedTo);
  const configuredFrom = firstNonEmptyString(args.configuredFrom);

  // Models sometimes incorrectly copy the recipient into `from`.
  // When that happens, prefer the configured sender instead.
  if (requestedFrom && requestedTo && requestedFrom === requestedTo) {
    if (configuredFrom && configuredFrom !== requestedFrom) {
      return configuredFrom;
    }
    return null;
  }

  return requestedFrom || configuredFrom || null;
}

function buildAiyraHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "x-aiyra-api-key": apiKey,
  };
}

function getOpenClawBaseUrl(): string {
  return normalizeBaseUrl(
    process.env.OPENCLAW_BASE_URL || process.env.AIYRA_BASE_URL || ""
  );
}

function getAiyraConfigPath(): string {
  return trimmed(process.env.OPENCLAW_AIYRA_CONFIG_PATH) || "/api/aiyra/config";
}

async function callOpenClawJson(args: {
  apiKey: string;
  path: string;
  body: Record<string, unknown>;
}): Promise<{
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
  text: string;
}> {
  const path = args.path.startsWith("/") ? args.path : `/${args.path}`;
  const response = await fetch(`${getOpenClawBaseUrl()}${path}`, {
    method: "POST",
    headers: buildAiyraHeaders(args.apiKey),
    body: JSON.stringify(args.body),
  });
  const text = await response.text().catch(() => "");
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  return {
    ok: response.ok,
    status: response.status,
    payload,
    text,
  };
}

async function loadUserAiyraTwilioDefaults(args: {
  supabase: SupabaseClient;
  userId: string;
  apiKey: string;
}): Promise<{
  enabled: boolean;
  from: string | null;
  to: string | null;
}> {
  const extractDefaults = (payload: Record<string, unknown>) => {
    const root = asRecord(payload) || {};
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
    return {
      enabled: twilio.enabled === true,
      from: firstNonEmptyString(twilio.from),
      to: firstNonEmptyString(twilio.to),
    };
  };

  const loadFromConversation = async (conversationId: string) => {
    const response = await callOpenClawJson({
      apiKey: args.apiKey,
      path: getAiyraConfigPath(),
      body: {
        apiKey: args.apiKey,
        autoLoadOnly: true,
        conversationId,
      },
    });
    return response.ok ? extractDefaults(response.payload) : null;
  };

  const { data: rows, error } = await args.supabase
    .from("aiyra_conversations")
    .select("conversation_id, channel_mode, updated_at")
    .eq("user_id", args.userId)
    .in("channel_mode", ["mic_main", "twilio_main"])
    .order("updated_at", { ascending: false })
    .limit(6);
  if (error) {
    throw new Error(error.message);
  }

  const conversationIds = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const record = row as {
        conversation_id?: unknown;
        channel_mode?: unknown;
      };
      return {
        conversationId: trimmed(record.conversation_id),
        channelMode: trimmed(record.channel_mode),
      };
    })
    .filter((row) => row.conversationId)
    .sort((a, b) => {
      if (a.channelMode === b.channelMode) return 0;
      if (a.channelMode === "mic_main") return -1;
      if (b.channelMode === "mic_main") return 1;
      return 0;
    });

  for (const row of conversationIds) {
    const defaults = await loadFromConversation(row.conversationId).catch(() => null);
    if (defaults?.from || defaults?.to || defaults?.enabled) {
      return defaults;
    }
  }

  const fallbackResponse = await callOpenClawJson({
    apiKey: args.apiKey,
    path: getAiyraConfigPath(),
    body: {
      apiKey: args.apiKey,
      autoLoadOnly: true,
    },
  });
  if (!fallbackResponse.ok) {
    return {
      enabled: false,
      from: null,
      to: null,
    };
  }

  return extractDefaults(fallbackResponse.payload);
}

export async function loadUserAiyraApiKey(args: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<string | null> {
  const { data, error } = await args.supabase
    .from("user_aiyra_settings")
    .select("api_key_enc")
    .eq("user_id", args.userId)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  const encrypted =
    data && typeof data === "object" ? trimmed((data as { api_key_enc?: unknown }).api_key_enc) : "";
  if (!encrypted) return null;
  try {
    return decryptLlmApiKey(encrypted);
  } catch {
    throw new Error("Failed to decrypt stored Aiyra API key");
  }
}

export async function getOrCreateSessionScopedAiyraConversation(args: {
  supabase: SupabaseClient;
  userId: string;
  orchestratorSessionId: string;
  channelMode?: ChannelMode;
  deviceId?: string | null;
}): Promise<{
  conversationId: string;
  channelMode: ChannelMode;
}> {
  const channelMode = args.channelMode || "twilio_main";
  const nowIso = new Date().toISOString();
  const { data: rows, error } = await args.supabase
    .from("aiyra_conversations")
    .select("conversation_id")
    .eq("user_id", args.userId)
    .eq("orchestrator_session_id", args.orchestratorSessionId)
    .eq("channel_mode", channelMode)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(error.message);
  }
  const existing = Array.isArray(rows) ? rows[0] : null;
  const existingConversationId =
    existing && typeof existing === "object"
      ? trimmed((existing as { conversation_id?: unknown }).conversation_id)
      : "";
  if (existingConversationId) {
    await args.supabase
      .from("aiyra_conversations")
      .update({
        updated_at: nowIso,
        ...(args.deviceId ? { device_id: args.deviceId } : {}),
      })
      .eq("user_id", args.userId)
      .eq("conversation_id", existingConversationId);
    return {
      conversationId: existingConversationId,
      channelMode,
    };
  }

  const conversationId = `aiyra-${randomUUID()}`;
  const { error: insertError } = await args.supabase.from("aiyra_conversations").insert({
    conversation_id: conversationId,
    user_id: args.userId,
    orchestrator_session_id: args.orchestratorSessionId,
    channel_mode: channelMode,
    ...(args.deviceId ? { device_id: args.deviceId } : {}),
    updated_at: nowIso,
  });
  if (insertError) {
    throw new Error(insertError.message);
  }
  return {
    conversationId,
    channelMode,
  };
}

export function normalizeTwilioSupervisorState(
  raw: unknown
): AiyraTwilioSupervisorState | null {
  const root = asRecord(raw);
  const update = asRecord(root?.update) || root;
  if (!update) return null;
  const state: AiyraTwilioSupervisorState = {
    id: firstNonEmptyString(update.id),
    at: firstNonEmptyString(update.at, update.updated_at),
    childConversationId: firstNonEmptyString(
      update.childConversationId,
      update.child_conversation_id
    ),
    childKind: firstNonEmptyString(update.childKind, update.child_kind),
    status: firstNonEmptyString(update.status),
    stage: firstNonEmptyString(update.stage),
    summary: firstNonEmptyString(update.summary),
    rawText: firstNonEmptyString(update.rawText, update.raw_text),
    callSid: firstNonEmptyString(update.callSid, update.call_sid),
    messageSid: firstNonEmptyString(update.messageSid, update.message_sid),
    speakSuggested:
      toNullableBoolean(update.speakSuggested) ??
      toNullableBoolean(update.speak_suggested),
  };
  const hasAnyValue = Object.values(state).some((value) => value !== null);
  return hasAnyValue ? state : null;
}

function parseTwilioSupervisorStateTime(state: AiyraTwilioSupervisorState | null): number | null {
  const at = firstNonEmptyString(state?.at);
  if (!at) return null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTerminalTwilioSupervisorState(state: AiyraTwilioSupervisorState | null): boolean {
  const status = trimmed(state?.status).toLowerCase();
  return status === "completed" || status === "ended" || status === "failed";
}

function getTwilioSupervisorIdentityParts(
  state: AiyraTwilioSupervisorState | null
): string[] {
  if (!state) return [];
  return [
    firstNonEmptyString(state.childConversationId),
    firstNonEmptyString(state.callSid),
    firstNonEmptyString(state.messageSid),
    firstNonEmptyString(state.id),
  ].filter((value): value is string => !!value);
}

function twilioSupervisorStatesReferToSameChild(
  a: AiyraTwilioSupervisorState | null,
  b: AiyraTwilioSupervisorState | null
): boolean {
  const aParts = getTwilioSupervisorIdentityParts(a);
  const bParts = getTwilioSupervisorIdentityParts(b);
  if (aParts.length === 0 || bParts.length === 0) return false;
  const bSet = new Set(bParts);
  return aParts.some((value) => bSet.has(value));
}

function selectPreferredTwilioSupervisorState(args: {
  relayState: AiyraTwilioSupervisorState | null;
  persistedState: AiyraTwilioSupervisorState | null;
}): AiyraTwilioSupervisorState | null {
  const relayState = args.relayState;
  const persistedState = args.persistedState;
  if (!relayState) return persistedState;
  if (!persistedState) return relayState;

  const relayTime = parseTwilioSupervisorStateTime(relayState);
  const persistedTime = parseTwilioSupervisorStateTime(persistedState);
  const relayTerminal = isTerminalTwilioSupervisorState(relayState);
  const persistedTerminal = isTerminalTwilioSupervisorState(persistedState);
  const sameChild = twilioSupervisorStatesReferToSameChild(relayState, persistedState);

  if (!sameChild) {
    if (relayTerminal !== persistedTerminal) {
      return relayTerminal ? persistedState : relayState;
    }
    if (relayTime !== null || persistedTime !== null) {
      return (persistedTime ?? -Infinity) >= (relayTime ?? -Infinity)
        ? persistedState
        : relayState;
    }
  }

  // Once the DB has a terminal state, do not let a stale in-memory "active"
  // snapshot override it unless the relay state is clearly newer.
  if (relayTerminal !== persistedTerminal) {
    if (persistedTerminal) {
      if (
        relayTime !== null &&
        persistedTime !== null &&
        relayTime > persistedTime
      ) {
        return relayState;
      }
      return persistedState;
    }
    if (
      relayTerminal &&
      relayTime !== null &&
      persistedTime !== null &&
      persistedTime > relayTime
    ) {
      return persistedState;
    }
    return relayState;
  }

  if (relayTime !== null || persistedTime !== null) {
    return (persistedTime ?? -Infinity) >= (relayTime ?? -Infinity)
      ? persistedState
      : relayState;
  }

  const relayDetail = firstNonEmptyString(relayState.summary, relayState.rawText);
  const persistedDetail = firstNonEmptyString(
    persistedState.summary,
    persistedState.rawText
  );
  if (persistedDetail && !relayDetail) return persistedState;
  return relayState;
}

function buildTwilioSupervisorStatusSummary(
  state: AiyraTwilioSupervisorState
): string {
  const kind = firstNonEmptyString(state.childKind, "task") || "task";
  const status = firstNonEmptyString(state.status, "unknown") || "unknown";
  const stage = firstNonEmptyString(state.stage);
  const detail = firstNonEmptyString(state.summary, state.rawText);
  const parts = [`${kind} status: ${status}.`];
  if (stage) parts.push(`Stage: ${stage}.`);
  if (detail) parts.push(`Latest detail: ${detail}`);
  return parts.join(" ");
}

async function resolveTwilioParentConversation(args: {
  supabase: SupabaseClient;
  userId: string;
  orchestratorSessionId: string;
  sourceConversationId?: string | null;
  deviceId?: string | null;
}): Promise<{
  conversationId: string;
  usesSourceConversation: boolean;
}> {
  const sourceConversationId = firstNonEmptyString(args.sourceConversationId);
  const nowIso = new Date().toISOString();
  if (sourceConversationId) {
    const { data, error } = await args.supabase
      .from("aiyra_conversations")
      .select("conversation_id")
      .eq("user_id", args.userId)
      .eq("conversation_id", sourceConversationId)
      .limit(1);
    if (error) {
      throw new Error(error.message);
    }
    const existing = Array.isArray(data) ? data[0] : null;
    const existingConversationId =
      existing && typeof existing === "object"
        ? firstNonEmptyString((existing as { conversation_id?: unknown }).conversation_id)
        : null;
    if (existingConversationId) {
      await args.supabase
        .from("aiyra_conversations")
        .update({
          updated_at: nowIso,
          ...(args.deviceId ? { device_id: args.deviceId } : {}),
        })
        .eq("user_id", args.userId)
        .eq("conversation_id", existingConversationId);
      return {
        conversationId: existingConversationId,
        usesSourceConversation: true,
      };
    }
  }

  const created = await getOrCreateSessionScopedAiyraConversation({
    supabase: args.supabase,
    userId: args.userId,
    orchestratorSessionId: args.orchestratorSessionId,
    channelMode: "twilio_parent",
    deviceId: args.deviceId,
  });
  return {
    conversationId: created.conversationId,
    usesSourceConversation: false,
  };
}

function readRelayAssistantText(payload: Record<string, unknown>): string | null {
  return firstNonEmptyString(
    payload.assistantText,
    payload.assistant_text,
    payload.responseText,
    payload.response_text,
    payload.text
  );
}

function readRelayWarning(payload: Record<string, unknown>): string | null {
  return firstNonEmptyString(payload.warning, payload.detail, payload.message);
}

function buildTwilioStartPrompt(args: {
  kind: "call" | "sms";
  to: string | null;
  message: string | null;
  lang: string | null;
}): string {
  const lines = [
    args.kind === "sms"
      ? "Start a supervised outbound SMS now."
      : "Start a supervised outbound phone call now.",
    args.to
      ? `Destination phone number: ${args.to}`
      : "Use the configured default destination phone number.",
  ];
  if (args.kind === "sms" && args.message) {
    lines.push(`Send this SMS body verbatim:\n${args.message}`);
  } else if (args.message) {
    lines.push(`Call objective:\n${args.message}`);
  }
  if (args.kind === "call") {
    lines.push(
      "If voicemail or an answering machine picks up, do not hang up silently. Leave a concise voicemail that identifies Groovy, explains why you called, and conveys the most important parts of the request.",
      "After leaving voicemail, if a short SMS follow-up would materially help deliver the same message, send a concise follow-up text as well using your built-in Twilio tooling. Skip the SMS only when the user clearly wanted call-only contact or a follow-up text would be inappropriate."
    );
  }
  if (args.lang) {
    lines.push(`Language hint: ${args.lang}`);
  }
  lines.push(
    "Use your built-in Twilio tooling for this conversation.",
    "Do not call material-query for this turn.",
    "Begin immediately and continue reporting supervisor updates on this conversation."
  );
  return lines.join("\n\n");
}

function buildTwilioStatusPrompt(): string {
  return [
    "Report the current status of the active supervised Twilio task on this conversation.",
    "Include the latest child kind, status, stage, and a concise summary.",
    "Use your built-in Twilio tooling for this conversation.",
    "Do not call material-query for this turn.",
  ].join("\n\n");
}

function buildTwilioCoachPrompt(message: string): string {
  return [
    "Apply this coaching instruction to the active supervised Twilio task now:",
    message,
    "Use your built-in Twilio tooling for this conversation.",
    "Do not call material-query for this turn.",
  ].join("\n\n");
}

function buildInitialSupervisorStateFromStartResponse(args: {
  kind: "call" | "sms";
  responsePayload: Record<string, unknown>;
  requestBody: Record<string, unknown>;
}): AiyraTwilioSupervisorState {
  const normalizedExisting = normalizeTwilioSupervisorState(args.responsePayload);
  if (normalizedExisting) {
    return {
      ...normalizedExisting,
      childKind: normalizedExisting.childKind || args.kind,
      status: normalizedExisting.status || "starting",
      stage:
        normalizedExisting.stage ||
        (args.kind === "sms" && firstNonEmptyString(args.responsePayload.messageSid)
          ? "sms_sent"
          : "starting"),
      at: normalizedExisting.at || new Date().toISOString(),
    };
  }

  const to = firstNonEmptyString(args.responsePayload.to, args.requestBody.to);
  return {
    id: null,
    at: new Date().toISOString(),
    childConversationId: null,
    childKind: args.kind,
    status: "starting",
    stage:
      args.kind === "sms" && firstNonEmptyString(args.responsePayload.messageSid)
        ? "sms_sent"
        : "starting",
    summary:
      args.kind === "sms"
        ? `Started supervised SMS${to ? ` to ${to}` : ""}.`
        : `Started supervised call${to ? ` to ${to}` : ""}.`,
    rawText:
      args.kind === "sms"
        ? firstNonEmptyString(args.responsePayload.body)
        : firstNonEmptyString(args.requestBody.message),
    callSid: firstNonEmptyString(args.responsePayload.callSid),
    messageSid: firstNonEmptyString(args.responsePayload.messageSid),
    speakSuggested: null,
  };
}

export async function persistAiyraConversationTwilioState(args: {
  supabase: SupabaseClient;
  userId: string;
  conversationId: string;
  state: AiyraTwilioSupervisorState | null;
}): Promise<void> {
  if (!args.state) return;
  const patch = {
    updated_at: new Date().toISOString(),
    twilio_last_update_id: args.state.id,
    twilio_last_update_at: args.state.at,
    twilio_child_conversation_id: args.state.childConversationId,
    twilio_child_kind: args.state.childKind,
    twilio_child_status: args.state.status,
    twilio_child_stage: args.state.stage,
    twilio_child_summary: args.state.summary,
    twilio_child_raw_text: args.state.rawText,
    twilio_call_sid: args.state.callSid,
    twilio_message_sid: args.state.messageSid,
    twilio_speak_suggested: args.state.speakSuggested,
    twilio_supervisor_state: args.state,
  };
  const { error } = await args.supabase
    .from("aiyra_conversations")
    .update(patch)
    .eq("user_id", args.userId)
    .eq("conversation_id", args.conversationId);
  if (error) {
    throw new Error(error.message);
  }
}

export async function loadPersistedAiyraTwilioState(args: {
  supabase: SupabaseClient;
  userId: string;
  conversationId: string;
}): Promise<AiyraTwilioSupervisorState | null> {
  const { data, error } = await args.supabase
    .from("aiyra_conversations")
    .select("twilio_supervisor_state")
    .eq("user_id", args.userId)
    .eq("conversation_id", args.conversationId)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  const raw =
    data && typeof data === "object"
      ? (data as { twilio_supervisor_state?: unknown }).twilio_supervisor_state
      : null;
  return normalizeTwilioSupervisorState(raw);
}

type TwilioStartArgs = {
  supabase: SupabaseClient;
  userId: string;
  orchestratorSessionId: string;
  deviceId?: string | null;
  sourceConversationId?: string | null;
  to?: string | null;
  from?: string | null;
  message?: string | null;
  lang?: string | null;
};

async function startTwilioChild(
  kind: "call" | "sms",
  args: TwilioStartArgs
): Promise<Record<string, unknown>> {
  const apiKey = await loadUserAiyraApiKey({
    supabase: args.supabase,
    userId: args.userId,
  });
  if (!apiKey) {
    throw new Error("Aiyra API key is not configured.");
  }
  const parentConversation = await resolveTwilioParentConversation({
    supabase: args.supabase,
    userId: args.userId,
    orchestratorSessionId: args.orchestratorSessionId,
    sourceConversationId: args.sourceConversationId,
    deviceId: args.deviceId,
  });
  const configuredDefaults = await loadUserAiyraTwilioDefaults({
    supabase: args.supabase,
    userId: args.userId,
    apiKey,
  }).catch(() => ({
    enabled: false,
    from: null,
    to: null,
  }));
  const requestBody: Record<string, unknown> = {
    conversationId: parentConversation.conversationId,
  };
  const to = firstNonEmptyString(args.to, configuredDefaults.to);
  const from = resolveEffectiveTwilioFromNumber({
    requestedFrom: firstNonEmptyString(args.from),
    requestedTo: to,
    configuredFrom: configuredDefaults.from,
  });
  const message = firstNonEmptyString(args.message);
  const lang = firstNonEmptyString(args.lang);
  if (to) requestBody.to = to;
  if (from) requestBody.from = from;
  if (message) requestBody.message = message;
  if (lang) requestBody.lang = lang;

  const supervisorState = buildInitialSupervisorStateFromStartResponse({
    kind,
    responsePayload: {},
    requestBody,
  });
  const relayResult = await sendAiyraRuntimeTextViaRelay({
    userId: args.userId,
    conversationId: parentConversation.conversationId,
    orchestratorSessionId: args.orchestratorSessionId,
    deviceId: args.deviceId,
    apiKey,
    baseUrl: getOpenClawBaseUrl(),
    text: buildTwilioStartPrompt({
      kind,
      to,
      message,
      lang,
    }),
    twilioFrom: from,
    twilioTo: configuredDefaults.to,
    initialSupervisorState: supervisorState as unknown as Record<string, unknown>,
    expectedSupervisorKind: kind,
    useDedicatedTwilioTools: !parentConversation.usesSourceConversation,
    timeoutMs: kind === "sms" ? 20_000 : 30_000,
  });
  const relaySupervisorState = normalizeTwilioSupervisorState(
    relayResult.supervisorState
  );
  const effectiveSupervisorState = relaySupervisorState || supervisorState;
  await persistAiyraConversationTwilioState({
    supabase: args.supabase,
    userId: args.userId,
    conversationId: parentConversation.conversationId,
    state: effectiveSupervisorState,
  });

  return {
    ok: true,
    source: "relay_runtime",
    parentConversationId: parentConversation.conversationId,
    ...(effectiveSupervisorState.callSid
      ? { callSid: effectiveSupervisorState.callSid }
      : {}),
    ...(effectiveSupervisorState.messageSid
      ? { messageSid: effectiveSupervisorState.messageSid }
      : {}),
    ...(readRelayAssistantText(relayResult)
      ? { assistantText: readRelayAssistantText(relayResult) }
      : {}),
    ...(readRelayWarning(relayResult) ? { warning: readRelayWarning(relayResult) } : {}),
    supervisorState: effectiveSupervisorState,
  };
}

export async function startAiyraTwilioCall(
  args: TwilioStartArgs
): Promise<Record<string, unknown>> {
  return startTwilioChild("call", args);
}

export async function startAiyraTwilioSms(
  args: TwilioStartArgs
): Promise<Record<string, unknown>> {
  return startTwilioChild("sms", args);
}

type TwilioChildArgs = {
  supabase: SupabaseClient;
  userId: string;
  orchestratorSessionId: string;
  deviceId?: string | null;
  sourceConversationId?: string | null;
};

export async function getAiyraTwilioChildStatus(
  args: TwilioChildArgs
): Promise<Record<string, unknown>> {
  const apiKey = await loadUserAiyraApiKey({
    supabase: args.supabase,
    userId: args.userId,
  });
  if (!apiKey) {
    throw new Error("Aiyra API key is not configured.");
  }
  const parentConversation = await resolveTwilioParentConversation({
    supabase: args.supabase,
    userId: args.userId,
    orchestratorSessionId: args.orchestratorSessionId,
    sourceConversationId: args.sourceConversationId,
    deviceId: args.deviceId,
  });
  const persisted = await loadPersistedAiyraTwilioState({
    supabase: args.supabase,
    userId: args.userId,
    conversationId: parentConversation.conversationId,
  });
  const configuredDefaults = await loadUserAiyraTwilioDefaults({
    supabase: args.supabase,
    userId: args.userId,
    apiKey,
  }).catch(() => ({
    enabled: false,
    from: null,
    to: null,
  }));
  try {
    const relayResult = await sendAiyraRuntimeTextViaRelay({
      userId: args.userId,
      conversationId: parentConversation.conversationId,
      orchestratorSessionId: args.orchestratorSessionId,
      deviceId: args.deviceId,
      apiKey,
      baseUrl: getOpenClawBaseUrl(),
      text: buildTwilioStatusPrompt(),
      twilioFrom: configuredDefaults.from,
      twilioTo: configuredDefaults.to,
      expectedSupervisorKind:
        persisted?.childKind === "call" || persisted?.childKind === "sms"
          ? persisted.childKind
          : null,
      useDedicatedTwilioTools: !parentConversation.usesSourceConversation,
      timeoutMs: 15_000,
    });
    const relaySupervisorState = normalizeTwilioSupervisorState(
      relayResult.supervisorState
    );
    const supervisorState = selectPreferredTwilioSupervisorState({
      relayState: relaySupervisorState,
      persistedState: persisted,
    });
    const relayAssistantText = readRelayAssistantText(relayResult);
    const useRelayAssistantText =
      !!relayAssistantText &&
      (!!relaySupervisorState
        ? supervisorState === relaySupervisorState
        : !supervisorState);
    if (supervisorState) {
      await persistAiyraConversationTwilioState({
        supabase: args.supabase,
        userId: args.userId,
        conversationId: parentConversation.conversationId,
        state: supervisorState,
      });
    }
    return {
      ok: true,
      parentConversationId: parentConversation.conversationId,
      source: supervisorState
        ? supervisorState === relaySupervisorState
          ? "relay_runtime"
          : "persisted_fresher"
        : "relay_runtime_no_state",
      ...(supervisorState ? { supervisorState } : {}),
      ...(supervisorState
        ? { statusSummary: buildTwilioSupervisorStatusSummary(supervisorState) }
        : {}),
      ...(useRelayAssistantText && relayAssistantText
        ? { assistantText: relayAssistantText }
        : {}),
      ...(readRelayWarning(relayResult) ? { warning: readRelayWarning(relayResult) } : {}),
    };
  } catch (error) {
    if (persisted) {
      return {
        ok: true,
        parentConversationId: parentConversation.conversationId,
        source: "persisted",
        supervisorState: persisted,
        warning:
          error instanceof Error
            ? error.message
            : "Using the last persisted Twilio supervisor state.",
      };
    }
    throw error;
  }
}

export async function coachAiyraTwilioChild(
  args: TwilioChildArgs & { message: string }
): Promise<Record<string, unknown>> {
  const apiKey = await loadUserAiyraApiKey({
    supabase: args.supabase,
    userId: args.userId,
  });
  if (!apiKey) {
    throw new Error("Aiyra API key is not configured.");
  }
  const parentConversation = await resolveTwilioParentConversation({
    supabase: args.supabase,
    userId: args.userId,
    orchestratorSessionId: args.orchestratorSessionId,
    sourceConversationId: args.sourceConversationId,
    deviceId: args.deviceId,
  });
  const configuredDefaults = await loadUserAiyraTwilioDefaults({
    supabase: args.supabase,
    userId: args.userId,
    apiKey,
  }).catch(() => ({
    enabled: false,
    from: null,
    to: null,
  }));
  const persisted = await loadPersistedAiyraTwilioState({
    supabase: args.supabase,
    userId: args.userId,
    conversationId: parentConversation.conversationId,
  }).catch(() => null);
  const relayResult = await sendAiyraRuntimeTextViaRelay({
    userId: args.userId,
    conversationId: parentConversation.conversationId,
    orchestratorSessionId: args.orchestratorSessionId,
    deviceId: args.deviceId,
    apiKey,
    baseUrl: getOpenClawBaseUrl(),
    text: buildTwilioCoachPrompt(args.message),
    twilioFrom: configuredDefaults.from,
    twilioTo: configuredDefaults.to,
    expectedSupervisorKind:
      persisted?.childKind === "call" || persisted?.childKind === "sms"
        ? persisted.childKind
        : null,
    useDedicatedTwilioTools: !parentConversation.usesSourceConversation,
    timeoutMs: 15_000,
  });
  const supervisorState = normalizeTwilioSupervisorState(relayResult.supervisorState);
  if (supervisorState) {
    await persistAiyraConversationTwilioState({
      supabase: args.supabase,
      userId: args.userId,
      conversationId: parentConversation.conversationId,
      state: supervisorState,
    });
  }
  return {
    ok: true,
    source: "relay_runtime",
    parentConversationId: parentConversation.conversationId,
    ...(readRelayAssistantText(relayResult)
      ? { assistantText: readRelayAssistantText(relayResult) }
      : {}),
    ...(readRelayWarning(relayResult) ? { warning: readRelayWarning(relayResult) } : {}),
    ...(supervisorState ? { supervisorState } : {}),
  };
}
