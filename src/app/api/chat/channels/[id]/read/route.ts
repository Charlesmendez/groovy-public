import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function readStateMigrationPending(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  return (
    error.code === "42P01" ||
    error.code === "42883" ||
    error.code === "PGRST204" ||
    error.code === "PGRST202" ||
    error.message?.includes("chat_channel_read_states") === true ||
    error.message?.includes("mark_chat_channel_read") === true
  );
}

export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The channel SELECT policy is the source of truth for both workspace-wide
  // rooms and private/DM membership.
  const { data: channel, error: channelError } = await supabase
    .from("chat_channels")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (channelError) {
    return NextResponse.json(
      { error: channelError.message },
      { status: 500 },
    );
  }
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  const { data: readAt, error } = await supabase.rpc(
    "mark_chat_channel_read",
    { p_channel_id: id },
  );
  if (error) {
    const migrationPending = readStateMigrationPending(error);
    return NextResponse.json(
      {
        error: migrationPending
          ? "Unread message tracking is still being activated."
          : error.message,
        migrationPending,
      },
      { status: migrationPending ? 503 : error.code === "42501" ? 403 : 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    readAt: typeof readAt === "string" ? readAt : null,
  });
}
