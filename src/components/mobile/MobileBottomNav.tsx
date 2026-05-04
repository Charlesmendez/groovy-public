"use client";

import { motion } from "framer-motion";
import {
  MessageSquare,
  Terminal,
  Activity,
  MoreHorizontal,
  Zap,
  Wifi,
  WifiOff,
  Loader2,
  Globe,
  FolderOpen,
  BookMarked,
  BarChart3,
} from "lucide-react";

export type MobileTab = "chat" | "code" | "activity" | "more";

type MobileBottomNavProps = {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  hasActivity?: boolean;
  codeSessionActive?: boolean;
  isStreaming?: boolean;
};

const TABS: {
  id: MobileTab;
  label: string;
  icon: typeof MessageSquare;
  activeColor: string;
}[] = [
  { id: "chat", label: "Chat", icon: MessageSquare, activeColor: "cyan" },
  { id: "code", label: "Code", icon: Terminal, activeColor: "emerald" },
  { id: "activity", label: "Activity", icon: Activity, activeColor: "violet" },
  { id: "more", label: "More", icon: MoreHorizontal, activeColor: "zinc" },
];

export function MobileBottomNav({
  activeTab,
  onTabChange,
  hasActivity,
  codeSessionActive,
  isStreaming,
}: MobileBottomNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-zinc-950/95 backdrop-blur-xl border-t border-white/10 safe-area-bottom">
      <div className="flex items-center justify-around h-16 px-2">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;
          const showDot =
            (tab.id === "activity" && hasActivity) ||
            (tab.id === "code" && codeSessionActive);
          const showPulse = tab.id === "chat" && isStreaming;

          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className="relative flex flex-col items-center justify-center w-16 h-full transition-all active:scale-95"
            >
              {/* Active indicator */}
              {isActive && (
                <motion.div
                  layoutId="mobile-tab-indicator"
                  className={`absolute top-1 left-1/2 -translate-x-1/2 w-8 h-1 rounded-full ${
                    tab.activeColor === "cyan"
                      ? "bg-cyan-400"
                      : tab.activeColor === "emerald"
                      ? "bg-emerald-400"
                      : tab.activeColor === "violet"
                      ? "bg-violet-400"
                      : "bg-zinc-400"
                  }`}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                />
              )}

              {/* Icon */}
              <div className="relative">
                <Icon
                  className={`w-6 h-6 transition-colors ${
                    isActive
                      ? tab.activeColor === "cyan"
                        ? "text-cyan-400"
                        : tab.activeColor === "emerald"
                        ? "text-emerald-400"
                        : tab.activeColor === "violet"
                        ? "text-violet-400"
                        : "text-white"
                      : "text-zinc-500"
                  }`}
                />

                {/* Notification dot */}
                {showDot && !isActive && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-cyan-400" />
                )}

                {/* Streaming pulse */}
                {showPulse && (
                  <motion.span
                    initial={{ scale: 0.8, opacity: 0.5 }}
                    animate={{ scale: 1.2, opacity: 0 }}
                    transition={{ repeat: Infinity, duration: 1 }}
                    className="absolute inset-0 rounded-full bg-cyan-400"
                  />
                )}
              </div>

              {/* Label */}
              <span
                className={`text-[10px] mt-1 font-medium transition-colors ${
                  isActive
                    ? tab.activeColor === "cyan"
                      ? "text-cyan-400"
                      : tab.activeColor === "emerald"
                      ? "text-emerald-400"
                      : tab.activeColor === "violet"
                      ? "text-violet-400"
                      : "text-white"
                    : "text-zinc-500"
                }`}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// Agent config matching desktop styling
const MOBILE_AGENT_CONFIG = {
  browser: {
    icon: Globe,
    label: "Browser",
    color: "text-cyan-400",
    bgColor: "bg-cyan-500/15",
    borderColor: "border-cyan-500/30",
  },
  obsidian: {
    icon: BookMarked,
    label: "Notes",
    color: "text-violet-400",
    bgColor: "bg-violet-500/15",
    borderColor: "border-violet-500/30",
  },
  files: {
    icon: FolderOpen,
    label: "Files",
    color: "text-amber-400",
    bgColor: "bg-amber-500/15",
    borderColor: "border-amber-500/30",
  },
  data: {
    icon: BarChart3,
    label: "Data",
    color: "text-emerald-400",
    bgColor: "bg-emerald-500/15",
    borderColor: "border-emerald-500/30",
  },
} as const;

// Compact agent strip for mobile (horizontal scroll)
export function MobileAgentStrip({
  onAgentTap,
  connectorOnline,
}: {
  onAgentTap: (agent: string) => void;
  connectorOnline: boolean;
}) {
  const agentIds = ["browser", "obsidian", "files", "data"] as const;

  return (
    <div className="flex gap-2 overflow-x-auto scrollbar-hide px-4 py-3">
      {agentIds.map((agentId) => {
        const config = MOBILE_AGENT_CONFIG[agentId];
        const Icon = config.icon;
        return (
          <button
            key={agentId}
            onClick={() => onAgentTap(agentId)}
            className={`flex items-center gap-2 px-3 py-2 rounded-full border shrink-0 transition-all active:scale-95 ${
              connectorOnline
                ? `${config.bgColor} ${config.borderColor} hover:brightness-110`
                : "bg-white/[0.02] border-white/5 opacity-50"
            }`}
          >
            <div className={`w-5 h-5 rounded-md ${config.bgColor} flex items-center justify-center`}>
              <Icon className={`w-3.5 h-3.5 ${config.color}`} />
            </div>
            <span className={`text-xs font-medium ${connectorOnline ? config.color : "text-zinc-500"}`}>
              {config.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Mobile-optimized header (minimal)
export function MobileHeader({
  title,
  subtitle,
  relayStatus,
  localConnectorOnline,
  connectorChecking = false,
}: {
  title: string;
  subtitle?: string;
  relayStatus: "disconnected" | "connecting" | "ready" | "error";
  localConnectorOnline: boolean;
  connectorChecking?: boolean;
}) {
  const state = connectorChecking
    ? "checking"
    : relayStatus !== "ready"
    ? "offline"
    : localConnectorOnline
    ? "machine"
    : "relay";
  const badge =
    state === "machine"
      ? { bg: "bg-emerald-500/10", text: "text-emerald-400", label: "Machine", Icon: Zap }
      : state === "checking"
      ? { bg: "bg-cyan-500/10", text: "text-cyan-300", label: "Checking", Icon: Loader2 }
      : state === "relay"
      ? { bg: "bg-amber-500/10", text: "text-amber-400", label: "Relay", Icon: Wifi }
      : { bg: "bg-zinc-800", text: "text-zinc-500", label: "Offline", Icon: WifiOff };

  return (
    <header className="sticky top-0 z-40 bg-zinc-950/90 backdrop-blur-xl border-b border-white/5 safe-area-top">
      <div className="flex items-center justify-between h-14 px-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-white">{title}</span>
            {subtitle && (
              <span className="text-xs text-zinc-500">{subtitle}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Connector status */}
          <div
            className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs ${badge.bg} ${badge.text}`}
          >
            <badge.Icon
              className={`w-3 h-3 ${
                state === "machine"
                  ? "fill-current"
                  : state === "checking"
                  ? "animate-spin"
                  : ""
              }`}
            />
            <span>{badge.label}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
