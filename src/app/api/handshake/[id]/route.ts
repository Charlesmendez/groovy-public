import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * DELETE /api/handshake/[id]
 * Marks a handshake as closed for this user.
 */
export async function DELETE(_req: Request, { params }: RouteParams) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const handshakeId = typeof id === "string" ? id.trim() : "";
  if (!handshakeId) {
    return NextResponse.json({ error: "Handshake ID is required" }, { status: 400 });
  }

  const { data: updated, error: updateError } = await supabase
    .from("handshake_sessions")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
    })
    .eq("id", handshakeId)
    .eq("user_id", user.id)
    .select("id")
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: "Failed to close handshake" }, { status: 500 });
  }
  if (!updated?.id) {
    return NextResponse.json({ error: "Handshake not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
