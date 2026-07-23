import { anthropic } from "@ai-sdk/anthropic";
import type { ToolSet } from "ai";
import type { ProviderId } from "@/lib/ai/modelResolver";

export const ANTHROPIC_WEB_SEARCH_TOOL_NAME = "web_search";
export const AGENT_SDK_WEB_SEARCH_TOOL_NAME = "WebSearch";

function envFlagEnabled(...names: string[]): boolean {
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const value = raw.trim().toLowerCase();
    return value !== "0" && value !== "false" && value !== "off";
  }
  return true;
}

function webSearchMaxUses(): number {
  const raw = Number(process.env.ORCH_ANTHROPIC_WEB_SEARCH_MAX_USES || "5");
  if (!Number.isFinite(raw)) return 5;
  return Math.max(1, Math.min(20, Math.trunc(raw)));
}

function buildUserLocation(localTimezone?: string | null) {
  const timezone = typeof localTimezone === "string" ? localTimezone.trim() : "";
  if (!timezone) return undefined;
  return {
    type: "approximate" as const,
    timezone,
  };
}

export function isAnthropicNativeWebSearchEnabled(provider: ProviderId): boolean {
  return (
    provider === "anthropic" &&
    envFlagEnabled("ORCH_ANTHROPIC_WEB_SEARCH", "ANTHROPIC_WEB_SEARCH")
  );
}

export function addAnthropicNativeWebSearchTool<T extends Record<string, unknown>>(
  tools: T,
  args: {
    provider: ProviderId;
    localTimezone?: string | null;
  }
): T & ToolSet {
  if (!isAnthropicNativeWebSearchEnabled(args.provider)) {
    return tools as T & ToolSet;
  }

  return {
    ...tools,
    // @ai-sdk/anthropic@3.0.x exposes Anthropic's native web_search_20250305
    // server tool through this helper. Keep the tool name aligned with the
    // Anthropic API docs so prompts and telemetry stay clear.
    [ANTHROPIC_WEB_SEARCH_TOOL_NAME]: anthropic.tools.webSearch_20250305({
      maxUses: webSearchMaxUses(),
      userLocation: buildUserLocation(args.localTimezone),
    }),
  } as T & ToolSet;
}

export function getAnthropicAgentSdkBuiltinTools(provider: ProviderId): string[] {
  return isAnthropicNativeWebSearchEnabled(provider)
    ? [AGENT_SDK_WEB_SEARCH_TOOL_NAME]
    : [];
}

export function isWebSearchToolName(toolName: string): boolean {
  return (
    toolName === ANTHROPIC_WEB_SEARCH_TOOL_NAME ||
    toolName === AGENT_SDK_WEB_SEARCH_TOOL_NAME
  );
}
