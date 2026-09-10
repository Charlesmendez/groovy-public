import { NextResponse } from "next/server";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import {
  emailAttachmentContentDisposition,
  resolvedEmailAttachmentMimeType,
  safeEmailAttachmentFilename,
} from "@/lib/email/attachment";
import {
  fetchGmailAttachment,
  findOwnedGmailMailbox,
} from "@/lib/email/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId")?.trim() || "";
  const messageId = url.searchParams.get("messageId")?.trim() || "";
  const attachmentId = url.searchParams.get("attachmentId")?.trim() || "";
  const threadId = url.searchParams.get("threadId")?.trim() || "";
  const partId = url.searchParams.get("partId")?.trim() || "";
  const requestedFilename = url.searchParams.get("filename")?.trim() || "";
  const requestedMimeType = url.searchParams.get("mimeType")?.trim() || "";
  const open = url.searchParams.get("open") === "1";
  const download = url.searchParams.get("download") === "1";
  if (!connectionId || !messageId || (!attachmentId && !partId)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "connectionId, messageId, and an attachment or part identity are required.",
      },
      { status: 400 },
    );
  }
  try {
    const mailbox = await findOwnedGmailMailbox({
      supabase: auth.supabase,
      userId: auth.userId,
      connectionId,
    });
    if (!mailbox) {
      return NextResponse.json(
        { ok: false, error: "Mailbox not found." },
        { status: 404 },
      );
    }
    const attachment = await fetchGmailAttachment({
      mailbox,
      messageId,
      attachmentId,
      threadId: threadId || undefined,
      partId: partId || undefined,
      filename: requestedFilename || undefined,
      mimeType: requestedMimeType || undefined,
      priority: open || download ? "interactive" : undefined,
    });
    const filename = safeEmailAttachmentFilename(attachment.filename);
    const mimeType = resolvedEmailAttachmentMimeType({
      mimeType: attachment.mimeType,
      filename,
    });
    return new NextResponse(new Uint8Array(attachment.data), {
      headers: {
        "Cache-Control": "private, max-age=3600, immutable",
        "Content-Disposition": emailAttachmentContentDisposition({
          filename,
          mimeType,
          download,
        }),
        "Content-Length": String(attachment.data.length),
        "Content-Type": mimeType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return jsonError(error, "Could not open this attachment.");
  }
}
