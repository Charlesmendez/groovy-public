import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createHash } from "crypto";

function generatePairingCode() {
  const raw = randomBytes(8).toString("hex").toUpperCase(); // 16 chars
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(
    12,
    16
  )}`;
}

function sha256Hex(s: string) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { rebindFromDeviceId?: string } | null;

  let rawRebindFromDeviceId =
    typeof body?.rebindFromDeviceId === "string" ? body.rebindFromDeviceId.trim() : "";
  if (!rawRebindFromDeviceId) {
    const { data: prefs } = await supabase
      .from("user_preferences")
      .select("onboarding_data")
      .eq("user_id", user.id)
      .maybeSingle();
    const onboardingData =
      prefs?.onboarding_data && typeof prefs.onboarding_data === "object"
        ? (prefs.onboarding_data as Record<string, unknown>)
        : null;
    rawRebindFromDeviceId =
      typeof onboardingData?.connectorDeviceId === "string"
        ? onboardingData.connectorDeviceId.trim()
        : "";
  }
  let rebindFromDeviceId: string | null = null;
  if (rawRebindFromDeviceId) {
    const { data: sourceDevice, error: sourceDeviceErr } = await supabase
      .from("devices")
      .select("id")
      .eq("user_id", user.id)
      .eq("id", rawRebindFromDeviceId)
      .limit(1)
      .maybeSingle();
    if (sourceDeviceErr) {
      return NextResponse.json({ error: sourceDeviceErr.message }, { status: 500 });
    }
    if (!sourceDevice?.id) {
      return NextResponse.json(
        { error: "rebindFromDeviceId is not owned by this account" },
        { status: 400 }
      );
    }
    rebindFromDeviceId = sourceDevice.id;
  }

  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10m
  const codeHash = sha256Hex(code);

  const basePayload = {
    code,
    code_hash: codeHash,
    user_id: user.id,
    expires_at: expiresAt,
  };
  const payloadWithRebind = {
    ...basePayload,
    rebind_from_device_id: rebindFromDeviceId,
  };

  let insertError: { message?: string } | null = null;
  if (rebindFromDeviceId) {
    const { error } = await supabase.from("device_pairing_codes").insert(payloadWithRebind);
    insertError = error;
    if (
      insertError?.message &&
      /rebind_from_device_id|schema cache/i.test(insertError.message)
    ) {
      // Backward-compat during migration rollout.
      const fallback = await supabase.from("device_pairing_codes").insert(basePayload);
      insertError = fallback.error;
    }
  } else {
    const { error } = await supabase.from("device_pairing_codes").insert(basePayload);
    insertError = error;
  }

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ code, expires_at: expiresAt });
}

