import { randomUUID } from "node:crypto";

export const CHAT_IMAGE_BUCKET = "chat_uploads";
export const MAX_CHAT_IMAGE_FILES = 3;
export const MAX_CHAT_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_CHAT_IMAGE_TOTAL_BYTES = 2 * 1024 * 1024;

const SUPPORTED_CHAT_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type ValidatedChatImage = {
  mediaType: string;
  base64: string;
  filename: string;
  bytes: Buffer;
  byteSize: number;
};

export type PublicChatImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export class ChatImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatImageValidationError";
  }
}

function normalizeFilename(value: unknown, mediaType: string): string {
  const fallback = `image.${IMAGE_EXTENSIONS[mediaType] || "jpg"}`;
  if (typeof value !== "string") return fallback;
  const clean = value
    .replace(/[\u0000-\u001f\u007f/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return clean || fallback;
}

function decodeStrictBase64(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new ChatImageValidationError("Each image must include base64 data.");
  }
  const trimmed = value.trim();
  const commaIndex = trimmed.indexOf(",");
  const normalized = (commaIndex >= 0 ? trimmed.slice(commaIndex + 1) : trimmed)
    .replace(/\s+/g, "");
  if (!normalized || !BASE64_PATTERN.test(normalized)) {
    throw new ChatImageValidationError("One of the attached images is invalid.");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes.length || bytes.toString("base64") !== normalized) {
    throw new ChatImageValidationError("One of the attached images is invalid.");
  }
  return bytes;
}

function hasExpectedSignature(mediaType: string, bytes: Buffer): boolean {
  if (mediaType === "image/jpeg") {
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }
  if (mediaType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    );
  }
  if (mediaType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mediaType === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

export function validateChatImages(value: unknown): ValidatedChatImage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ChatImageValidationError("files must be an array.");
  }
  if (value.length > MAX_CHAT_IMAGE_FILES) {
    throw new ChatImageValidationError(
      `Attach up to ${MAX_CHAT_IMAGE_FILES} images at a time.`,
    );
  }

  const files: ValidatedChatImage[] = [];
  let totalBytes = 0;
  for (const raw of value) {
    const item =
      raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)
        : null;
    const mediaType =
      typeof item?.mediaType === "string"
        ? item.mediaType.trim().toLowerCase()
        : "";
    if (!SUPPORTED_CHAT_IMAGE_TYPES.has(mediaType)) {
      throw new ChatImageValidationError(
        "Use a JPEG, PNG, WebP, or GIF image.",
      );
    }
    const bytes = decodeStrictBase64(item?.base64);
    if (bytes.length > MAX_CHAT_IMAGE_BYTES) {
      throw new ChatImageValidationError(
        "Each attached image must be 2 MB or smaller.",
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) {
      throw new ChatImageValidationError(
        "Keep attached images under 2 MB total.",
      );
    }
    if (!hasExpectedSignature(mediaType, bytes)) {
      throw new ChatImageValidationError(
        "An attached file does not match its image type.",
      );
    }
    files.push({
      mediaType,
      base64: bytes.toString("base64"),
      filename: normalizeFilename(item?.filename, mediaType),
      bytes,
      byteSize: bytes.length,
    });
  }
  return files;
}

export function buildChatImageStoragePath(args: {
  uploaderId: string;
  channelId: string;
  mediaType: string;
}): string {
  return `${args.uploaderId}/team-chat/${args.channelId}/${randomUUID()}.${
    IMAGE_EXTENSIONS[args.mediaType] || "jpg"
  }`;
}

export function imageOnlyMessage(count: number): string {
  return count === 1 ? "Shared an image" : `Shared ${count} images`;
}

export function publicChatImageAttachment(value: {
  id: unknown;
  file_name: unknown;
  mime_type: unknown;
  size_bytes: unknown;
}): PublicChatImageAttachment {
  return {
    id: String(value.id),
    name: String(value.file_name),
    mimeType: String(value.mime_type),
    sizeBytes: Number(value.size_bytes),
  };
}
