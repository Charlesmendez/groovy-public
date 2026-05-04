"use client";

import { useRef } from "react";
import {
  File,
  FileSpreadsheet,
  FileText,
  Globe,
  Loader2,
  Plus,
  Upload,
} from "lucide-react";

export type EnterpriseDocument = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt?: string;
};

type EnterpriseContextPanelProps = {
  targetUrl: string;
  onTargetUrlChange: (value: string) => void;
  documents: EnterpriseDocument[];
  documentsLoading: boolean;
  uploadInProgress: boolean;
  sessionTitle: string;
  contextError: string | null;
  connectorReady: boolean;
  onUploadFiles: (files: File[]) => void;
  onStartNewReview: () => void;
};

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(fileName: string, mimeType: string) {
  const name = fileName.toLowerCase();
  if (mimeType.includes("spreadsheet") || name.endsWith(".xlsx") || name.endsWith(".xls")) {
    return FileSpreadsheet;
  }
  if (mimeType.includes("pdf") || name.endsWith(".pdf")) {
    return FileText;
  }
  return File;
}

export function EnterpriseContextPanel({
  targetUrl,
  onTargetUrlChange,
  documents,
  documentsLoading,
  uploadInProgress,
  sessionTitle,
  contextError,
  connectorReady,
  onUploadFiles,
  onStartNewReview,
}: EnterpriseContextPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <aside className="w-[340px] shrink-0 rounded-3xl border border-white/10 bg-zinc-950/80 backdrop-blur-xl overflow-hidden">
      <div className="border-b border-white/10 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-cyan-300/80">
              Review Context
            </div>
            <h2 className="mt-1 text-lg font-semibold text-white">{sessionTitle}</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Add your company URL and upload reference documents. Then ask the assistant to review
              any page against this context.
            </p>
          </div>
          <button
            type="button"
            onClick={onStartNewReview}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-zinc-200 transition hover:bg-white/10"
          >
            <Plus className="h-3.5 w-3.5" />
            New review
          </button>
        </div>
      </div>

      <div className="space-y-6 p-5">
        <section>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Globe className="h-4 w-4 text-cyan-300" />
            Company URL
          </div>
          <p className="mb-3 text-xs text-zinc-500">
            Your company website or portfolio page. This is used as additional context alongside the
            uploaded documents when evaluating opportunities.
          </p>
          <input
            type="url"
            value={targetUrl}
            onChange={(e) => onTargetUrlChange(e.target.value)}
            placeholder="https://yourcompany.com"
            className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-cyan-400/40"
          />
        </section>

        <section>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Upload className="h-4 w-4 text-cyan-300" />
            Reference documents
          </div>
          <p className="mb-3 text-xs text-zinc-500">
            Upload PDFs or Excel files. They stay scoped to this review session only.
          </p>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.xlsx,.xls,.docx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(e) => {
              const files = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = "";
              if (files.length > 0) onUploadFiles(files);
            }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadInProgress}
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-cyan-400/20 bg-cyan-500/10 px-4 py-3 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploadInProgress ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {uploadInProgress ? "Uploading..." : "Upload documents"}
          </button>

          <div className="mt-4">
            {documentsLoading ? (
              <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading documents...
              </div>
            ) : documents.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-5 text-sm text-zinc-500">
                No documents uploaded for this review yet.
              </div>
            ) : (
              <div className="space-y-2">
                {documents.map((doc) => {
                  const Icon = getFileIcon(doc.fileName, doc.mimeType);
                  return (
                    <div
                      key={doc.id}
                      className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/5 px-3 py-3"
                    >
                      <div className="mt-0.5 rounded-xl bg-white/10 p-2 text-zinc-300">
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-white">{doc.fileName}</div>
                        <div className="mt-1 text-xs text-zinc-500">
                          {formatFileSize(doc.sizeBytes)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4">
          <div className="text-sm font-medium text-white">Demo connector</div>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                connectorReady ? "bg-emerald-400" : "bg-amber-400"
              }`}
            />
            <span className={connectorReady ? "text-emerald-300" : "text-amber-300"}>
              {connectorReady ? "Connector online" : "Waiting for Groovy Connector"}
            </span>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Browser comparisons will use the existing connector/computer-use flow. The docs in this
            panel only shape the context for this review.
          </p>
        </section>

        {contextError && (
          <div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {contextError}
          </div>
        )}
      </div>
    </aside>
  );
}
