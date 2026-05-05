import dns from "node:dns/promises";
import net from "node:net";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import type { ToolExecutionContext, ToolResult } from "@/lib/orchestrator/toolExecutor";
import type {
  ExtensionApprovalState,
  ExtensionConnectionRuntime,
  ExtensionRunnerRuntime,
  ExtensionRuntimeTool,
} from "./types";
import { loadExtensionRunnerRuntime } from "./runners";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(safeJson(value), "utf8");
}

function previewPayload(value: unknown, maxChars = 4000): Record<string, unknown> {
  const serialized = safeJson(value);
  if (serialized.length <= maxChars) {
    return {
      truncated: false,
      value,
    };
  }
  return {
    truncated: true,
    preview: `${serialized.slice(0, maxChars)}...`,
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

function approvalRequired(tool: ExtensionRuntimeTool): boolean {
  const required = tool.approvalPolicy.requireApprovalForRiskLevels || [];
  return required.includes(tool.riskLevel);
}

function buildApprovalState(tool: ExtensionRuntimeTool): ExtensionApprovalState {
  return approvalRequired(tool) ? "required" : "not_required";
}

function decryptSecrets(enc: string): Record<string, unknown> {
  const trimmed = asTrimmed(enc);
  if (!trimmed) return {};
  try {
    return asRecord(JSON.parse(decryptLlmApiKey(trimmed)));
  } catch {
    return {};
  }
}

async function loadConnectionRuntime(
  context: ToolExecutionContext,
  tool: ExtensionRuntimeTool
): Promise<ExtensionConnectionRuntime | null> {
  if (tool.authScope === "none") {
    return {
      id: "",
      authScope: "none",
      status: "connected",
      config: {},
      secrets: {},
    };
  }
  if (!context.supabase) return null;

  let query = context.supabase
    .from("orchestrator_extension_connections")
    .select("id,auth_scope,status,config,secrets_enc")
    .eq("user_id", context.userId)
    .eq("installation_id", tool.installationId);

  if (tool.connectionId) {
    query = query.eq("id", tool.connectionId);
  } else {
    query = query.eq("auth_scope", tool.authScope);
  }

  const { data, error } = await query.limit(1).maybeSingle();
  if (error || !data) return null;
  return {
    id: asTrimmed(data.id),
    authScope:
      data.auth_scope === "shared_org" ||
      data.auth_scope === "service_identity" ||
      data.auth_scope === "none"
        ? data.auth_scope
        : "end_user",
    status:
      data.status === "connected" ||
      data.status === "disconnected" ||
      data.status === "error"
        ? data.status
        : "pending",
    config: asRecord(data.config),
    secrets: decryptSecrets(asTrimmed(data.secrets_enc)),
  };
}

async function loadRunnerRuntime(
  context: ToolExecutionContext,
  tool: ExtensionRuntimeTool
): Promise<ExtensionRunnerRuntime | null> {
  if (!tool.runnerId) return null;
  if (!context.supabase) return null;
  return loadExtensionRunnerRuntime({
    supabase: context.supabase,
    userId: context.userId,
    agentId: tool.agentId,
    runnerId: tool.runnerId,
  });
}

type TemplateScope = {
  args: Record<string, unknown>;
  connection: Record<string, unknown>;
  runtime: Record<string, unknown>;
};

function lookupTemplateValue(scope: TemplateScope, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed) return undefined;

  const directArg = scope.args[trimmed];
  if (directArg !== undefined) return directArg;

  const parts = trimmed.split(".");
  let current: unknown = scope;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function renderTemplateString(input: string, scope: TemplateScope): unknown {
  const exact = input.match(/^\s*\{\{\s*([^}]+)\s*\}\}\s*$/);
  if (exact) {
    const resolved = lookupTemplateValue(scope, exact[1]);
    if (resolved === undefined) {
      throw new Error(`Missing template value: ${exact[1].trim()}`);
    }
    return resolved;
  }

  return input.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, path: string) => {
    const resolved = lookupTemplateValue(scope, path);
    if (resolved === undefined) {
      throw new Error(`Missing template value: ${path.trim()}`);
    }
    if (typeof resolved === "string") return resolved;
    return safeJson(resolved);
  });
}

function resolveTemplateValue(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === "string") return renderTemplateString(value, scope);
  if (Array.isArray(value)) return value.map((item) => resolveTemplateValue(item, scope));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = resolveTemplateValue(item, scope);
  }
  return out;
}

