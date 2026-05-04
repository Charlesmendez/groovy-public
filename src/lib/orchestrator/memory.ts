/**
 * Orchestrator Memory Integration
 * Uses Datagran Brain with Groovy's server-side API key.
 */

import {
  datagranCreateMemoryConnection,
  datagranQueryBrain,
  datagranCompileRawText,
  formatTraceAsRawText,
  type DatagranBrainResponse,
} from "@/lib/datagran/memory";

const GROOVY_DATAGRAN_API_KEY = process.env.DATAGRAN_API_KEY || "";

// Cache memory connection IDs per user
const connectionCache = new Map<string, string>();

/**
 * Get or create a memory connection for a user
 */
export async function getMemoryConnection(userId: string, email?: string): Promise<string | null> {
  if (!GROOVY_DATAGRAN_API_KEY) {
    console.warn("[memory] DATAGRAN_API_KEY not configured, memory disabled");
    return null;
  }

  // Check cache first
  const cached = connectionCache.get(userId);
  if (cached) return cached;

  try {
    const result = await datagranCreateMemoryConnection({
      apiKey: GROOVY_DATAGRAN_API_KEY,
      endUserExternalId: userId,
      email,
    });

    if (result.ok && result.data?.connection_id) {
      const connectionId = result.data.connection_id;
      connectionCache.set(userId, connectionId);
      console.log("[memory] Created/retrieved memory connection:", connectionId);
      return connectionId;
    }

    console.error("[memory] Failed to create connection:", result);
    return null;
  } catch (err) {
    console.error("[memory] Error creating connection:", err);
    return null;
  }
}

/**
 * Query the brain for relevant context
 */
export async function queryMemory(
  connectionId: string,
  question: string
): Promise<{
  context: string;
  data: DatagranBrainResponse | null;
}> {
  if (!GROOVY_DATAGRAN_API_KEY || !connectionId) {
    return { context: "", data: null };
  }

  try {
    const result = await datagranQueryBrain({
      apiKey: GROOVY_DATAGRAN_API_KEY,
      connectionId,
      question,
      mindState: "auto",
      include: { evidence: true },
    });

    if (!result.ok || !result.data) {
      return { context: "", data: null };
    }

    const brain = result.data;
    const contextParts: string[] = [];

    // Format memory layers into context
    if (brain.short_term && typeof brain.short_term === "object") {
      const st = brain.short_term as Record<string, unknown>;
      if (st.summary) {
        contextParts.push(`Recent context: ${st.summary}`);
      }
    }

    if (brain.mid_term && typeof brain.mid_term === "object") {
      const mt = brain.mid_term as Record<string, unknown>;
      if (mt.summary) {
        contextParts.push(`Session context: ${mt.summary}`);
      }
    }

    if (brain.long_term && typeof brain.long_term === "object") {
      const lt = brain.long_term as Record<string, unknown>;
      if (lt.summary) {
        contextParts.push(`Long-term memory: ${lt.summary}`);
      }
    }

    if (brain.evidence && Array.isArray(brain.evidence)) {
      const evidenceText = brain.evidence
        .slice(0, 3)
        .map((e, i) => `[${i + 1}] ${typeof e === "string" ? e : JSON.stringify(e)}`)
        .join("\n");
      if (evidenceText) {
        contextParts.push(`Relevant memories:\n${evidenceText}`);
      }
    }

    return {
      context: contextParts.join("\n\n"),
      data: brain,
    };
  } catch (err) {
    console.error("[memory] Error querying brain:", err);
    return { context: "", data: null };
  }
}

/**
 * Store a conversation trace to memory
 */
export async function storeToMemory(
  connectionId: string,
  trace: {
    traceId: string;
    createdAtIso: string;
    prompt: string;
    response: string;
    agentName?: string;
    agentType?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<boolean> {
  if (!GROOVY_DATAGRAN_API_KEY || !connectionId) {
    return false;
  }

  try {
    const rawText = formatTraceAsRawText({
      traceId: trace.traceId,
      createdAtIso: trace.createdAtIso,
      agentName: trace.agentName || "Orchestrator",
      agentType: trace.agentType || "orchestrator",
      prompt: trace.prompt,
      response: trace.response,
      metadata: trace.metadata,
    });

    const result = await datagranCompileRawText({
      apiKey: GROOVY_DATAGRAN_API_KEY,
      connectionId,
      text: rawText,
      name: `trace-${trace.traceId}`,
      ref: trace.traceId,
    });

    if (result.ok) {
      console.log("[memory] Stored trace to memory:", trace.traceId);
      return true;
    }

    console.error("[memory] Failed to store trace:", result);
    return false;
  } catch (err) {
    console.error("[memory] Error storing trace:", err);
    return false;
  }
}

/**
 * Store an explicit memory (user said "remember this")
 */
export async function storeExplicitMemory(
  connectionId: string,
  content: string,
  label?: string
): Promise<boolean> {
  if (!GROOVY_DATAGRAN_API_KEY || !connectionId) {
    return false;
  }

  try {
    const timestamp = new Date().toISOString();
    const memoryId = `mem-${Date.now()}`;
    const rawText = `MEMORY_ID: ${memoryId}
TIMESTAMP: ${timestamp}
TYPE: explicit_memory
LABEL: ${label || "User Memory"}

CONTENT:
${content}
`;

    const result = await datagranCompileRawText({
      apiKey: GROOVY_DATAGRAN_API_KEY,
      connectionId,
      text: rawText,
      name: label || `memory-${memoryId}`,
      ref: memoryId,
    });

    if (result.ok) {
      console.log("[memory] Stored explicit memory:", memoryId);
      return true;
    }

    console.error("[memory] Failed to store explicit memory:", result);
    return false;
  } catch (err) {
    console.error("[memory] Error storing explicit memory:", err);
    return false;
  }
}

/**
 * Format brain response into a system prompt addition
 */
export function formatMemoryForSystemPrompt(memoryContext: string): string {
  if (!memoryContext.trim()) return "";

  return `
## Memory Context
The following is relevant context from the user's memory and previous conversations:

${memoryContext}

Use this context to provide more personalized and informed responses. Reference previous conversations when relevant.
`;
}
