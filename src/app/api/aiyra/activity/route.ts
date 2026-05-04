import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const deviceId = asTrimmedString(url.searchParams.get("deviceId"));

  let query = supabase
    .from("aiyra_conversations")
    .select("updated_at, device_id")
    .eq("user_id", user.id)
    .eq("channel_mode", "mic_main")
    .order("updated_at", { ascending: false })
    .limit(1);

  if (deviceId) {
    query = query.eq("device_id", deviceId);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const row =
    Array.isArray(data) && data.length > 0
      ? (data[0] as { updated_at?: unknown; device_id?: unknown })
      : null;

  return NextResponse.json({
    ok: true,
    activityAt: typeof row?.updated_at === "string" ? row.updated_at : null,
    deviceId: typeof row?.device_id === "string" ? row.device_id : null,
  });
}
