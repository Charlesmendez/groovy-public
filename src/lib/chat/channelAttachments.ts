import { randomUUID } from "node:crypto";
import {
  ChatImageValidationError,
  MAX_CHAT_IMAGE_FILES,
  MAX_CHAT_IMAGE_TOTAL_BYTES,
  validateChatImages,
  type ValidatedChatImage,
} from "./channelImages";

export const MAX_CHAT_ATTACHMENT_FILES = 5;
export const MAX_CHAT_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 3 * 1024 * 1024;

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const FILE_MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  txt: "text/plain",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

const FILE_EXTENSIONS_BY_MEDIA_TYPE = new Map(
  Object.entries(FILE_MEDIA_TYPES_BY_EXTENSION).map(([extension, mediaType]) => [
    mediaType,
    extension,
  ]),
);

const IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "webp"]);

export type ValidatedChatFile = {
  kind: "file";
  mediaType: string;
  base64: string;
  filename: string;
  bytes: Buffer;
  byteSize: number;
};

export type ValidatedChatAttachment =
  | (ValidatedChatImage & { kind: "image" })
  | ValidatedChatFile;

export type PublicChatAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  sizeBytes: number;
};

function filenameExtension(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1] || "";
}

function requestedMediaType(value: unknown, filename: unknown): string {
  const fromFilename =
    FILE_MEDIA_TYPES_BY_EXTENSION[filenameExtension(filename)] || "";
  if (fromFilename) return fromFilename;
  const declared =
    typeof value === "string"
      ? value.trim().toLowerCase().split(";")[0]
      : "";
  return declared === "application/octet-stream" ? "" : declared;
}

function isRequestedImage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const mediaType =
    typeof item.mediaType === "string"
      ? item.mediaType.trim().toLowerCase().split(";")[0]
      : "";
  const extension = filenameExtension(item.filename);
  if (IMAGE_EXTENSIONS.has(extension)) return true;
  if (FILE_MEDIA_TYPES_BY_EXTENSION[extension]) return false;
  return mediaType.startsWith("image/");
}

function decodeStrictBase64(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new ChatImageValidationError("Each attached file must include data.");
  }
  const trimmed = value.trim();
  const commaIndex = trimmed.indexOf(",");
  const normalized = (commaIndex >= 0 ? trimmed.slice(commaIndex + 1) : trimmed)
    .replace(/\s+/g, "");
  if (!normalized || !BASE64_PATTERN.test(normalized)) {
    throw new ChatImageValidationError("One of the attached files is invalid.");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes.length || bytes.toString("base64") !== normalized) {
    throw new ChatImageValidationError("One of the attached files is invalid.");
  }
  return bytes;
}

function cleanFilename(value: unknown, mediaType: string): string {
  const fallback = `attachment.${FILE_EXTENSIONS_BY_MEDIA_TYPE.get(mediaType) || "bin"}`;
  if (typeof value !== "string") return fallback;
  const clean = value
    .replace(/[\u0000-\u001f\u007f/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  if (!clean) return fallback;
  const extension = filenameExtension(clean);
  if (FILE_MEDIA_TYPES_BY_EXTENSION[extension] === mediaType) return clean;
  return `${clean}.${FILE_EXTENSIONS_BY_MEDIA_TYPE.get(mediaType) || "bin"}`;
}

function hasZipSignature(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(bytes[2]) &&
    [0x04, 0x06, 0x08].includes(bytes[3])
  );
}

function hasOleSignature(bytes: Buffer): boolean {
  return (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    )
  );
}

