"use client";

import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight } from "lucide-react";

type HandshakeMessageProps = {
  direction: "incoming" | "outgoing";
  partnerName: string;
  content: string;
  timestamp?: Date;
};

export function HandshakeMessage({
  direction,
  partnerName,
  content,
  timestamp,
}: HandshakeMessageProps) {
  const isIncoming = direction === "incoming";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={`flex flex-col gap-0.5 ${isIncoming ? "items-start" : "items-end"}`}
    >
      {/* Direction label */}
      <div
        className={`flex items-center gap-1 px-1 ${
          isIncoming ? "flex-row" : "flex-row-reverse"
        }`}
      >
        {isIncoming ? (
          <ArrowLeft className="w-2.5 h-2.5 text-orange-400/70" />
        ) : (
          <ArrowRight className="w-2.5 h-2.5 text-orange-400/70" />
        )}
        <span className="text-[9px] text-orange-400/70 font-medium">
          {isIncoming ? `From: ${partnerName}` : `To: ${partnerName}`}
        </span>
        {timestamp && (
          <span className="text-[8px] text-zinc-500">
            {timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>

      {/* Message bubble */}
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-xs text-zinc-200 ${
          isIncoming
            ? "bg-orange-500/8 border-l-2 border-orange-500/40 rounded-tl-sm"
            : "bg-orange-500/8 border-r-2 border-orange-500/40 rounded-tr-sm"
        }`}
      >
        <p className="whitespace-pre-wrap break-words leading-relaxed">{content}</p>
      </div>
    </motion.div>
  );
}
