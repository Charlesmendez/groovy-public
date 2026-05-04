/**
 * Prompt Compaction
 * Manages conversation history to keep total tokens under threshold.
 * Summarizes older messages while keeping recent ones intact.
 */

import Anthropic from "@anthropic-ai/sdk";
import { generateText } from "ai";
import { resolveChatModel, type ProviderId } from "@/lib/ai/modelResolver";

// Configuration
const COMPACTION_TRIGGER_TOKENS = 150_000;  // Trigger at 150k tokens
const KEEP_RECENT_TOKENS = 40_000;          // Keep ~40k recent tokens verbatim
const SUMMARY_TARGET_TOKENS = 100_000;      // Older messages get summarized
const CHARS_PER_TOKEN = 4; // Rough estimate for quick pre-check

export type CompactableMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type CompactionResult = {
  messages: CompactableMessage[];
  didCompact: boolean;
  /** Original messages that were kept (preserves images/files) */
  keptOriginalMessages?: unknown[];
  /** Index where kept messages start in original array */
  keepStartIndex?: number;
  /** Usage metadata for the summarization LLM call (if compaction happened) */
  summaryUsage?: { provider: ProviderId; model: string; usage?: unknown };
  stats?: {
    originalTokens: number;
    compactedTokens: number;
    messagesSummarized: number;
    messagesKept: number;
  };
};

/**
 * Quick heuristic estimate of token count (4 chars ≈ 1 token).
 * Used as a fast pre-check before calling the Anthropic API.
 */
function estimateTokensQuick(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function messagesToText(messages: CompactableMessage[]): string {
  return messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");
}

function systemPromptToText(systemPrompt: string): string {
  return systemPrompt || "";
}

/**
 * Count tokens using Anthropic's countTokens API.
 * Falls back to heuristic if API fails.
 */
async function countTokensAccurate(
  systemPrompt: string,
  messages: CompactableMessage[],
  apiKey?: string
): Promise<number> {
  try {
    const anthropic = new Anthropic(apiKey ? { apiKey } : {});
    
    // Convert to Anthropic message format
    const anthropicMessages = messages.map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));

    // Use a model that supports countTokens
    const result = await anthropic.messages.countTokens({
      model: "claude-sonnet-4-5-20250929",
      system: systemPrompt || undefined,
      messages: anthropicMessages,
    });

    return result.input_tokens;
  } catch (error) {
    console.warn("[compaction] countTokens API failed, using heuristic:", error);
    const totalText = systemPromptToText(systemPrompt) + "\n" + messagesToText(messages);
    return estimateTokensQuick(totalText);
  }
}

/**
 * Count tokens for messages only (not system prompt).
 */
async function countMessagesTokens(
  messages: CompactableMessage[],
  apiKey?: string
): Promise<number> {
  try {
    const anthropic = new Anthropic(apiKey ? { apiKey } : {});
    
    const anthropicMessages = messages.map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));

    const result = await anthropic.messages.countTokens({
      model: "claude-sonnet-4-5-20250929",
      messages: anthropicMessages,
    });

    return result.input_tokens;
  } catch (error) {
    console.warn("[compaction] countTokens API failed, using heuristic:", error);
    return estimateTokensQuick(messagesToText(messages));
  }
}

/**
 * Find the split point: keep messages from the end that fit within KEEP_RECENT_TOKENS.
 * Returns the index where "keep" portion starts.
 */
async function findSplitPoint(
  messages: CompactableMessage[],
  keepTokens: number
): Promise<number> {
  let keepCount = 0;
  let tokensSoFar = 0;

  // Work backwards from the end
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokensQuick(messages[i].content);
    if (tokensSoFar + msgTokens > keepTokens) {
      break;
    }
    tokensSoFar += msgTokens;
    keepCount++;
  }

  // Ensure we keep at least the last message
  if (keepCount === 0 && messages.length > 0) {
    keepCount = 1;
  }

  // Ensure we have something to summarize
  if (keepCount >= messages.length && messages.length > 2) {
    keepCount = Math.floor(messages.length / 2);
  }

  return messages.length - keepCount;
}