function fileMatchesMediaType(mediaType: string, bytes: Buffer): boolean {
  if (mediaType === "application/pdf") {
    return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  }
  if (mediaType === "application/zip") return hasZipSignature(bytes);
  if (mediaType.includes("openxmlformats-officedocument")) {
    if (
      !hasZipSignature(bytes) ||
      !bytes.includes(Buffer.from("[Content_Types].xml"))
    ) {
      return false;
    }
    if (mediaType.includes("wordprocessingml")) {
      return bytes.includes(Buffer.from("word/"));
    }
    if (mediaType.includes("spreadsheetml")) {
      return bytes.includes(Buffer.from("xl/"));
    }
    if (mediaType.includes("presentationml")) {
      return bytes.includes(Buffer.from("ppt/"));
    }
    return false;
  }
  if (
    mediaType === "application/msword" ||
    mediaType === "application/vnd.ms-excel" ||
    mediaType === "application/vnd.ms-powerpoint"
  ) {
    return hasOleSignature(bytes);
  }
  if (mediaType === "application/rtf") {
    return bytes.subarray(0, 5).toString("ascii").toLowerCase() === "{\\rtf";
  }
  if (
    mediaType === "text/plain" ||
    mediaType === "text/csv" ||
    mediaType === "text/markdown" ||
    mediaType === "application/json"
  ) {
    const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
    if (
      sample.includes(0) ||
      hasZipSignature(bytes) ||
      hasOleSignature(bytes) ||
      (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-")
    ) {
      return false;
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) return false;
    if (mediaType === "application/json") {
      try {
        JSON.parse(text);
      } catch {
        return false;
      }
    }
    return true;
  }
  return false;
}

function validateChatFile(value: unknown): ValidatedChatFile {
  const item =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const mediaType = requestedMediaType(item?.mediaType, item?.filename);
  if (!FILE_EXTENSIONS_BY_MEDIA_TYPE.has(mediaType)) {
    throw new ChatImageValidationError(
      "Upload a PDF, Word, Excel, PowerPoint, text, CSV, Markdown, JSON, RTF, or ZIP file.",
    );
  }
  const bytes = decodeStrictBase64(item?.base64);
  if (bytes.length > MAX_CHAT_FILE_BYTES) {
    throw new ChatImageValidationError("Each attached file must be 3 MB or smaller.");
  }
  if (!fileMatchesMediaType(mediaType, bytes)) {
    throw new ChatImageValidationError(
      "An attached file does not match its declared file type.",
    );
  }
  return {
    kind: "file",
    mediaType,
    base64: bytes.toString("base64"),
    filename: cleanFilename(item?.filename, mediaType),
    bytes,
    byteSize: bytes.length,
  };
}

export function validateChatAttachments(value: unknown): ValidatedChatAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ChatImageValidationError("files must be an array.");
  }
  if (value.length > MAX_CHAT_ATTACHMENT_FILES) {
    throw new ChatImageValidationError(
      `Attach up to ${MAX_CHAT_ATTACHMENT_FILES} files at a time.`,
    );
  }
  const attachments = value.map((item): ValidatedChatAttachment => {
    if (isRequestedImage(item)) {
      const [image] = validateChatImages([item]);
      return { ...image, kind: "image" };
    }
    return validateChatFile(item);
  });
  const images = attachments.filter(
    (attachment) => attachment.kind === "image",
  );
  if (images.length > MAX_CHAT_IMAGE_FILES) {
    throw new ChatImageValidationError(
      `Attach up to ${MAX_CHAT_IMAGE_FILES} images at a time.`,
    );
  }
  const imageBytes = images.reduce(
    (total, image) => total + image.byteSize,
    0,
  );
  if (imageBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) {
    throw new ChatImageValidationError(
      "Keep attached images under 2 MB total.",
    );
  }
  const totalBytes = attachments.reduce(
    (total, attachment) => total + attachment.byteSize,
    0,
  );
  if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
    throw new ChatImageValidationError("Keep attached files under 3 MB total.");
  }
  return attachments;
}

export function buildChatAttachmentStoragePath(args: {
  uploaderId: string;
  channelId: string;
  mediaType: string;
}): string {
  const extension = FILE_EXTENSIONS_BY_MEDIA_TYPE.get(args.mediaType) ||
    (args.mediaType === "image/jpeg" ? "jpg" : args.mediaType.split("/")[1]) ||
    "bin";
  return `${args.uploaderId}/team-chat/${args.channelId}/${randomUUID()}.${extension}`;
}

export function attachmentOnlyMessage(
  attachments: readonly Pick<ValidatedChatAttachment, "kind">[],
): string {
  const imageCount = attachments.filter((attachment) => attachment.kind === "image").length;
  if (imageCount === attachments.length) {
    return imageCount === 1 ? "Shared an image" : `Shared ${imageCount} images`;
  }
  if (imageCount === 0) {
    return attachments.length === 1
      ? "Shared a file"
      : `Shared ${attachments.length} files`;
  }
  return `Shared ${attachments.length} attachments`;
}

export function publicChatAttachment(value: {
  id: unknown;
  kind: unknown;
  file_name: unknown;
  mime_type: unknown;
  size_bytes: unknown;
}): PublicChatAttachment {
  return {
    id: String(value.id),
    kind: value.kind === "file" ? "file" : "image",
    name: String(value.file_name),
    mimeType: String(value.mime_type),
    sizeBytes: Number(value.size_bytes),
  };
}
