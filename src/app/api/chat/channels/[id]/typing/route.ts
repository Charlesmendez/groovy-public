import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  CHAT_TYPING_TTL_MS,
  socialSchemaUnavailable,
} from "@/lib/chat/social";
import { scopeChatTypingQuery } from "@/lib/chat/typingScope";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
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
  const active = body?.active !== false;
  const threadRootMessageId =
    body?.threadRootMessageId === null ||
    body?.threadRootMessageId === undefined
      ? null
      : isUuid(body.threadRootMessageId)
        ? body.threadRootMessageId
        : undefined;
  if (threadRootMessageId === undefined) {
    return NextResponse.json(
      { error: "threadRootMessageId must be a UUID" },
      { status: 400 },
    );
  }

  if (threadRootMessageId) {
    const { data: root, error: rootError } = await supabase
      .from("chat_messages")
      .select("id")
      .eq("id", threadRootMessageId)
      .eq("channel_id", id)
      .is("thread_root_message_id", null)
      .maybeSingle();
    if (rootError) {
      return NextResponse.json({ error: rootError.message }, { status: 500 });
    }
    if (!root) {
      return NextResponse.json(
        { error: "Thread root not found" },
        { status: 404 },
      );
    }
  }

  if (!active) {
    // Expire the row instead of deleting it. This keeps "stopped typing"
    // reliable even if an older deployment published the expression-keyed
    // table to realtime before setting REPLICA IDENTITY FULL. The follow-up
    // migration enables direct/FK deletes, while this update is backwards
    // compatible during rolling deploys.
    let scoped = supabase
      .from("chat_typing_indicators")
      .update({
        expires_at: new Date(0).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("channel_id", id)
      .eq("user_id", user.id);
    scoped = threadRootMessageId
      ? scoped.eq("thread_root_message_id", threadRootMessageId)
      : scoped.is("thread_root_message_id", null);
    const { error } = await scoped;
    if (error && !socialSchemaUnavailable(error)) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({
      active: false,
      migrationPending: socialSchemaUnavailable(error),
    });
  }

  const now = new Date();
  const row = {
    channel_id: id,
    user_id: user.id,
    thread_root_message_id: threadRootMessageId,
    expires_at: new Date(now.getTime() + CHAT_TYPING_TTL_MS).toISOString(),
    updated_at: now.toISOString(),
  };
  let existing = supabase
    .from("chat_typing_indicators")
    .select("channel_id")
    .eq("channel_id", id)
    .eq("user_id", user.id);
  existing = threadRootMessageId
    ? existing.eq("thread_root_message_id", threadRootMessageId)
    : existing.is("thread_root_message_id", null);
  const { data: current, error: currentError } = await existing.maybeSingle();
  if (currentError) {
    if (socialSchemaUnavailable(currentError)) {
      return NextResponse.json({ active: false, migrationPending: true });
    }
    return NextResponse.json({ error: currentError.message }, { status: 500 });
  }
  const write = current
    ? scopeChatTypingQuery(
        supabase
          .from("chat_typing_indicators")
          .update(row)
          .eq("channel_id", id)
          .eq("user_id", user.id),
        threadRootMessageId,
      )
    : supabase.from("chat_typing_indicators").insert(row);
  const { error } = await write;
  if (error) {
    if (socialSchemaUnavailable(error)) {
      return NextResponse.json({ active: false, migrationPending: true });
    }
    // A concurrent first keystroke can win the expression-backed unique
    // index. The next 3-second refresh extends that row, so the UX remains
    // correct without weakening the uniqueness boundary.
    if (error.code !== "23505") {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  return NextResponse.json({ active: true, migrationPending: false });
}
