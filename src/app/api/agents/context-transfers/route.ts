/**
 * Context transfers between agents.
 * POST { fromAgent, toAgent, instructions? } — summarize + hand off.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";
import { transferContext } from "@/lib/orchestrator/agentTasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    fromAgent?: string;
    toAgent?: string;
    instructions?: string;
  } | null;
  const fromAgent = typeof body?.fromAgent === "string" ? body.fromAgent.trim() : "";
  const toAgent = typeof body?.toAgent === "string" ? body.toAgent.trim() : "";
  if (!fromAgent || !toAgent) {
    return NextResponse.json({ error: "Missing fromAgent or toAgent" }, { status: 400 });
  }

  const resolved = await resolveKeys(user.id, supabase, req.headers.get("cookie") || "");
  const provider = resolved.userKeys.anthropic
    ? ("anthropic" as const)
    : resolved.userKeys.openai
      ? ("openai" as const)
      : ("anthropic" as const);

  const outcome = await transferContext({
    userId: user.id,
    fromAgentRef: fromAgent,
    toAgentRef: toAgent,
    instructions: typeof body?.instructions === "string" ? body.instructions : null,
    provider,
    apiKey:
      provider === "anthropic"
        ? resolved.userKeys.anthropic || undefined
        : resolved.userKeys.openai || undefined,
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: 400 });
  }
  return NextResponse.json(outcome);
}
