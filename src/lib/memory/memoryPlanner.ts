/**
 * Memory Planner - AI-driven memory query planning
 * 
 * Uses a small LLM call to decide what questions to ask Datagran brain
 * based on the user's message and conversation context.
 */

import { generateText } from "ai";
import {
  resolveChatModel,
  type ProviderId,
} from "@/lib/ai/modelResolver";
import type { WikiLearningTarget } from "./wikiMemory";

export type MemoryPlannerInput = {
  userMessage: string;
  recentHistory?: Array<{ role: string; content: string }>;
  isNewSession: boolean;
};

export type MemoryPlannerOutput = {
  questions: string[];
  reasoning?: string;
  // Optional billing/debug metadata
  provider?: ProviderId;
  model?: string;
  usage?: unknown;
};

export type MemoryPlannerOptions = {
  apiKey?: string;
  provider?: ProviderId;
  model?: string;
};

const PLANNER_SYSTEM_PROMPT = `You are a memory query planner. Your job is to decide what questions to ask the user's memory system to retrieve relevant context for their request.

Given:
- The user's current message
- Whether this is a new session (no prior conversation history)
- Recent conversation history (if any)

Output a JSON object with:
- "questions": array of 0-2 questions to ask the memory system (max 2)
- "reasoning": brief explanation of why these questions will help (optional)

Guidelines:
- Questions should retrieve RELEVANT context that will help answer the user's request
- If the message is generic/capability-related ("what can you do?", "hello"), you may return 0 questions
- If the message references something specific (a project, app, preference, past work), craft questions to retrieve that context
- For new sessions, consider asking about ongoing projects or user preferences if relevant
- Keep questions natural and specific to what the user seems to need
- Don't ask redundant questions - quality over quantity

Examples:

User: "I want to modify my app"
New session: true
Output: {"questions": ["What app or project has this user been working on recently?", "What preferences or constraints has the user stated about their app development?"], "reasoning": "User refers to 'my app' - need to identify which app and any relevant context"}

User: "hello"
New session: true
Output: {"questions": [], "reasoning": "Generic greeting, no specific context needed"}

User: "can you help me with the dashboard bug we discussed?"
New session: false
Output: {"questions": ["What dashboard bug or issue has been discussed with this user?"], "reasoning": "User references a specific past discussion"}

User: "what's the weather?"
New session: true
Output: {"questions": [], "reasoning": "General knowledge question, user memory not relevant"}

User: "continue where we left off"
New session: true
Output: {"questions": ["What was this user working on in their most recent conversation?", "What tasks or projects are currently in progress for this user?"], "reasoning": "User wants to resume previous work, need to find latest context"}

Respond ONLY with valid JSON, no other text.`;

// Keep memory planning/storage on a cheap, current Anthropic model.
const MEMORY_PLANNER_ANTHROPIC_MODEL = "claude-haiku-4.5";

function normalizeStoredMemory(
  memoryNote?: string,
  label?: string
): { memoryNote?: string; label?: string } {
  const note = typeof memoryNote === "string" ? memoryNote.trim() : "";
  if (!note) return { memoryNote, label };

  let nextLabel = typeof label === "string" ? label.trim() : undefined;
  // Do not infer preference from rule-based heuristics.
  // Preference classification should be decided by the model output.
  if (/preference/i.test(nextLabel || "")) {
    nextLabel = "preference";
  }

  let normalizedNote = note.replace(/\s+/g, " ").trim();
  if (nextLabel === "preference") {
    normalizedNote = normalizedNote.replace(/^preference:\s*/i, "");
    normalizedNote = `Preference: ${normalizedNote}`;
  }

  if (normalizedNote.length > 200) {
    normalizedNote = `${normalizedNote.slice(0, 197).trim()}...`;
  }

  return { memoryNote: normalizedNote, label: nextLabel };
}

