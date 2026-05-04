import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import { datagranQueryBrain, type DatagranMindState } from "@/lib/datagran/memory";
import OpenAI from "openai";

export const maxDuration = 800;

type PostBody = {
  question?: unknown;
  mind_state?: unknown;
};

// Tool definitions for OpenAI function calling
const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "open_agent",
      description: "Opens an agent card by its name. Use this when the user wants to open, show, or go to a specific agent.",
      parameters: {
        type: "object",
        properties: {
          agent_name: {
            type: "string",
            description: "The agent's name or partial name to match",
          },
        },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_agent",
      description: "Closes the currently open agent panel",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "Types text into the active agent's input field",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The text to type into the input",
          },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description: "Sends/submits the current message in the active agent",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_input",
      description: "Clears the current input field",
      parameters: { type: "object", properties: {} },
    },
  },
];

function toStringOrEmpty(v: unknown) {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

function isMindState(v: unknown): v is DatagranMindState {
  return v === "auto" || v === "short_term" || v === "mid_term" || v === "long_term";
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const nowIso = new Date().toISOString();

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const question = toStringOrEmpty(body.question).trim();
  const mindState = isMindState(body.mind_state) ? body.mind_state : "auto";
  if (!question) return NextResponse.json({ error: "Missing question" }, { status: 400 });

  const { data: cfg, error: cfgError } = await supabase
    .from("datagran_memory_configs")
    .select("datagran_api_key_enc, connection_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (cfgError) {
    return NextResponse.json(
      { error: cfgError.message || "Failed to load memory config" },
      { status: 500 }
    );
  }

  if (!cfg?.datagran_api_key_enc) {
    return NextResponse.json(
      { error: "Datagran memory not configured. Add your Datagran API key first." },
      { status: 400 }
    );
  }

  const connectionId = (cfg.connection_id || "").trim();
  if (!connectionId) {
    return NextResponse.json(
      {
        error:
          "Datagran memory needs a connection_id. Add it in the memory settings (from your Datagran dashboard).",
      },
      { status: 400 }
    );
  }

  let apiKey: string;
  try {
    apiKey = decryptLlmApiKey(cfg.datagran_api_key_enc);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to decrypt Datagran API key" },
      { status: 500 }
    );
  }

  const result = await datagranQueryBrain({
    apiKey,
    connectionId,
    question,
    mindState,
    providers: ["memory"], // Filter to only memory provider (our traces)
    include: { evidence: true, precision: false },
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: `Datagran API error (${result.status}): ${result.error}` },
      { status: 502 }
    );
  }

  // Extract raw memory text from Datagran response
  const data = result.data;
  const rawMemory =
    (data.short_term as { raw_text?: string })?.raw_text ||
    (data.mid_term as { raw_text?: string })?.raw_text ||
    (data.long_term as { raw_text?: string })?.raw_text ||
    "";

  // If no memory found, return early
  if (!rawMemory.trim()) {
    return NextResponse.json({
      answer: "I don't have any memory of previous interactions yet. Try asking me something after chatting with an agent.",
      raw_data: data,
    });
  }

  // Use OpenAI to synthesize an answer from the raw memory (with tool calling)
  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a helpful assistant that answers questions and can take actions based on the user's conversation history/memory.
You will be given raw memory traces from the user's previous interactions with AI agents.

CURRENT_DATETIME_ISO: ${nowIso}

About MEMORY TRACES:
- MEMORY TRACES is a concatenation of many independent trace blocks, each representing one user prompt (PROMPT) and an optional agent output (RESPONSE).
- This is an append-only activity log across multiple agents; treat it as a timeline. Use CREATED_AT to order events chronologically.
- To reconstruct a conversation thread, group traces by SESSION_ID when present (best), otherwise by AGENT name + close CREATED_AT proximity, and use TRACE_ID as a stable identifier.
- METADATA_JSON may contain additional context (e.g., repository, cursor_agent_id, flags). Use it when the user asks “which agent”, “which repo/branch”, “what task”, or similar.

You can:
1. Answer questions about the memory traces
2. Take actions like opening agents, typing text, or sending messages

When the user asks to "open" an agent or wants to interact with one from their history, use the open_agent tool with the agent name from the traces.
When you open an agent, you can also type a message and send it if the user requests.

Answer quality rules:
- Use the timestamps in the traces (CREATED_AT) to interpret time-based queries.
- If the user asks "today", only include traces whose date matches today relative to CURRENT_DATETIME_ISO (use UTC if timezone is unknown; say you're using UTC if it matters).
- If the user asks "yesterday/this week/last week", apply the same idea: filter by date range and do not include outside-range items unless explicitly requested.
- Always include the agent name when the user asks "which agent did I ask", and include time (HH:MM) when available or at least the ISO timestamp.
- If the user asks for “the conversation” with an agent, present the ordered sequence of PROMPT/RESPONSE pairs for that agent (and SESSION_ID if available), in chronological order.
- Prefer tight bullet points. Avoid padding or unrelated history.

Be concise and helpful.`,
        },
        {
          role: "user",
          content: `MEMORY TRACES:
${rawMemory.slice(0, 50000)}

CURRENT_DATETIME_ISO: ${nowIso}

USER REQUEST: ${question}

If this is a question, answer it based on the memory traces.
If this is a command to open an agent or take an action, use the appropriate tool.`,
        },
      ],
      tools,
      tool_choice: "auto",
    });

    const message = completion.choices[0]?.message;
    const answer = message?.content || "";
    const toolCalls = message?.tool_calls || [];

    console.log("[memory/brain] AI result:", {
      answer: answer.slice(0, 100),
      toolCallCount: toolCalls.length,
    });

    // Parse tool calls into commands
    const commands = toolCalls
      .filter((tc): tc is OpenAI.ChatCompletionMessageToolCall & { type: "function" } => 
        tc.type === "function"
      )
      .map((tc) => {
        const args = JSON.parse(tc.function.arguments || "{}");
        return {
          type: tc.function.name,
          ...args,
        };
      });

    return NextResponse.json({
      answer: answer || (commands.length > 0 ? "Opening agent..." : ""),
      commands, // Array of commands to execute
      raw_data: data,
    });
  } catch (err) {
    console.error("[memory/brain] OpenAI error:", err);
    // Fallback: return raw data without AI synthesis
    return NextResponse.json({
      answer: "Unable to process memory. Here's the raw data.",
      raw_data: data,
      error: err instanceof Error ? err.message : "OpenAI error",
    });
  }
}

