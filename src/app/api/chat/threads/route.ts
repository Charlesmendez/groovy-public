import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

type MessageRow = {
  id: string;
  channel_id: string;
  author_type: "user" | "agent" | "orchestrator" | "system";
  author_user_id: string | null;
  author_agent_id: string | null;
  profile_id: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  thread_root_message_id: string | null;
};

const MESSAGE_FIELDS =
  "id,channel_id,author_type,author_user_id,author_agent_id,profile_id,content,metadata,created_at,thread_root_message_id";

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function threadReadSchemaUnavailable(error: {
  code?: string | null;
  message?: string | null;
}) {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    String(error.message || "").includes("chat_thread_read_states")
  );
}

function isDeleted(message: Pick<MessageRow, "metadata">) {
  return (
    message.metadata &&
    typeof message.metadata === "object" &&
    !Array.isArray(message.metadata) &&
    typeof message.metadata.deleted_at === "string"
  );
}

function chunks<T>(values: T[], size = 150): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

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
    return NextResponse.json({ threads: [], unreadCount: 0 });
  }

  // Fetch enough recent replies to build a useful cross-room inbox. The
  // second page avoids Supabase's common 1,000-row response cap.
  const replyPages = await Promise.all(
    [0, 1].map((page) =>
      supabase
        .from("chat_messages")
        .select(MESSAGE_FIELDS)
        .in("channel_id", channelIds)
        .not("thread_root_message_id", "is", null)
        .order("created_at", { ascending: false })
        .range(page * 1_000, page * 1_000 + 999),
    ),
  );
  const replyError = replyPages.find((page) => page.error)?.error;
  if (replyError) {
    return NextResponse.json({ error: replyError.message }, { status: 500 });
  }
  const replies = replyPages
    .flatMap((page) => (page.data || []) as MessageRow[])
    .filter((message) => !isDeleted(message));
  const rootIds = Array.from(
    new Set(
      replies
        .map((reply) => reply.thread_root_message_id)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (rootIds.length === 0) {
    return NextResponse.json({
      threads: [],
      unreadCount: 0,
      migrationPending: false,
    });
  }

  const rootResults = await Promise.all(
    chunks(rootIds).map((ids) =>
      supabase
        .from("chat_messages")
        .select(MESSAGE_FIELDS)
        .in("id", ids)
        .is("thread_root_message_id", null),
    ),
  );
  const rootError = rootResults.find((result) => result.error)?.error;
  if (rootError) {
    return NextResponse.json({ error: rootError.message }, { status: 500 });
  }
  const roots = rootResults
    .flatMap((result) => (result.data || []) as MessageRow[])
    .filter((message) => !isDeleted(message));
  const rootMap = new Map(roots.map((root) => [root.id, root]));

  const participationResults = await Promise.all(
    chunks(rootIds).map((ids) =>
      supabase
        .from("chat_messages")
        .select("thread_root_message_id")
        .eq("author_type", "user")
        .eq("author_user_id", user.id)
        .in("thread_root_message_id", ids),
    ),
  );
  const participationError = participationResults.find(
    (result) => result.error,
  )?.error;
  if (participationError) {
    return NextResponse.json(
      { error: participationError.message },
      { status: 500 },
    );
  }
  const repliedRootIds = new Set(
    participationResults
      .flatMap((result) => result.data || [])
      .map((row) => String(row.thread_root_message_id || ""))
      .filter(Boolean),
  );
  const participatedRootIds = rootIds.filter((rootId) => {
    const root = rootMap.get(rootId);
    return (
      root?.author_user_id === user.id ||
      repliedRootIds.has(rootId)
    );
  });
  if (participatedRootIds.length === 0) {
    return NextResponse.json({
      threads: [],
      unreadCount: 0,
      migrationPending: false,
    });
  }

  const readResults = await Promise.all(
    chunks(participatedRootIds).map((ids) =>
      supabase
        .from("chat_thread_read_states")
        .select("thread_root_message_id,last_read_at")
        .eq("user_id", user.id)
        .in("thread_root_message_id", ids),
    ),
  );
  const readError = readResults.find((result) => result.error)?.error;
  const migrationPending = Boolean(
    readError && threadReadSchemaUnavailable(readError),
  );
  if (readError && !migrationPending) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  const lastReadByRoot = new Map(
    migrationPending
      ? []
      : readResults
          .flatMap((result) => result.data || [])
          .map((row) => [
            String(row.thread_root_message_id),
            String(row.last_read_at),
          ]),
  );
  const repliesByRoot = new Map<string, MessageRow[]>();
  for (const reply of replies) {
    const rootId = reply.thread_root_message_id;
    if (!rootId || !rootMap.has(rootId)) continue;
    const current = repliesByRoot.get(rootId) || [];
    current.push(reply);
    repliesByRoot.set(rootId, current);
  }

  const threads = participatedRootIds
    .map((rootId) => {
      const root = rootMap.get(rootId);
      const channel = root ? channelMap.get(root.channel_id) : null;
      const threadReplies = repliesByRoot.get(rootId) || [];
      const latestReply = threadReplies[0] || null;
      if (!root || !channel || !latestReply) return null;
      const lastReadAt = lastReadByRoot.get(rootId) || null;
      const unread =
        !migrationPending &&
        threadReplies.some(
          (reply) =>
            reply.author_user_id !== user.id &&
            (!lastReadAt ||
              new Date(reply.created_at).getTime() >
                new Date(lastReadAt).getTime()),
        );
      return {
        thread_root_message_id: rootId,
        channel,
        root_message: root,
        latest_reply: latestReply,
        reply_count: threadReplies.length,
        unread,
        last_read_at: lastReadAt,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        new Date(right!.latest_reply.created_at).getTime() -
        new Date(left!.latest_reply.created_at).getTime(),
    )
    .slice(0, 100);

  return NextResponse.json({
    threads,
    unreadCount: threads.filter((thread) => thread?.unread).length,
    migrationPending,
  });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const rootId = body?.threadRootMessageId;
  if (!isUuid(rootId)) {
    return NextResponse.json(
      { error: "threadRootMessageId must be a UUID" },
      { status: 400 },
    );
  }
  const { data: root, error: rootError } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("id", rootId)
    .is("thread_root_message_id", null)
    .maybeSingle();
  if (rootError) {
    return NextResponse.json({ error: rootError.message }, { status: 500 });
  }
  if (!root) {
    return NextResponse.json(
      { error: "Thread not found or inaccessible" },
      { status: 404 },
    );
  }
  const now = new Date().toISOString();
  const { error } = await supabase.from("chat_thread_read_states").upsert(
    {
      thread_root_message_id: rootId,
      user_id: user.id,
      last_read_at: now,
      updated_at: now,
    },
    { onConflict: "thread_root_message_id,user_id" },
  );
  if (error) {
    if (threadReadSchemaUnavailable(error)) {
      return NextResponse.json(
        { error: "Thread read state needs the latest database update." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, lastReadAt: now });
}
