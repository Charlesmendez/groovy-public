"use client";

import { motion } from "framer-motion";
import { Link2, X, Loader2 } from "lucide-react";
import type { HandshakeState } from "@/hooks/useMultiAgent";

type HandshakeBannerProps = {
  handshake: HandshakeState;
  onDisconnect: () => void;
};

const STATUS_LABELS: Record<HandshakeState["status"], string> = {
  active: "Connected",
  collaborating: "Collaborating",
  waiting: "Waiting for response",
  closed: "Disconnected",
};

const STATUS_DETAILS: Record<HandshakeState["status"], string> = {
  active: "Ready to collaborate with your linked agent.",
  collaborating: "Both agents are actively coordinating this request.",
  waiting: "Partner agent is working on the handoff.",
  closed: "Handshake channel is closed.",
};

export function HandshakeBanner({ handshake, onDisconnect }: HandshakeBannerProps) {
  const isWorking = handshake.status === "collaborating" || handshake.status === "waiting";
  const detail =
    typeof handshake.statusDetail === "string" && handshake.statusDetail.trim()
      ? handshake.statusDetail.trim()
      : STATUS_DETAILS[handshake.status];

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
      className="overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 bg-orange-500/8 border-b border-orange-500/20">
        {/* Animated handshake icon */}
        <motion.div
          animate={
            isWorking
              ? { rotate: [0, 10, -10, 0], scale: [1, 1.1, 1] }
              : { rotate: 0, scale: 1 }
          }
          transition={
            isWorking
              ? { repeat: Infinity, duration: 1.5, ease: "easeInOut" }
              : {}
          }
        >
          <Link2 className="w-3.5 h-3.5 text-orange-400" />
        </motion.div>

        {/* Partner + status detail */}
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-orange-300/90 font-medium truncate">
            Connected to:{" "}
            <span className="text-orange-200">{handshake.partnerName}</span>
          </div>
          <div className="text-[10px] text-orange-300/65 truncate">
            {detail}
          </div>
        </div>

        {/* Status */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isWorking ? (
            <Loader2 className="w-3 h-3 text-orange-400 animate-spin" />
          ) : (
            <motion.div
              className="w-1.5 h-1.5 rounded-full bg-orange-400"
              animate={{ opacity: [1, 0.4, 1] }}
              transition={{ repeat: Infinity, duration: 2 }}
            />
          )}
          <span className="text-[9px] text-orange-400/70 uppercase tracking-wider font-medium">
            {STATUS_LABELS[handshake.status]}
          </span>
        </div>

        {/* Disconnect button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDisconnect();
          }}
          className="p-0.5 rounded hover:bg-orange-500/20 text-orange-400/60 hover:text-orange-300 transition-colors shrink-0"
          title="Disconnect handshake"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </motion.div>
  );
}
