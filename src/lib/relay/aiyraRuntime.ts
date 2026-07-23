import { buildInternalRouteAuthHeaders } from "@/lib/internalRouteAuth";
import { getRelayUrl } from "@/lib/config/appConfig";

export const RELAY_AIYRA_RUNTIME_SCOPE = "relay_aiyra_runtime";

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveRelayHttpBaseUrl(): string {
  const raw =
    trimmed(process.env.INTERNAL_RELAY_HTTP_URL) ||
    trimmed(getRelayUrl());
  if (!raw) {
    throw new Error("Missing relay URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid relay URL: ${raw}`);
  }
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

export async function sendAiyraRuntimeTextViaRelay(args: {
  userId: string;
  conversationId: string;
  orchestratorSessionId?: string | null;
  deviceId?: string | null;
  apiKey: string;
  baseUrl: string;
  text: string;
  twilioFrom?: string | null;
  twilioTo?: string | null;
  initialSupervisorState?: Record<string, unknown> | null;
  expectedSupervisorKind?: "call" | "sms" | null;
  useDedicatedTwilioTools?: boolean;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const userId = trimmed(args.userId);
  const conversationId = trimmed(args.conversationId);
  const apiKey = trimmed(args.apiKey);
  const baseUrl = trimmed(args.baseUrl);
  const text = trimmed(args.text);
  if (!userId) throw new Error("Missing user id for relay Aiyra runtime");
  if (!conversationId) throw new Error("Missing conversation id for relay Aiyra runtime");
  if (!apiKey) throw new Error("Missing Aiyra API key for relay Aiyra runtime");
  if (!baseUrl) throw new Error("Missing Aiyra base URL for relay Aiyra runtime");
  if (!text) throw new Error("Missing text for relay Aiyra runtime");

  const authHeaders = buildInternalRouteAuthHeaders({
    userId,
    scope: RELAY_AIYRA_RUNTIME_SCOPE,
  });
  if (!authHeaders["x-groovy-internal-auth"]) {
    throw new Error("Internal relay auth unavailable");
  }

  const response = await fetch(`${resolveRelayHttpBaseUrl()}/internal/aiyra-runtime`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      conversationId,
      orchestratorSessionId: trimmed(args.orchestratorSessionId),
      deviceId: trimmed(args.deviceId),
      apiKey,
      baseUrl,
      text,
      twilioFrom: trimmed(args.twilioFrom),
      twilioTo: trimmed(args.twilioTo),
      initialSupervisorState:
        args.initialSupervisorState &&
        typeof args.initialSupervisorState === "object" &&
        !Array.isArray(args.initialSupervisorState)
          ? args.initialSupervisorState
          : null,
      expectedSupervisorKind: args.expectedSupervisorKind || null,
      useDedicatedTwilioTools: args.useDedicatedTwilioTools === true,
      timeoutMs: args.timeoutMs,
    }),
  });

  const textBody = await response.text().catch(() => "");
  let json: unknown = {};
  try {
    json = textBody ? JSON.parse(textBody) : {};
  } catch {
    throw new Error(
      response.ok
        ? "Relay Aiyra runtime returned invalid JSON"
        : `Relay Aiyra runtime failed (${response.status})`
    );
  }

  if (!response.ok) {
    const err =
      json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
        ? String((json as { error: string }).error).trim()
        : trimmed(textBody) || `Relay Aiyra runtime failed (${response.status})`;
    throw new Error(err || `Relay Aiyra runtime failed (${response.status})`);
  }

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Relay Aiyra runtime returned an invalid payload");
  }

  return json as Record<string, unknown>;
}