function buildTemplateScope(
  context: ToolExecutionContext,
  params: Record<string, unknown>,
  connection: ExtensionConnectionRuntime | null
): TemplateScope {
  return {
    args: params,
    connection: {
      ...(connection?.config || {}),
      ...(connection?.secrets || {}),
    },
    runtime: {
      user_id: context.userId,
      trace_id: context.traceId || null,
      session_id: context.orchestratorSessionId || null,
      turn_id: context.turnId || null,
      device_id: context.deviceId || null,
    },
  };
}

function appendQueryParams(url: URL, query: Record<string, unknown>) {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isPrivateIpAddress(ip: string): boolean {
  const normalized = normalizeHostname(ip);
  const version = net.isIP(normalized);
  if (version === 4) {
    const parts = normalized.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (version === 6) {
    if (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("ff") ||
      normalized === "fd00:ec2::254"
    ) {
      return true;
    }
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpAddress(mapped[1]);
  }

  return version === 0;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".flycast") ||
    normalized === "metadata.google.internal" ||
    normalized === "metadata.azure.com" ||
    normalized.split(".").length < 2
  );
}

async function assertPublicHttpsUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:") {
    throw new Error("Extension outbound requests require https URLs");
  }

  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error("Extension outbound request host is not allowed");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      throw new Error("Extension outbound request IP is not allowed");
    }
    return;
  }

  let addresses: Array<{ address: string }> = [];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Extension outbound request host could not be resolved");
  }

  if (!addresses.length || addresses.some((item) => isPrivateIpAddress(item.address))) {
    throw new Error("Extension outbound request resolved to a blocked address");
  }
}

function buildRunnerExecuteUrl(endpoint: string, executePath: string): URL {
  const base = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  if (base.protocol !== "https:") {
    throw new Error("Runner endpoint must use https");
  }

  const trimmedPath = executePath.trim() || "v1/execute";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmedPath) || trimmedPath.startsWith("//")) {
    throw new Error("Runner execute_path must be a relative path");
  }

  const relativePath = trimmedPath.startsWith("/") ? trimmedPath.slice(1) : trimmedPath;
  const url = new URL(relativePath, base);
  if (url.origin !== base.origin) {
    throw new Error("Runner execute_path cannot change hosts");
  }
  return url;
}

async function executeHttpAction(args: {
  tool: ExtensionRuntimeTool;
  params: Record<string, unknown>;
  context: ToolExecutionContext;
  connection: ExtensionConnectionRuntime | null;
  startTime: number;
}): Promise<ToolResult> {
  const action = args.tool.action;
  if (action.kind !== "http_action") {
    return {
      success: false,
      error: `Tool ${args.tool.toolName} is not configured as an HTTP action`,
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  }

  const scope = buildTemplateScope(args.context, args.params, args.connection);
  const method = action.method || "POST";
  const resolvedUrl = String(resolveTemplateValue(action.url, scope) || "").trim();
  if (!resolvedUrl) {
    return {
      success: false,
      error: `Tool ${args.tool.toolName} does not resolve to a valid URL`,
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  }

  try {
    const url = new URL(resolvedUrl);
    const resolvedQuery = asRecord(resolveTemplateValue(action.query || {}, scope));
    appendQueryParams(url, resolvedQuery);
    await assertPublicHttpsUrl(url);

    const resolvedHeaders = asRecord(resolveTemplateValue(action.headers || {}, scope));
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(resolvedHeaders)) {
      if (value === undefined || value === null) continue;
      headers[key] = String(value);
    }

    let body: BodyInit | undefined;
    let bodyValue: unknown = undefined;
    if (method !== "GET" && method !== "DELETE" && action.body !== undefined) {
      bodyValue = resolveTemplateValue(action.body, scope);
      const contentType =
        headers["Content-Type"] || headers["content-type"] || "application/json";
      if (typeof bodyValue === "string" && !contentType.includes("application/json")) {
        body = bodyValue;
      } else {
        body = safeJson(bodyValue);
        headers["Content-Type"] = contentType;
      }
    }

    const timeoutMs = Number.isFinite(action.timeoutMs) ? Number(action.timeoutMs) : 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: "manual",
      });

      const contentType = response.headers.get("content-type") || "";
      const rawText = await response.text();
      const parsed =
        contentType.includes("application/json") && rawText.trim()
          ? JSON.parse(rawText)
          : rawText;
      const truncated =
        rawText.length > (Number.isFinite(action.maxResponseChars) ? Number(action.maxResponseChars) : 12000);
      const resultPayload = truncated
        ? {
            ok: response.ok,
            status: response.status,
            contentType,
            truncated: true,
            preview: `${rawText.slice(
              0,
              Number.isFinite(action.maxResponseChars) ? Number(action.maxResponseChars) : 12000
            )}...`,
          }
        : {
            ok: response.ok,
            status: response.status,
            contentType,
            data: parsed,
          };

      if (!response.ok) {
        return {
          success: false,
          error: `Extension API request failed with status ${response.status}`,
          result: resultPayload,
          agent: "extension",
          toolName: args.tool.toolName,
          executionTime: Date.now() - args.startTime,
        };
      }

      return {
        success: true,
        result: resultPayload,
        agent: "extension",
        toolName: args.tool.toolName,
        executionTime: Date.now() - args.startTime,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "HTTP action failed",
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  }
}

