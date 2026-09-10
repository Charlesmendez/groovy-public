export function emailAttachmentUrl(args: {
  connectionId: string;
  messageId: string;
  attachmentId?: string;
  threadId?: string;
  partId?: string;
  filename?: string;
  mimeType?: string;
  open?: boolean;
  download?: boolean;
}): string {
  const search = new URLSearchParams({
    connectionId: args.connectionId,
    messageId: args.messageId,
  });
  if (args.attachmentId) search.set("attachmentId", args.attachmentId);
  if (args.threadId) search.set("threadId", args.threadId);
  if (args.partId) search.set("partId", args.partId);
  if (args.filename) search.set("filename", args.filename);
  if (args.mimeType) search.set("mimeType", args.mimeType);
  if (args.open) search.set("open", "1");
  if (args.download) search.set("download", "1");
  return `/api/email/attachment?${search.toString()}`;
}

export function safeEmailAttachmentFilename(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  return cleaned.slice(0, 180) || "attachment";
}

export function safeEmailAttachmentMimeType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)
    ? normalized
    : "application/octet-stream";
}

export function resolvedEmailAttachmentMimeType(args: {
  mimeType: string;
  filename?: string;
}): string {
  const mimeType = safeEmailAttachmentMimeType(args.mimeType);
  if (mimeType === "application/x-pdf" || mimeType === "application/acrobat") {
    return "application/pdf";
  }
  if (
    mimeType === "application/octet-stream" &&
    /\.pdf$/i.test(safeEmailAttachmentFilename(args.filename || ""))
  ) {
    return "application/pdf";
  }
  return mimeType;
}

export function canRenderEmailAttachmentAsInlineImage(
  mimeType: string,
): boolean {
  const normalized = safeEmailAttachmentMimeType(mimeType);
  return (
    normalized === "image/png" ||
    normalized === "image/jpeg" ||
    normalized === "image/gif" ||
    normalized === "image/webp" ||
    normalized === "image/avif"
  );
}

export function canOpenEmailAttachmentInline(mimeType: string): boolean {
  const normalized = safeEmailAttachmentMimeType(mimeType);
  return (
    normalized === "application/pdf" ||
    normalized === "text/plain" ||
    normalized === "image/png" ||
    normalized === "image/jpeg" ||
    normalized === "image/gif" ||
    normalized === "image/webp" ||
    normalized === "image/avif"
  );
}

export function emailAttachmentContentDisposition(args: {
  filename: string;
  mimeType: string;
  download?: boolean;
}): string {
  const filename = safeEmailAttachmentFilename(args.filename);
  const asciiFilename =
    filename
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_") || "attachment";
  const encodedFilename = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const disposition =
    !args.download && canOpenEmailAttachmentInline(args.mimeType)
      ? "inline"
      : "attachment";
  return `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}
