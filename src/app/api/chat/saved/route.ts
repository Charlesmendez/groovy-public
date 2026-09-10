import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { socialSchemaUnavailable } from "@/lib/chat/social";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const workspace = await getOrCreateWorkspaceForUser();
  const { data: channels, error: channelsError } = await supabase
    .from("chat_channels")
    .select("id,name,kind,slug")
    .eq("workspace_id", workspace.id)
    .eq("is_archived", false);
  if (channelsError) {
    return NextResponse.json({ error: channelsError.message }, { status: 500 });
  }
  const channelMap = new Map(
    (channels || []).map((channel) => [String(channel.id), channel]),
  );
  const channelIds = Array.from(channelMap.keys());
  if (channelIds.length === 0) {
    return NextResponse.json({ saved: [], migrationPending: false });
  }
  const { data: savedRows, error: savedError } = await supabase
    .from("chat_saved_messages")
    .select("message_id,channel_id,created_at")
    .eq("user_id", user.id)
    .in("channel_id", channelIds)
    .order("created_at", { ascending: false })
    .limit(200);
  if (savedError) {
    if (socialSchemaUnavailable(savedError)) {
      return NextResponse.json({ saved: [], migrationPending: true });
    }
    return NextResponse.json({ error: savedError.message }, { status: 500 });
  }
  const messageIds = (savedRows || []).map((row) => String(row.message_id));
  if (messageIds.length === 0) {
    return NextResponse.json({ saved: [], migrationPending: false });
  }
  const { data: messages, error: messagesError } = await supabase
    .from("chat_messages")
    .select(
      "id,channel_id,author_type,author_user_id,author_agent_id,profile_id,content,metadata,created_at,thread_root_message_id",
    )
    .in("id", messageIds);
  if (messagesError) {
    return NextResponse.json({ error: messagesError.message }, { status: 500 });
  }
  const messageMap = new Map(
    (messages || []).map((message) => [String(message.id), message]),
  );
  const saved = (savedRows || [])
    .map((row) => {
      const message = messageMap.get(String(row.message_id));
      if (!message) return null;
      return {
        saved_at: row.created_at,
        channel: channelMap.get(String(row.channel_id)) || null,
        message,
      };
    })
    .filter(Boolean);
  return NextResponse.json({ saved, migrationPending: false });
}
