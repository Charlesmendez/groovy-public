import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordExtensionRunnerHeartbeat } from "@/lib/extensions/runners";
import { sha256Hex } from "@/lib/crypto/llmKey";

type PostBody = {
  status?: unknown;
  metadata?: unknown;
  lastSeenAt?: unknown;
};

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const runnerId = asTrimmed(id);
  if (!runnerId) {
    return NextResponse.json({ error: "Runner id is required" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    let scopedClient: typeof supabase | ReturnType<typeof createSupabaseAdminClient> = supabase;
    let userId = user?.id || "";
    if (!userId) {
      const authHeader = req.headers.get("authorization") || "";
      const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
      const token = tokenMatch?.[1]?.trim() || "";
      if (!token) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const admin = createSupabaseAdminClient();
      const { data: runner, error: runnerError } = await admin
        .from("orchestrator_extension_runners")
        .select("id,user_id")
        .eq("id", runnerId)
        .eq("auth_token_hash", sha256Hex(token))
        .maybeSingle();

      if (runnerError || !runner) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      scopedClient = admin;
      userId = asTrimmed(runner.user_id);
    }

    const runner = await recordExtensionRunnerHeartbeat({
      supabase: scopedClient,
      userId,
      runnerId,
      status:
        body.status === "pending" || body.status === "offline" || body.status === "error"
          ? body.status
          : "online",
      metadata: body.metadata,
      lastSeenAt: asTrimmed(body.lastSeenAt) || null,
    });

    return NextResponse.json({ runner });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update runner heartbeat" },
      { status: 400 }
    );
  }
}
