"use client";

import { motion } from "framer-motion";
import { Paperclip, Download, Loader2 } from "lucide-react";
import type { OrchestratorMessage } from "@/hooks/useOrchestrator";
import { HandshakeMessage } from "@/components/handshake/HandshakeMessage";
import { FormattedMessageContent } from "@/components/common/FormattedMessageContent";

type MessageListProps = {
  messages: OrchestratorMessage[];
  isStreaming: boolean;
  streamingContent: string;
  /** If true, uses compact sizing for tile view */
  compact?: boolean;
  emptyMessage?: string;
};

export function MessageList({
  messages,
  isStreaming,
  streamingContent,
  compact = false,
  emptyMessage = "Send a message to get started",
}: MessageListProps) {
  const textSize = compact ? "text-xs" : "text-sm";
  const maxW = compact ? "max-w-[95%]" : "max-w-[95%] sm:max-w-[85%]";
  const padding = compact ? "px-3 py-2" : "px-4 py-3";
  const timestampSize = compact ? "text-[9px]" : "text-[10px]";

  if (messages.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center px-6">
          <p className={`${textSize} text-zinc-500`}>{emptyMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {messages.map((msg) => (
        (() => {
          const metadata =
            msg.metadata && typeof msg.metadata === "object"
              ? (msg.metadata as Record<string, unknown>)
              : null;
          const handshake =
            metadata &&
            metadata.handshake &&
            typeof metadata.handshake === "object"
              ? (metadata.handshake as Record<string, unknown>)
              : null;
          const direction =
            handshake && typeof handshake.direction === "string"
              ? handshake.direction.trim().toLowerCase()
              : "";
          const handshakeDirection =
            direction === "incoming" || direction === "outgoing" ? direction : null;
          const partnerName =
            handshakeDirection === "incoming"
              ? (typeof handshake?.fromSessionTitle === "string" &&
                  handshake.fromSessionTitle.trim()) ||
                "Partner Agent"
              : handshakeDirection === "outgoing"
                ? (typeof handshake?.toSessionTitle === "string" &&
                    handshake.toSessionTitle.trim()) ||
                  "Partner Agent"
                : "";
          const shouldRenderHandshakeBubble =
            !!handshakeDirection && typeof msg.content === "string" && msg.content.trim().length > 0;

          if (shouldRenderHandshakeBubble) {
            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex flex-col ${
                  handshakeDirection === "outgoing" ? "items-end" : "items-start"
                }`}
              >
                <HandshakeMessage
                  direction={handshakeDirection}
                  partnerName={partnerName}
                  content={msg.content}
                  timestamp={msg.timestamp}
                />
              </motion.div>
            );
          }

          return (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
            >
              <div
                className={`${maxW} rounded-2xl ${padding} ${
                  msg.role === "user"
                    ? "bg-cyan-500/10 border border-cyan-500/20 text-white"
                    : "bg-white/5 border border-white/10 text-zinc-300"
                }`}
              >
            {/* Attached files */}
            {msg.role === "user" &&
              msg.metadata &&
              Array.isArray((msg.metadata as { files?: unknown }).files) &&
              ((msg.metadata as { files: Array<{ id: string; name: string }> }).files).length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {(msg.metadata as { files: Array<{ id: string; name: string }> }).files.map((f, idx) => (
                    <div
                      key={`${msg.id}-file-${idx}`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-[10px]"
                    >
                      <Paperclip className="w-2.5 h-2.5" />
                      <span className="truncate max-w-[100px]">{f.name}</span>
                    </div>
                  ))}
                </div>
              )}

            {/* Team reply tag */}
            {msg.metadata &&
              typeof (msg.metadata as Record<string, unknown>).workspace_request_id === "string" && (
                <div className="mb-1 text-[9px] text-zinc-500">
                  Team reply
                  {typeof (msg.metadata as Record<string, unknown>).workspace_request_requested_user_handle === "string" &&
                    Boolean((msg.metadata as Record<string, unknown>).workspace_request_requested_user_handle) && (
                      <>
                        {" "}&middot;{" "}
                        <span className="text-zinc-300">
                          @{String((msg.metadata as Record<string, unknown>).workspace_request_requested_user_handle)}
                        </span>
                      </>
                    )}
                </div>
              )}

            <FormattedMessageContent
              content={
                msg.role === "assistant"
                  ? msg.content.replace(/\[Saving [^\]]+\.\.\.\]\s*/gi, "").trim()
                  : msg.content
              }
              className={`${textSize} space-y-2`}
              textClassName="whitespace-pre-wrap break-words"
            />

            {/* Generated images */}
            {msg.role === "assistant" &&
              msg.metadata &&
              Array.isArray((msg.metadata as { generated_images?: unknown }).generated_images) &&
              (msg.metadata as { generated_images: Array<{ mediaType: string; base64: string }> })
                .generated_images.length > 0 && (
                <div className="mt-2 grid grid-cols-1 gap-2">
                  {(msg.metadata as { generated_images: Array<{ mediaType: string; base64: string }> })
                    .generated_images.map((img, idx) => (
                      <div
                        key={`img-${idx}`}
                        className="rounded-xl overflow-hidden border border-white/10 bg-black/20"
                      >
                        <img
                          src={`data:${img.mediaType};base64,${img.base64}`}
                          alt={`Generated image ${idx + 1}`}
                          className="w-full max-h-[200px] object-contain"
                        />
                      </div>
                    ))}
                </div>
              )}

            <p className={`${timestampSize} text-zinc-600 mt-1`}>
              {msg.timestamp.toLocaleTimeString()}
            </p>
          </div>

          {/* Generated files */}
          {msg.role === "assistant" &&
            msg.metadata &&
            Array.isArray((msg.metadata as { generated_files?: unknown }).generated_files) &&
            (msg.metadata as { generated_files: Array<{ name?: string; filename?: string; url?: string; mediaType?: string; mime_type?: string; storage_path?: string; file_id?: string }> })
              .generated_files.length > 0 && (
              <div className="mt-1.5 w-full space-y-1.5">
                {(msg.metadata as { generated_files: Array<{ name?: string; filename?: string; url?: string; mediaType?: string; mime_type?: string; storage_path?: string; file_id?: string }> })
                  .generated_files.map((f, idx) => {
                    const fileName = f.filename || f.name || "file";
                    const mimeType = f.mime_type || f.mediaType || "file";
                    const fileUrl =
                      (f.storage_path
                        ? `/api/datagran/files?storagePath=${encodeURIComponent(f.storage_path)}&agentId=generated`
                        : null) ||
                      (f.file_id
                        ? `/api/datagran/files?fileId=${encodeURIComponent(f.file_id)}&agentId=generated`
                        : null) ||
                      (typeof f.url === "string" && f.url ? f.url : null);
                    return (
                      <a
                        key={`${fileName}-${idx}`}
                        href={fileUrl || "#"}
                        target={fileUrl ? "_blank" : undefined}
                        rel={fileUrl ? "noreferrer" : undefined}
                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-white/10 bg-black/20 text-xs ${
                          fileUrl ? "hover:bg-white/5" : "opacity-60 cursor-not-allowed"
                        }`}
                        onClick={(e) => { if (!fileUrl) e.preventDefault(); }}
                      >
                        <span className="truncate text-white">{fileName}</span>
                        <span className="text-[9px] text-zinc-500 shrink-0">{mimeType}</span>
                        <Download className="w-3 h-3 text-zinc-400 shrink-0 ml-auto" />
                      </a>
                    );
                  })}
              </div>
            )}
            </motion.div>
          );
        })()
      ))}

      {/* Streaming content */}
      {isStreaming && streamingContent && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex justify-start"
        >
          <div className={`${maxW} rounded-2xl ${padding} bg-white/5 border border-white/10`}>
            <div className={`${textSize} text-zinc-300`}>
              <FormattedMessageContent
                content={streamingContent.replace(/\[Saving [^\]]+\.\.\.\]\s*/gi, "").trim()}
                className="space-y-2"
                textClassName="whitespace-pre-wrap break-words"
              />
              <span className="inline-block w-1.5 h-3 bg-cyan-400 ml-1 animate-pulse" />
            </div>
          </div>
        </motion.div>
      )}

      {/* Working indicator */}
      {isStreaming && !streamingContent && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex justify-start"
        >
          <div className={`rounded-2xl ${padding} bg-white/5 border border-white/10`}>
            <div className="flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
              <span className={`${textSize} text-zinc-500`}>Working...</span>
            </div>
          </div>
        </motion.div>
      )}
    </>
  );
}
