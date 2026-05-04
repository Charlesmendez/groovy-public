import { buildInternalRouteAuthHeaders } from "@/lib/internalRouteAuth";

export const RELAY_CONNECTOR_RPC_SCOPE = "relay_connector_rpc";

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveRelayHttpBaseUrl(): string {
  const raw =
    trimmed(process.env.INTERNAL_RELAY_HTTP_URL) ||
    trimmed(process.env.NEXT_PUBLIC_RELAY_URL);
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

export async function callConnectorRpcViaRelay(args: {
  userId: string;
  deviceId: string;
  rpcType: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
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

  return json as Record<string, unknown>;
}
