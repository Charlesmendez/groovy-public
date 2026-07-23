/**
 * User-selectable orchestrator "brain" model.
 *
 * The selection is stored in user_preferences.onboarding_data.orchestratorModel
 * ({ provider, model }) — NOT on the orchestrator-runtime agents row, because
 * those rows are created with a default provider/model and would make every
 * user look like they had picked one (silently overriding the env-resolved
 * default fleet-wide).
 *
 * v1 scope: anthropic | openai (matches the main-call machinery incl.
 * compaction and summarizers).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ResolvedKeys } from "@/lib/keys/resolveKeyMode";

export type OrchestratorModelOverride = {
  provider: "anthropic" | "openai";
  modelName: string;
  /** User key when their mode requires one; null = use server env key. */
  apiKey: string | null;
  reasoningEffort: string | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type StoredOrchestratorModel = {
  provider: "anthropic" | "openai";
  model: string;
  reasoningEffort: string | null;
} | null;

/** Read the explicit user selection (null when the user never picked one). */
export async function readOrchestratorModelSelection(
  supabase: SupabaseClient,
  userId: string
): Promise<StoredOrchestratorModel> {
  try {
    const { data: prefs } = await supabase
      .from("user_preferences")
      .select("onboarding_data")
      .eq("user_id", userId)
      .maybeSingle();
    const od =
      prefs?.onboarding_data && typeof prefs.onboarding_data === "object"
        ? (prefs.onboarding_data as Record<string, unknown>)
        : null;
    const raw =
      od?.orchestratorModel && typeof od.orchestratorModel === "object"
        ? (od.orchestratorModel as {
            provider?: unknown;
            model?: unknown;
            reasoningEffort?: unknown;
          })
        : null;
    const provider = asString(raw?.provider);
    const model = asString(raw?.model);
    if (!model || (provider !== "anthropic" && provider !== "openai")) return null;
    return { provider, model, reasoningEffort: asString(raw?.reasoningEffort) };
  } catch {
    return null;
  }
}

export async function resolveOrchestratorModelOverride(args: {
  supabase: SupabaseClient;
  userId: string;
  /** Kept for call-site compatibility; the selection is per-user. */
  agentId?: string | null;
  resolved: ResolvedKeys;
  selectionOverride?: StoredOrchestratorModel;
}): Promise<OrchestratorModelOverride | null> {
  const selection =
    args.selectionOverride === undefined
      ? await readOrchestratorModelSelection(args.supabase, args.userId)
      : args.selectionOverride;
  if (!selection) return null;

  // Respect the user's key mode for the chosen provider: in "user" mode the
  // call must use their key; without one, skip the override rather than
  // silently billing the server key.
  const mode = args.resolved.keyModes[selection.provider] || args.resolved.globalMode;
  const userKey = args.resolved.userKeys[selection.provider] || null;
  if (mode === "user" && !userKey) return null;

  return {
    provider: selection.provider,
    modelName: selection.model,
    apiKey: mode === "user" ? userKey : null,
    reasoningEffort: selection.reasoningEffort,
  };
}