/**
 * Summarize a conversation history into a concise continuation summary.
 */
async function summarizeHistory(
  messages: CompactableMessage[],
  provider: ProviderId,
  apiKey?: string
): Promise<{ summary: string; provider: ProviderId; model: string; usage?: unknown }> {
  const historyText = messagesToText(messages);

  const summarizationPrompt = `You are a helpful assistant that creates concise continuation summaries.

Below is a conversation history between a user and an AI assistant. Create a detailed summary that captures:
1. All key facts, data, and conclusions reached
2. Any important tool calls made and their results
3. User's original requests and any follow-up clarifications
4. The current state of the conversation (what was accomplished, what remains)
5. File/attachment context: uploaded filenames, generated files/images, and which outputs are still relevant
6. Any unresolved decisions, ambiguities, or pending actions that the assistant should continue from

Keep the summary factual and comprehensive - it will be used to continue this conversation.
Do NOT include phrases like "Here's a summary" - just provide the summary directly.

CONVERSATION HISTORY:
${historyText}

SUMMARY:`;

  try {
    // Use a fast model for summarization based on provider
    const modelName = provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001";
    const model = resolveChatModel(provider, modelName, apiKey ? { apiKey } : undefined);
    
    const result = await generateText({
      model,
      prompt: summarizationPrompt,
    });

    return {
      summary: result.text.trim(),
      provider,
      model: modelName,
      usage: (result as unknown as { usage?: unknown }).usage,
    };
  } catch (error) {
    console.error("[compaction] Summarization failed:", error);
    // Fallback: just truncate the history
    const truncated = historyText.slice(0, SUMMARY_TARGET_TOKENS * CHARS_PER_TOKEN);
    return {
      summary: `[Previous conversation summary - truncated due to error]\n${truncated}`,
      provider,
      model: provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001",
    };
  }
}

/**
 * Main compaction function.
 * Takes system prompt (never modified) and messages array.
 * Returns potentially compacted messages array.
 */
