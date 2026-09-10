/**
 * Resolve the connector device to use for a user in server contexts
 * (Team Chat, WhatsApp webhooks, schedules).
 *
 * A saved preference is only useful while that connector is still active.
 * Connector records survive reinstalls/re-pairing, so blindly trusting an old
 * preferred id can route every command to an offline device even when a newer
 * connector is online.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const PREFERRED_DEVICE_RECENCY_MS = 2 * 60 * 1000;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type DeviceCandidate = {
  id?: unknown;
  last_seen?: unknown;
};

function lastSeenMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function chooseUserDeviceId(args: {
  devices: DeviceCandidate[];
  preferredDeviceId: string | null;
  nowMs?: number;
}): string | null {
  return chooseUserDeviceIds(args)[0] || null;
}

export function chooseUserDeviceIds(args: {
  devices: DeviceCandidate[];
  preferredDeviceId: string | null;
  nowMs?: number;
}): string[] {
  const devices = args.devices.flatMap((candidate) => {
    const id = asString(candidate.id);
    return id ? [{ id, lastSeen: lastSeenMs(candidate.last_seen) }] : [];
  });
  const preferredId = asString(args.preferredDeviceId);
  const preferred = preferredId
    ? devices.find((candidate) => candidate.id === preferredId) || null
    : null;
  const nowMs = args.nowMs ?? Date.now();

  if (
    preferred?.lastSeen != null &&
    nowMs - preferred.lastSeen <= PREFERRED_DEVICE_RECENCY_MS
  ) {
    return [
      preferred.id,
      ...devices
        .filter((candidate) => candidate.id !== preferred.id)
        .map((candidate) => candidate.id),
    ];
  }

  return devices.map((candidate) => candidate.id);
}

export async function resolveUserDeviceId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const deviceIds = await resolveUserDeviceIds(supabase, userId);
  return deviceIds[0] || null;
}

export async function resolveUserDeviceIds(
  supabase: SupabaseClient,
  userId: string
): Promise<string[]> {
  let preferredDeviceId: string | null = null;
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
    preferredDeviceId = asString(onboardingData?.connectorDeviceId);
  } catch {
    // Device recency still provides a safe fallback.
  }

  try {
    const { data: devices } = await supabase
      .from("devices")
      .select("id,last_seen")
      .eq("user_id", userId)
      .order("last_seen", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(20);
    return chooseUserDeviceIds({
      devices: (devices || []) as DeviceCandidate[],
      preferredDeviceId,
    });
  } catch {
    return [];
  }
}
