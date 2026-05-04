import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { encryptLlmApiKey, sha256Hex } from "@/lib/crypto/llmKey";
import { datagranCreateMemoryConnection } from "@/lib/datagran/memory";

type PostBody = {
  apiKey?: unknown;
};

type DatagranCreateConnectionResult = Awaited<ReturnType<typeof datagranCreateMemoryConnection>>;

function isRetryableCreateConnectionFailure(result: DatagranCreateConnectionResult): boolean {
  if (result.ok) return false;
  const status = typeof result.status === "number" ? result.status : null;
  if (status === null || status === 0) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  const resultError = (result as { error?: unknown }).error;
  const msg = typeof resultError === "string" ? resultError : JSON.stringify(resultError ?? "");
  return /(timeout|temporar|network|econn|aborted|rate limit|too many requests)/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createMemoryConnectionWithRetry(args: {
  apiKey: string;
  endUserExternalId: string;
  email?: string;
  userId: string;
  maxAttempts?: number;
}): Promise<DatagranCreateConnectionResult> {
  const maxAttempts = Math.max(1, args.maxAttempts || 3);
  let lastResult: DatagranCreateConnectionResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await datagranCreateMemoryConnection({
      apiKey: args.apiKey,
      endUserExternalId: args.endUserExternalId,
      email: args.email,
    });
    lastResult = result;
    if (result.ok) return result;

    const retryable = isRetryableCreateConnectionFailure(result);
    if (!retryable || attempt >= maxAttempts) return result;

    const delayMs = attempt === 1 ? 350 : attempt === 2 ? 900 : 1800;
    console.warn("[memory/config] datagranCreateMemoryConnection retrying", {
      userId: args.userId,
      externalId: args.endUserExternalId,
      attempt,
      maxAttempts,
      status: result.status ?? null,
      delayMs,
    });
    await sleep(delayMs);
  }

  return (
    lastResult || {
      ok: false as const,
      status: 0,
      error: "Unknown connection creation error",
    }
  );
}

function toStringOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return null;
  return String(v);
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("datagran_memory_configs")
    .select("connection_id,end_user_external_id,datagran_api_key_hash")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: error.message || "Failed to load config" },
      { status: 500 }
    );
  }

  const configured = Boolean(data?.datagran_api_key_hash && data?.connection_id);
  return NextResponse.json({
    configured,
    hasConnection: Boolean(data?.connection_id),
    endUserExternalId: data?.end_user_external_id || null,
  });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const apiKey = (toStringOrNull(body.apiKey) || "").trim();

  if (!apiKey) {
    return NextResponse.json({ error: "Datagran API key is required" }, { status: 400 });
  }

  const endUserExternalId = `flow_${user.id}`;

  // Create or retrieve memory connection from Datagran (with retry for transient failures)
  const memRes = await createMemoryConnectionWithRetry({
    apiKey,
    endUserExternalId,
    email: user.email || undefined,
    userId: user.id,
  });

  if (!memRes.ok) {
    return NextResponse.json(
      { error: `Datagran API error: ${memRes.error}` },
      { status: memRes.status || 500 }
    );
  }

  const connectionId = memRes.data.connection_id;
  if (!connectionId) {
    return NextResponse.json(
      { error: "Datagran did not return a connection_id" },
      { status: 500 }
    );
  }

  const enc = encryptLlmApiKey(apiKey);
  const hash = sha256Hex(apiKey);

  const { error } = await supabase.from("datagran_memory_configs").upsert(
    {
      user_id: user.id,
      datagran_api_key_enc: enc,
      datagran_api_key_hash: hash,
      end_user_external_id: endUserExternalId,
      connection_id: connectionId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) {
    return NextResponse.json(
      { error: error.message || "Failed to save config" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, connectionId });
}

