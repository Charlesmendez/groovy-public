import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { socialSchemaUnavailable } from "@/lib/chat/social";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string; messageId: string }>;
};

export async function POST(req: Request, { params }: Params) {
  const { id, messageId } = await params;
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
  const action =
    body?.action === "reaction" ||
    body?.action === "save" ||
    body?.action === "pin"
      ? body.action
      : null;
  if (!action) {
    return NextResponse.json(
      { error: "Choose a message interaction" },
      { status: 400 },
    );
  }
  const { data: message, error: messageError } = await supabase
    .from("chat_messages")
    .select("id,metadata")
    .eq("id", messageId)
    .eq("channel_id", id)
    .maybeSingle();
  if (messageError) {
    return NextResponse.json({ error: messageError.message }, { status: 500 });
  }
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  if (
    message.metadata &&
    typeof message.metadata === "object" &&
    !Array.isArray(message.metadata) &&
    typeof (message.metadata as Record<string, unknown>).deleted_at === "string"
  ) {
    return NextResponse.json(
      { error: "Deleted messages cannot be changed" },
      { status: 409 },
    );
  }

  if (action === "reaction") {
    const emoji =
      typeof body?.emoji === "string" ? body.emoji.trim().slice(0, 24) : "";
    if (!emoji) {
      return NextResponse.json({ error: "Choose a reaction" }, { status: 400 });
    }
    const { data: existing, error: existingError } = await supabase
      .from("chat_message_reactions")
      .select("id")
      .eq("message_id", messageId)
      .eq("user_id", user.id)
      .eq("emoji", emoji)
      .maybeSingle();
    if (existingError) {
      return interactionError(existingError);
    }
    const { data, error } = existing
      ? await supabase
          .from("chat_message_reactions")
          .delete()
          .eq("id", existing.id)
          .eq("user_id", user.id)
          .select("id")
          .maybeSingle()
      : await supabase
          .from("chat_message_reactions")
          .insert({
            channel_id: id,
            message_id: messageId,
            user_id: user.id,
            emoji,
          })
          .select("*")
          .single();
    if (error) return interactionError(error);
    return NextResponse.json({
      action,
      active: !existing,
      reaction: data || null,
    });
  }

  if (action === "save") {
    const { data: existing, error: existingError } = await supabase
      .from("chat_saved_messages")
      .select("message_id")
      .eq("message_id", messageId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (existingError) return interactionError(existingError);
    const { error } = existing
      ? await supabase
          .from("chat_saved_messages")
          .delete()
          .eq("message_id", messageId)
          .eq("user_id", user.id)
      : await supabase.from("chat_saved_messages").insert({
          channel_id: id,
          message_id: messageId,
          user_id: user.id,
        });
    if (error) return interactionError(error);
    return NextResponse.json({ action, active: !existing });
  }

  const { data: existing, error: existingError } = await supabase
    .from("chat_channel_pins")
    .select("message_id,pinned_by")
    .eq("channel_id", id)
    .eq("message_id", messageId)
    .maybeSingle();
  if (existingError) return interactionError(existingError);
  const { data: changedPin, error } = existing
    ? await supabase
        .from("chat_channel_pins")
        .delete()
        .eq("channel_id", id)
        .eq("message_id", messageId)
        .select("message_id")
        .maybeSingle()
    : await supabase.from("chat_channel_pins").insert({
        channel_id: id,
        message_id: messageId,
        pinned_by: user.id,
      }).select("message_id").single();
  if (error) return interactionError(error);
  if (existing && !changedPin) {
    return NextResponse.json(
      {
        error:
          "Only the teammate who pinned this message or a room manager can unpin it.",
      },
      { status: 403 },
    );
  }
  return NextResponse.json({ action, active: !existing });
}

function interactionError(error: {
  code?: string | null;
  message: string;
}) {
  const migrationPending = socialSchemaUnavailable(error);
  return NextResponse.json(
    {
      error: migrationPending
        ? "Message reactions and saves are still being activated. Try again shortly."
        : error.message,
    },
    { status: migrationPending ? 503 : error.code === "42501" ? 403 : 500 },
  );
}
