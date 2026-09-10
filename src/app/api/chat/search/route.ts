import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") || "").replace(/\s+/g, " ").trim();
  if (query.length < 2) {
    return NextResponse.json({ results: [] });
  }
  if (query.length > 200) {
    return NextResponse.json(
      { error: "Search queries can be up to 200 characters" },
      { status: 400 },
    );
  }
  const escapedQuery = query.replace(/[\\%_]/g, "\\$&");
  const requestedChannelId = url.searchParams.get("channelId");
  const author = url.searchParams.get("author");
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
  let channelIds = Array.from(channelMap.keys());
  if (requestedChannelId) {
    if (!channelMap.has(requestedChannelId)) {
      return NextResponse.json({ results: [] });
    }
    channelIds = [requestedChannelId];
  }
  if (channelIds.length === 0) {
    return NextResponse.json({ results: [] });
  }

  let search = supabase
    .from("chat_messages")
    .select(
      "id,channel_id,author_type,author_user_id,author_agent_id,profile_id,content,metadata,created_at,thread_root_message_id",
    )
    .in("channel_id", channelIds)
    .ilike("content", `%${escapedQuery}%`)
    .order("created_at", { ascending: false })
    .limit(80);
  if (
    author === "user" ||
    author === "agent" ||
    author === "orchestrator" ||
    author === "system"
  ) {
    search = search.eq("author_type", author);
  }
  const { data: messages, error } = await search;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const results = (messages || [])
    .filter((message) => {
      const metadata =
        message.metadata &&
        typeof message.metadata === "object" &&
        !Array.isArray(message.metadata)
          ? (message.metadata as Record<string, unknown>)
          : {};
      return typeof metadata.deleted_at !== "string";
    })
    .map((message) => ({
      ...message,
      channel: channelMap.get(String(message.channel_id)) || null,
    }));
  return NextResponse.json({ query, results });
}
