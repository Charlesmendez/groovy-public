import {
  createSdkMcpServer,
  query,
  tool,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "fs";
import { dirname } from "path";
import { join } from "path";
import { fileURLToPath } from "url";
import type { ModelMessage } from "ai";
import { z } from "zod";

type ExecutableToolDefinition = {
  description: string;
  inputSchema: z.ZodType<unknown>;
  execute: (args: unknown) => Promise<string>;
};

type ExecutableTools = Record<string, ExecutableToolDefinition>;

export type AgentSdkToolCallEvent = {
  toolCallId: string;
  toolName: string;
  rawToolName: string;
  input: unknown;
};

export type AgentSdkToolResultEvent = {
  toolCallId: string;
  toolName: string;
  rawToolName: string;
  output: string;
  outputRaw: unknown;
  elapsedMs?: number;
};

type AgentSdkCallbacks = {
  onTextDelta?: (text: string) => void | Promise<void>;
  onToolCall?: (event: AgentSdkToolCallEvent) => void | Promise<void>;
  onToolResult?: (event: AgentSdkToolResultEvent) => void | Promise<void>;
};

export type RunAgentSdkOrchestratorArgs = {
  systemPrompt: string;
  messages: ModelMessage[];
  tools: ExecutableTools;
  model: string;
  betas?: string[];
  maxTurns: number;
  apiKey?: string | null;
  cwd?: string;
  unrestricted?: boolean;
  callbacks?: AgentSdkCallbacks;
};

export type RunAgentSdkOrchestratorResult = {
  text: string;
  toolCalls: AgentSdkToolCallEvent[];
  toolResults: AgentSdkToolResultEvent[];
  usage?: unknown;
  sessionId?: string;
  metrics?: {
    durationMs?: number;
    durationApiMs?: number;
    numTurns?: number;
    toolExecutionMsTotal: number;
  };
};

const DEFAULT_MCP_SERVER_NAME = "groovy_tools";

function resolveClaudeCodeExecutablePath(): string {
  const candidates: string[] = [];
  const envOverride = (process.env.CLAUDE_AGENT_SDK_CLI_PATH || "").trim();
  if (envOverride) {
    candidates.push(envOverride);
  }

  // Resolve relative to this module's directory (works in both dev and deployed bundles).
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // In dev: thisDir is src/lib/orchestrator → walk up to repo root
    // In deploy: thisDir is inside .next/server/chunks or /var/task → try cwd fallback
    const fromModule = join(thisDir, "..", "..", "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js");
    candidates.push(fromModule);
  } catch {
    // import.meta.url may not resolve in all environments
  }

  candidates.push(
    join(process.cwd(), "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js")
  );

  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
  const found = uniqueCandidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  throw new Error(
    `Claude Code executable not found. Checked paths: ${uniqueCandidates.join(", ")}`
  );
}

function normalizeToolName(rawToolName: string, serverName: string): string {
  const prefix = `mcp__${serverName}__`;
  if (rawToolName.startsWith(prefix)) {
    return rawToolName.slice(prefix.length);
  }
  return rawToolName;
}

function modelMessageContentToText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      parts.push(p.text);
      continue;
    }
    if (p.type === "image") {
      parts.push("[image]");
      continue;
    }
    if (p.type === "file") {
      parts.push("[file]");
      continue;
    }
  }
  return parts.join("\n");
}

export function buildPromptFromMessages(messages: ModelMessage[]): string {
  const rendered = messages
    .map((m) => {
      const role = String(m.role || "user").toUpperCase();
      const text = modelMessageContentToText(m.content).trim();
      if (!text) return `[[${role}]]`;
      return `[[${role}]]\n${text}`;
    })
    .join("\n\n");

  return rendered.trim();
}

