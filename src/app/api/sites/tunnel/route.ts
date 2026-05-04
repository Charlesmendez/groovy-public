/**
 * Site tunnel proxy: bridges dashboard iframe → relay → connector localhost dev server.
 *
 * Auth: cookie session + device ownership check.
 * The connector validates the tunnelNonce server-side.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Auth: user must be signed in
  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const deviceId = url.searchParams.get("deviceId") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const tunnelPath = url.searchParams.get("path") || "/";

  if (!deviceId || !nonce) {
    return NextResponse.json({ error: "deviceId and nonce required" }, { status: 400 });
  }

  // Verify user owns this device
  const admin = createSupabaseAdminClient();
  const { data: device } = await admin
    .from("devices")
    .select("id")
    .eq("id", deviceId)
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (!device) {
    return NextResponse.json({ error: "device_not_owned" }, { status: 403 });
  }

  // This endpoint previously returned a placeholder "ok: true" response,
  // which caused callers to believe tunneling worked even though no proxying
  // happened. Keep this explicit until relay HTTP bridge support is added.
  return NextResponse.json(
    {
      ok: false,
      error: "site_tunnel_not_implemented",
      message:
        "Remote site tunnel proxy is not implemented yet. Use local preview (http://localhost:<devPort>) on the same machine running the connector.",
      tunnelParams: {
        deviceId,
        nonce,
        path: tunnelPath,
      },
    },
    { status: 501 }
  );
}