export async function maybeCompactMessages(
  systemPrompt: string,
  messages: CompactableMessage[],
  options?: {
    apiKey?: string;
    provider?: ProviderId;
    triggerTokens?: number;
    keepTokens?: number;
    verbose?: boolean;
    /** Original messages (preserves images/files for kept portion) */
    originalMessages?: unknown[];
  }
): Promise<CompactionResult> {
  const {
    apiKey,
    provider = "anthropic",
    triggerTokens = COMPACTION_TRIGGER_TOKENS,
    keepTokens = KEEP_RECENT_TOKENS,
    verbose = false,
    originalMessages,
  } = options || {};

  // Quick pre-check using heuristic
  const systemTokensEstimate = estimateTokensQuick(systemPrompt);
  const messagesTokensEstimate = estimateTokensQuick(messagesToText(messages));
  const totalEstimate = systemTokensEstimate + messagesTokensEstimate;

  if (verbose) {
    console.log("[compaction] Quick estimate:", {
      systemTokens: systemTokensEstimate,
      messagesTokens: messagesTokensEstimate,
      total: totalEstimate,
      threshold: triggerTokens,
    });
  }

  // If well under threshold, skip accurate counting
  if (totalEstimate < triggerTokens * 0.8) {
    return { messages, didCompact: false };
  }

  // Do accurate count
  const actualTokens = await countTokensAccurate(systemPrompt, messages, apiKey);

  if (verbose) {
    console.log("[compaction] Accurate count:", {
      tokens: actualTokens,
      threshold: triggerTokens,
    });
  }

  if (actualTokens < triggerTokens) {
    return { messages, didCompact: false };
  }

  // Need to compact
  console.log("[compaction] Triggering compaction:", {
    currentTokens: actualTokens,
    threshold: triggerTokens,
    messageCount: messages.length,
  });

  // Calculate how much budget we have for messages after system prompt
  // Use heuristic for system-only count since API requires at least one message
  const systemTokens = estimateTokensQuick(systemPrompt);
  const availableForMessages = triggerTokens - systemTokens - 500; // 500 token buffer

  // Adjust keep budget if system prompt is very large
  const effectiveKeepTokens = Math.min(keepTokens, availableForMessages * 0.3);

  // Find split point
  const splitIndex = await findSplitPoint(messages, effectiveKeepTokens);

  if (splitIndex === 0) {
    // Nothing to summarize
    console.log("[compaction] Nothing to summarize (all messages fit in keep budget)");
    return { messages, didCompact: false };
  }

  const toSummarize = messages.slice(0, splitIndex);
  const toKeep = messages.slice(splitIndex);

  console.log("[compaction] Splitting:", {
    summarize: toSummarize.length,
    keep: toKeep.length,
  });

  // Generate summary
  const summaryResult = await summarizeHistory(toSummarize, provider, apiKey);
  const summary = summaryResult.summary;

  // Build compacted messages
  // Ensure proper role alternation: summary role should be opposite of first kept message
  const firstKeptRole = toKeep.length > 0 ? toKeep[0].role : "assistant";
  const summaryRole: "user" | "assistant" = firstKeptRole === "user" ? "assistant" : "user";
  
  const summaryMessage: CompactableMessage = {
    role: summaryRole,
    content: `[CONVERSATION CONTINUATION - Previous context summary]\n\n${summary}\n\n[END OF SUMMARY - The conversation continues below with recent messages]`,
  };

  const compactedMessages: CompactableMessage[] = [summaryMessage, ...toKeep];

  // Get final token count
  const compactedTokens = await countMessagesTokens(compactedMessages, apiKey);

  console.log("[compaction] Completed:", {
    originalTokens: actualTokens,
    compactedTokens: compactedTokens + systemTokens,
    messagesSummarized: toSummarize.length,
    messagesKept: toKeep.length,
  });

  // Get original messages for kept portion (preserves images/files)
  const keptOriginals = originalMessages ? originalMessages.slice(splitIndex) : undefined;

  return {
    messages: compactedMessages,
    didCompact: true,
    keepStartIndex: splitIndex,
    keptOriginalMessages: keptOriginals,
    summaryUsage: {
      provider: summaryResult.provider,
      model: summaryResult.model,
      usage: summaryResult.usage,
    },
    stats: {
      originalTokens: actualTokens,
      compactedTokens: compactedTokens + systemTokens,
      messagesSummarized: toSummarize.length,
      messagesKept: toKeep.length,
    },
  };
}

/**
 * Convert AI SDK ModelMessage to CompactableMessage format.
 */
export function modelMessageToCompactable(
  msg: { role: string; content: unknown }
): CompactableMessage | null {
  const role = msg.role as "user" | "assistant" | "system";
  if (role !== "user" && role !== "assistant" && role !== "system") {
    return null;
  }

  let content: string;
  if (typeof msg.content === "string") {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    // Extract text from content parts
    content = msg.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string" && p.text.trim()) {
            return p.text;
          }
          const type = typeof p.type === "string" ? p.type : "";
          if (type === "file") {
            const mimeType = typeof p.mimeType === "string" ? p.mimeType : "unknown";
            return `[Attached file part: mimeType=${mimeType}]`;
          }
          if (type === "image") {
            const mimeType = typeof p.mimeType === "string" ? p.mimeType : "unknown";
            return `[Attached image part: mimeType=${mimeType}]`;
          }
          if (type) {
            return `[Non-text content part: ${type}]`;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else {
    return null;
  }

  if (!content.trim()) {
    return null;
  }

  return { role, content };
}

/**
 * Convert CompactableMessage back to AI SDK format.
 */
export function compactableToModelMessage(
  msg: CompactableMessage
): { role: "user" | "assistant" | "system"; content: string } {
  return {
    role: msg.role,
    content: msg.content,
  };
}