function extractRawShape(schema: z.ZodType<unknown>): Record<string, z.ZodTypeAny> {
  const s = schema as unknown as {
    shape?: unknown;
    _def?: { shape?: unknown };
  };

  let shape: unknown;
  if (s && typeof s === "object" && "shape" in s) {
    shape = typeof s.shape === "function" ? (s.shape as () => unknown)() : s.shape;
  }
  if (
    (!shape || typeof shape !== "object" || Array.isArray(shape)) &&
    s &&
    typeof s === "object" &&
    s._def &&
    typeof s._def === "object" &&
    "shape" in s._def
  ) {
    const candidate = s._def.shape;
    shape = typeof candidate === "function" ? (candidate as () => unknown)() : candidate;
  }

  if (shape && typeof shape === "object" && !Array.isArray(shape)) {
    return shape as Record<string, z.ZodTypeAny>;
  }

  return { input: z.any() };
}

function normalizeHandlerArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (
    Object.keys(args).length === 1 &&
    "input" in args &&
    args.input &&
    typeof args.input === "object" &&
    !Array.isArray(args.input)
  ) {
    return args.input as Record<string, unknown>;
  }
  return args;
}

function buildMcpTools(tools: ExecutableTools): SdkMcpToolDefinition[] {
  return Object.entries(tools).map(([toolName, def]) => {
    const rawShape = extractRawShape(def.inputSchema);
    return tool(
      toolName,
      def.description || toolName,
      rawShape,
      async (args: Record<string, unknown>) => {
        const normalizedArgs = normalizeHandlerArgs(args);
        const output = await def.execute(normalizedArgs);
        return {
          content: [
            {
              type: "text",
              text:
                typeof output === "string"
                  ? output
                  : JSON.stringify(output ?? null),
            },
          ],
        };
      }
    );
  });
}

function extractTextPartsFromContentArray(content: unknown[]): string[] {
  const textParts: string[] = [];
  for (const part of content) {
    const p =
      part && typeof part === "object" && !Array.isArray(part)
        ? (part as Record<string, unknown>)
        : null;
    if (!p) continue;
    if (typeof p.text === "string") {
      textParts.push(p.text);
    }
  }
  return textParts.filter((t) => t.trim().length > 0);
}

function extractToolResponseTextInternal(toolResponse: unknown, depth: number): string | null {
  if (depth > 4) return null;

  if (typeof toolResponse === "string") {
    const raw = toolResponse;
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        const nested = extractToolResponseTextInternal(parsed, depth + 1);
        if (nested && nested.trim()) return nested;
      } catch {
        // fall through to raw string
      }
    }
    return raw;
  }

  if (Array.isArray(toolResponse)) {
    const textParts = extractTextPartsFromContentArray(toolResponse);
    if (textParts.length > 0) return textParts.join("\n");

    const nestedParts = toolResponse
      .map((v) => extractToolResponseTextInternal(v, depth + 1))
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    if (nestedParts.length > 0) return nestedParts.join("\n");
    return null;
  }

  if (toolResponse && typeof toolResponse === "object") {
    const asRecord = toolResponse as Record<string, unknown>;
    if (Array.isArray(asRecord.content)) {
      const textParts = extractTextPartsFromContentArray(asRecord.content);
      if (textParts.length > 0) return textParts.join("\n");
    }
    if (typeof asRecord.text === "string" && asRecord.text.trim()) {
      return asRecord.text;
    }
    const nestedKeys = ["result", "output", "tool_response", "data"];
    for (const key of nestedKeys) {
      if (!(key in asRecord)) continue;
      const nested = extractToolResponseTextInternal(asRecord[key], depth + 1);
      if (nested && nested.trim()) return nested;
    }
  }

  return null;
}

function extractToolResponseText(toolResponse: unknown): string {
  const extracted = extractToolResponseTextInternal(toolResponse, 0);
  if (extracted && extracted.trim()) return extracted;

  try {
    return JSON.stringify(toolResponse ?? null);
  } catch {
    return String(toolResponse ?? "");
  }
}

function extractAssistantText(message: unknown): string {
  const m =
    message && typeof message === "object" ? (message as Record<string, unknown>) : null;
  const payload =
    m && m.message && typeof m.message === "object"
      ? (m.message as Record<string, unknown>)
      : null;
  const content = payload?.content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => part as Record<string, unknown>)
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

