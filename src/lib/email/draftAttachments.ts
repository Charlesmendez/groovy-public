import type { EmailDraftAttachment } from "@/lib/email/types";

export const EMAIL_DRAFT_ATTACHMENT_BUCKET = "chat_uploads";
export const EMAIL_DRAFT_ATTACHMENT_MAX_COUNT = 12;
export const EMAIL_DRAFT_ATTACHMENT_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const EMAIL_DRAFT_ATTACHMENT_MAX_TOTAL_BYTES = 17 * 1024 * 1024;

const INLINE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function safeEmailDraftFilename(value: unknown): string {
  const cleaned = text(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 180) || "attachment";
}

export function safeEmailDraftMimeType(value: unknown): string {
  const normalized = text(value).toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(normalized)
    ? normalized
    : "application/octet-stream";
}

export function canInlineEmailDraftMimeType(value: unknown): boolean {
  return INLINE_IMAGE_MIME_TYPES.has(safeEmailDraftMimeType(value));
}

export function emailDraftContentId(id: string): string {
  const safeId = id.replace(/[^a-z0-9._-]/gi, "").slice(0, 100);
  return `groovy-${safeId || "image"}@inline`;
}

export function normalizeEmailDraftAttachments(
  value: unknown,
): EmailDraftAttachment[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const attachments: EmailDraftAttachment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const id = text(item.id).slice(0, 120);
    const storagePath = text(item.storagePath).slice(0, 1_000);
    const size = Math.floor(Number(item.size));
    if (
      !id ||
      seen.has(id) ||
      !storagePath ||
      !Number.isFinite(size) ||
      size <= 0 ||
      size > EMAIL_DRAFT_ATTACHMENT_MAX_FILE_BYTES
    ) {
      continue;
    }
    const mimeType = safeEmailDraftMimeType(item.mimeType);
    const wantsInline =
      item.disposition === "inline" &&
      canInlineEmailDraftMimeType(mimeType);
    const requestedContentId = text(item.contentId)
      .replace(/[^a-z0-9._@-]/gi, "")
      .slice(0, 180);
    seen.add(id);
    attachments.push({
      id,
      storagePath,
      filename: safeEmailDraftFilename(item.filename),
      mimeType,
      size,
      disposition: wantsInline ? "inline" : "attachment",
      contentId: wantsInline
        ? requestedContentId || emailDraftContentId(id)
        : null,
    });
  }
  if (attachments.length > EMAIL_DRAFT_ATTACHMENT_MAX_COUNT) {
    throw new Error(
      `Add no more than ${EMAIL_DRAFT_ATTACHMENT_MAX_COUNT} files to one email.`,
    );
  }
  const totalBytes = attachments.reduce(
    (total, attachment) => total + attachment.size,
    0,
  );
  if (totalBytes > EMAIL_DRAFT_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new Error("Attachments must total 17 MB or less.");
  }
  return attachments;
}

export function assertOwnedEmailDraftAttachments(args: {
  userId: string;
  attachments: EmailDraftAttachment[];
}): void {
  const prefix = `${args.userId}/email-drafts/`;
  if (
    args.attachments.some(
      (attachment) => {
        if (!attachment.storagePath.startsWith(prefix)) return true;
        const relativePath = attachment.storagePath.slice(prefix.length);
        const segments = relativePath.split("/");
        return (
          !relativePath ||
          segments.some(
            (segment) => !segment || segment === "." || segment === "..",
          )
        );
      },
    )
  ) {
    throw new Error("An email attachment path is invalid.");
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function plainTextWithInlineImages(args: {
  body: string;
  offset: number;
  attachments: EmailDraftAttachment[];
}): string {
  const offset = Math.max(0, Math.min(args.body.length, args.offset));
  const before = escapeHtml(args.body.slice(0, offset)).replace(/\n/g, "<br>");
  const after = escapeHtml(args.body.slice(offset)).replace(/\n/g, "<br>");
  const images = args.attachments
    .filter(
      (attachment) =>
        attachment.disposition === "inline" && attachment.contentId,
    )
    .map(
      (attachment) =>
        `<img src="cid:${escapeHtml(attachment.contentId || "")}" ` +
        `alt="${escapeHtml(attachment.filename)}" ` +
        'style="display:block;max-width:100%;height:auto;margin:10px 0">',
    )
    .join("");
  return `${before}${images}${after}`;
}

export function plainTextWithInlineImageLabels(args: {
  body: string;
  offset: number;
  attachments: EmailDraftAttachment[];
}): string {
  const offset = Math.max(0, Math.min(args.body.length, args.offset));
  const labels = args.attachments
    .filter((attachment) => attachment.disposition === "inline")
    .map((attachment) => `[Inline image: ${attachment.filename}]`)
    .join("\n");
  return `${args.body.slice(0, offset)}${labels}${args.body.slice(offset)}`;
}
