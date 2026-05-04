import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function DELETE(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const deviceId = searchParams.get("device_id");

    if (!deviceId) {
      return NextResponse.json({ error: "device_id required" }, { status: 400 });
    }

    // Verify the device belongs to this user (RLS-enforced)
    const { data: device, error: fetchError } = await supabase
      .from("devices")
      .select("id,name")
      .eq("id", deviceId)
      .single();

    if (fetchError || !device) {
      return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }

    // Delete dependent rows explicitly (avoids relying on FK cascades/RLS edge cases)
    const { error: cfgErr } = await supabase
      .from("claude_code_agent_configs")
      .delete()
      .eq("device_id", deviceId);
    if (cfgErr) {
      return NextResponse.json(
        { error: `Failed to delete agent configs: ${cfgErr.message}` },
        { status: 500 }
      );
    }

    const { error: wsErr } = await supabase
      .from("device_workspaces")
      .delete()
      .eq("device_id", deviceId);
    if (wsErr) {
      return NextResponse.json(
        { error: `Failed to delete workspaces: ${wsErr.message}` },
        { status: 500 }
      );
    }

    const { error: codesErr } = await supabase
      .from("device_pairing_codes")
      .delete()
      .eq("device_id", deviceId);
    if (codesErr) {
      return NextResponse.json(
        { error: `Failed to delete pairing codes: ${codesErr.message}` },
        { status: 500 }
      );
    }

    // Delete the device (RLS ensures it's your own)
    const { error: deleteError } = await supabase
      .from("devices")
      .delete()
      .eq("id", deviceId);

    if (deleteError) {
      return NextResponse.json(
        { error: `Failed to delete device: ${deleteError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, deleted: device.name });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