function computeTextDelta(existing: string, next: string): string {
  if (!next) return "";
  if (!existing) return next;
  if (next.startsWith(existing)) return next.slice(existing.length);
  if (existing.endsWith(next)) return "";
  return `\n${next}`;
}

export async function runAgentSdkOrchestrator(
  args: RunAgentSdkOrchestratorArgs
): Promise<RunAgentSdkOrchestratorResult> {
  const startedAt = Date.now();
  const mcpServerName = DEFAULT_MCP_SERVER_NAME;
  const mcpTools = buildMcpTools(args.tools);
  const mcpServer = createSdkMcpServer({
    name: mcpServerName,
    version: "1.0.0",
    tools: mcpTools,
  });

  const prompt = buildPromptFromMessages(args.messages);
  const toolCalls: AgentSdkToolCallEvent[] = [];
  const toolResults: AgentSdkToolResultEvent[] = [];

  let streamedText = "";
  let finalText = "";
  let usage: unknown = null;
  let sessionId: string | undefined;
  let durationMs: number | undefined;
  let durationApiMs: number | undefined;
  let numTurns: number | undefined;
  let sawResultEvent = false;
  let resultWasError = false;
  const resultSubtypes: string[] = [];
  const resultErrors: string[] = [];
  const observedMessageTypes = new Set<string>();
  const toolStartById = new Map<string, number>();
  let toolExecutionMsTotal = 0;

  const preToolUseHook = async (input: unknown) => {
    const event =
      input && typeof input === "object" ? (input as Record<string, unknown>) : null;
    if (!event || event.hook_event_name !== "PreToolUse") return {};

    const rawToolName = typeof event.tool_name === "string" ? event.tool_name : "";
    const toolCallId = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
    if (!rawToolName || !toolCallId) return {};

    const parsedEvent: AgentSdkToolCallEvent = {
      toolCallId,
      rawToolName,
      toolName: normalizeToolName(rawToolName, mcpServerName),
      input: event.tool_input,
    };
    toolStartById.set(toolCallId, Date.now());
    toolCalls.push(parsedEvent);
    await args.callbacks?.onToolCall?.(parsedEvent);
    return {};
  };

  const postToolUseHook = async (input: unknown) => {
    const event =
      input && typeof input === "object" ? (input as Record<string, unknown>) : null;
    if (!event || event.hook_event_name !== "PostToolUse") return {};

    const rawToolName = typeof event.tool_name === "string" ? event.tool_name : "";
    const toolCallId = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
    if (!rawToolName || !toolCallId) return {};

    const output = extractToolResponseText(event.tool_response);
    const started = toolStartById.get(toolCallId);
    const elapsedMs = typeof started === "number" ? Math.max(0, Date.now() - started) : undefined;
    if (typeof elapsedMs === "number") toolExecutionMsTotal += elapsedMs;
    toolStartById.delete(toolCallId);
    const parsedEvent: AgentSdkToolResultEvent = {
      toolCallId,
      rawToolName,
      toolName: normalizeToolName(rawToolName, mcpServerName),
      output,
      outputRaw: event.tool_response,
      elapsedMs,
    };
    toolResults.push(parsedEvent);
    await args.callbacks?.onToolResult?.(parsedEvent);
    return {};
  };

  const env = {
    ...process.env,
    ...(args.apiKey ? { ANTHROPIC_API_KEY: args.apiKey } : {}),
  };
  const pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath();
  const sdkBetas = Array.isArray(args.betas)
    ? args.betas.filter(
        (beta): beta is "context-1m-2025-08-07" => beta === "context-1m-2025-08-07"
      )
    : [];

  const q = query({
    prompt,
    options: {
      model: args.model,
      betas: sdkBetas.length > 0 ? sdkBetas : undefined,
      maxTurns: args.maxTurns,
      cwd: args.cwd,
      env,
      systemPrompt: args.systemPrompt,
      mcpServers: {
        [mcpServerName]: mcpServer,
      },
      // Only expose our MCP tools — do NOT use the claude_code preset which
      // includes interactive built-in tools (AskUserQuestion, etc.) that waste
      // step budget in headless/server contexts.
      tools: [],
      permissionMode: args.unrestricted ? "bypassPermissions" : "default",
      allowDangerouslySkipPermissions: args.unrestricted ? true : undefined,
      persistSession: false,
      pathToClaudeCodeExecutable,
      settingSources: ["project"],
      includePartialMessages: true,
      hooks: {
        PreToolUse: [{ hooks: [preToolUseHook] }],
        PostToolUse: [{ hooks: [postToolUseHook] }],
      },
    },
  });

  for await (const message of q as AsyncIterable<Record<string, unknown>>) {
    const messageType = typeof message.type === "string" ? message.type : "";
    if (messageType) observedMessageTypes.add(messageType);

    if (typeof message.session_id === "string" && message.session_id) {
      sessionId = message.session_id;
    }

    if (messageType === "assistant") {
      const assistantText = extractAssistantText(message);
      if (assistantText.trim()) {
        const delta = computeTextDelta(streamedText, assistantText);
        if (delta.trim()) {
          streamedText += delta;
          await args.callbacks?.onTextDelta?.(delta);
        }
      }
      continue;
    }

    if (messageType === "result") {
      sawResultEvent = true;
      const subtype = typeof message.subtype === "string" ? message.subtype : "";
      if (subtype) resultSubtypes.push(subtype);
      const isErrorFlag = message.is_error === true || subtype.startsWith("error");
      if (isErrorFlag) resultWasError = true;
      if (Array.isArray(message.errors)) {
        for (const err of message.errors) {
          if (typeof err === "string" && err.trim()) {
            resultErrors.push(err.trim());
          }
        }
      }
      if (typeof message.result === "string" && message.result.trim()) {
        finalText = message.result.trim();
      }
      if (message.modelUsage) {
        usage = message.modelUsage;
      } else if (message.usage) {
        usage = message.usage;
      }

      const durationMsValue =
        typeof message.duration_ms === "number"
          ? message.duration_ms
          : typeof message.durationMs === "number"
            ? message.durationMs
            : undefined;
      if (typeof durationMsValue === "number") durationMs = durationMsValue;

      const durationApiMsValue =
        typeof message.duration_api_ms === "number"
          ? message.duration_api_ms
          : typeof message.durationApiMs === "number"
            ? message.durationApiMs
            : undefined;
      if (typeof durationApiMsValue === "number") durationApiMs = durationApiMsValue;

      const numTurnsValue =
        typeof message.num_turns === "number"
          ? message.num_turns
          : typeof message.numTurns === "number"
            ? message.numTurns
            : undefined;
      if (typeof numTurnsValue === "number") numTurns = numTurnsValue;
      continue;
    }
  }

  const wallClockDurationMs = Date.now() - startedAt;
  const outputText = finalText || streamedText.trim();

  if (resultWasError) {
    const subtype = resultSubtypes[resultSubtypes.length - 1] || "error";
    const detail =
      resultErrors.join("; ") ||
      outputText ||
      "Agent SDK returned an error result with no details.";
    throw new Error(`Agent SDK result ${subtype}: ${detail}`);
  }

  if (!outputText.trim() && toolCalls.length === 0 && toolResults.length === 0) {
    const messageTypes = Array.from(observedMessageTypes).join(", ") || "none";
    const resultState = sawResultEvent
      ? "received an empty result event"
      : "did not emit a result event";
    throw new Error(
      `Agent SDK returned no assistant text or tool events (${resultState}; message types: ${messageTypes}).`
    );
  }

  return {
    text: outputText,
    toolCalls,
    toolResults,
    usage: usage || undefined,
    sessionId,
    metrics: {
      durationMs: durationMs ?? wallClockDurationMs,
      durationApiMs,
      numTurns,
      toolExecutionMsTotal,
    },
  };
}

