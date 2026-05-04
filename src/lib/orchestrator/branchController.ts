import type { SupabaseClient } from "@supabase/supabase-js";

export type BranchControllerMode = "read_only" | "read_write";

export type BranchControllerSettings = {
  maxBranches: number;
  maxTurnsPerBranch: number;
  mode: BranchControllerMode;
};

const DEFAULT_SETTINGS: BranchControllerSettings = {
  maxBranches: 4,
  maxTurnsPerBranch: 8,
  mode: "read_write",
};

function toBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function normalizeBranchControllerSettings(input: unknown): BranchControllerSettings {
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const modeRaw = typeof rec.mode === "string" ? rec.mode.trim().toLowerCase() : "";
  const mode: BranchControllerMode = modeRaw === "read_only" ? "read_only" : "read_write";
  return {
    maxBranches: toBoundedInt(rec.maxBranches, DEFAULT_SETTINGS.maxBranches, 1, 12),
    maxTurnsPerBranch: toBoundedInt(rec.maxTurnsPerBranch, DEFAULT_SETTINGS.maxTurnsPerBranch, 1, 64),
    mode,
  };
}

export async function loadBranchControllerSettings(
  supabase: SupabaseClient,
  userId: string
): Promise<BranchControllerSettings> {
  const { data } = await supabase
    .from("user_preferences")
    .select("branch_controller,onboarding_data")
    .eq("user_id", userId)
    .maybeSingle();
  const row = (data || null) as
    | { branch_controller?: unknown; onboarding_data?: Record<string, unknown> | null }
    | null;
  const explicit = normalizeBranchControllerSettings(row?.branch_controller);
  if (row?.branch_controller && typeof row.branch_controller === "object") {
    return explicit;
  }
  const legacy = row?.onboarding_data && typeof row.onboarding_data === "object"
    ? normalizeBranchControllerSettings((row.onboarding_data as Record<string, unknown>).branchController)
    : DEFAULT_SETTINGS;
  return legacy;
}

export async function saveBranchControllerSettings(args: {
  supabase: SupabaseClient;
  userId: string;
  settings: BranchControllerSettings;
}) {
  const normalized = normalizeBranchControllerSettings(args.settings);
  const nowIso = new Date().toISOString();
  await args.supabase
    .from("user_preferences")
    .upsert(
      {
        user_id: args.userId,
        branch_controller: normalized,
        updated_at: nowIso,
      },
      { onConflict: "user_id" }
    );
  return normalized;
}
