/**
 * Resolve the connector device to use for a user in server contexts
 * (WhatsApp webhooks, schedules): the onboarding-preferred device when it is
 * still owned by the user, else the most recently seen device.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function resolveUserDeviceId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  try {
    const { data: prefs } = await supabase
      .from("user_preferences")
      .select("onboarding_data")
      .eq("user_id", userId)
      .maybeSingle();
    const onboardingData =
      prefs?.onboarding_data && typeof prefs.onboarding_data === "object"
        ? (prefs.onboarding_data as Record<string, unknown>)
        : null;
    const preferred = asString(onboardingData?.connectorDeviceId);
    if (preferred) {
      const { data: owned } = await supabase
        .from("devices")
        .select("id")
        .eq("user_id", userId)
        .eq("id", preferred)
        .maybeSingle();
      if (asString((owned as { id?: unknown } | null)?.id)) return preferred;
    }
  } catch {
    // fall through to latest device
  }

  try {
    const { data: latest } = await supabase
      .from("devices")
      .select("id")
      .eq("user_id", userId)
      .order("last_seen", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return asString((latest as { id?: unknown } | null)?.id);
  } catch {
    return null;
  }
}
