"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import {
  formatVoiceNoteDuration,
  preferredChatVoiceMimeType,
  type PendingChatVoiceNote,
} from "@/lib/chat/voiceNotes.client";
import { MAX_CHAT_VOICE_DURATION_MS } from "@/lib/chat/voiceNotes";

export function ChatVoiceRecorderButton({
  disabled,
  hasVoiceNote,
  onRecorded,
  onError,
}: {
  disabled?: boolean;
  hasVoiceNote: boolean;
  onRecorded: (note: PendingChatVoiceNote) => void;
  onError: (message: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);

  const releaseStream = () => {
    for (const track of streamRef.current?.getTracks() || []) track.stop();
    streamRef.current = null;
  };

  const stop = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
      stop();
      releaseStream();
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const interval = window.setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_CHAT_VOICE_DURATION_MS) stop();
    }, 200);
    return () => window.clearInterval(interval);
  }, [recording]);

  const start = async () => {
    if (disabled || hasVoiceNote || recording) return;
    if (
      typeof MediaRecorder === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      onError("Voice notes are not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!mountedRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      const preferredMimeType = preferredChatVoiceMimeType();
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelledRef.current = false;
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        onError("The voice note could not be recorded.");
      };
      recorder.onstop = () => {
        const durationMs = Math.min(
          Date.now() - startedAtRef.current,
          MAX_CHAT_VOICE_DURATION_MS,
        );
        const chunks = chunksRef.current;
        const cancelled = cancelledRef.current;
        const mediaType =
          recorder.mimeType || preferredMimeType || chunks[0]?.type || "";
        recorderRef.current = null;
        chunksRef.current = [];
        releaseStream();
        if (mountedRef.current) setRecording(false);
        if (cancelled || !mountedRef.current) return;
        const blob = new Blob(chunks, { type: mediaType });
        if (durationMs < 250 || blob.size === 0) {
          onError("Hold the recording a little longer, then try again.");
          return;
        }
        const extension = mediaType.includes("mp4")
          ? "m4a"
          : mediaType.includes("ogg")
            ? "ogg"
            : "webm";
        onRecorded({
          blob,
          previewUrl: URL.createObjectURL(blob),
          mediaType,
          filename: `voice-note-${new Date()
            .toISOString()
            .replace(/[:.]/g, "-")}.${extension}`,
          durationMs,
        });
      };
      recorder.start(250);
      setRecording(true);
    } catch (cause) {
      releaseStream();
      const denied =
        cause instanceof DOMException &&
        (cause.name === "NotAllowedError" ||
          cause.name === "PermissionDeniedError");
      onError(
        denied
          ? "Allow microphone access to record a voice note."
          : "The microphone is unavailable right now.",
      );
    }
  };

  return (
    <button
      type="button"
      onClick={() => {
        if (recording) stop();
        else void start();
      }}
      disabled={disabled || hasVoiceNote}
      className={`flex h-9 shrink-0 items-center justify-center rounded-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40 disabled:opacity-35 ${
        recording
          ? "gap-2 bg-rose-400/10 px-2.5 text-rose-300"
          : "w-9 text-[var(--text-secondary)] hover:bg-white/[0.06] hover:text-white"
      }`}
      aria-label={recording ? "Stop voice recording" : "Record a voice note"}
      title={recording ? "Stop recording" : "Record a voice note"}
    >
      {recording ? (
        <>
          <Square className="h-3.5 w-3.5 fill-current" />
          <span className="text-[10px] tabular-nums">
            {formatVoiceNoteDuration(elapsedMs)}
          </span>
        </>
      ) : (
        <Mic className="h-[18px] w-[18px]" />
      )}
    </button>
  );
}