async function executeConnectorAction(args: {
  tool: ExtensionRuntimeTool;
  params: Record<string, unknown>;
  context: ToolExecutionContext;
  connection: ExtensionConnectionRuntime | null;
  startTime: number;
}): Promise<ToolResult> {
  const action = args.tool.action;
  if (action.kind !== "connector_action") {
    return {
      success: false,
      error: `Tool ${args.tool.toolName} is not configured as a connector action`,
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  }

  if (!args.context.deviceId) {
    return {
      success: false,
      error: "Local connector not connected. Please ensure the Groovy Connector is online.",
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  }

  try {
    const scope = buildTemplateScope(args.context, args.params, args.connection);
    const connectorParams = asRecord(resolveTemplateValue(action.params || {}, scope));
    const messageValue = action.message
      ? resolveTemplateValue(action.message, scope)
      : `Executing ${args.tool.extensionName}: ${args.tool.description}`;

    return {
      success: true,
      result: {
        __connector_execute__: true,
        type: action.connectorType,
        params: connectorParams,
        toolName: args.tool.toolName,
        agent: "extension",
        message: typeof messageValue === "string" ? messageValue : safeJson(messageValue),
      },
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Connector action failed",
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  }
}

async function executeRunnerAction(args: {
  tool: ExtensionRuntimeTool;
  params: Record<string, unknown>;
  context: ToolExecutionContext;
  connection: ExtensionConnectionRuntime | null;
  runner: ExtensionRunnerRuntime;
  startTime: number;
}): Promise<ToolResult> {
  const action = args.tool.action;
  if (action.kind !== "cli_action") {
    return {
      success: false,
      error: `Tool ${args.tool.toolName} is not configured as a CLI action`,
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  }

  if (args.runner.transport !== "https") {
    return {
      success: false,
      error: `Runner transport ${args.runner.transport} is not implemented yet`,
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  }

  if (args.runner.status !== "online") {
    return {
      success: false,
      error: `Runner ${args.runner.name} is not online`,
      result: {
        needsRunner: true,
        runnerId: args.runner.id,
        runnerStatus: args.runner.status,
      },
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  }

  const endpoint = asTrimmed(args.runner.endpoint);
  if (!endpoint) {
    return {
      success: false,
      error: `Runner ${args.runner.name} is missing an HTTPS endpoint`,
      result: {
        needsRunner: true,
        runnerId: args.runner.id,
        runnerStatus: args.runner.status,
      },
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  }

  try {
    const scope = buildTemplateScope(args.context, args.params, args.connection);
    const resolvedArgv = action.argvTemplate.map((item) => String(resolveTemplateValue(item, scope)));
    const resolvedCwdRaw = action.cwd ? resolveTemplateValue(action.cwd, scope) : undefined;
    const resolvedCwd =
      resolvedCwdRaw === undefined || resolvedCwdRaw === null ? null : String(resolvedCwdRaw);
    const resolvedEnvRaw = asRecord(resolveTemplateValue(action.env || {}, scope));
    const resolvedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(resolvedEnvRaw)) {
      if (value === undefined || value === null) continue;
      resolvedEnv[key] = String(value);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (args.runner.authToken) {
      headers.Authorization = `Bearer ${args.runner.authToken}`;
    }

    const executePath = asTrimmed(args.runner.metadata.execute_path) || "v1/execute";
    const url = buildRunnerExecuteUrl(endpoint, executePath);
    await assertPublicHttpsUrl(url);
    const timeoutMs = Number.isFinite(action.timeoutMs) ? Number(action.timeoutMs) : 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 2000);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers,
        signal: controller.signal,
        redirect: "manual",
        body: JSON.stringify({
          traceId: args.context.traceId || null,
          turnId: args.context.turnId || null,
          sessionId: args.context.orchestratorSessionId || null,
          userId: args.context.userId,
          extension: {
            id: args.tool.extensionId,
            slug: args.tool.extensionSlug,
            name: args.tool.extensionName,
            versionId: args.tool.extensionVersionId,
          },
          tool: {
            name: args.tool.toolName,
            slug: args.tool.toolSlug,
            description: args.tool.description,
            riskLevel: args.tool.riskLevel,
            authScope: args.tool.authScope,
          },
          action: {
            kind: "cli_action",
            argv: resolvedArgv,
            cwd: resolvedCwd,
            env: resolvedEnv,
            timeoutMs,
            maxOutputChars:
              Number.isFinite(action.maxOutputChars) ? Number(action.maxOutputChars) : null,
          },
          params: args.params,
          connection: {
            authScope: args.connection?.authScope || "none",
            config: args.connection?.config || {},
            secrets: args.connection?.secrets || {},
          },
          runtime: {
            deviceId: args.context.deviceId || null,
            localTimezone: args.context.localTimezone || null,
          },
        }),
      });

      const contentType = response.headers.get("content-type") || "";
      const rawText = await response.text();
      const parsed =
        contentType.includes("application/json") && rawText.trim()
          ? JSON.parse(rawText)
          : rawText;
      const parsedRecord = asRecord(parsed);
      const runnerOk =
        response.ok &&
        !(parsedRecord.ok === false) &&
        !(typeof parsedRecord.error === "string" && parsedRecord.error.trim());

      const payload = {
        ok: runnerOk,
        status: response.status,
        data: parsed,
      };

      if (!runnerOk) {
        const message =
          asTrimmed(parsedRecord.error) ||
          (response.ok
            ? "Runner execution failed"
            : `Runner request failed with status ${response.status}`);
        return {
          success: false,
          error: message,
          result: payload,
          agent: "extension",
          toolName: args.tool.toolName,
          executionTime: Date.now() - args.startTime,
        };
      }

      return {
        success: true,
        result: payload,
        agent: "extension",
        toolName: args.tool.toolName,
        executionTime: Date.now() - args.startTime,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Runner execution failed",
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  }
}

async function recordControlPlane(args: {
  context: ToolExecutionContext;
  tool: ExtensionRuntimeTool;
  params: Record<string, unknown>;
  result: ToolResult;
  approvalState: ExtensionApprovalState;
  connection: ExtensionConnectionRuntime | null;
}) {
  if (!args.context.supabase) return;

  const adapter = args.tool.action.kind;
  const status =
    args.result.success && asRecord(args.result.result).__connector_execute__ === true
      ? "scheduled"
      : args.result.success
        ? "success"
        : "error";
  const requestPreview = previewPayload(args.params);
  const resultPreview = previewPayload(args.result.result ?? { error: args.result.error || null });
  const sharedBase = {
    user_id: args.context.userId,
    agent_id: args.tool.agentId,
    extension_id: args.tool.extensionId,
    installation_id: args.tool.installationId,
    extension_slug: args.tool.extensionSlug,
    tool_name: args.tool.toolName,
    trace_id: args.context.traceId || null,
    turn_id: args.context.turnId || null,
    orchestrator_session_id: args.context.orchestratorSessionId || null,
  };
  const sharedWithVersion = {
    ...sharedBase,
    extension_version_id: args.tool.extensionVersionId,
  };

  await Promise.allSettled([
    args.context.supabase.from("orchestrator_extension_usage_meter").insert({
      ...sharedWithVersion,
      runtime_target: args.tool.runtimeTarget,
      adapter,
      auth_scope: args.tool.authScope,
      risk_level: args.tool.riskLevel,
      approval_state: args.approvalState,
      status,
      billing_workspace_id: args.context.billingWorkspaceId || null,
      duration_ms: Math.max(0, Math.trunc(args.result.executionTime || 0)),
      input_bytes: byteLength(args.params),
      output_bytes: byteLength(args.result.result ?? args.result.error ?? null),
      groovy_cost_usd: null,
      external_usage_units: null,
      error_code: args.result.success ? null : "extension_execution_failed",
      metadata: {
        connector_platform: args.context.connectorPlatform || null,
        connection_id: args.connection?.id || null,
      },
    }),
    args.context.supabase.from("orchestrator_extension_audit_events").insert({
      ...sharedBase,
      action: "tool_call",
      actor_scope: args.tool.authScope,
      approval_state: args.approvalState,
      status,
      request_preview: requestPreview,
      result_preview: resultPreview,
      metadata: {
        connection_id: args.connection?.id || null,
      },
    }),
    args.context.supabase.from("orchestrator_extension_runtime_traces").insert({
      ...sharedWithVersion,
      runtime_target: args.tool.runtimeTarget,
      adapter,
      status,
      duration_ms: Math.max(0, Math.trunc(args.result.executionTime || 0)),
      request_payload: requestPreview,
      response_payload: resultPreview,
      error_code: args.result.success ? null : "extension_execution_failed",
      error_message: args.result.success ? null : args.result.error || null,
      metadata: {
        connection_id: args.connection?.id || null,
      },
    }),
    args.context.supabase.from("orchestrator_extension_analytics_events").insert({
      user_id: args.context.userId,
      agent_id: args.tool.agentId,
      extension_id: args.tool.extensionId,
      installation_id: args.tool.installationId,
      trace_id: args.context.traceId || null,
      event_name: "extension_tool_invoked",
      payload: {
        tool_name: args.tool.toolName,
        extension_slug: args.tool.extensionSlug,
        runtime_target: args.tool.runtimeTarget,
        adapter,
        status,
        risk_level: args.tool.riskLevel,
      },
    }),
  ]);
}

export async function executeExtensionRuntimeTool(args: {
  tool: ExtensionRuntimeTool;
  params: Record<string, unknown>;
  context: ToolExecutionContext;
  startTime: number;
}): Promise<ToolResult> {
  const approvalState = buildApprovalState(args.tool);
  const connection = await loadConnectionRuntime(args.context, args.tool);
  const runner = await loadRunnerRuntime(args.context, args.tool);

  if (approvalState === "required") {
    const blocked: ToolResult = {
      success: false,
      error: `Approval required for ${args.tool.extensionName} tool ${args.tool.toolName}`,
      result: {
        approvalRequired: true,
        extension: args.tool.extensionSlug,
        toolName: args.tool.toolName,
        riskLevel: args.tool.riskLevel,
      },
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
    await recordControlPlane({
      context: args.context,
      tool: args.tool,
      params: args.params,
      result: blocked,
      approvalState,
      connection,
    });
    return blocked;
  }

  if (args.tool.authScope !== "none" && (!connection || connection.status !== "connected")) {
    const missingConnection: ToolResult = {
      success: false,
      error: `Connection required for ${args.tool.extensionName} (${args.tool.authScope})`,
      result: {
        needsConnection: true,
        extension: args.tool.extensionSlug,
        authScope: args.tool.authScope,
      },
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
    await recordControlPlane({
      context: args.context,
      tool: args.tool,
      params: args.params,
      result: missingConnection,
      approvalState,
      connection,
    });
    return missingConnection;
  }

  let result: ToolResult;
  if (args.tool.runtimeTarget === "groovy_cloud" && args.tool.action.kind === "http_action") {
    result = await executeHttpAction({
      tool: args.tool,
      params: args.params,
      context: args.context,
      connection,
      startTime: args.startTime,
    });
  } else if (
    args.tool.runtimeTarget === "device_connector" &&
    args.tool.action.kind === "connector_action"
  ) {
    result = await executeConnectorAction({
      tool: args.tool,
      params: args.params,
      context: args.context,
      connection,
      startTime: args.startTime,
    });
  } else if (
    args.tool.runtimeTarget === "customer_runner" &&
    args.tool.action.kind === "cli_action"
  ) {
    if (!runner) {
      result = {
        success: false,
        error: `Runner required for ${args.tool.extensionName}`,
        result: {
          needsRunner: true,
          extension: args.tool.extensionSlug,
          runnerId: args.tool.runnerId,
        },
        agent: "extension",
        toolName: args.tool.toolName,
        executionTime: Date.now() - args.startTime,
      };
    } else {
      result = await executeRunnerAction({
        tool: args.tool,
        params: args.params,
        context: args.context,
        connection,
        runner,
        startTime: args.startTime,
      });
    }
  } else {
    result = {
      success: false,
      error: `Runtime ${args.tool.runtimeTarget}/${args.tool.action.kind} is not implemented yet`,
      agent: "extension",
      toolName: args.tool.toolName,
      executionTime: Date.now() - args.startTime,
    };
  }

  await recordControlPlane({
    context: args.context,
    tool: args.tool,
    params: args.params,
    result,
    approvalState,
    connection,
  });
  return result;
}
