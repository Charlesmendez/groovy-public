import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ userId: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { userId } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data, error } = await supabase
    .from("chat_member_profiles")
    .select("avatar_path,updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data?.avatar_path) {
    return NextResponse.json({ error: "Profile photo not found" }, { status: 404 });
  }

  const admin = createSupabaseAdminClient();
  const { data: signed, error: signedError } = await admin.storage
    .from("chat_uploads")
    .createSignedUrl(String(data.avatar_path), 300);
  if (signedError || !signed?.signedUrl) {
    return NextResponse.json({ error: "Profile photo unavailable" }, { status: 404 });
  }
  const response = NextResponse.redirect(signed.signedUrl, 307);
  response.headers.set("Cache-Control", "private, max-age=240");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
