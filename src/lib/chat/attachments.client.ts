"use client";

import {
  isVisionImageFile,
  MAX_INLINE_IMAGE_FILES,
  MAX_INLINE_IMAGE_TOTAL_BYTES,
  prepareInlineImageFiles,
} from "@/lib/orchestrator/inlineImages.client";

export const CHAT_ATTACHMENT_ACCEPT = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
  ".csv",
  ".md",
  ".json",
  ".rtf",
  ".zip",
].join(",");

export const MAX_CHAT_ATTACHMENT_FILES = 5;
export const MAX_CHAT_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 3 * 1024 * 1024;

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

const IMAGE_MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(
  Object.values(IMAGE_MEDIA_TYPES_BY_EXTENSION),
);

const SUPPORTED_FILE_MEDIA_TYPES = new Set(
  Object.values(FILE_MEDIA_TYPES_BY_EXTENSION),
);

export type PreparedChatAttachment = {
  kind: "image" | "file";
  mediaType: string;
  base64: string;
  filename: string | null;
  byteSize: number;
};

function filenameExtension(file: File): string {
  return file.name.trim().toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1] || "";
}

export function chatAttachmentMediaType(file: File): string | null {
  const declared = file.type.trim().toLowerCase().split(";")[0];
  if (isChatImageAttachment(file)) {
    return SUPPORTED_IMAGE_MEDIA_TYPES.has(declared)
      ? declared
      : IMAGE_MEDIA_TYPES_BY_EXTENSION[filenameExtension(file)] || null;
  }
  if (SUPPORTED_FILE_MEDIA_TYPES.has(declared)) return declared;
  return FILE_MEDIA_TYPES_BY_EXTENSION[filenameExtension(file)] || null;
}

export function isChatImageAttachment(file: File): boolean {
  const extension = filenameExtension(file);
  if (FILE_MEDIA_TYPES_BY_EXTENSION[extension]) return false;
  return isVisionImageFile(file);
}

export function isSupportedChatAttachmentFile(file: File): boolean {
  return Boolean(chatAttachmentMediaType(file));
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the attached file."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export async function prepareChatAttachmentFiles(
  files: File[],
): Promise<PreparedChatAttachment[]> {
  if (files.length > MAX_CHAT_ATTACHMENT_FILES) {
    throw new Error(`Attach up to ${MAX_CHAT_ATTACHMENT_FILES} files at a time.`);
  }
  const prepared = await Promise.all(
    files.map(async (file): Promise<PreparedChatAttachment> => {
      if (isChatImageAttachment(file)) {
        const [image] = await prepareInlineImageFiles([file]);
        return { ...image, kind: "image", filename: image.filename || null };
      }
      const mediaType = chatAttachmentMediaType(file);
      if (!mediaType) {
        throw new Error(
          `${file.name || "That file"} is not a supported Chat attachment.`,
        );
      }
      if (file.size > MAX_CHAT_FILE_BYTES) {
        throw new Error(`${file.name || "That file"} must be 3 MB or smaller.`);
      }
      return {
        kind: "file",
        mediaType,
        base64: await readBlobAsBase64(file),
        filename: file.name || null,
        byteSize: file.size,
      };
    }),
  );
  const images = prepared.filter((file) => file.kind === "image");
  if (images.length > MAX_INLINE_IMAGE_FILES) {
    throw new Error(`Attach up to ${MAX_INLINE_IMAGE_FILES} images at a time.`);
  }
  const imageBytes = images.reduce((total, file) => total + file.byteSize, 0);
  if (imageBytes > MAX_INLINE_IMAGE_TOTAL_BYTES) {
    throw new Error("Keep attached images under 2 MB total after compression.");
  }
  const totalBytes = prepared.reduce((total, file) => total + file.byteSize, 0);
  if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
    throw new Error("Keep attached files under 3 MB total.");
  }
  return prepared;
}

export function chatAttachmentOnlyMessage(files: File[]): string {
  const imageCount = files.filter(isChatImageAttachment).length;
  if (imageCount === files.length) {
    return imageCount === 1 ? "Shared an image" : `Shared ${imageCount} images`;
  }
  if (imageCount === 0) {
    return files.length === 1 ? "Shared a file" : `Shared ${files.length} files`;
  }
  return `Shared ${files.length} attachments`;
}
