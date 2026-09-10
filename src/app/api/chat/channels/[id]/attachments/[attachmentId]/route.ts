import { NextResponse } from "next/server";
import { CHAT_IMAGE_BUCKET } from "@/lib/chat/channelImages";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string; attachmentId: string }>;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeDownloadName(value: unknown): string {
  const normalized =
    typeof value === "string"
      ? value
          .replace(/[\u0000-\u001f\u007f/\\]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 180)
      : "";
  return normalized || "chat-attachment";
}

export async function GET(request: Request, { params }: Params) {
  const { id: channelId, attachmentId } = await params;
  if (!UUID_PATTERN.test(channelId) || !UUID_PATTERN.test(attachmentId)) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // This read is intentionally performed with the user's cookie client.
  // chat_channels RLS prevents a removed member or a user outside a private
  // channel from minting a URL.
  const { data: channel, error: channelError } = await supabase
    .from("chat_channels")
    .select("id")
    .eq("id", channelId)
    .maybeSingle();
  if (channelError) {
    return NextResponse.json(
      { error: "Could not verify access to this attachment." },
      { status: 500 },
    );
  }
  if (!channel) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  const admin = createSupabaseAdminClient();
  const { data: attachment, error } = await admin
    .from("chat_message_attachments")
    .select("storage_path,file_name,mime_type")
    .eq("id", attachmentId)
    .eq("channel_id", channelId)
    .maybeSingle();
  if (error) {
    const migrationPending =
      error.code === "42P01" ||
      error.code === "PGRST205" ||
      /chat_message_attachments/i.test(error.message || "");
    return NextResponse.json(
      {
        error: migrationPending
          ? "Chat attachments are not enabled yet."
          : "Could not load this attachment.",
      },
      { status: migrationPending ? 503 : 500 },
    );
  }
  if (!attachment?.storage_path) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  const download = new URL(request.url).searchParams.get("download") === "1";
  const { data: signed, error: signedError } = await admin.storage
    .from(CHAT_IMAGE_BUCKET)
    .createSignedUrl(
      String(attachment.storage_path),
      60,
      download
        ? { download: safeDownloadName(attachment.file_name) }
        : undefined,
    );
  if (signedError || !signed?.signedUrl) {
    return NextResponse.json(
      { error: "This attachment is temporarily unavailable." },
      { status: 503 },
    );
  }

  const response = NextResponse.redirect(signed.signedUrl, 307);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
