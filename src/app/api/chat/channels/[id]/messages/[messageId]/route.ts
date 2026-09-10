import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CHAT_IMAGE_BUCKET } from "@/lib/chat/channelImages";
import { MAX_CHAT_MESSAGE_CHARACTERS } from "@/lib/chat/messageLimits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string; messageId: string }>;
};

function recordMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function ownedMessage(args: {
  channelId: string;
  messageId: string;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { user: null, message: null, channel: null, error: null };
  }
  const { data, error } = await supabase
    .from("chat_messages")
    .select(
      "id,channel_id,author_type,author_user_id,content,metadata,thread_root_message_id",
    )
    .eq("id", args.messageId)
    .eq("channel_id", args.channelId)
    .maybeSingle();
  if (error || !data) {
    return {
      user,
      message: data,
      channel: null,
      error,
    };
  }
  const { data: channel, error: channelError } = await supabase
    .from("chat_channels")
    .select("id,is_archived")
    .eq("id", args.channelId)
    .maybeSingle();
  return {
    user,
    message: data,
    channel,
    error: channelError,
  };
}

export async function PATCH(req: Request, { params }: Params) {
  const { id, messageId } = await params;
  const { user, message, channel, error } = await ownedMessage({
    channelId: id,
    messageId,
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  if (!channel || channel.is_archived) {
    return NextResponse.json(
      { error: "Archived channels are read-only" },
      { status: 409 },
    );
  }
  if (
    message.author_type !== "user" ||
    message.author_user_id !== user.id
  ) {
    return NextResponse.json(
      { error: "You can only edit your own messages" },
      { status: 403 },
    );
  }
  const metadata = recordMetadata(message.metadata);
  if (typeof metadata.deleted_at === "string") {
    return NextResponse.json(
      { error: "Deleted messages cannot be edited" },
      { status: 409 },
    );
  }
  if (
    metadata.image_only === true ||
    metadata.voice_only === true ||
    metadata.snippet_only === true
  ) {
    return NextResponse.json(
      { error: "Attachment-only messages do not have editable text." },
      { status: 409 },
    );
  }
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const content =
    typeof body?.content === "string" ? body.content.trim() : "";
  if (!content || content.length > MAX_CHAT_MESSAGE_CHARACTERS) {
    return NextResponse.json(
      {
        error: `Messages must be between 1 and ${MAX_CHAT_MESSAGE_CHARACTERS.toLocaleString()} characters`,
      },
      { status: 400 },
    );
  }
  const admin = createSupabaseAdminClient();
  const { data, error: updateError } = await admin
    .from("chat_messages")
    .update({
      content,
      metadata: {
        ...metadata,
        edited_at: new Date().toISOString(),
        edit_count:
          (typeof metadata.edit_count === "number" ? metadata.edit_count : 0) +
          1,
        image_only: false,
        voice_only: false,
        snippet_only: false,
      },
    })
    .eq("id", messageId)
    .eq("channel_id", id)
    .eq("author_type", "user")
    .eq("author_user_id", user.id)
    .select("*")
    .single();
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }
  return NextResponse.json({ message: data });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id, messageId } = await params;
  const { user, message, channel, error } = await ownedMessage({
    channelId: id,
    messageId,
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  if (!channel || channel.is_archived) {
    return NextResponse.json(
      { error: "Archived channels are read-only" },
      { status: 409 },
    );
  }
  if (
    message.author_type !== "user" ||
    message.author_user_id !== user.id
  ) {
    return NextResponse.json(
      { error: "You can only delete your own messages" },
      { status: 403 },
    );
  }
  const metadata = recordMetadata(message.metadata);
  if (typeof metadata.deleted_at === "string") {
    return NextResponse.json({ deleted: true, message });
  }

  const admin = createSupabaseAdminClient();
  const { data: attachments, error: attachmentReadError } = await admin
    .from("chat_message_attachments")
    .select("id,storage_path")
    .eq("channel_id", id)
    .eq("message_id", messageId);
  const attachmentMigrationPending =
    attachmentReadError?.code === "42P01" ||
    attachmentReadError?.code === "PGRST205";
  if (attachmentReadError && !attachmentMigrationPending) {
    return NextResponse.json(
      { error: attachmentReadError.message },
      { status: 500 },
    );
  }

  const deletedAt = new Date().toISOString();
  const { data, error: updateError } = await admin
    .from("chat_messages")
    .update({
      content: "Message deleted",
      metadata: {
        ...metadata,
        attachments: [],
        voice_note: null,
        snippet: null,
        image_only: false,
        voice_only: false,
        snippet_only: false,
        deleted_at: deletedAt,
        deleted_by: user.id,
      },
    })
    .eq("id", messageId)
    .eq("channel_id", id)
    .eq("author_type", "user")
    .eq("author_user_id", user.id)
    .select("*")
    .single();
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  if ((attachments || []).length > 0) {
    const paths = (attachments || [])
      .map((attachment) => String(attachment.storage_path || ""))
      .filter(Boolean);
    await admin
      .from("chat_message_attachments")
      .delete()
      .eq("channel_id", id)
      .eq("message_id", messageId);
    if (paths.length > 0) {
      await admin.storage
        .from(CHAT_IMAGE_BUCKET)
        .remove(paths)
        .catch(() => undefined);
    }
  }
  await Promise.all([
    admin
      .from("chat_message_reactions")
      .delete()
      .eq("channel_id", id)
      .eq("message_id", messageId),
    admin
      .from("chat_saved_messages")
      .delete()
      .eq("channel_id", id)
      .eq("message_id", messageId),
    admin
      .from("chat_channel_pins")
      .delete()
      .eq("channel_id", id)
      .eq("message_id", messageId),
  ]);
  return NextResponse.json({ deleted: true, message: data });
}