/**
 * Plan what memory queries to make based on user message and context.
 * Uses a fast, cheap LLM call to decide.
 */
export async function planMemoryQueries(
  input: MemoryPlannerInput,
  options?: MemoryPlannerOptions
): Promise<MemoryPlannerOutput> {
  const { userMessage, recentHistory, isNewSession } = input;

  // Build the user prompt
  const historyText = recentHistory?.length
    ? `Recent history:\n${recentHistory
        .slice(-4) // Last 4 messages max
        .map((m) => `${m.role}: ${m.content.slice(0, 200)}${m.content.length > 200 ? "..." : ""}`)
        .join("\n")}`
    : "Recent history: (none)";

  const userPrompt = `User message: "${userMessage}"
New session: ${isNewSession}
${historyText}

Output the JSON:`;

  try {
    // Use a fast model for planning (haiku or gpt-4o-mini)
    // Prefer Anthropic if available, fall back to OpenAI
    const resolvedModel = resolveMemoryPlannerModel(options);
    if (!resolvedModel) {
      // No API key available - return empty questions
      console.warn("[memoryPlanner] No API key available, skipping planning");
      return {
        questions: [],
        reasoning: "No API key available for planning",
      };
    }

    const result = await generateText({
      model: resolvedModel.model,
      system: PLANNER_SYSTEM_PROMPT,
      prompt: userPrompt,
    });

    const text = result.text.trim();
    
    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[memoryPlanner] No JSON found in response:", text);
      return { questions: [], reasoning: "Failed to parse planner response" };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { questions?: unknown; reasoning?: unknown };
    
    // Validate and extract questions
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.filter((q): q is string => typeof q === "string").slice(0, 2)
      : [];
    
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : undefined;

    console.log("[memoryPlanner] Planned queries:", { questions, reasoning, isNewSession });
    
    return {
      questions,
      reasoning,
      provider: resolvedModel.provider,
      model: resolvedModel.modelName,
      usage: (result as unknown as { usage?: unknown }).usage,
    };
  } catch (err) {
    console.error("[memoryPlanner] Error planning queries:", err);
    return {
      questions: [],
      reasoning: `Planning error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Decide if AI should store a memory based on conversation content.
 * Returns a distilled memory note if storage is recommended.
 */
export async function shouldStoreMemory(
  input: {
    userMessage: string;
    assistantResponse: string;
    existingMemoryContext?: string;
  },
  options?: MemoryPlannerOptions
): Promise<{
  shouldStore: boolean;
  memoryNote?: string;
  label?: string;
  reason?: string;
  wikiTarget?: WikiLearningTarget;
}> {
  const { userMessage, assistantResponse, existingMemoryContext } = input;

  const systemPrompt = `You decide whether a conversation exchange should be stored in long-term memory.

Store memories for:
- User preferences, constraints, or requirements they've stated
- Explicit standing rules such as "don't update me on X", "never mention Y", "always do Z"
- Project/app identity info (names, tech stack, goals)
- Important decisions or choices made
- Facts about the user or their work that will be useful later
- Instructions the user wants remembered

Do NOT store:
- Generic greetings or small talk
- Repetitive/routine exchanges
- Transient status updates
- Information already in memory context
- Questions and answers about general knowledge

Output JSON:
{
  "shouldStore": true/false,
  "memoryNote": "Concise note to store (if shouldStore is true)",
  "label": "Category label (e.g. 'project', 'preference', 'constraint')",
  "wikiCategory": "entities | concepts | projects",
  "wikiPage": "kebab-case page name without .md",
  "wikiTitle": "Human-readable page title",
  "reason": "Brief explanation"
}

If the memory is a preference/constraint:
- set label to "preference"
- write memoryNote as a normalized rule beginning with "Preference:"
- keep the rule explicit and actionable

Choose the Wiki target that will compound cleanly over time:
- entities: named people, companies, products, organizations, and places
- projects: named active projects, initiatives, roadmaps, and workstreams
- concepts: preferences, constraints, standing decisions, recurring methods, and uncategorized durable learnings
- reuse a stable page name for related learnings instead of creating one page per conversation
- use only a short kebab-case page name, never a directory or file extension

Keep memoryNote under 200 chars - distill the key info only.`;

  const userPrompt = `User said: "${userMessage.slice(0, 500)}"
Assistant replied: "${assistantResponse.slice(0, 500)}"
${existingMemoryContext ? `Existing memory context: "${existingMemoryContext.slice(0, 300)}"` : "No existing memory context."}

Should this be stored?`;

  try {
    const resolvedModel = resolveMemoryPlannerModel(options);
    if (!resolvedModel) {
      return { shouldStore: false, reason: "No API key available" };
    }

    const result = await generateText({
      model: resolvedModel.model,
      system: systemPrompt,
      prompt: userPrompt,
    });

    const text = result.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { shouldStore: false, reason: "Failed to parse decision" };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      shouldStore?: boolean;
      memoryNote?: string;
      label?: string;
      wikiCategory?: string;
      wikiPage?: string;
      wikiTitle?: string;
      reason?: string;
    };

    const shouldStore = parsed.shouldStore === true;
    let memoryNote = typeof parsed.memoryNote === "string" ? parsed.memoryNote : undefined;
    let label = typeof parsed.label === "string" ? parsed.label : undefined;

    if (shouldStore && memoryNote) {
      const normalized = normalizeStoredMemory(memoryNote, label);
      memoryNote = normalized.memoryNote;
      label = normalized.label;
    }

    const wikiCategory =
      parsed.wikiCategory === "entities" ||
      parsed.wikiCategory === "concepts" ||
      parsed.wikiCategory === "projects"
        ? parsed.wikiCategory
        : undefined;
    const wikiPage =
      typeof parsed.wikiPage === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(parsed.wikiPage)
        ? parsed.wikiPage
        : undefined;
    const wikiTitle =
      typeof parsed.wikiTitle === "string" && parsed.wikiTitle.trim()
        ? parsed.wikiTitle.trim().slice(0, 100)
        : undefined;

    return {
      shouldStore,
      memoryNote,
      label,
      wikiTarget:
        shouldStore && (wikiCategory || wikiPage || wikiTitle)
          ? {
              category: wikiCategory,
              page: wikiPage,
              title: wikiTitle,
            }
          : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch (err) {
    console.error("[memoryPlanner] Error deciding storage:", err);
    return { shouldStore: false, reason: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function resolveMemoryPlannerModel(options?: MemoryPlannerOptions): {
  model: ReturnType<typeof resolveChatModel>;
  provider: ProviderId;
  modelName: string;
} | null {
  if (options?.apiKey && options.provider) {
    const modelName =
      options.provider === "anthropic"
        ? MEMORY_PLANNER_ANTHROPIC_MODEL
        : options.provider === "openai"
          ? "gpt-4o-mini"
          : options.model;
    if (modelName) {
      return {
        model: resolveChatModel(options.provider, modelName, { apiKey: options.apiKey }),
        provider: options.provider,
        modelName,
      };
    }
  }

  if (options?.apiKey) {
    return {
      model: resolveChatModel("anthropic", MEMORY_PLANNER_ANTHROPIC_MODEL, {
        apiKey: options.apiKey,
      }),
      provider: "anthropic",
      modelName: MEMORY_PLANNER_ANTHROPIC_MODEL,
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return {
      model: resolveChatModel("anthropic", MEMORY_PLANNER_ANTHROPIC_MODEL),
      provider: "anthropic",
      modelName: MEMORY_PLANNER_ANTHROPIC_MODEL,
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      model: resolveChatModel("openai", "gpt-4o-mini"),
      provider: "openai",
      modelName: "gpt-4o-mini",
    };
  }

  return null;
}
