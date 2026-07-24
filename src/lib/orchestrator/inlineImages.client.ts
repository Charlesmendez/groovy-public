"use client";

export type InlineOrchestratorFile = {
  mediaType: string;
  base64: string;
  filename?: string | null;
};

export type PreparedInlineOrchestratorFile = InlineOrchestratorFile & {
  byteSize: number;
};

export const VISION_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";
export const MAX_INLINE_IMAGE_FILES = 3;
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_INLINE_IMAGE_TOTAL_BYTES = 2 * 1024 * 1024;

const VISION_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const VISION_IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};
const MAX_INLINE_IMAGE_DIMENSION = 1600;
const INLINE_IMAGE_JPEG_QUALITIES = [0.86, 0.78, 0.68, 0.58, 0.48];

function getVisionImageMediaType(file: File): string | null {
  if (VISION_IMAGE_TYPES.has(file.type)) return file.type;
  const ext = file.name.toLowerCase().split(".").pop() || "";
  return VISION_IMAGE_EXTENSIONS[ext] || null;
}

export function isVisionImageFile(file: File): boolean {
  return Boolean(getVisionImageMediaType(file));
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not prepare image")),
      type,
      quality,
    );
  });
}

async function loadDrawableImage(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Fall back to an HTMLImageElement below.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not load image"));
      img.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function prepareVisionImageFile(
  file: File,
): Promise<PreparedInlineOrchestratorFile> {
  const originalMediaType = getVisionImageMediaType(file);
  if (!originalMediaType) {
    throw new Error(
      `${file.name || "That file"} is not a supported image. Use JPEG, PNG, WebP, or GIF.`,
    );
  }
  if (file.size <= MAX_INLINE_IMAGE_BYTES) {
    return {
      mediaType: originalMediaType,
      base64: await readBlobAsBase64(file),
      filename: file.name || null,
      byteSize: file.size,
    };
  }

  const drawable = await loadDrawableImage(file);
  try {
    const longestSide = Math.max(drawable.width, drawable.height);
    let scale = Math.min(
      1,
      MAX_INLINE_IMAGE_DIMENSION / Math.max(1, longestSide),
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const width = Math.max(1, Math.round(drawable.width * scale));
      const height = Math.max(1, Math.round(drawable.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not prepare image");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(drawable.source, 0, 0, width, height);

      for (const quality of INLINE_IMAGE_JPEG_QUALITIES) {
        const blob = await canvasToBlob(canvas, "image/jpeg", quality);
        if (blob.size <= MAX_INLINE_IMAGE_BYTES) {
          return {
            mediaType: "image/jpeg",
            base64: await readBlobAsBase64(blob),
            filename: file.name || null,
            byteSize: blob.size,
          };
        }
      }

      scale *= 0.72;
    }
  } finally {
    drawable.close();
  }

  throw new Error(
    `${file.name || "Image"} is too large to attach. Try a smaller image or screenshot.`,
  );
}

export async function prepareInlineImageFiles(
  files: File[],
): Promise<PreparedInlineOrchestratorFile[]> {
  if (files.length > MAX_INLINE_IMAGE_FILES) {
    throw new Error(`Attach up to ${MAX_INLINE_IMAGE_FILES} images at a time.`);
  }
  const prepared = await Promise.all(files.map(prepareVisionImageFile));
  const totalBytes = prepared.reduce((sum, file) => sum + file.byteSize, 0);
  if (totalBytes > MAX_INLINE_IMAGE_TOTAL_BYTES) {
    throw new Error("Keep attached images under 2 MB total after compression.");
  }
  return prepared;
}
