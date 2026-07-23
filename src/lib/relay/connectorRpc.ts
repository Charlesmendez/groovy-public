import { buildInternalRouteAuthHeaders } from "@/lib/internalRouteAuth";
import { getRelayUrl } from "@/lib/config/appConfig";

export const RELAY_CONNECTOR_RPC_SCOPE = "relay_connector_rpc";

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

async function postConnectorRpc(args: {
  userId: string;
  deviceId: string;
  rpcType: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  requestId?: string;
  completionUrl?: string;
  taskId?: string;
  taskMeta?: Record<string, unknown>;
}): Promise<{ response: Response; json: Record<string, unknown> }> {
  const userId = trimmed(args.userId);
  const deviceId = trimmed(args.deviceId);
  const rpcType = trimmed(args.rpcType);
  if (!userId) throw new Error("Missing user id for relay connector RPC");
  if (!deviceId) throw new Error("Missing device id for relay connector RPC");
  if (!rpcType) throw new Error("Missing rpc type for relay connector RPC");

  const authHeaders = buildInternalRouteAuthHeaders({
    userId,
    scope: RELAY_CONNECTOR_RPC_SCOPE,
  });
  if (!authHeaders["x-groovy-internal-auth"]) {
    throw new Error("Internal relay auth unavailable");
  }

  const response = await fetch(`${resolveRelayHttpBaseUrl()}/internal/connector-rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      deviceId,
      rpcType,
      payload: args.payload || {},
      timeoutMs: args.timeoutMs,
      ...(trimmed(args.requestId) ? { requestId: trimmed(args.requestId) } : {}),
      ...(trimmed(args.completionUrl)
        ? {
            delivery: "callback",
            completionUrl: trimmed(args.completionUrl),
            taskId: trimmed(args.taskId),
            taskMeta: args.taskMeta || {},
          }
        : {}),
    }),
  });

  const text = await response.text().catch(() => "");
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      response.ok
        ? "Relay connector RPC returned invalid JSON"
        : `Relay connector RPC failed (${response.status})`
    );
  }

  if (!response.ok) {
    const err =
      json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
        ? String((json as { error: string }).error).trim()
        : trimmed(text) || `Relay connector RPC failed (${response.status})`;
    throw new Error(err || `Relay connector RPC failed (${response.status})`);
  }

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Relay connector RPC returned an invalid payload");
  }

  return { response, json: json as Record<string, unknown> };
}

export async function callConnectorRpcViaRelay(args: {
  userId: string;
  deviceId: string;
  rpcType: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  requestId?: string;
}): Promise<Record<string, unknown>> {
  const { json } = await postConnectorRpc(args);
  return json;
}

export async function startConnectorRpcViaRelay(args: {
  userId: string;
  deviceId: string;
  rpcType: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  requestId: string;
  taskId: string;
  taskMeta: Record<string, unknown>;
  completionUrl: string;
}): Promise<{ requestId: string }> {
  const { response, json } = await postConnectorRpc(args);
  if (response.status !== 202 || json.accepted !== true) {
    throw new Error(
      typeof json.error === "string" && json.error.trim()
        ? json.error.trim()
        : "Relay did not accept the background connector RPC"
    );
  }
  const requestId = trimmed(json.requestId);
  if (!requestId) {
    throw new Error("Relay accepted the background connector RPC without a request id");
  }
  return { requestId };
}
