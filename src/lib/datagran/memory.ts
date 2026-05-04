export type DatagranMindState = "auto" | "short_term" | "mid_term" | "long_term";

/** A single long-term chunk returned by the new Datagran brain format (2026-02-10+). */
export type DatagranLongTermChunk = {
  epoch?: number;
  chunk_index?: number;
  provider?: string;
  snippet?: string;
  relevance?: number;
  source_artifact_version_id?: string;
  source_created_at?: string;
};

/** A single citation returned by the new Datagran brain format. */
export type DatagranCitation = {
  kind?: string;
  ref?: string;
  provider?: string;
  ts?: string;
  score?: number;
  semantic?: number;
  freshness?: number;
};

export type DatagranBrainResponse = {
  success: boolean;
  answer?: string;
  mode?: string;
  short_term?: unknown;
  mid_term?: unknown;
  /** Old format: object with raw_text. New format (2026-02-10+): array of DatagranLongTermChunk. */
  long_term?: unknown;
  evidence?: unknown;
  citations?: DatagranCitation[];
  memory_weights?: unknown;
  trace_id?: string;
  suggested_action?: unknown;
  usage?: unknown;
  latency_ms?: number;
  freshness?: unknown;
  brain?: unknown;
};

export type DatagranCompileResponse = {
  success: boolean;
  compiled_memory_id?: string;
  artifact_id?: string;
  version_number?: number;
  num_beacons?: number;
  source_token_count?: number;
  compression_ratio?: number;
  size_bytes?: number;
};

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

export function formatTraceAsRawText(input: {
  traceId: string;
  createdAtIso: string;
  agentName: string;
  agentType: string;
  flagKey?: string | null;
  provider?: string | null;
  model?: string | null;
  sessionId?: string | null;
  prompt: string;
  response?: string | null;
  metadata?: unknown;
}) {
  const lines: string[] = [];
  lines.push(`TRACE_ID: ${input.traceId}`);
  lines.push(`CREATED_AT: ${input.createdAtIso}`);
  lines.push(`AGENT: ${input.agentName}`);
  lines.push(`AGENT_TYPE: ${input.agentType}`);
  if (input.flagKey) lines.push(`FLAG: ${input.flagKey}`);
  if (input.provider) lines.push(`PROVIDER: ${input.provider}`);
  if (input.model) lines.push(`MODEL: ${input.model}`);
  if (input.sessionId) lines.push(`SESSION_ID: ${input.sessionId}`);
  lines.push("");
  lines.push("PROMPT:");
  lines.push(input.prompt || "");
  lines.push("");
  if (typeof input.response === "string" && input.response.trim()) {
    lines.push("RESPONSE:");
    lines.push(input.response);
    lines.push("");
  }
  if (input.metadata !== undefined) {
    lines.push("METADATA_JSON:");
    lines.push(safeJson(input.metadata));
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

export async function datagranCompileRawText(args: {
  apiKey: string;
  connectionId?: string | null;
  text: string;
  name: string;
  ref?: string;
  alpha?: number;
  chunkSize?: number;
}) {
  const body: Record<string, unknown> = {
    type: "raw_text",
    text: args.text,
    name: args.name,
  };

  if (args.ref) body.ref = args.ref;
  if (typeof args.alpha === "number") body.alpha = args.alpha;
  if (typeof args.chunkSize === "number") body.chunkSize = args.chunkSize;
  if (args.connectionId) body.connection_id = args.connectionId;

  // 2 minute timeout for compile (can be slow)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  let res: Response;
  try {
    res = await fetch("https://www.datagran.io/api/context/compile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": args.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    // Handle timeout/abort errors
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false as const, status: 408, error: "Request timeout" };
    }
    return { ok: false as const, status: 0, error: String(err) };
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!res.ok) {
    return {
      ok: false as const,
      status: res.status,
      error: typeof json === "string" ? json : safeJson(json),
    };
  }

  return { ok: true as const, data: json as DatagranCompileResponse };
}

export type DatagranMemoryConnectionResponse = {
  success: boolean;
  connection_id?: string;
  end_user_id?: string;
  end_user_external_id?: string;
  provider?: string;
  created?: boolean;
  message?: string;
};

/**
 * Create or retrieve a memory-only connection for a user.
 * This eliminates the need to ask users for a connection_id.
 */
export async function datagranCreateMemoryConnection(args: {
  apiKey: string;
  endUserExternalId: string;
  email?: string;
}) {
  const res = await fetch("https://www.datagran.io/api/connections/memory", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": args.apiKey,
    },
    body: JSON.stringify({
      endUser: {
        externalId: args.endUserExternalId,
        ...(args.email ? { email: args.email } : {}),
      },
    }),
  });

  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!res.ok) {
    return {
      ok: false as const,
      status: res.status,
      error: typeof json === "string" ? json : safeJson(json),
    };
  }

  return { ok: true as const, data: json as DatagranMemoryConnectionResponse };
}

export async function datagranQueryBrain(args: {
  apiKey: string;
  connectionId: string;
  question: string;
  mindState?: DatagranMindState;
  providers?: string[];
  include?: { evidence?: boolean; precision?: boolean };
}) {
  // 5 minute timeout for brain queries (can be slow on large memory sets)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300_000);

  let res: Response;
  try {
    res = await fetch("https://www.datagran.io/api/context/brain", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": args.apiKey,
      },
      body: JSON.stringify({
        connection_id: args.connectionId,
        question: args.question,
        mind_state: args.mindState || "auto",
        ...(args.providers ? { providers: args.providers } : {}),
        ...(args.include ? { include: args.include } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    // Handle timeout/abort errors
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false as const, status: 408, error: "Request timeout" };
    }
    return { ok: false as const, status: 0, error: String(err) };
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!res.ok) {
    return {
      ok: false as const,
      status: res.status,
      error: typeof json === "string" ? json : safeJson(json),
    };
  }

  return { ok: true as const, data: json as DatagranBrainResponse };
}

