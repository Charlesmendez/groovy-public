import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import {
  continueParallelBranchRuntime,
  type ParallelBranchConnectorToolResultInput,
  type ParallelBranchRuntimeState,
} from "@/lib/orchestrator/parallelBranchRuntime";

type PostBody = {
  state?: ParallelBranchRuntimeState;
  toolResults?: ParallelBranchConnectorToolResultInput[];
};

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || typeof body !== "object" || !body.state || typeof body.state !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const deviceToken = req.headers.get("x-device-token") || req.headers.get("X-Device-Token") || "";
  const supabaseCookie = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabaseCookie.auth.getUser();

  const cookie = req.headers.get("cookie") || "";
  let userId: string | null = user?.id || null;
  const supabase =
    userId && !userError
      ? supabaseCookie
      : (() => {
          if (!deviceToken) return null;
          const secret = process.env.RELAY_JWT_SECRET || "";
          const verified = verifyRelayDeviceToken(deviceToken, secret);
          if (!verified) return null;
          userId = verified.userId;
          return createSupabaseAdminClient();
        })();

  if (!supabase || !userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const toolResults = Array.isArray(body.toolResults)
    ? body.toolResults.filter(
        (row): row is ParallelBranchConnectorToolResultInput =>
          !!row &&
          typeof row.branchId === "string" &&
          typeof row.toolCallId === "string" &&
          typeof row.toolName === "string" &&
          typeof row.result === "string"
      )
    : [];

  try {
    const result = await continueParallelBranchRuntime({
      supabase,
      userId,
      state: body.state,
      toolResults,
      cookies: cookie || undefined,
      deviceToken: deviceToken || undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to continue parallel branches.",
      },
      { status: 500 }
    );
  }
}
