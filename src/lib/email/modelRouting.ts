import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";

export type EmailModelTier = "fast" | "quality" | "escalation";

export type ResolvedEmailModel = {
  provider: "openai";
  modelName: string;
  apiKey: string | null;
  tier: EmailModelTier;
  reasoningEffort: "none" | "low";
};

export const EMAIL_MODEL_PROVIDER = "openai" as const;
export const EMAIL_MODEL_NAME = "gpt-5.6-luna";

export function getEmailReasoningEffort(
  tier: EmailModelTier,
): "none" | "low" {
  return tier === "fast" ? "none" : "low";
}

export function chooseEmailAssistTier(args: {
  task: "complete" | "rewrite" | "draft" | "steer";
  instruction?: string;
  contextLength?: number;
}): EmailModelTier {
  if (args.task === "complete") return "fast";
  const direction = (args.instruction || "").toLowerCase();
  const explicitRescue =
    /\b(start over|try again|missed|wrong|nuance|sensitive|careful|high[- ]stakes)\b/.test(
      direction,
    );
  if (explicitRescue || (args.contextLength || 0) > 14_000) {
    return "escalation";
  }
  return "quality";
}

export async function resolveEmailModel(args: {
  supabase: SupabaseClient;
  userId: string;
  tier: EmailModelTier;
  cookieHeader?: string;
}): Promise<ResolvedEmailModel> {
  const keys = await resolveKeys(
    args.userId,
    args.supabase,
    args.cookieHeader || "",
  );
  const keyMode = keys.keyModes.openai || keys.globalMode;
  const apiKey =
    keyMode === "user" ? keys.userKeys.openai?.trim() || null : null;
  if (keyMode === "user" && !apiKey) {
    throw new Error(
      "Add an OpenAI API key in Settings to use Groovy Email AI.",
    );
  }
  if (keyMode === "groovy" && !process.env.OPENAI_API_KEY) {
    throw new Error("The Groovy OpenAI API key is not configured.");
  }
  return {
    provider: EMAIL_MODEL_PROVIDER,
    modelName: EMAIL_MODEL_NAME,
    apiKey,
    tier: args.tier,
    reasoningEffort: getEmailReasoningEffort(args.tier),
  };
}
