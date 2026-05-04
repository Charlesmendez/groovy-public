"use client";

import { useRef, useState } from "react";
import { Paperclip, Loader2 } from "lucide-react";

const ACCEPT = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  ".pdf",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".docx",
  ".xlsx",
  ".xls",
].join(",");

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Upload failed";
}

export function FileUpload({
  sessionId,
  onUploaded,
}: {
  sessionId: string;
  onUploaded: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingFileName, setPendingFileName] = useState<string | null>(null);

  const handlePick = () => inputRef.current?.click();

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setError(null);
    setPendingFileName(file.name || "upload");
    setUploading(true);
    try {
      const form = new FormData();
      form.set("sessionId", sessionId);
      form.set("file", file);

      const res = await fetch("/api/chat/files", {
        method: "POST",
        body: form,
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error || "Upload failed");
      }

      onUploaded();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setUploading(false);
      setPendingFileName(null);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={handleChange}
      />

      <button
        onClick={handlePick}
        disabled={uploading}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
        title="Upload a document (pdf, docx, xlsx, txt, md, csv, json)"
      >
        {uploading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Paperclip className="w-4 h-4" />
        )}
        <span className="hidden sm:inline">
          {uploading ? "Uploading..." : "Upload"}
        </span>
      </button>

      {pendingFileName && (
        <div className="max-w-[220px] truncate px-2.5 py-2 rounded-xl bg-white/5 border border-white/10 text-xs text-zinc-300">
          {pendingFileName}
        </div>
      )}

      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}

