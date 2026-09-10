"use client";

import { MAX_CHAT_VOICE_BYTES } from "@/lib/chat/voiceNotes";

export type PendingChatVoiceNote = {
  blob: Blob;
  previewUrl: string;
  mediaType: string;
  filename: string;
  durationMs: number;
};

export type PreparedChatVoiceNote = {
  mediaType: string;
  base64: string;
  filename: string;
  durationMs: number;
  byteSize: number;
};

const VOICE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

export function preferredChatVoiceMimeType(): string {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return "";
  }
  return (
    VOICE_MIME_TYPES.find((mimeType) =>
      MediaRecorder.isTypeSupported(mimeType),
    ) || ""
  );
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the voice note."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export async function prepareChatVoiceNote(
  note: PendingChatVoiceNote,
): Promise<PreparedChatVoiceNote> {
  if (note.blob.size > MAX_CHAT_VOICE_BYTES) {
    throw new Error("Voice notes must be 12 MB or smaller.");
  }
  return {
    mediaType: note.mediaType,
    base64: await readBlobAsBase64(note.blob),
    filename: note.filename,
    durationMs: note.durationMs,
    byteSize: note.blob.size,
  };
}

export function formatVoiceNoteDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
