/**
 * Orchestrator "brain" model selection.
 *
 * GET   — current explicit selection (null = Auto / env-resolved default).
 * PATCH — { provider: "anthropic"|"openai", model: string } or { model: null }
 *         to clear back to Auto.
 *
 * Stored in user_preferences.onboarding_data.orchestratorModel. NOT on the
 * orchestrator-runtime agents row: those rows carry creation-default
 * provider/model values, which made "has a model" indistinguishable from
 * "user picked a model".
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readOrchestratorModelSelection } from "@/lib/orchestrator/orchestratorModel";
import { reasoningEffortsForModel } from "@/lib/ai/modelCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const selection = await readOrchestratorModelSelection(supabase, user.id);
  return NextResponse.json({
    provider: selection?.provider || null,
    model: selection?.model || null,
    reasoningEffort: selection?.reasoningEffort || null,
  });
}

export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    provider?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
  } | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
  const provider =
    body.provider === "anthropic" || body.provider === "openai" ? body.provider : null;
  const reasoningEffort =
    provider && typeof body.reasoningEffort === "string" && body.reasoningEffort.trim()
      ? body.reasoningEffort.trim()
      : null;
  if (
    reasoningEffort &&
    !reasoningEffortsForModel(model).includes(
      reasoningEffort as ReturnType<typeof reasoningEffortsForModel>[number]
    )
  ) {
    return NextResponse.json({ error: "Unsupported reasoning effort" }, { status: 400 });
  }
  if (model && !provider) {
    return NextResponse.json(
      { error: "provider must be anthropic or openai when setting a model" },
      { status: 400 }
    );
  }

  // Shallow-merge into onboarding_data (same semantics as the prefs route).
  const { data: prefs } = await supabase
    .from("user_preferences")
    .select("onboarding_data")
    .eq("user_id", user.id)
    .maybeSingle();
  const existing =
    prefs?.onboarding_data && typeof prefs.onboarding_data === "object"
      ? (prefs.onboarding_data as Record<string, unknown>)
      : {};
  const { error } = await supabase.from("user_preferences").upsert(
    {
      user_id: user.id,
      onboarding_data: {
        ...existing,
        orchestratorModel: model ? { provider, model, reasoningEffort } : null,
        orchestratorModelSet: !!model,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    provider: model ? provider : null,
    model,
    reasoningEffort: model ? reasoningEffort : null,
  });
}
