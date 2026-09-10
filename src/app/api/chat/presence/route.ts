import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { socialSchemaUnavailable } from "@/lib/chat/social";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const availability =
    body?.availability === "away" || body?.availability === "dnd"
      ? body.availability
      : "online";
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("chat_member_presence")
    .upsert(
      {
        user_id: user.id,
        availability,
        last_active_at: now,
        updated_at: now,
      },
      { onConflict: "user_id" },
    )
    .select("user_id,availability,last_active_at,updated_at")
    .single();
  if (error) {
    if (socialSchemaUnavailable(error)) {
      return NextResponse.json({ migrationPending: true });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ presence: data, migrationPending: false });
}
