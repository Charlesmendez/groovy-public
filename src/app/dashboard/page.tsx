"use client";

import { Suspense, useState, useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Settings,
  Download,
  Wifi,
  WifiOff,
  Plus,
  MessageSquare,
  Trash2,
  Edit2,
  Check,
  X,
  Laptop2,
  Globe,
  FolderOpen,
  BookOpen,
  ChevronDown,
  Loader2,
  Terminal as TerminalIcon,
  Paperclip,
  BarChart3,
  Clock,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  FileText,
  Mic,
  MicOff,
  Plug,
} from "lucide-react";
import { MobileBottomNav, MobileHeader, MobileAgentStrip, type MobileTab } from "@/components/mobile/MobileBottomNav";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useMultiAgent } from "@/hooks/useMultiAgent";
import { AgentGrid } from "@/components/command-center/AgentGrid";
import { useRelay } from "@/hooks/useRelay";
// #disabled - voice hook removed because of major implementation change (realtime voice)
// import { useVoiceControl, type VoiceCommand } from "@/hooks/useVoiceControl";
import { UnifiedInput } from "@/components/command-center/UnifiedInput";
import type { AgentStatus } from "@/components/command-center/AgentTile";
import { AgentParticles } from "@/components/command-center/AgentParticles";
import { RunningAgentPanel } from "@/components/command-center/RunningAgentPanel";
import { CompactActivityStrip } from "@/components/command-center/CompactActivityStrip";
import { ActivityFeed, type FeedItem } from "@/components/command-center/ActivityFeed";
import { SettingsModal, type SettingsFocusSection } from "@/components/command-center/SettingsModal";
import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
import { WelcomeOnboarding } from "@/components/onboarding/WelcomeOnboarding";
import { ChatAgentCreateModal } from "@/components/chat/ChatAgentCreateModal";
import { ObsidianSetupModal, type ObsidianVault } from "@/components/obsidian/ObsidianSetupModal";
import { FilesAgentSetupModal, type FilesAgentInfo } from "@/components/files/FilesAgentSetupModal";
import {
  DataIntegrationsPanel,
  type DataConnection,
  type WebPixel,
  type PlatformType,
  getDatagranProvider,
} from "@/components/command-center/DataIntegrationsPanel";
import { FilesAgentPanel } from "@/components/files/FilesAgentPanel";
import IntegrationsPanel from "@/components/command-center/IntegrationsPanel";
import { ClaudeCliChatPanel } from "@/components/claude/ClaudeCliChatPanel";
import { ClaudeCodeSessionsPanel } from "@/components/claude/ClaudeCodeSessionsPanel";
import { PlansBrowser } from "@/components/claude/PlansBrowser";
import { useClaudePlans, type ClaudePlan } from "@/hooks/useClaudePlans";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { SchedulePanel } from "@/components/command-center/SchedulePanel";
import SiteBuilderPanel from "@/components/site-builder/SiteBuilderPanel";
import PagesManagerModal from "@/components/site-builder/PagesManagerModal";
import type { AgentType } from "@/lib/orchestrator/router";
import { useConnectorInstallGuide } from "@/lib/connector/installGuide";
import type { Provider, KeyModes } from "@/lib/keys/resolveKeyMode";

type CodeCliProvider = "claude" | "codex";
type CodeAgentInfo = {
  id: string;
  name: string;
  createdAt?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  codeCliProvider?: CodeCliProvider;
};

function CellIcon({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full border border-current ${className}`}
    >
      <span className="h-[22%] w-[22%] rounded-full bg-current" />
    </span>
  );
}

type CodeWorkspaceSelection = {
  id: string;
  rootPath?: string;
};
type WorkspaceAddedMsg = {
  type: "workspace_added";
  request_id?: string;
  ok?: boolean;
  workspace?: { id?: string; root_path?: string; label?: string };
  error?: string;
};
type PendingCodePrompt = {
  id: string;
  agentId: string;
  content: string;
  targetPaneId?: string | null;
};
type TeamMember = { id: string; handle: string; label: string; description?: string };
type WorkspaceOrchestratorRequestRow = {
  id: string;
  workspace_id: string;
  session_id: string | null;
  agent_id?: string | null;
  requested_by_user_id: string;
  requested_user_id: string;
  status: string;
  request: {
    message?: unknown;
    requiresConnector?: unknown;
    provider?: unknown;
    metadata?: unknown;
  };
  result?: unknown;
  dedupe_key?: string | null;
  expires_at?: string | null;
  claimed_at?: string | null;
  claimed_by_client_id?: string | null;
  attempt_count?: number;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
};

type MobileScheduledJob = {
  id: string;
  name: string;
  device_id: string | null;
  kind: string | null;
  command: string | null;
  task: unknown;
  schedule: unknown;
  enabled: boolean;
  skip_next_run: boolean;
  last_run_at: string | null;
  last_status: string | null;
  updated_at: string | null;
};

type ConnectorWhatsAppHealthStatus =
  | "healthy"
  | "degraded"
  | "recovering"
  | "disabled"
  | "unknown";

type ConnectorWhatsAppHealth = {
  status: ConnectorWhatsAppHealthStatus;
  reason?: string;
  detail?: string;
  updated_at?: string | null;
  last_healthy_at?: string | null;
  last_failure_at?: string | null;
  consecutive_failures?: number;
  recent_failures?: number;
  auto_restart_pending?: boolean;
  auto_restart_count?: number;
};

type ConnectorAiyraVoiceHealthStatus =
  | "healthy"
  | "degraded"
  | "recovering"
  | "disabled"
  | "unknown";

type ConnectorAiyraVoiceHealth = {
  status: ConnectorAiyraVoiceHealthStatus;
  reason?: string;
  detail?: string;
  updated_at?: string | null;
  last_healthy_at?: string | null;
  last_failure_at?: string | null;
  listening?: boolean;
  active?: boolean;
  muted?: boolean;
  wake_word?: string;
  wake_sensitivity?: number;
  openwakeword_threshold?: number | null;
  idle_timeout_ms?: number;
  wake_hits?: number;
  wake_suppressed?: number;
  missed_reports?: number;
  false_trigger_reports?: number;
  session_count?: number;
  session_error_count?: number;
  reconnect_attempt_count?: number;
  last_session_duration_ms?: number;
  last_metric_event?: string;
  last_metric_at?: string | null;
  low_mic_gain_detected?: boolean;
  low_mic_gain_at?: string | null;
  low_mic_gain_message?: string | null;
  low_mic_gain_max_energy_observed?: number | null;
  low_mic_gain_threshold?: number | null;
  configured_mic_name?: string | null;
  resolved_device_name?: string | null;
  mic_selection_fallback_reason?: string | null;
  mic_input_level?: number | null;
  mic_input_updated_at?: string | null;
  conversation_id?: string | null;
  orchestrator_session_id?: string | null;
  twilio_supervisor_state?: {
    id?: string | null;
    at?: string | null;
    childConversationId?: string | null;
    childKind?: string | null;
    status?: string | null;
    stage?: string | null;
    summary?: string | null;
    rawText?: string | null;
    callSid?: string | null;
    messageSid?: string | null;
    speakSuggested?: boolean | null;
  } | null;
};

type TwilioConversationEntrySpeaker = "assistant" | "contact" | "system";

type TwilioConversationEntry = {
  id: string;
  at: string | null;
  speaker: TwilioConversationEntrySpeaker;
  text: string;
  label?: string | null;
};

type ConnectorHealthSnapshot = {
  whatsapp?: ConnectorWhatsAppHealth | null;
  aiyra_voice?: ConnectorAiyraVoiceHealth | null;
};

type AiyraConfigSnapshot = {
  configured: boolean;
  enabled: boolean;
  personaPrompt: string;
  voiceId: string;
  ttsSpeed: number;
  wakeWord: string;
  wakeSensitivity: number;
  idleTimeoutMs: number;
  twilioEnabled: boolean;
  twilioFrom: string;
  twilioTo: string;
  updatedAt?: string | null;
};

type AiyraMicMode = "computer_default" | "system_default" | "specific";
type AiyraAudioDevice = { index: number; name: string };
type AiyraAudioDeviceListResult = {
  devices: AiyraAudioDevice[];
  currentDeviceIndex?: number;
  currentMicMode?: AiyraMicMode;
  currentMicName?: string;
  resolvedDeviceName?: string;
};

const AIYRA_RECENT_UI_ACTIVITY_EVENTS = [
  "wake_detected",
  "voice_session_started",
  "voice_session_connected",
  "voice_audio_delta_started",
  "voice_audio_delta_activity",
  "voice_user_speech_detected",
  "voice_user_speech_activity",
  "voice_thinking_pulse_started",
  "voice_spoken_progress_started",
  "voice_deferred_followup_started",
] as const;

type OnlineDeviceInfo = {
  deviceId: string;
  version?: string;
  claudeCliInstalled?: boolean;
  health?: ConnectorHealthSnapshot | null;
};

const DEFAULT_AIYRA_TTS_SPEED = 1.03;

function VoiceMicLevelMeter({
  level,
  muted = false,
}: {
  level: number;
  muted?: boolean;
}) {
  const clampedLevel = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  const barWeights = [0.42, 0.68, 1, 0.72, 0.48];
  return (
    <span className="flex h-4 items-end gap-[3px]" aria-hidden="true">
      {barWeights.map((weight, index) => {
        const scaled = muted ? 0.08 : Math.max(0.12, Math.min(1, 0.12 + clampedLevel * weight));
        const heightPx = 4 + Math.round(scaled * 11);
        const opacity = muted
          ? 0.28
          : Math.min(0.95, 0.28 + clampedLevel * (0.35 + index * 0.07));
        return (
          <span
            key={`${weight}-${index}`}
            className={`w-[3px] rounded-full bg-current transition-all duration-150 ${
              !muted && clampedLevel > 0.65 ? "shadow-[0_0_10px_rgba(255,255,255,0.14)]" : ""
            }`}
            style={{ height: `${heightPx}px`, opacity }}
          />
        );
      })}
    </span>
  );
}

function normalizeAiyraTtsSpeed(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_AIYRA_TTS_SPEED;
  return Math.round(Math.max(0.5, Math.min(2, n)) * 100) / 100;
}

function readAiyraTtsSpeed(config: Record<string, unknown> | null): number {
  if (!config) return DEFAULT_AIYRA_TTS_SPEED;
  const ttsRaw =
    config.tts && typeof config.tts === "object" && !Array.isArray(config.tts)
      ? (config.tts as Record<string, unknown>)
      : null;
  return normalizeAiyraTtsSpeed(config.ttsSpeed ?? ttsRaw?.speed);
}

function readAiyraTwilioConfig(config: Record<string, unknown> | null): {
  enabled: boolean;
  from: string;
  to: string;
} {
  const toolsRaw =
    config?.tools && typeof config.tools === "object" && !Array.isArray(config.tools)
      ? (config.tools as Record<string, unknown>)
      : null;
  const twilioRaw =
    toolsRaw?.twilio && typeof toolsRaw.twilio === "object" && !Array.isArray(toolsRaw.twilio)
      ? (toolsRaw.twilio as Record<string, unknown>)
      : null;
  return {
    enabled: twilioRaw?.enabled === true,
    from: typeof twilioRaw?.from === "string" ? twilioRaw.from : "",
    to: typeof twilioRaw?.to === "string" ? twilioRaw.to : "",
  };
}

const NON_PANEL_ACTIVITY_ACTIONS = new Set([
  "Message sent",
  "Storing to memory",
  "Memory context loaded",
  "Processing request",
  "Grabbing your memory and building your context",
]);

const PANEL_AGENT_SET = new Set<AgentType>([
  "browser",
  "files",
  "pages",
  "obsidian",
  "data",
  "chat",
  "schedule",
  "code",
]);

function isPanelAgent(agent: string): agent is AgentType {
  return PANEL_AGENT_SET.has(agent as AgentType);
}

function humanizeSkillToolName(toolName: string): string {
  const raw = String(toolName || "").trim();
  if (!raw) return "custom";
  if (raw.startsWith("skill_registry_")) {
    return raw.slice("skill_registry_".length).replace(/_/g, " ").trim() || "registry";
  }
  const slug = raw.replace(/^skill_/, "").trim();
  if (!slug) return "custom";
  return slug.replace(/_/g, " ");
}

async function isLocalPreviewReachable(port: number, timeoutMs = 3000): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0) return false;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    // no-cors lets us detect local reachability without requiring CORS headers.
    await fetch(`http://127.0.0.1:${port}/?__groovy_probe__=${Date.now()}`, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

function formatScheduleCompact(schedule: unknown): string {
  if (!schedule || typeof schedule !== "object") return "unknown";
  const t = (schedule as { type?: unknown }).type;
  if (t === "once") {
    const runAt = (schedule as { run_at?: unknown }).run_at;
    return typeof runAt === "string" ? `once @ ${runAt}` : "once";
  }
  if (t === "daily") {
    const hour = (schedule as { hour?: unknown }).hour;
    const minute = (schedule as { minute?: unknown }).minute;
    if (typeof hour === "number" && typeof minute === "number") {
      return `daily @ ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    return "daily";
  }
  if (t === "weekly") {
    const weekday = (schedule as { weekday?: unknown }).weekday;
    const hour = (schedule as { hour?: unknown }).hour;
    const minute = (schedule as { minute?: unknown }).minute;
    const wd =
      typeof weekday === "number"
        ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday] || "?"
        : "?";
    if (typeof hour === "number" && typeof minute === "number") {
      return `weekly ${wd} @ ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    return `weekly ${wd}`;
  }
  if (t === "interval_minutes") {
    const minutes = (schedule as { minutes?: unknown }).minutes;
    return typeof minutes === "number" ? `every ${minutes}m` : "interval";
  }
  return typeof t === "string" ? t : "unknown";
}

function getScheduledJobDetailCompact(j: MobileScheduledJob): string {
  const kind = (j.kind || "shell").toLowerCase();
  if (kind === "orchestrator") {
    const taskObj =
      j.task && typeof j.task === "object" ? (j.task as { message?: unknown }) : null;
    const msg =
      taskObj && typeof taskObj.message === "string" ? taskObj.message.trim() : "";
    return msg || "(no task)";
  }
  return (j.command || "").trim() || "(no command)";
}

function humanizeTwilioSupervisorField(value: string | null | undefined): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function normalizeTwilioConversationText(value: string | null | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function parseTwilioConversationEntry(state: NonNullable<ConnectorAiyraVoiceHealth["twilio_supervisor_state"]>) {
  const detail = normalizeTwilioConversationText(state.summary || state.rawText || "");
  const status = humanizeTwilioSupervisorField(state.status);
  const stage = humanizeTwilioSupervisorField(state.stage);
  const kind = humanizeTwilioSupervisorField(state.childKind) || "Call";
  const baseEntryId = normalizeTwilioConversationText(state.id || "");
  const entryId = baseEntryId
    ? [baseEntryId, state.status || "", state.stage || "", detail].join("|")
    : [state.at || "", state.status || "", state.stage || "", detail].join("|");
  const assistantPrefix =
    /^(i told them|i said|agent message|agent said|assistant said|groovy said)\s*:?\s*/i;
  const contactPrefix =
    /^(they said|contact said|recipient said|caller said|customer said|user said)\s*:?\s*/i;
  const stageKey = normalizeTwilioConversationText(state.stage || "").toLowerCase();

  if (detail) {
    if (assistantPrefix.test(detail)) {
      return {
        id: entryId,
        at: state.at || null,
        speaker: "assistant" as const,
        text: detail.replace(assistantPrefix, "").trim() || detail,
        label: null,
      };
    }
    if (contactPrefix.test(detail)) {
      return {
        id: entryId,
        at: state.at || null,
        speaker: "contact" as const,
        text: detail.replace(contactPrefix, "").trim() || detail,
        label: null,
      };
    }
    if (/(agent|assistant|groovy)/.test(stageKey)) {
      return {
        id: entryId,
        at: state.at || null,
        speaker: "assistant" as const,
        text: detail,
        label: null,
      };
    }
    if (/(contact|recipient|caller|customer|user)/.test(stageKey)) {
      return {
        id: entryId,
        at: state.at || null,
        speaker: "contact" as const,
        text: detail,
        label: null,
      };
    }
    return {
      id: entryId,
      at: state.at || null,
      speaker: "system" as const,
      text: detail,
      label: [status, stage].filter(Boolean).join(" • ") || `${kind} update`,
    };
  }

  const statusKey = normalizeTwilioConversationText(state.status || "").toLowerCase();
  let systemText = "";
  if (statusKey === "starting") systemText = `${kind} started`;
  else if (statusKey === "active") systemText = `${kind} in progress`;
  else if (statusKey === "completed" || statusKey === "ended") systemText = `${kind} ended`;
  else if (statusKey === "failed") systemText = `${kind} failed`;
  else if (stage) systemText = stage;
  if (!systemText) return null;

  return {
    id: entryId,
    at: state.at || null,
    speaker: "system" as const,
    text: systemText,
    label: status && systemText !== status ? status : null,
  };
}

function appendTwilioConversationEntry(
  entries: TwilioConversationEntry[],
  next: TwilioConversationEntry
): TwilioConversationEntry[] {
  if (entries.some((entry) => entry.id === next.id)) return entries;
  const last = entries[entries.length - 1];
  const normalizeKey = (entry: TwilioConversationEntry) =>
    `${entry.speaker}|${entry.text.toLowerCase()}|${String(entry.label || "").toLowerCase()}`;
  if (last && normalizeKey(last) === normalizeKey(next)) {
    const updated = [...entries];
    updated[updated.length - 1] = {
      ...last,
      at: next.at || last.at,
      id: next.id || last.id,
    };
    return updated;
  }
  const appended = [...entries, next];
  return appended.slice(-6);
}

function isTerminalTwilioConversationState(
  state: ConnectorAiyraVoiceHealth["twilio_supervisor_state"] | null | undefined
): boolean {
  const statusKey = normalizeTwilioConversationText(state?.status || "").toLowerCase();
  return statusKey === "completed" || statusKey === "ended" || statusKey === "failed";
}

function buildTwilioConversationSummaryKey(
  state: NonNullable<ConnectorAiyraVoiceHealth["twilio_supervisor_state"]>
): string {
  return [
    normalizeTwilioConversationText(state.id || ""),
    normalizeTwilioConversationText(state.childConversationId || ""),
    normalizeTwilioConversationText(state.callSid || ""),
    normalizeTwilioConversationText(state.messageSid || ""),
    normalizeTwilioConversationText(state.at || ""),
    normalizeTwilioConversationText(state.status || ""),
    normalizeTwilioConversationText(state.stage || ""),
  ]
    .filter(Boolean)
    .join("|");
}

function isVoicemailLikeTwilioEntry(text: string): boolean {
  return /\b(voicemail|voice mail|mailbox|please record your message|leave (?:me )?(?:a )?message|after the tone|at the tone)\b/i.test(
    text
  );
}

function buildTwilioConversationSummaryMessage(args: {
  state: NonNullable<ConnectorAiyraVoiceHealth["twilio_supervisor_state"]>;
  entries: TwilioConversationEntry[];
}) {
  const summaryKey = buildTwilioConversationSummaryKey(args.state);
  if (!summaryKey) return null;

  const kind = humanizeTwilioSupervisorField(args.state.childKind) || "Call";
  const detail = normalizeTwilioConversationText(args.state.summary || args.state.rawText || "");
  const reversedEntries = [...args.entries].reverse();
  const latestAssistant = reversedEntries.find((entry) => entry.speaker === "assistant") || null;
  const latestContact = reversedEntries.find((entry) => entry.speaker === "contact") || null;
  const firstSystem = args.entries.find((entry) => entry.speaker === "system") || null;
  const latestSystem = reversedEntries.find((entry) => entry.speaker === "system") || null;
  const combinedText = [
    detail,
    ...args.entries.map((entry) => entry.text),
    args.state.stage || "",
  ]
    .filter(Boolean)
    .join(" ");
  const hitVoicemail =
    normalizeTwilioConversationText(args.state.childKind || "").toLowerCase() === "call" &&
    isVoicemailLikeTwilioEntry(combinedText);

  let outcome = "";
  if (hitVoicemail) {
    outcome = "We hit voicemail instead of a live person, so the requested conversation did not happen.";
  } else if (normalizeTwilioConversationText(args.state.status || "").toLowerCase() === "failed") {
    outcome = detail ? `The ${kind.toLowerCase()} failed. ${detail}` : `The ${kind.toLowerCase()} failed.`;
  } else if (detail) {
    outcome = detail;
  } else {
    outcome = `The ${kind.toLowerCase()} ended.`;
  }

  const lines = [`${kind} summary:`];
  if (firstSystem) {
    lines.push(
      `- ${firstSystem.label ? `${firstSystem.label} · ` : ""}${firstSystem.text}`
    );
  }
  if (latestAssistant) {
    lines.push(`- Groovy: ${latestAssistant.text}`);
  }
  if (latestContact) {
    lines.push(`- Them: ${latestContact.text}`);
  } else if (latestSystem && latestSystem !== firstSystem) {
    lines.push(
      `- ${latestSystem.label ? `${latestSystem.label} · ` : ""}${latestSystem.text}`
    );
  }
  lines.push(`- Outcome: ${outcome}`);

  return {
    summaryKey,
    content: lines.join("\n"),
    metadata: {
      kind: "twilio_supervisor_summary",
      twilio_summary_key: summaryKey,
      twilio_summary_outcome: outcome,
      twilio_summary_detected_voicemail: hitVoicemail,
      twilio_supervisor_state: args.state,
      twilio_thread_entries: args.entries,
    } satisfies Record<string, unknown>,
  };
}

function renderTwilioConversationLiveBody(
  metadata: Record<string, unknown> | undefined
) {
  const metadataKind = typeof metadata?.kind === "string" ? metadata.kind.trim() : "";
  const isSummary = metadataKind === "twilio_supervisor_summary";
  if (!metadata || (metadataKind !== "twilio_supervisor_live" && !isSummary)) return null;
  const state =
    metadata.twilio_supervisor_state &&
    typeof metadata.twilio_supervisor_state === "object" &&
    !Array.isArray(metadata.twilio_supervisor_state)
      ? (metadata.twilio_supervisor_state as NonNullable<
          ConnectorAiyraVoiceHealth["twilio_supervisor_state"]
        >)
      : null;
  const entries = Array.isArray(metadata.twilio_thread_entries)
    ? (metadata.twilio_thread_entries as Array<Record<string, unknown>>)
        .map((entry) => ({
          id: typeof entry.id === "string" ? entry.id : "",
          at: typeof entry.at === "string" ? entry.at : null,
          speaker:
            entry.speaker === "assistant" || entry.speaker === "contact"
              ? entry.speaker
              : "system",
          text: typeof entry.text === "string" ? entry.text.trim() : "",
          label: typeof entry.label === "string" ? entry.label.trim() : null,
        }))
        .filter((entry) => entry.id && entry.text)
    : [];
  const kind = humanizeTwilioSupervisorField(state?.childKind) || "Call";
  const status = humanizeTwilioSupervisorField(state?.status);
  const statusKey = normalizeTwilioConversationText(state?.status || "").toLowerCase();
  const summaryOutcome =
    typeof metadata.twilio_summary_outcome === "string"
      ? metadata.twilio_summary_outcome.trim()
      : "";
  const statusToneClass =
    statusKey === "active"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
      : statusKey === "failed"
        ? "border-red-500/30 bg-red-500/10 text-red-200"
        : statusKey === "completed" || statusKey === "ended"
          ? "border-zinc-500/30 bg-zinc-500/10 text-zinc-200"
          : "border-cyan-500/30 bg-cyan-500/10 text-cyan-200";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
          {isSummary ? `${kind} Summary` : `Live ${kind} Thread`}
        </span>
        {status ? (
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusToneClass}`}
          >
            {status}
          </span>
        ) : null}
      </div>

      <div className="space-y-2">
        {entries.length > 0 ? (
          entries.map((entry) =>
            entry.speaker === "system" ? (
              <div key={entry.id} className="flex justify-center">
                <div className="max-w-[90%] rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-zinc-400">
                  {entry.label ? `${entry.label} · ` : ""}
                  {entry.text}
                </div>
              </div>
            ) : (
              <div
                key={entry.id}
                className={`flex flex-col ${
                  entry.speaker === "assistant" ? "items-end" : "items-start"
                }`}
              >
                <div className="mb-1 px-1 text-[10px] uppercase tracking-wide text-zinc-500">
                  {entry.speaker === "assistant" ? "Groovy" : "Them"}
                </div>
                <div
                  className={`max-w-[88%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                    entry.speaker === "assistant"
                      ? "border border-cyan-500/20 bg-cyan-500/10 text-white"
                      : "border border-white/10 bg-white/5 text-zinc-200"
                  }`}
                >
                  {entry.text}
                </div>
              </div>
            )
          )
        ) : (
          <div className="text-xs text-zinc-500">
            {isSummary ? "No detailed thread was captured." : "Waiting for the next call update…"}
          </div>
        )}
        {summaryOutcome ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200">
            <span className="mr-1 text-[10px] uppercase tracking-wide text-zinc-500">
              Outcome
            </span>
            {summaryOutcome}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function buildTwilioConversationStatusMessage(args: {
  currentSessionId: string | null;
  voiceHealth: ConnectorAiyraVoiceHealth | null;
  entries: TwilioConversationEntry[];
}) {
  const currentSessionId =
    typeof args.currentSessionId === "string" ? args.currentSessionId.trim() : "";
  const sessionId =
    typeof args.voiceHealth?.orchestrator_session_id === "string"
      ? args.voiceHealth.orchestrator_session_id.trim()
      : "";
  const state = args.voiceHealth?.twilio_supervisor_state || null;
  if (!currentSessionId || !sessionId || sessionId !== currentSessionId || !state) return null;

  const kind = humanizeTwilioSupervisorField(state.childKind) || "Twilio";
  const timestamp =
    typeof state.at === "string" && Number.isFinite(Date.parse(state.at))
      ? new Date(state.at)
      : new Date();

  return {
    id: `twilio-supervisor-live:${currentSessionId}`,
    role: "assistant" as const,
    content: `Live ${kind} Thread`,
    timestamp,
    metadata: {
      kind: "twilio_supervisor_live",
      twilio_supervisor_state: state,
      twilio_thread_entries: args.entries,
      synthetic: true,
    },
  };
}

function normalizeConnectorHealth(raw: unknown): ConnectorHealthSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const whatsappRaw =
    obj.whatsapp && typeof obj.whatsapp === "object"
      ? (obj.whatsapp as Record<string, unknown>)
      : null;
  const aiyraRaw =
    obj.aiyra_voice && typeof obj.aiyra_voice === "object"
      ? (obj.aiyra_voice as Record<string, unknown>)
      : null;
  if (!whatsappRaw && !aiyraRaw) return null;
  const statusRaw =
    typeof (whatsappRaw || aiyraRaw)?.status === "string"
      ? String((whatsappRaw || aiyraRaw)?.status).trim().toLowerCase()
      : "unknown";
  const allowed = new Set([
    "healthy",
    "degraded",
    "recovering",
    "disabled",
    "unknown",
  ]);
  const status: ConnectorWhatsAppHealthStatus = allowed.has(statusRaw)
    ? (statusRaw as ConnectorWhatsAppHealthStatus)
    : "unknown";
  const normalizeStatus = (value: unknown): ConnectorWhatsAppHealthStatus => {
    const s = typeof value === "string" ? value.trim().toLowerCase() : "unknown";
    return allowed.has(s) ? (s as ConnectorWhatsAppHealthStatus) : "unknown";
  };
  const toSafeNumber = (value: unknown, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const toOptionalNumber = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const hasOwn = (obj: Record<string, unknown>, key: string) =>
    Object.prototype.hasOwnProperty.call(obj, key);
  const normalizeTwilioSupervisorState = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const root = value as Record<string, unknown>;
    const update =
      root.update && typeof root.update === "object" && !Array.isArray(root.update)
        ? (root.update as Record<string, unknown>)
        : root;
    const readString = (...inputs: unknown[]) => {
      for (const input of inputs) {
        if (typeof input !== "string") continue;
        const text = input.trim();
        if (text) return text;
      }
      return null;
    };
    const state = {
      id: readString(update.id),
      at: readString(update.at, update.updated_at),
      childConversationId: readString(
        update.childConversationId,
        update.child_conversation_id
      ),
      childKind: readString(update.childKind, update.child_kind),
      status: readString(update.status),
      stage: readString(update.stage),
      summary: readString(update.summary),
      rawText: readString(update.rawText, update.raw_text),
      callSid: readString(update.callSid, update.call_sid),
      messageSid: readString(update.messageSid, update.message_sid),
      speakSuggested:
        typeof update.speakSuggested === "boolean"
          ? update.speakSuggested
          : typeof update.speak_suggested === "boolean"
            ? update.speak_suggested
            : null,
    };
    return Object.values(state).some((entry) => entry !== null) ? state : null;
  };

  const out: ConnectorHealthSnapshot = {};
  if (whatsappRaw) {
    out.whatsapp = {
      status: normalizeStatus(whatsappRaw.status) || status,
      reason: typeof whatsappRaw.reason === "string" ? whatsappRaw.reason : "",
      detail: typeof whatsappRaw.detail === "string" ? whatsappRaw.detail : "",
      updated_at:
        typeof whatsappRaw.updated_at === "string"
          ? whatsappRaw.updated_at
          : null,
      last_healthy_at:
        typeof whatsappRaw.last_healthy_at === "string"
          ? whatsappRaw.last_healthy_at
          : null,
      last_failure_at:
        typeof whatsappRaw.last_failure_at === "string"
          ? whatsappRaw.last_failure_at
          : null,
      consecutive_failures: toSafeNumber(
        whatsappRaw.consecutive_failures,
        0
      ),
      recent_failures: toSafeNumber(whatsappRaw.recent_failures, 0),
      auto_restart_pending: whatsappRaw.auto_restart_pending === true,
      auto_restart_count: toSafeNumber(whatsappRaw.auto_restart_count, 0),
    };
  }
  if (aiyraRaw) {
    out.aiyra_voice = {
      status: normalizeStatus(aiyraRaw.status),
      reason: typeof aiyraRaw.reason === "string" ? aiyraRaw.reason : "",
      detail: typeof aiyraRaw.detail === "string" ? aiyraRaw.detail : "",
      updated_at:
        typeof aiyraRaw.updated_at === "string"
          ? aiyraRaw.updated_at
          : null,
      last_healthy_at:
        typeof aiyraRaw.last_healthy_at === "string"
          ? aiyraRaw.last_healthy_at
          : null,
      last_failure_at:
        typeof aiyraRaw.last_failure_at === "string"
          ? aiyraRaw.last_failure_at
          : null,
      listening: aiyraRaw.listening === true,
      active: aiyraRaw.active === true,
      ...(typeof aiyraRaw.muted === "boolean" ? { muted: aiyraRaw.muted } : {}),
      wake_word: typeof aiyraRaw.wake_word === "string" ? aiyraRaw.wake_word : "",
      wake_sensitivity: toSafeNumber(aiyraRaw.wake_sensitivity, 0),
      ...(hasOwn(aiyraRaw, "openwakeword_threshold")
        ? {
            openwakeword_threshold: toOptionalNumber(
              aiyraRaw.openwakeword_threshold
            ),
          }
        : {}),
      idle_timeout_ms: toSafeNumber(aiyraRaw.idle_timeout_ms, 0),
      wake_hits: toSafeNumber(aiyraRaw.wake_hits, 0),
      wake_suppressed: toSafeNumber(aiyraRaw.wake_suppressed, 0),
      missed_reports: toSafeNumber(aiyraRaw.missed_reports, 0),
      false_trigger_reports: toSafeNumber(aiyraRaw.false_trigger_reports, 0),
      session_count: toSafeNumber(aiyraRaw.session_count, 0),
      session_error_count: toSafeNumber(aiyraRaw.session_error_count, 0),
      reconnect_attempt_count: toSafeNumber(aiyraRaw.reconnect_attempt_count, 0),
      last_session_duration_ms: toSafeNumber(aiyraRaw.last_session_duration_ms, 0),
      last_metric_event:
        typeof aiyraRaw.last_metric_event === "string"
          ? aiyraRaw.last_metric_event
          : "",
      last_metric_at:
        typeof aiyraRaw.last_metric_at === "string"
          ? aiyraRaw.last_metric_at
          : null,
      low_mic_gain_detected: aiyraRaw.low_mic_gain_detected === true,
      low_mic_gain_at:
        typeof aiyraRaw.low_mic_gain_at === "string"
          ? aiyraRaw.low_mic_gain_at
          : null,
      low_mic_gain_message:
        typeof aiyraRaw.low_mic_gain_message === "string"
          ? aiyraRaw.low_mic_gain_message
          : null,
      low_mic_gain_max_energy_observed: toOptionalNumber(
        aiyraRaw.low_mic_gain_max_energy_observed
      ),
      low_mic_gain_threshold: toOptionalNumber(aiyraRaw.low_mic_gain_threshold),
      ...(hasOwn(aiyraRaw, "configured_mic_name")
        ? {
            configured_mic_name:
              typeof aiyraRaw.configured_mic_name === "string"
                ? aiyraRaw.configured_mic_name
                : null,
          }
        : {}),
      ...(hasOwn(aiyraRaw, "resolved_device_name")
        ? {
            resolved_device_name:
              typeof aiyraRaw.resolved_device_name === "string"
                ? aiyraRaw.resolved_device_name
                : null,
          }
        : {}),
      ...(hasOwn(aiyraRaw, "mic_selection_fallback_reason")
        ? {
            mic_selection_fallback_reason:
              typeof aiyraRaw.mic_selection_fallback_reason === "string"
                ? aiyraRaw.mic_selection_fallback_reason
                : null,
          }
        : {}),
      ...(hasOwn(aiyraRaw, "mic_input_level")
        ? {
            mic_input_level:
              toOptionalNumber(aiyraRaw.mic_input_level) === null
                ? null
                : Math.max(
                    0,
                    Math.min(1, Number(toOptionalNumber(aiyraRaw.mic_input_level)))
                  ),
          }
        : {}),
      ...(hasOwn(aiyraRaw, "mic_input_updated_at")
        ? {
            mic_input_updated_at:
              typeof aiyraRaw.mic_input_updated_at === "string"
                ? aiyraRaw.mic_input_updated_at
                : null,
          }
        : {}),
      conversation_id:
        typeof aiyraRaw.conversation_id === "string" ? aiyraRaw.conversation_id : null,
      orchestrator_session_id:
        typeof aiyraRaw.orchestrator_session_id === "string"
          ? aiyraRaw.orchestrator_session_id
          : null,
      twilio_supervisor_state: normalizeTwilioSupervisorState(
        aiyraRaw.twilio_supervisor_state
      ),
    };
  }
  return out;
}

function mergeAiyraVoiceHealth(
  prev: ConnectorAiyraVoiceHealth | null | undefined,
  next: Partial<ConnectorAiyraVoiceHealth> | null | undefined
): ConnectorAiyraVoiceHealth | null {
  if (!next) return prev || null;
  if (!prev) {
    return typeof next.status === "string"
      ? (next as ConnectorAiyraVoiceHealth)
      : null;
  }
  return {
    ...prev,
    ...next,
    ...(typeof next.muted === "boolean" ? { muted: next.muted } : { muted: prev.muted }),
  };
}

function mergeConnectorHealthSnapshot(
  prev: ConnectorHealthSnapshot | null | undefined,
  next: ConnectorHealthSnapshot | null | undefined
): ConnectorHealthSnapshot | null {
  if (!next) return prev || null;
  return {
    whatsapp: next.whatsapp ?? prev?.whatsapp ?? null,
    aiyra_voice: mergeAiyraVoiceHealth(prev?.aiyra_voice, next.aiyra_voice),
  };
}

function scoreAiyraVoiceHealth(health: ConnectorAiyraVoiceHealth | null | undefined): number {
  if (!health) return -1;
  let score = 0;
  if (health.active === true) score += 1000;
  if (health.listening === true) score += 400;

  const wakeHits = Number(health.wake_hits || 0);
  const sessionCount = Number(health.session_count || 0);
  const sessionErrorCount = Number(health.session_error_count || 0);
  const wakeSuppressed = Number(health.wake_suppressed || 0);
  if (wakeHits > 0) score += 200 + Math.min(wakeHits, 50);
  if (sessionCount > 0) score += 240 + Math.min(sessionCount * 8, 80);
  if (sessionErrorCount > 0) score += 60 + Math.min(sessionErrorCount * 5, 40);
  if (wakeSuppressed > 0) score += 40 + Math.min(wakeSuppressed, 20);

  const metricAtMs = health.last_metric_at ? Date.parse(health.last_metric_at) : NaN;
  if (Number.isFinite(metricAtMs)) {
    const ageMs = Date.now() - metricAtMs;
    if (ageMs < 15_000) score += 320;
    else if (ageMs < 60_000) score += 140;
  }

  switch ((health.status || "unknown").toLowerCase()) {
    case "healthy":
      score += 120;
      break;
    case "recovering":
      score += 60;
      break;
    case "degraded":
      score += 30;
      break;
    case "disabled":
      score -= 20;
      break;
    default:
      break;
  }

  return score;
}

function isRestartableWhatsAppIssue(health: ConnectorWhatsAppHealth | null | undefined): boolean {
  if (!health) return false;
  const reason = String(health.reason || "").toLowerCase();
  // Scheduled-job WhatsApp sends already attempt an in-process bridge restart on detached-frame
  // failures. Triggering a full connector restart from the dashboard at the same time causes a
  // restart storm where WhatsApp keeps relaunching even though the bridge can recover locally.
  if (
    reason.startsWith("scheduler_whatsapp_send_") ||
    reason.startsWith("scheduler_whatsapp_bridge_")
  ) {
    return false;
  }
  const combined = `${String(health.reason || "")}; ${String(health.detail || "")}`.toLowerCase();
  return (
    combined.includes("bridge_needs_restart") ||
    combined.includes("detached frame") ||
    combined.includes("execution context was destroyed") ||
    combined.includes("target closed") ||
    combined.includes("session closed") ||
    combined.includes("browser has disconnected") ||
    combined.includes("protocol error")
  );
}

export default function CommandCenterDashboard() {
  return (
    <Suspense>
      <CommandCenterDashboardInner />
    </Suspense>
  );
}

function CommandCenterDashboardInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = getSupabaseBrowserClient();

  // Auth state
  const [_userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [workspaceInfo, setWorkspaceInfo] = useState<{
    id: string;
    name: string;
    role: "admin" | "member";
  } | null>(null);
  const [connectorModePref, setConnectorModePref] = useState<"local" | "groovy" | null>(null);
  const [connectorPrefsLoaded, setConnectorPrefsLoaded] = useState(false);
  const [connectorModePrefSaving, setConnectorModePrefSaving] = useState(false);
  const [connectorModePrefError, setConnectorModePrefError] = useState<string | null>(null);
  const [joinedWorkspaceBannerVisible, setJoinedWorkspaceBannerVisible] = useState(false);
  const [joinedWorkspaceBannerDismissed, setJoinedWorkspaceBannerDismissed] = useState(false);
  const [joinedWorkspaceAutoSelectedGroovy, setJoinedWorkspaceAutoSelectedGroovy] = useState(false);
  const [workspaceHostedMacInfo, setWorkspaceHostedMacInfo] = useState<{
    hasGroovyMac: boolean;
    requestStatus: string | null;
    requestDetail: string | null;
    deviceId: string | null;
    deviceOnline: boolean | null;
    deviceLastSeen: string | null;
  } | null>(null);
  const joinedWorkspaceProcessedRef = useRef(false);
  const joinedFromInvite = searchParams.get("joined") === "1";
  const bypassEnterpriseDemo = searchParams.get("classic") === "1";

  // UI state
  const [showSettings, setShowSettings] = useState(false);
  const [showObsidianSetup, setShowObsidianSetup] = useState(false);
  const [showFilesSetup, setShowFilesSetup] = useState(false);
  const [showChatAgentCreate, setShowChatAgentCreate] = useState(false);
  const [showDataPanel, setShowDataPanel] = useState(false);
  const [showIntegrationsPanel, setShowIntegrationsPanel] = useState(false);
  const [showFilesPanel, setShowFilesPanel] = useState(false);
  const [showSchedulePanel, setShowSchedulePanel] = useState(false);
  // Site Builder state
  const [showSiteBuilderPanel, setShowSiteBuilderPanel] = useState(false);
  const [showPagesManagerModal, setShowPagesManagerModal] = useState(false);
  const [siteBuilderExpanded, setSiteBuilderExpanded] = useState(false);
  const [siteBuilderState, setSiteBuilderState] = useState<{
    slug?: string;
    status?: string;
    devPort?: number;
    tunnelNonce?: string;
    productionUrl?: string;
    deviceId?: string;
    errorMessage?: string;
    startRequestedAt?: number;
  }>({});
  const [runningScheduledJobs, setRunningScheduledJobs] = useState<Set<string>>(new Set());
  const [mobileScheduledJobs, setMobileScheduledJobs] = useState<MobileScheduledJob[]>([]);
  const [mobileScheduledJobsLoading, setMobileScheduledJobsLoading] = useState(false);
  const [mobileScheduledJobsError, setMobileScheduledJobsError] = useState<string | null>(null);
  const [showWelcomeOnboarding, setShowWelcomeOnboarding] = useState(false);
  const [onboardingInitialStep, setOnboardingInitialStep] = useState<"welcome" | "connector" | "whatsapp" | "api_keys" | "chat_agent" | "done" | undefined>(undefined);
  const [filesPanelSessionId, setFilesPanelSessionId] = useState<string | null>(null);
  const [showSessionList, setShowSessionList] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [, setExpandedAgent] = useState<AgentType | null>(null);
  const [compactActivity, setCompactActivity] = useState(false); // Auto-compacts when agent runs
  
  const [settingsFocusSection, setSettingsFocusSection] = useState<SettingsFocusSection | undefined>(undefined);
  const openApiSettings = () => {
    setSettingsFocusSection(undefined);
    setShowSettings(true);
  };
  const openSettingsToSection = (section: SettingsFocusSection) => {
    setSettingsFocusSection(section);
    setShowSettings(true);
  };
  const openObsidianSetup = () => setShowObsidianSetup(true);
  const openFilesSetup = useCallback(() => setShowFilesSetup(true), []);
  const openChatAgentCreate = () => setShowChatAgentCreate(true);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [whatsappConfirmBusyFor, setWhatsappConfirmBusyFor] = useState<string | null>(null);
  const [telegramConfirmBusyFor, setTelegramConfirmBusyFor] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<
    Partial<Record<Provider, { configured: boolean; lastUpdated?: string }>>
  >({});
  const teamMemberHandleSet = useMemo(() => {
    return new Set(teamMembers.map((m) => m.handle.toLowerCase()));
  }, [teamMembers]);
  const teamMemberByHandle = useMemo(() => {
    const m = new Map<string, TeamMember>();
    for (const tm of teamMembers) m.set(tm.handle.toLowerCase(), tm);
    return m;
  }, [teamMembers]);
  const RESERVED_AGENT_HANDLES = useMemo(() => {
    // Avoid collisions with agent routing tags.
    return new Set(["chat", "ai", "files", "browser", "obsidian", "data", "schedule", "code"]);
  }, []);

  const parseTeamMentions = useCallback(
    (message: string) => {
      const matches: string[] = [];
      const regex = /@([a-z0-9_]{1,50})/gi;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(message)) !== null) {
        const handle = m[1]?.toLowerCase();
        const idx = m.index;
        const prev = idx > 0 ? message[idx - 1] : "";
        // Skip emails / word-embedded @ (e.g. "foo@bar.com")
        if (idx > 0 && /[A-Za-z0-9_.%+-]/.test(prev)) continue;
        if (handle && !RESERVED_AGENT_HANDLES.has(handle) && teamMemberHandleSet.has(handle)) {
          matches.push(handle);
        }
      }
      return Array.from(new Set(matches));
    },
    [RESERVED_AGENT_HANDLES, teamMemberHandleSet]
  );
  const myTeamMember = useMemo(() => {
    if (!_userId) return null;
    return teamMembers.find((m) => m.id === _userId) || null;
  }, [_userId, teamMembers]);

  const buildTeamMembers = useCallback((members: Array<{ user_id: string; email?: string | null }>) => {
    const handleCounts = new Map<string, number>();
    const result: TeamMember[] = [];
    for (const member of members) {
      const email = member.email || "";
      const base =
        email.split("@")[0]?.trim() ||
        `user_${member.user_id.slice(0, 6)}`;
      let handle = base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      if (!handle) handle = `user_${member.user_id.slice(0, 6)}`;
      const count = (handleCounts.get(handle) || 0) + 1;
      handleCounts.set(handle, count);
      if (count > 1) {
        handle = `${handle}_${count}`;
      }
      result.push({
        id: member.user_id,
        handle,
        label: base,
        description: email || `User ${member.user_id.slice(0, 6)}`,
      });
    }
    return result;
  }, []);
  const [llmKeyMode, setLlmKeyMode] = useState<"groovy" | "user">("groovy");
  const [llmKeyModes, setLlmKeyModes] = useState<KeyModes>({});
  const hasAnyUserKeys = Object.values(apiKeys).some((k) => k?.configured);
  const [autoRunTeamRequests, setAutoRunTeamRequests] = useState(false);
  const [pendingTeamRequests, setPendingTeamRequests] = useState<WorkspaceOrchestratorRequestRow[]>([]);
  const [teamRequestToRun, setTeamRequestToRun] = useState<WorkspaceOrchestratorRequestRow | null>(null);
  const teamRequestsClientIdRef = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (crypto as any).randomUUID()
      : `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const isRunningTeamRequestRef = useRef(false);
  const persistAutoRunTeamRequests = useCallback(async (next: boolean) => {
    setAutoRunTeamRequests(next);
    await fetch("/api/user-preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingData: { autoRunTeamRequests: next } }),
    }).catch(() => {});
  }, []);

  // Data integrations state
  const [dataConnections, setDataConnections] = useState<DataConnection[]>([]);
  const [webPixels, setWebPixels] = useState<WebPixel[]>([]);
  const [datagranScriptLoaded, setDatagranScriptLoaded] = useState(false);

  // Files agents state (can have multiple)
  const [filesAgents, setFilesAgents] = useState<FilesAgentInfo[]>([]);
  // Claude Code sessions (named terminals)
  const [codeAgents, setCodeAgents] = useState<CodeAgentInfo[]>([]);
  const [showCodeSessions, setShowCodeSessions] = useState(false);
  const [showPlansBrowser, setShowPlansBrowser] = useState(false);
  const [activeCodeAgentId, setActiveCodeAgentId] = useState<string | null>(null);
  const activeCodeAgent = useMemo(() => codeAgents.find(a => a.id === activeCodeAgentId) ?? null, [codeAgents, activeCodeAgentId]);
  const [pendingCodePrompt, setPendingCodePrompt] = useState<PendingCodePrompt | null>(null);
  const [mainPane, setMainPane] = useState<"chat" | "code">("chat");
  const lastCodeAgentStorageKey = "groovy:code:lastAgentId";
  const sharedSessionIdsRef = useRef<Set<string>>(new Set());

  // AI Chat agents state
  type ChatAgentInfo = { id: string; name: string; provider?: string; model?: string };
  const [chatAgents, setChatAgents] = useState<ChatAgentInfo[]>([]);
  const [activeChatAgentId, setActiveChatAgentId] = useState<string | null>(null);
  const [showChatPanel, setShowChatPanel] = useState(false);
  const lastChatAgentStorageKey = "groovy:chat:lastAgentId";

  // AI Chat sessions for the currently active AI Chat agent
  type ChatSessionInfo = { id: string; title: string; updated_at?: string; created_at?: string };
  const [chatSessions, setChatSessions] = useState<ChatSessionInfo[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);

  // Files agent sessions
  type FilesSessionInfo = { id: string; title: string };
  const [activeFilesAgentId, setActiveFilesAgentId] = useState<string | null>(null);
  const [filesSessions, setFilesSessions] = useState<FilesSessionInfo[]>([]);
  const [activeFilesSessionId, setActiveFilesSessionId] = useState<string | null>(null);
  const lastFilesAgentStorageKey = "groovy:files:lastAgentId";

  // Mobile state
  const [isMobile, setIsMobile] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");

  // Detect mobile screen
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Allow deep-linking directly into Claude Code pane (used by dashboard-v2 redirect on ui-open-code)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash === "#code") {
      setMainPane("code");
    }
  }, []);

  // Sync mobile tab with main pane
  useEffect(() => {
    if (mobileTab === "chat") setMainPane("chat");
    if (mobileTab === "code") setMainPane("code");
  }, [mobileTab]);

  // Relay connection for connector (defined early for connector callback)
  const relay = useRelay();
  const isConnected = relay.status === "ready";
  const relayStatusRef = useRef(relay.status);
  
  // Track local connector status
  const [localConnectorOnline, setLocalConnectorOnline] = useState(false);
  const localConnectorOnlineRef = useRef(false);
  const [, setConnectorLastSeen] = useState<Date | null>(null);
  const [connectorVersion, setConnectorVersion] = useState<string | null>(null);
  const [claudeCliInstalled, setClaudeCliInstalled] = useState<boolean | null>(null);
  const [connectorWhatsAppHealth, setConnectorWhatsAppHealth] =
    useState<ConnectorWhatsAppHealth | null>(null);
  const [connectorAiyraVoiceHealth, setConnectorAiyraVoiceHealth] =
    useState<ConnectorAiyraVoiceHealth | null>(null);
  const [twilioConversationThreads, setTwilioConversationThreads] = useState<
    Record<string, TwilioConversationEntry[]>
  >({});
  const twilioSummaryPersistedKeysRef = useRef<Set<string>>(new Set());
  const [aiyraVoiceMutePending, setAiyraVoiceMutePending] = useState(false);
  const [aiyraVoiceMutedOverride, setAiyraVoiceMutedOverride] = useState<boolean | null>(null);
  const [voiceWakePulseActive, setVoiceWakePulseActive] = useState(false);
  const voiceWakePulseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousVoiceSignalRef = useRef<{
    wakeHits: number;
    sessionCount: number;
    lastMetricAt: string;
    active: boolean;
  }>({
    wakeHits: 0,
    sessionCount: 0,
    lastMetricAt: "",
    active: false,
  });
  const [aiyraAudioDeviceDebugLog, setAiyraAudioDeviceDebugLog] = useState<string[]>([]);
  const [aiyraConfig, setAiyraConfig] = useState<AiyraConfigSnapshot>({
    configured: false,
    enabled: false,
    personaPrompt: "",
    voiceId: "",
    ttsSpeed: DEFAULT_AIYRA_TTS_SPEED,
    wakeWord: "hey groovy",
    wakeSensitivity: 0.5,
    idleTimeoutMs: 12000,
    twilioEnabled: false,
    twilioFrom: "",
    twilioTo: "",
    updatedAt: null,
  });
  const [showConnectorMenu, setShowConnectorMenu] = useState(false);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const activeDeviceIdRef = useRef<string | null>(null);
  const connectorModeTargetDeviceIdRef = useRef<string | null>(null);
  const [preferredConnectorDeviceId, setPreferredConnectorDeviceId] = useState<string | null>(null);
  const onlineDevicesRef = useRef<Map<string, OnlineDeviceInfo>>(
    new Map()
  );
  const lastAutoRestartForWhatsAppRef = useRef(0);
  const [prefersHostedConnector, setPrefersHostedConnector] = useState(false);
  const [hostedPreferredDeviceId, setHostedPreferredDeviceId] = useState<string | null>(null);

  // Obsidian vault discovery (auto-config)
  const [obsidianVaults, setObsidianVaults] = useState<ObsidianVault[]>([]);
  const [obsidianVaultPath, setObsidianVaultPath] = useState<string | undefined>(undefined);
  const lastVaultStorageKey = "groovy:obsidian:lastVaultPath";
  const siteBuilderStorageBaseKey = "groovy:pages:siteBuilderPanel:v2";
  const didHydrateSiteBuilderRef = useRef(false);
  const didRecoverSiteBuilderFallbackRef = useRef(false);
  const siteBuilderStatusSyncKeyRef = useRef<string | null>(null);
  const didDiscoverVaultsRef = useRef(false);
  const [connectorMenuPos, setConnectorMenuPos] = useState<{ top: number; left: number } | null>(null);
  const connectorButtonRef = useRef<HTMLButtonElement | null>(null);
  const [connectorCapabilities, setConnectorCapabilities] = useState<{
    browser?: { ok: boolean; error?: string };
    files?: { ok: boolean; error?: string };
    obsidian?: { ok: boolean; error?: string };
    testing?: boolean;
  }>({});
  
  // Pairing code state
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingCopied, setPairingCopied] = useState(false);
  
  // Generate pairing code
  const generatePairingCode = useCallback(async () => {
    setPairingLoading(true);
    try {
      const rebindCandidateDeviceId = activeDeviceId || preferredConnectorDeviceId || null;
      const activeLooksHosted =
        !!rebindCandidateDeviceId &&
        !!hostedPreferredDeviceId &&
        rebindCandidateDeviceId === hostedPreferredDeviceId;
      const rebindFromDeviceId =
        !localConnectorOnline && !activeLooksHosted && rebindCandidateDeviceId
          ? rebindCandidateDeviceId
          : null;
      const res = await fetch("/api/devices/pairing-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          rebindFromDeviceId ? { rebindFromDeviceId } : {}
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to generate code");
      setPairingCode(String(json.code || ""));
    } catch (err) {
      console.error("Failed to generate pairing code:", err);
    } finally {
      setPairingLoading(false);
    }
  }, [activeDeviceId, hostedPreferredDeviceId, localConnectorOnline, preferredConnectorDeviceId]);
  
  // Minimum required connector version (update this when connector features change)
  // Bump this when connector protocol/lifecycle expectations change.
  const MIN_CONNECTOR_VERSION = "0.22.77";
  const connectorGuide = useConnectorInstallGuide();
  
  // Version comparison helper
  const isVersionOutdated = useCallback((version: string | null, minVersion: string) => {
    if (!version) return true;
    const v = version.split(".").map(Number);
    const min = minVersion.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((v[i] || 0) < (min[i] || 0)) return true;
      if ((v[i] || 0) > (min[i] || 0)) return false;
    }
    return false;
  }, []);

  // Tool execution still requires a ready relay, but the UI should not flash
  // offline while a known-online connector is being rechecked after focus/router changes.
  const connectorOk = isConnected && localConnectorOnline;
  const connectorChecking = relay.isChecking || relay.status === "connecting";
  const connectorVisibleOnline = localConnectorOnline && (isConnected || connectorChecking);
  const connectorWhatsAppStatus = connectorWhatsAppHealth?.status || "unknown";
  const connectorHasWhatsAppIssue =
    connectorVisibleOnline &&
    (connectorWhatsAppStatus === "degraded" ||
      connectorWhatsAppStatus === "recovering");
  const activeConnectorIsHosted =
    !!activeDeviceId &&
    !!hostedPreferredDeviceId &&
    activeDeviceId === hostedPreferredDeviceId;
  const canHostedSelfUpdate = activeConnectorIsHosted;

  // Debug logging for connector status
  useEffect(() => {
    console.log("[Dashboard] Connector status changed:", {
      relayStatus: relay.status,
      isConnected,
      localConnectorOnline,
      activeDeviceId,
      connectorOk,
      connectorWhatsAppStatus,
    });
  }, [
    relay.status,
    isConnected,
    localConnectorOnline,
    activeDeviceId,
    connectorOk,
    connectorWhatsAppStatus,
  ]);

  const updateConnectorMenuPos = useCallback(() => {
    const btn = connectorButtonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setConnectorMenuPos({
      top: Math.round(rect.bottom + 8),
      left: Math.round(rect.left),
    });
  }, []);

  useEffect(() => {
    activeDeviceIdRef.current = activeDeviceId;
  }, [activeDeviceId]);

  const persistPreferredConnectorDeviceId = useCallback(async (deviceId: string | null) => {
    setPreferredConnectorDeviceId(deviceId);
    await fetch("/api/user-preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingData: { connectorDeviceId: deviceId } }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    relayStatusRef.current = relay.status;
  }, [relay.status]);

  const triggerVoicePulse = useCallback(() => {
    setVoiceWakePulseActive(true);
    if (voiceWakePulseTimeoutRef.current) {
      clearTimeout(voiceWakePulseTimeoutRef.current);
    }
    voiceWakePulseTimeoutRef.current = setTimeout(() => {
      setVoiceWakePulseActive(false);
    }, 5000);
  }, []);

  useEffect(() => {
    const health = connectorAiyraVoiceHealth;
    if (!health) return;
    const wakeHits = Number(health.wake_hits || 0);
    const sessionCount = Number(health.session_count || 0);
    const metricEvent = String(health.last_metric_event || "")
      .trim()
      .toLowerCase();
    const metricAt = String(health.last_metric_at || "");
    const active = health.active === true;
    const prev = previousVoiceSignalRef.current;
    const metricTriggersPulse =
      metricAt &&
      metricAt !== prev.lastMetricAt &&
      AIYRA_RECENT_UI_ACTIVITY_EVENTS.includes(
        metricEvent as (typeof AIYRA_RECENT_UI_ACTIVITY_EVENTS)[number]
      );
    const shouldPulse =
      wakeHits > prev.wakeHits ||
      sessionCount > prev.sessionCount ||
      metricTriggersPulse ||
      (active && !prev.active);

    previousVoiceSignalRef.current = {
      wakeHits,
      sessionCount,
      lastMetricAt: metricAt,
      active,
    };

    if (!shouldPulse) return;
    triggerVoicePulse();
  }, [
    connectorAiyraVoiceHealth,
    connectorAiyraVoiceHealth?.wake_hits,
    connectorAiyraVoiceHealth?.session_count,
    connectorAiyraVoiceHealth?.last_metric_event,
    connectorAiyraVoiceHealth?.last_metric_at,
    connectorAiyraVoiceHealth?.active,
    triggerVoicePulse,
  ]);

  useEffect(() => {
    const health = connectorAiyraVoiceHealth;
    const metricEvent = String(health?.last_metric_event || "")
      .trim()
      .toLowerCase();
    if (
      !health ||
      metricEvent === "voice_session_ended" ||
      health.listening === true ||
      health.status === "disabled"
    ) {
      setAiyraVoiceMutedOverride(null);
    }
  }, [
    connectorAiyraVoiceHealth,
    connectorAiyraVoiceHealth?.last_metric_event,
    connectorAiyraVoiceHealth?.listening,
    connectorAiyraVoiceHealth?.status,
  ]);

  useEffect(() => {
    return () => {
      if (voiceWakePulseTimeoutRef.current) {
        clearTimeout(voiceWakePulseTimeoutRef.current);
      }
    };
  }, []);

  // If the relay socket is truly gone, we may never receive a `device_offline` event.
  // Do not clear during normal reconnect/check cycles; that causes the whole UI to flash offline.
  useEffect(() => {
    if (relay.status === "ready") return;
    if (relay.isChecking || relay.status === "connecting") return;

    const timeoutId = window.setTimeout(() => {
      if (relayStatusRef.current === "ready") return;
      onlineDevicesRef.current.clear();
      setLocalConnectorOnline(false);
      setConnectorVersion(null);
      setConnectorWhatsAppHealth(null);
      setConnectorAiyraVoiceHealth(null);
      setActiveDeviceId(null);
    }, 8_000);

    return () => window.clearTimeout(timeoutId);
  }, [relay.isChecking, relay.status]);

  useEffect(() => {
    localConnectorOnlineRef.current = localConnectorOnline;
  }, [localConnectorOnline]);

  const toggleConnectorMenu = useCallback(() => {
    setShowConnectorMenu((prev) => {
      const next = !prev;
      if (next) requestAnimationFrame(updateConnectorMenuPos);
      return next;
    });
  }, [updateConnectorMenuPos]);

  const openConnectorMenu = useCallback(() => {
    setShowConnectorMenu(true);
    requestAnimationFrame(updateConnectorMenuPos);
  }, [updateConnectorMenuPos]);

  const ensureActiveDeviceIdReady = useCallback(async () => {
    // Avoid sending @obsidian/@browser/@files requests without device_id; that hides connector tools
    // and causes the model to fall back to "connector isn't running" text.
    // After refresh/HMR, relay + device_online can lag. Poll refs for a short window.
    for (let i = 0; i < 20; i++) {
      if (activeDeviceIdRef.current) return activeDeviceIdRef.current;
      const rs = relayStatusRef.current as unknown as string;
      if (rs === "error") return null;
      // If connector is offline, don't wait the full duration.
      if (!localConnectorOnlineRef.current) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return activeDeviceIdRef.current;
  }, []);

  const resolveAiyraConnectorDeviceId = useCallback(async () => {
    const active =
      activeDeviceIdRef.current || activeDeviceId || (await ensureActiveDeviceIdReady());
    const onlineEntries = Array.from(onlineDevicesRef.current.entries());
    if (onlineEntries.length === 0) return active;

    // Prefer a local connector that is reporting Aiyra health (strong signal it supports voice RPCs).
    const localWithAiyraHealth = onlineEntries.find(
      ([id, info]) =>
        (!hostedPreferredDeviceId || id !== hostedPreferredDeviceId) &&
        !!info?.health?.aiyra_voice
    );
    if (localWithAiyraHealth?.[0]) return localWithAiyraHealth[0];

    // Aiyra voice (mic input/wake-word) must prefer a local connector when available.
    if (hostedPreferredDeviceId) {
      const localDeviceId = onlineEntries.find(
        ([id]) => id !== hostedPreferredDeviceId
      )?.[0];
      if (localDeviceId) return localDeviceId;
    }

    if (active && onlineDevicesRef.current.has(active)) return active;
    return onlineEntries[0]?.[0] || null;
  }, [activeDeviceId, ensureActiveDeviceIdReady, hostedPreferredDeviceId]);

  const pickDesiredActiveDeviceId = useCallback(
    (currentActiveId: string | null): string | null => {
      const onlineIds = Array.from(onlineDevicesRef.current.keys()).sort();
      if (onlineIds.length === 0) return null;

      if (prefersHostedConnector) {
        // Hosted mode: stick to the hosted connector when available.
        if (
          hostedPreferredDeviceId &&
          onlineDevicesRef.current.has(hostedPreferredDeviceId)
        ) {
          return hostedPreferredDeviceId;
        }

        // Fallback to persisted selection if hosted isn't available.
        if (
          preferredConnectorDeviceId &&
          onlineDevicesRef.current.has(preferredConnectorDeviceId)
        ) {
          return preferredConnectorDeviceId;
        }

        // Keep existing active device when still online.
        if (currentActiveId && onlineDevicesRef.current.has(currentActiveId)) {
          return currentActiveId;
        }

        return onlineIds[0] || null;
      }

      // Local mode: respect persisted selection when it's a non-hosted device.
      if (
        preferredConnectorDeviceId &&
        onlineDevicesRef.current.has(preferredConnectorDeviceId) &&
        (!hostedPreferredDeviceId || preferredConnectorDeviceId !== hostedPreferredDeviceId)
      ) {
        return preferredConnectorDeviceId;
      }

      // Local mode: avoid auto-selecting hosted when a local device is online.
      if (hostedPreferredDeviceId) {
        const nonHosted = onlineIds.find((id) => id !== hostedPreferredDeviceId);
        if (nonHosted) return nonHosted;
      }

      // Keep existing active device when still online.
      if (currentActiveId && onlineDevicesRef.current.has(currentActiveId)) {
        return currentActiveId;
      }

      return onlineIds[0] || null;
    },
    [preferredConnectorDeviceId, prefersHostedConnector, hostedPreferredDeviceId]
  );

  const pickVisibleAiyraVoiceHealth = useCallback(
    (desiredDeviceId: string | null): ConnectorAiyraVoiceHealth | null => {
      const desiredHealth = desiredDeviceId
        ? onlineDevicesRef.current.get(desiredDeviceId)?.health?.aiyra_voice || null
        : null;
      let best = desiredHealth;
      let bestScore = scoreAiyraVoiceHealth(desiredHealth);
      for (const info of onlineDevicesRef.current.values()) {
        const health = info?.health?.aiyra_voice || null;
        if (!health) continue;
        const score = scoreAiyraVoiceHealth(health);
        if (score > bestScore) {
          best = health;
          bestScore = score;
        }
      }
      return best || null;
    },
    []
  );

  const refreshPersistedAiyraVoiceHealth = useCallback(async () => {
    if (!_userId) return;

    const { data, error } = await supabase
      .from("connector_aiyra_voice_health")
      .select(
        [
          "device_id",
          "status",
          "reason",
          "detail",
          "updated_at",
          "last_healthy_at",
          "last_failure_at",
          "listening",
          "active",
          "muted",
          "wake_word",
          "wake_sensitivity",
          "idle_timeout_ms",
          "wake_hits",
          "wake_suppressed",
          "missed_reports",
          "false_trigger_reports",
          "session_count",
          "session_error_count",
          "reconnect_attempt_count",
          "last_session_duration_ms",
          "last_metric_event",
          "last_metric_at",
          "low_mic_gain_detected",
          "low_mic_gain_at",
          "low_mic_gain_message",
          "low_mic_gain_max_energy_observed",
          "low_mic_gain_threshold",
          "configured_mic_name",
          "resolved_device_name",
          "mic_selection_fallback_reason",
          "mic_input_level",
          "mic_input_updated_at",
          "conversation_id",
          "orchestrator_session_id",
          "twilio_supervisor_state",
        ].join(",")
      )
      .eq("user_id", _userId)
      .order("updated_at", { ascending: false })
      .limit(12);

    if (error || !Array.isArray(data) || data.length === 0) return;
    const rows = data as unknown as Record<string, unknown>[];

    const normalizePersistedRow = (row: Record<string, unknown>): ConnectorAiyraVoiceHealth | null =>
      normalizeConnectorHealth({ aiyra_voice: row })?.aiyra_voice || null;

    const desiredRow = activeDeviceId
      ? rows.find(
          (row) =>
            typeof row?.device_id === "string" && String(row.device_id) === activeDeviceId
        ) || null
      : null;

    let bestHealth = desiredRow
      ? normalizePersistedRow(desiredRow as Record<string, unknown>)
      : null;
    let bestScore = scoreAiyraVoiceHealth(bestHealth);

    for (const row of rows) {
      const health = normalizePersistedRow(row);
      const score = scoreAiyraVoiceHealth(health);
      if (score > bestScore) {
        bestHealth = health;
        bestScore = score;
      }
    }

    if (!bestHealth) return;

    setConnectorAiyraVoiceHealth((prev) => {
      const prevScore = scoreAiyraVoiceHealth(prev);
      const prevUpdatedAtMs = prev?.updated_at ? Date.parse(prev.updated_at) : NaN;
      const nextUpdatedAtMs = bestHealth?.updated_at ? Date.parse(bestHealth.updated_at) : NaN;

      if (prevScore > bestScore) return prev;
      if (
        prevScore === bestScore &&
        Number.isFinite(prevUpdatedAtMs) &&
        Number.isFinite(nextUpdatedAtMs) &&
        prevUpdatedAtMs >= nextUpdatedAtMs
      ) {
        return prev;
      }
      return mergeAiyraVoiceHealth(prev, bestHealth);
    });
  }, [_userId, activeDeviceId, supabase]);

  useEffect(() => {
    if (!showSettings || !_userId) return;
    void refreshPersistedAiyraVoiceHealth();
    const timer = window.setInterval(() => {
      void refreshPersistedAiyraVoiceHealth();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [_userId, showSettings, refreshPersistedAiyraVoiceHealth]);

  useEffect(() => {
    if (!showConnectorMenu) return;
    updateConnectorMenuPos();
    const onMove = () => updateConnectorMenuPos();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [showConnectorMenu, updateConnectorMenuPos]);

  // Create connector execute callback for browser/files/obsidian tools
  const pendingConnectorRequests = useRef<Map<string, {
    resolve: (result: { ok: boolean; error?: string; [key: string]: unknown }) => void;
    timeout: NodeJS.Timeout;
    requestType: string;
    deviceId: string;
  }>>(new Map());
  const relaySubscribe = relay.subscribe;
  const relaySend = relay.send;

  const failPendingConnectorRequestsForDevice = useCallback(
    (deviceId: string, errorText: string) => {
      if (!deviceId) return;
      const pendingMap = pendingConnectorRequests.current;
      for (const [requestId, pending] of Array.from(pendingMap.entries())) {
        if (pending.deviceId !== deviceId) continue;
        clearTimeout(pending.timeout);
        try {
          pending.resolve({ ok: false, error: errorText });
        } catch {
          // no-op
        }
        pendingMap.delete(requestId);
      }
    },
    []
  );

  const CONNECTOR_DEFAULT_TIMEOUT_MS = 30_000;
  const CONNECTOR_CREDENTIAL_TIMEOUT_MS = 120_000;
  const CONNECTOR_BROWSER_TASK_TIMEOUT_MS = 9 * 60 * 1000;
  const CONNECTOR_TERMINAL_TIMEOUT_MS = 10 * 60 * 1000;
  const CONNECTOR_CLAUDE_RUN_TIMEOUT_MS = 15 * 60 * 1000;
  const CONNECTOR_SITE_DEV_START_TIMEOUT_MS = 210_000;
  const CONNECTOR_SITE_DEPLOY_TIMEOUT_MS = 240_000;
  const getConnectorTimeoutMs = useCallback((type: string, payload?: Record<string, unknown>) => {
    // Credential prompts require human input; allow 2 minutes.
    if (type === "browser_credential_request") return CONNECTOR_CREDENTIAL_TIMEOUT_MS;
    // Browser task runs can legitimately take several minutes (Playwright + Claude loop).
    if (type === "browser_task_run") return CONNECTOR_BROWSER_TASK_TIMEOUT_MS;
    // Terminal commands (e.g., create-next-app, npm install) frequently exceed 30s.
    if (type === "terminal_exec") {
      const requested = Number(payload?.timeout_ms);
      if (Number.isFinite(requested) && requested > 0) {
        // Give a small buffer over connector-side timeout to account for relay latency.
        return Math.min(Math.max(CONNECTOR_DEFAULT_TIMEOUT_MS, requested + 10_000), 15 * 60 * 1000);
      }
      return CONNECTOR_TERMINAL_TIMEOUT_MS;
    }
    // Interactive Claude PTY steps often pause while Claude thinks, so they need
    // the same long timeout treatment as other terminal-style operations.
    if (type === "terminal_step") {
      const requested = Number(payload?.max_wait_ms);
      if (Number.isFinite(requested) && requested > 0) {
        return Math.min(Math.max(CONNECTOR_DEFAULT_TIMEOUT_MS, requested + 10_000), 15 * 60 * 1000);
      }
      return CONNECTOR_TERMINAL_TIMEOUT_MS;
    }
    // Headless Claude runs are long-running by design.
    if (type === "claude_run") {
      const requested = Number(payload?.timeout_ms);
      if (Number.isFinite(requested) && requested > 0) {
        return Math.min(Math.max(CONNECTOR_DEFAULT_TIMEOUT_MS, requested + 10_000), 20 * 60 * 1000);
      }
      return CONNECTOR_CLAUDE_RUN_TIMEOUT_MS;
    }
    // site_dev_start can include dependency installs + readiness checks.
    if (type === "site_dev_start") return CONNECTOR_SITE_DEV_START_TIMEOUT_MS;
    return CONNECTOR_DEFAULT_TIMEOUT_MS;
  }, [
    CONNECTOR_BROWSER_TASK_TIMEOUT_MS,
    CONNECTOR_CREDENTIAL_TIMEOUT_MS,
    CONNECTOR_DEFAULT_TIMEOUT_MS,
    CONNECTOR_CLAUDE_RUN_TIMEOUT_MS,
    CONNECTOR_SITE_DEV_START_TIMEOUT_MS,
    CONNECTOR_TERMINAL_TIMEOUT_MS,
  ]);

  // Subscribe to connector responses
  useEffect(() => {
    if (!relaySubscribe) return;
    
    const unsub = relaySubscribe((msg) => {
      const msgType = (msg as { type?: string }).type;
      const requestId = (msg as { request_id?: string }).request_id;
      console.log("[Dashboard] Relay message received:", msgType, requestId ? `req=${requestId}` : "");
      
      // Track local connector status
      if (msgType === "device_online") {
        const deviceId = String((msg as { device_id?: string }).device_id || "");
        const version = String((msg as { version?: string }).version || "0.0.0");
        const capabilities = (msg as { capabilities?: { claudeCliInstalled?: boolean } }).capabilities;
        const health = normalizeConnectorHealth(
          (msg as { health?: unknown }).health
        );
        if (deviceId) {
          const prevInfo = onlineDevicesRef.current.get(deviceId) || null;
          onlineDevicesRef.current.set(deviceId, {
            deviceId,
            version,
            claudeCliInstalled: capabilities?.claudeCliInstalled ?? prevInfo?.claudeCliInstalled,
            health: mergeConnectorHealthSnapshot(prevInfo?.health ?? null, health),
          });
        }

        const desired = pickDesiredActiveDeviceId(activeDeviceIdRef.current);

        setConnectorLastSeen(new Date());
        setActiveDeviceId(desired);
        setLocalConnectorOnline(!!desired);
        const desiredDeviceInfo = desired ? onlineDevicesRef.current.get(desired) : null;
        setConnectorVersion(desiredDeviceInfo?.version || null);
        setClaudeCliInstalled(desiredDeviceInfo?.claudeCliInstalled ?? null);
        setConnectorWhatsAppHealth(desiredDeviceInfo?.health?.whatsapp || null);
        setConnectorAiyraVoiceHealth(pickVisibleAiyraVoiceHealth(desired));
      } else if (msgType === "device_offline") {
        const deviceId = String((msg as { device_id?: string }).device_id || "");
        if (deviceId) {
          onlineDevicesRef.current.delete(deviceId);
          failPendingConnectorRequestsForDevice(
            deviceId,
            "Connector went offline while request was running."
          );
        }

        const desired = pickDesiredActiveDeviceId(activeDeviceIdRef.current);

        setActiveDeviceId(desired);
        setLocalConnectorOnline(!!desired);
        const desiredDeviceInfo = desired ? onlineDevicesRef.current.get(desired) : null;
        setConnectorVersion(desiredDeviceInfo?.version || null);
        setClaudeCliInstalled(desiredDeviceInfo?.claudeCliInstalled ?? null);
        setConnectorWhatsAppHealth(desiredDeviceInfo?.health?.whatsapp || null);
        setConnectorAiyraVoiceHealth(pickVisibleAiyraVoiceHealth(desired));
      } else if (msgType === "schedule_run_report") {
        // Job finished running - remove from running set
        const jobId = String((msg as { job_id?: string }).job_id || "");
        if (jobId) {
          setRunningScheduledJobs((prev) => {
            const next = new Set(prev);
            next.delete(jobId);
            return next;
          });
        }
      } else if (msgType === "schedule_trigger_result") {
        const ok = (msg as { ok?: boolean }).ok !== false;
        const jobId = String((msg as { job_id?: string }).job_id || "");
        const err = (msg as { error?: unknown }).error;
        const error = typeof err === "string" ? err : ok ? null : "unknown_error";

        console.log("[Dashboard] schedule_trigger_result:", { ok, jobId, error, requestId });

        // If trigger failed, clear the running badge immediately.
        if (!ok && jobId) {
          setRunningScheduledJobs((prev) => {
            const next = new Set(prev);
            next.delete(jobId);
            return next;
          });
        }
      }
      
      if (requestId && pendingConnectorRequests.current.has(requestId)) {
        // Streaming updates (e.g. claude_run_progress) should not resolve the
        // pending request; wait for the terminal result event.
        if (msgType === "claude_run_progress") {
          return;
        }
        const pending = pendingConnectorRequests.current.get(requestId)!;
        clearTimeout(pending.timeout);
        pendingConnectorRequests.current.delete(requestId);
        const hasScreenshot = !!(msg as { screenshot?: string }).screenshot;
        const scrollY = (msg as { scrollY?: number }).scrollY;
        console.log("[Dashboard] Resolving pending request:", requestId, "ok:", (msg as { ok?: boolean }).ok, "hasScreenshot:", hasScreenshot, "screenshotLen:", hasScreenshot ? ((msg as { screenshot?: string }).screenshot?.length || 0) : 0, "scrollY:", scrollY);
        pending.resolve(msg as unknown as { ok: boolean; error?: string; [key: string]: unknown });
      }
    });
    
    return unsub;
  }, [relaySubscribe, pickDesiredActiveDeviceId, pickVisibleAiyraVoiceHealth, failPendingConnectorRequestsForDevice]);

  // Re-evaluate active connector after preference/device-id changes.
  useEffect(() => {
    const desired = pickDesiredActiveDeviceId(activeDeviceIdRef.current);
    setActiveDeviceId(desired);
    setLocalConnectorOnline(!!desired);
    const desiredDeviceInfo = desired ? onlineDevicesRef.current.get(desired) : null;
    setConnectorVersion(desiredDeviceInfo?.version || null);
    setClaudeCliInstalled(desiredDeviceInfo?.claudeCliInstalled ?? null);
    setConnectorWhatsAppHealth(desiredDeviceInfo?.health?.whatsapp || null);
    setConnectorAiyraVoiceHealth(pickVisibleAiyraVoiceHealth(desired));
  }, [pickDesiredActiveDeviceId, pickVisibleAiyraVoiceHealth]);

  // Backfill preference once when none exists yet.
  useEffect(() => {
    if (!connectorPrefsLoaded) return;
    if (prefersHostedConnector) return;
    if (preferredConnectorDeviceId) return;
    if (!activeDeviceId) return;
    const onlineIds = Array.from(onlineDevicesRef.current.keys());
    if (onlineIds.length === 0) return;
    const localCandidates = hostedPreferredDeviceId
      ? onlineIds.filter((id) => id !== hostedPreferredDeviceId)
      : onlineIds;
    if (localCandidates.length !== 1) return;
    void persistPreferredConnectorDeviceId(localCandidates[0] || null);
  }, [
    connectorPrefsLoaded,
    prefersHostedConnector,
    preferredConnectorDeviceId,
    activeDeviceId,
    hostedPreferredDeviceId,
    persistPreferredConnectorDeviceId,
  ]);

  const cancelPendingConnectorRequests = useCallback(
    (origin: "user" | "unmount") => {
      const pendingMap = pendingConnectorRequests.current;
      for (const [requestId, pending] of pendingMap.entries()) {
        if (origin === "user" && !requestId.startsWith("req-")) {
          continue;
        }
        clearTimeout(pending.timeout);
        if (pending.requestType === "browser_task_run" && pending.deviceId) {
          try {
            relaySend({
              type: "browser_task_cancel",
              request_id: `cancel-${origin}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              device_id: pending.deviceId,
              target_request_id: requestId,
            });
          } catch {
            // ignore best-effort cleanup failures
          }
        }
        try {
          pending.resolve({ ok: false, error: "cancelled" });
        } catch {
          // no-op
        }
        pendingMap.delete(requestId);
      }
    },
    [relaySend]
  );

  // Best-effort cleanup: if the dashboard tab reloads/closes mid browser_task_run,
  // ask connector to abort in-flight tasks so they don't keep running orphaned.
  useEffect(() => {
    return () => {
      cancelPendingConnectorRequests("unmount");
    };
  }, [cancelPendingConnectorRequests]);

  const handleConnectorExecute = useCallback(async (params: {
    type: string;
    params: Record<string, unknown>;
    toolCallId: string;
    toolName: string;
    agent: AgentType;
    sessionId?: string;
  }): Promise<{ ok: boolean; error?: string; [key: string]: unknown }> => {
    console.log("[Dashboard] handleConnectorExecute:", params.type, params.toolName, "relay.status:", relayStatusRef.current);
    
    // Use ref for current status to avoid stale closure issues
    const currentStatus = relayStatusRef.current as unknown as string;
    if (currentStatus !== "ready") {
      // Relay may briefly go through "connecting" during HMR/refresh; retry with exponential backoff
      console.warn("[Dashboard] Relay not ready, waiting...");
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 300 + i * 100)); // 300ms, 400ms, 500ms, ...
        const retryStatus = relayStatusRef.current as unknown as string;
        console.log("[Dashboard] Retry", i + 1, "relay.status:", retryStatus);
        if (retryStatus === "ready") break;
      }
      const finalStatus = relayStatusRef.current as unknown as string;
      if (finalStatus !== "ready") {
        return { ok: false, error: "Connector not connected. Start the Groovy Connector on your machine." };
      }
    }
    const resolvedDeviceId = activeDeviceIdRef.current || activeDeviceId || (await ensureActiveDeviceIdReady());
    if (!resolvedDeviceId) {
      return {
        ok: false,
        error: "No local device selected/online. Start the Groovy Connector and then click the connector pill to reconnect.",
      };
    }

    let connectorParams: Record<string, unknown> = { ...(params.params || {}) };
    if (params.type === "whatsapp_send_media") {
      const rawUrl =
        typeof connectorParams.url === "string" ? connectorParams.url.trim() : "";
      const storagePath =
        typeof connectorParams.storage_path === "string"
          ? connectorParams.storage_path.trim()
          : "";
      const explicitLocalPath =
        typeof connectorParams.local_path === "string"
          ? connectorParams.local_path.trim()
          : "";
      const fileId =
        typeof connectorParams.file_id === "string"
          ? connectorParams.file_id.trim()
          : "";
      const inferredLocalPathFromStorage = (() => {
        if (explicitLocalPath || !storagePath) return "";
        if (/^[a-z]+:\/\//i.test(storagePath)) return "";
        if (storagePath.startsWith("~/") || storagePath.startsWith("~\\")) return storagePath;
        if (storagePath.startsWith("/") || storagePath.startsWith("\\")) return storagePath;
        if (/^[a-zA-Z]:[\\/]/.test(storagePath)) return storagePath;
        return "";
      })();
      const localPath = explicitLocalPath || inferredLocalPathFromStorage;
      const inferredStoragePathFromUrl = (() => {
        if (!rawUrl) return "";
        try {
          const parsed = new URL(rawUrl);
          const markers = [
            "/storage/v1/object/sign/chat_uploads/",
            "/storage/v1/object/public/chat_uploads/",
            "/storage/v1/object/authenticated/chat_uploads/",
          ];
          for (const marker of markers) {
            const idx = parsed.pathname.indexOf(marker);
            if (idx < 0) continue;
            const raw = parsed.pathname.slice(idx + marker.length).replace(/^\/+/, "");
            return raw ? decodeURIComponent(raw) : "";
          }
          return "";
        } catch {
          return "";
        }
      })();

      if (localPath) {
        connectorParams = {
          ...connectorParams,
          local_path: localPath,
        };
      } else if (storagePath || fileId || inferredStoragePathFromUrl) {
        let usedSignedUrl = false;
        try {
          const sessionIdFromParams =
            typeof params.sessionId === "string" ? params.sessionId.trim() : "";
          const sessionIdFromPayload =
            typeof connectorParams.orchestrator_session_id === "string"
              ? String(connectorParams.orchestrator_session_id).trim()
              : "";
          const sessionIdForMedia = sessionIdFromPayload || sessionIdFromParams;
          if (!sessionIdForMedia) {
            return {
              ok: false,
              error: "No active session available to validate media send.",
            };
          }
          const signRes = await fetch("/api/orchestrator/media-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: sessionIdForMedia,
              ...((storagePath || inferredStoragePathFromUrl)
                ? { storagePath: storagePath || inferredStoragePathFromUrl }
                : {}),
              ...(fileId ? { fileId } : {}),
            }),
          });
          const signJson = (await signRes.json().catch(() => null)) as
            | { url?: unknown; filename?: unknown; error?: unknown }
            | null;
          const signedUrl =
            signJson && typeof signJson.url === "string" ? signJson.url.trim() : "";
          if (signRes.ok && signedUrl) {
            const filename =
              signJson && typeof signJson.filename === "string"
                ? signJson.filename.trim()
                : "";
            connectorParams = {
              ...connectorParams,
              url: signedUrl,
              ...(
                !(
                  typeof connectorParams.filename === "string" &&
                  connectorParams.filename.trim()
                ) && filename
                  ? { filename }
                  : {}
              ),
            };
            usedSignedUrl = true;
          } else if (signRes.status === 400 || signRes.status === 403) {
            const err =
              signJson && typeof signJson.error === "string"
                ? signJson.error
                : "Media URL was rejected for this session.";
            return { ok: false, error: err };
          } else if (!rawUrl) {
            const err =
              signJson && typeof signJson.error === "string"
                ? signJson.error
                : "Failed to resolve media URL.";
            return { ok: false, error: err };
          }
        } catch (e) {
          if (!rawUrl) {
            const err = e instanceof Error ? e.message : "Failed to resolve media URL.";
            return { ok: false, error: err };
          }
        }
        if (!usedSignedUrl && rawUrl) {
          connectorParams = { ...connectorParams, url: rawUrl };
        }
      } else if (!rawUrl) {
        return {
          ok: false,
          error: "whatsapp_send_media requires url, local_path, or storage_path/file_id.",
        };
      }
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log("[Dashboard] Sending to connector:", params.type, requestId);
    
    return new Promise((resolve) => {
      const timeoutMs = getConnectorTimeoutMs(params.type, connectorParams);
      // Set timeout
      const timeout = setTimeout(() => {
        console.error("[Dashboard] Request TIMED OUT:", requestId, params.type);
        pendingConnectorRequests.current.delete(requestId);
        if (params.type === "browser_task_run") {
          try {
            relaySend({
              type: "browser_task_cancel",
              request_id: `cancel-timeout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              device_id: resolvedDeviceId,
              target_request_id: requestId,
            });
          } catch {
            // ignore best-effort cancellation failures
          }
        }
        resolve({ ok: false, error: `Connector request timed out (${Math.round(timeoutMs / 1000)}s)` });
      }, timeoutMs);
      
      pendingConnectorRequests.current.set(requestId, {
        resolve,
        timeout,
        requestType: params.type,
        deviceId: resolvedDeviceId,
      });
      
      // Send to connector
      relaySend({
        type: params.type,
        request_id: requestId,
        device_id: resolvedDeviceId,
        ...connectorParams,
      });
    });
  }, [
    relaySend,
    activeDeviceId,
    ensureActiveDeviceIdReady,
    getConnectorTimeoutMs,
  ]);

  // Wrap handleConnectorExecute to detect site_dev_start results and open the preview panel
  const handleConnectorExecuteWithSiteDetection = useCallback(
    async (params: Parameters<typeof handleConnectorExecute>[0]) => {
      // Open Pages panel immediately when local site startup begins, so the user can
      // watch progress before a localhost port is available.
      if (params.type === "site_dev_start") {
        const requestedSlug =
          typeof params.params.slug === "string" && params.params.slug.trim()
            ? params.params.slug.trim()
            : undefined;
        setShowSiteBuilderPanel(true);
        setSiteBuilderState((prev) => ({
          ...prev,
          slug: requestedSlug || prev.slug,
          status: "starting",
          deviceId: activeDeviceId || prev.deviceId,
          errorMessage: undefined,
          startRequestedAt: Date.now(),
        }));
      }

      const result = await handleConnectorExecute(params);

      // Complete site_publish flow:
      // 1) tool returns __connector_execute__ site_read_files
      // 2) connector returns files here
      // 3) dashboard posts files to /api/sites/deploy and returns deploy result
      if (params.type === "site_read_files" && params.toolName === "site_publish") {
        if (!result.ok) return result;

        const files = Array.isArray(result.files) ? result.files : [];
        const slug =
          typeof params.params.slug === "string" && params.params.slug.trim()
            ? params.params.slug.trim()
            : "";
        const siteId =
          typeof params.params.siteId === "string" && params.params.siteId.trim()
            ? params.params.siteId.trim()
            : undefined;

        if (files.length === 0) {
          setSiteBuilderState((prev) => ({ ...prev, status: "error" }));
          return { ok: false, error: "No site files were returned from connector." };
        }

        setShowSiteBuilderPanel(true);
        setSiteBuilderState((prev) => ({
          ...prev,
          slug: slug || prev.slug,
          status: "deploying",
          errorMessage: undefined,
          startRequestedAt: Date.now(),
        }));

        try {
          const deployRes = await fetch("/api/sites/deploy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              siteId,
              slug,
              files,
            }),
          });
          const deployJson = (await deployRes.json().catch(() => null)) as
            | {
                ok?: boolean;
                url?: string;
                error?: string;
                effectiveStatus?: string;
                warning?: string;
                [key: string]: unknown;
              }
            | null;

          if (!deployJson) {
            setSiteBuilderState((prev) => ({
              ...prev,
              status: "error",
              errorMessage: "Deploy API returned invalid JSON.",
            }));
            return { ok: false, error: "Deploy API returned invalid JSON." };
          }

          if (deployJson.ok) {
            setSiteBuilderState((prev) => ({
              ...prev,
              status: "live",
              productionUrl: typeof deployJson.url === "string" ? deployJson.url : prev.productionUrl,
              errorMessage: undefined,
            }));
          } else {
            const effectiveStatus =
              typeof deployJson.effectiveStatus === "string" ? deployJson.effectiveStatus : undefined;
            const nextStatus =
              effectiveStatus === "live"
                ? "live"
                : effectiveStatus === "deploying"
                  ? "deploying"
                  : "error";
            setSiteBuilderState((prev) => ({
              ...prev,
              status: nextStatus,
              productionUrl:
                typeof deployJson.url === "string" && deployJson.url.trim()
                  ? deployJson.url.trim()
                  : prev.productionUrl,
              errorMessage:
                nextStatus !== "error"
                  ? undefined
                  : typeof deployJson.error === "string" && deployJson.error.trim()
                    ? deployJson.error
                    : "Deploy failed.",
            }));
          }

          return deployJson as { ok: boolean; error?: string; [key: string]: unknown };
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to deploy site";
          setSiteBuilderState((prev) => ({ ...prev, status: "error", errorMessage: msg }));
          return { ok: false, error: msg };
        }
      }

      // Detect site dev server started
      if (params.type === "site_dev_start" && result.ok) {
        const rawPort = (result as { port?: unknown }).port;
        const parsedPort = typeof rawPort === "number" ? rawPort : Number(rawPort);
        const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : undefined;
        const nonce = typeof result.tunnelNonce === "string" ? result.tunnelNonce : undefined;
        const slug = typeof result.slug === "string" ? result.slug : undefined;
        if (port) {
          setSiteBuilderState((prev) => ({
            ...prev,
            slug,
            devPort: port,
            tunnelNonce: nonce,
            status: "dev",
            deviceId: activeDeviceId || undefined,
            errorMessage: undefined,
            startRequestedAt: undefined,
          }));
          setShowSiteBuilderPanel(true);
        } else {
          const errText =
            typeof result.error === "string" && result.error.trim()
              ? result.error
              : "Dev server did not return a preview port.";
          setSiteBuilderState((prev) => ({
            ...prev,
            status: "error",
            errorMessage: errText,
            startRequestedAt: undefined,
          }));
        }
      } else if (params.type === "site_dev_start" && !result.ok) {
        const errText =
          typeof result.error === "string" && result.error.trim()
            ? result.error
            : "Failed to start local dev server.";
        setSiteBuilderState((prev) => ({
          ...prev,
          status: "error",
          errorMessage: errText,
          startRequestedAt: undefined,
        }));
      }

      // Detect site dev server stopped
      if (params.type === "site_dev_stop" && result.ok) {
        const stoppedSlug =
          typeof params.params.slug === "string" && params.params.slug.trim()
            ? params.params.slug.trim()
            : "";
        setSiteBuilderState((prev) => {
          if (stoppedSlug && prev.slug && prev.slug !== stoppedSlug) return prev;
          return {
            ...prev,
            devPort: undefined,
            tunnelNonce: undefined,
            status: "draft",
            errorMessage: undefined,
            startRequestedAt: undefined,
          };
        });
      }

      return result;
    },
    [handleConnectorExecute, activeDeviceId]
  );

  // Trigger a scheduled job manually via relay -> connector
  const triggerScheduledJob = useCallback((jobId: string, deviceId?: string | null) => {
    const targetDeviceId = (typeof deviceId === "string" && deviceId.trim() ? deviceId.trim() : "") || activeDeviceId;
    if (!targetDeviceId || relay.status !== "ready") {
      console.warn("[Dashboard] Cannot trigger job: no device connected");
      return;
    }
    const requestId = `trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    relay.send({
      type: "schedule_trigger",
      request_id: requestId,
      device_id: targetDeviceId,
      job_id: jobId,
    });
    // Mark job as running
    setRunningScheduledJobs((prev) => new Set(prev).add(jobId));
    console.log("[Dashboard] Triggered scheduled job:", { jobId, deviceId: targetDeviceId, requestId });
  }, [relay, activeDeviceId]);

  const refreshMobileScheduledJobs = useCallback(async () => {
    setMobileScheduledJobsLoading(true);
    setMobileScheduledJobsError(null);
    try {
      const { data, error } = await supabase
        .from("scheduled_jobs")
        .select(
          "id,name,device_id,kind,command,task,schedule,enabled,skip_next_run,last_run_at,last_status,updated_at"
        )
        .order("updated_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      const visible = ((data as MobileScheduledJob[]) || []).filter((j) => {
        const t =
          j.task && typeof j.task === "object" ? (j.task as Record<string, unknown>) : null;
        return !(t && (t.type === "heartbeat_v1" || t.ui_hidden === true));
      });
      setMobileScheduledJobs(visible);
    } catch (e) {
      setMobileScheduledJobsError(e instanceof Error ? e.message : String(e));
    } finally {
      setMobileScheduledJobsLoading(false);
    }
  }, [supabase]);

  // Mobile "More" shows scheduled jobs inline; refresh when opened.
  useEffect(() => {
    if (mobileTab !== "more") return;
    refreshMobileScheduledJobs().catch(() => {});
  }, [mobileTab, refreshMobileScheduledJobs]);

  const ensureObsidianVaultSelected = useCallback(
    async (): Promise<string | null> => {
      if (obsidianVaultPath) return obsidianVaultPath;
      if (relay.status !== "ready" || !localConnectorOnline || !activeDeviceId) {
        return null;
      }

      const result = await handleConnectorExecute({
        type: "obsidian_discover",
        params: {},
        toolCallId: `obsidian-discover-${Date.now()}`,
        toolName: "obsidian_discover",
        agent: "obsidian",
      });
      if (!result.ok) return null;

      const vaults = (result.vaults as Array<{ name: string; path: string }>) || [];
      setObsidianVaults(vaults);

      let preferred: string | undefined;
      try {
        preferred = window.localStorage.getItem(lastVaultStorageKey) || undefined;
      } catch {
        preferred = undefined;
      }

      const matched =
        (preferred && vaults.find((v) => v.path === preferred)?.path) || undefined;
      const chosen =
        matched || (vaults.length === 1 ? vaults[0].path : vaults[0]?.path);

      if (chosen) {
        setObsidianVaultPath(chosen);
        try {
          window.localStorage.setItem(lastVaultStorageKey, chosen);
        } catch {
          // ignore
        }
        return chosen;
      }

      return null;
    },
    [
      obsidianVaultPath,
      relay.status,
      localConnectorOnline,
      activeDeviceId,
      handleConnectorExecute,
      lastVaultStorageKey,
    ]
  );

  // Auto-discover Obsidian vaults when the connector is online
  useEffect(() => {
    if (didDiscoverVaultsRef.current) return;
    if (relay.status !== "ready" || !localConnectorOnline || !activeDeviceId) return;

    didDiscoverVaultsRef.current = true;
    (async () => {
      const result = await handleConnectorExecute({
        type: "obsidian_discover",
        params: {},
        toolCallId: `obsidian-discover-${Date.now()}`,
        toolName: "obsidian_discover",
        agent: "obsidian",
      });

      if (!result.ok) {
        // Allow retry if it failed
        didDiscoverVaultsRef.current = false;
        return;
      }

      const vaults = (result.vaults as Array<{ name: string; path: string }>) || [];
      setObsidianVaults(vaults);

      // Pick last used vault if present; else auto-pick if only one; else first.
      let preferred: string | undefined;
      try {
        preferred = window.localStorage.getItem(lastVaultStorageKey) || undefined;
      } catch {
        preferred = undefined;
      }

      const matched =
        (preferred && vaults.find((v) => v.path === preferred)?.path) || undefined;
      const chosen =
        matched || (vaults.length === 1 ? vaults[0].path : vaults[0]?.path);

      if (chosen) {
        setObsidianVaultPath(chosen);
        try {
          window.localStorage.setItem(lastVaultStorageKey, chosen);
        } catch {
          // ignore
        }
      }
    })();
  }, [relay.status, localConnectorOnline, activeDeviceId, handleConnectorExecute, lastVaultStorageKey]);

  // Test connector capabilities
  const testConnectorCapabilities = useCallback(async () => {
    if (relay.status !== "ready" || !localConnectorOnline) return;
    
    setConnectorCapabilities({ testing: true });
    
    const results: typeof connectorCapabilities = {};
    
    // Test browser (quick init check)
    try {
      const browserResult = await handleConnectorExecute({
        type: "browser_init",
        params: { headless: true },
        toolCallId: `test-${Date.now()}`,
        toolName: "browser_init",
        agent: "browser",
      });
      results.browser = { ok: browserResult.ok, error: browserResult.error };
    } catch {
      results.browser = { ok: false, error: "Test failed" };
    }
    
    // Test files (list home dir)
    try {
      const filesResult = await handleConnectorExecute({
        type: "file_list",
        params: { path: "~" },
        toolCallId: `test-${Date.now()}`,
        toolName: "file_list",
        agent: "files",
      });
      results.files = { ok: filesResult.ok, error: filesResult.error };
    } catch {
      results.files = { ok: false, error: "Test failed" };
    }
    
    // Test obsidian (discover vaults)
    try {
      const obsidianResult = await handleConnectorExecute({
        type: "obsidian_discover",
        params: {},
        toolCallId: `test-${Date.now()}`,
        toolName: "obsidian_discover",
        agent: "obsidian",
      });
      results.obsidian = { ok: obsidianResult.ok, error: obsidianResult.error };
    } catch {
      results.obsidian = { ok: false, error: "Test failed" };
    }
    
    setConnectorCapabilities(results);
  }, [relay.status, localConnectorOnline, handleConnectorExecute]);

  // Multi-agent hook - wraps useOrchestrator and adds multi-pane support
  const multiAgent = useMultiAgent({
    onConnectorExecute: handleConnectorExecuteWithSiteDetection,
    onOpenCodeSession: (agentId: string) => {
      setActiveCodeAgentId(agentId);
      try {
        window.localStorage.setItem(lastCodeAgentStorageKey, agentId);
      } catch {
        // ignore
      }
      setMainPane("code");
      setShowCodeSessions(false);
    },
  });
  // Alias for backward compat -- all existing code references `orchestrator.*`
  const orchestrator = multiAgent.orchestrator;
  const handleCancelOrchestratorStream = useCallback(() => {
    orchestrator.cancelStream();
    cancelPendingConnectorRequests("user");
  }, [orchestrator, cancelPendingConnectorRequests]);

  const siteBuilderStorageKey = useMemo(() => {
    const sid =
      typeof orchestrator.currentSessionId === "string" && orchestrator.currentSessionId.trim()
        ? orchestrator.currentSessionId.trim()
        : "global";
    return `${siteBuilderStorageBaseKey}:${sid}`;
  }, [orchestrator.currentSessionId, siteBuilderStorageBaseKey]);

  const shareSessionWithWorkspace = useCallback(async (sessionId: string) => {
    if (sharedSessionIdsRef.current.has(sessionId)) return;
    try {
      const agentId = orchestrator.getAgentIdForSession(sessionId);
      const res = await fetch("/api/orchestrator/agents/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: sessionId, agentId }),
      });
      if (res.ok) {
        sharedSessionIdsRef.current.add(sessionId);
        orchestrator.markSessionShared(sessionId);
      }
    } catch {
      // ignore
    }
  }, [orchestrator]);

  // Code plans hook
  const codeAgentWorkspaceRoots = useMemo(
    () => [...new Set(codeAgents.map((a) => a.workspaceRoot).filter((r): r is string => !!r))],
    [codeAgents]
  );
  const claudePlans = useClaudePlans({
    relaySend: relay.send,
    relaySubscribe: relay.subscribe,
    relayStatus: relay.status,
    activeDeviceId,
    workspaceRoots: codeAgentWorkspaceRoots,
  });

  const handleQueuedCodePromptHandled = useCallback((promptId: string) => {
    setPendingCodePrompt((prev) => (prev?.id === promptId ? null : prev));
  }, []);

  const createCodeAgentForPlan = useCallback(
    async (plan: ClaudePlan, codeCliProvider: CodeCliProvider = "claude"): Promise<CodeAgentInfo | null> => {
      if (!activeDeviceId) return null;

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;

      const workspaceMatch = codeAgents.find(
        (agent) => agent.workspaceRoot === plan.workspaceRoot && agent.workspaceId
      );
      if (!workspaceMatch?.workspaceId) {
        return null;
      }

      const trimmedTitle = plan.title.trim();
      const providerLabel = codeCliProvider === "codex" ? " (Codex)" : "";
      const baseName = (trimmedTitle || "Code Session") + providerLabel;
      const existingNames = new Set(codeAgents.map((agent) => agent.name.trim()).filter(Boolean));
      let nextName = baseName;
      let suffix = 2;
      while (existingNames.has(nextName)) {
        nextName = `${baseName} ${suffix}`;
        suffix += 1;
      }

      const { data: agentRow, error: agentErr } = await supabase
        .from("agents")
        .insert({
          user_id: user.id,
          type: "claude-code",
          name: nextName,
          flag_key: null,
          provider: null,
          model: null,
        })
        .select("id")
        .single();
      if (agentErr || !agentRow?.id) {
        return null;
      }

      const { error: cfgErr } = await supabase.from("claude_code_agent_configs").insert({
        agent_id: agentRow.id,
        user_id: user.id,
        device_id: activeDeviceId,
        workspace_id: workspaceMatch.workspaceId,
        terminal_id: null,
        code_cli_provider: codeCliProvider,
      });
      if (cfgErr) {
        await supabase.from("agents").delete().eq("id", agentRow.id);
        return null;
      }

      const createdAgent: CodeAgentInfo = {
        id: String(agentRow.id),
        name: nextName,
        createdAt: new Date().toISOString(),
        workspaceId: workspaceMatch.workspaceId,
        workspaceRoot: workspaceMatch.workspaceRoot,
        codeCliProvider,
      };
      setCodeAgents((prev) => [createdAgent, ...prev]);
      return createdAgent;
    },
    [activeDeviceId, codeAgents, supabase]
  );

  const createCodeAgentFromMultiView = useCallback(
    async ({
      name,
      codeCliProvider,
      workspaceId,
      workspaceRoot,
    }: {
      name: string;
      codeCliProvider: CodeCliProvider;
      workspaceId?: string | null;
      workspaceRoot?: string | null;
    }): Promise<CodeAgentInfo | null> => {
      if (!activeDeviceId) return null;

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;

      const baseName = name.trim() || "Code Session";
      const existingNames = new Set(codeAgents.map((agent) => agent.name.trim()).filter(Boolean));
      let nextName = baseName;
      let suffix = 2;
      while (existingNames.has(nextName)) {
        nextName = `${baseName} ${suffix}`;
        suffix += 1;
      }

      const { data: agentRow, error: agentErr } = await supabase
        .from("agents")
        .insert({
          user_id: user.id,
          type: "claude-code",
          name: nextName,
          flag_key: null,
          provider: null,
          model: null,
        })
        .select("id")
        .single();
      if (agentErr || !agentRow?.id) return null;

      const { error: cfgErr } = await supabase.from("claude_code_agent_configs").insert({
        agent_id: agentRow.id,
        user_id: user.id,
        device_id: activeDeviceId,
        workspace_id: workspaceId || null,
        terminal_id: null,
        code_cli_provider: codeCliProvider,
      });
      if (cfgErr) {
        await supabase.from("agents").delete().eq("id", agentRow.id);
        return null;
      }

      const createdAgent: CodeAgentInfo = {
        id: String(agentRow.id),
        name: nextName,
        createdAt: new Date().toISOString(),
        workspaceId: workspaceId || undefined,
        workspaceRoot: workspaceRoot || undefined,
        codeCliProvider,
      };
      setCodeAgents((prev) => [createdAgent, ...prev.filter((agent) => agent.id !== createdAgent.id)]);
      setActiveCodeAgentId(createdAgent.id);
      try {
        window.localStorage.setItem(lastCodeAgentStorageKey, createdAgent.id);
      } catch {
        // ignore
      }
      return createdAgent;
    },
    [activeDeviceId, codeAgents, lastCodeAgentStorageKey, supabase]
  );

  const pickCodeWorkspaceForMultiView = useCallback(async (): Promise<CodeWorkspaceSelection | null> => {
    if (!activeDeviceId) {
      throw new Error("No device online. Start the connector first.");
    }
    if (relay.status !== "ready") {
      throw new Error("Relay not connected.");
    }

    const requestId = crypto.randomUUID();

    return await new Promise<CodeWorkspaceSelection | null>((resolve, reject) => {
      let settled = false;
      let unsub: (() => void) | null = null;
      const timer = window.setTimeout(() => {
        finish(() => reject(new Error("Timed out waiting for folder picker. Check the connector.")));
      }, 20000);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (unsub) unsub();
        fn();
      };

      unsub = relay.subscribe((msg) => {
        const msgType = (msg as { type?: string }).type;

        if (msgType === "workspace_added") {
          const m = msg as unknown as WorkspaceAddedMsg;
          if (String(m.request_id || "") !== requestId) return;
          if (!m.ok || !m.workspace?.id) {
            finish(() => reject(new Error(m.error || "Failed to add workspace")));
            return;
          }
          finish(() =>
            resolve({
              id: String(m.workspace?.id || ""),
              rootPath: m.workspace?.root_path ? String(m.workspace.root_path) : undefined,
            })
          );
          return;
        }

        if (msgType === "workspace_pick_result") {
          const m = msg as { request_id?: string; ok?: boolean; error?: string };
          if (String(m.request_id || "") !== requestId) return;
          if (m.ok) return;
          finish(() =>
            reject(new Error(m.error === "cancelled" ? "Folder selection cancelled" : (m.error || "Failed to pick folder")))
          );
          return;
        }

        if (msgType === "error") {
          const m = msg as { error?: string };
          if (m.error === "device_not_online") {
            finish(() => reject(new Error("Connector not online. Check that the Groovy Connector is running.")));
          }
        }
      });

      relay.send({ type: "workspace_pick", request_id: requestId, device_id: activeDeviceId });
    });
  }, [activeDeviceId, relay]);

  const handleExecutePlan = useCallback(
    async (plan: ClaudePlan, agentId: string | null) => {
      const planProvider: CodeCliProvider = plan.provider === "codex" ? "codex" : "claude";
      let targetAgent =
        (agentId ? codeAgents.find((agent) => agent.id === agentId) : null) || null;

      if (targetAgent && (targetAgent.codeCliProvider || "claude") !== planProvider) {
        targetAgent = null;
      }

      if (!targetAgent) {
        targetAgent = await createCodeAgentForPlan(plan, planProvider);
        if (!targetAgent) return;
      }

      const promptId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let targetPaneId: string | null = null;

      if (multiAgent.viewMode === "multi") {
        targetPaneId =
          multiAgent.panes.find((pane) => pane.kind === "code" && pane.codeAgentId === targetAgent?.id)?.id ||
          null;
        if (!targetPaneId) {
          targetPaneId =
            multiAgent.addPane({
              kind: "code",
              codeAgentId: targetAgent.id,
              codeAgentName: targetAgent.name,
            }) || null;
        }
      } else {
        setActiveCodeAgentId(targetAgent.id);
        try {
          window.localStorage.setItem(lastCodeAgentStorageKey, targetAgent.id);
        } catch {
          // ignore
        }
        setMainPane("code");
        if (isMobile) {
          setMobileTab("code");
        }
      }

      setPendingCodePrompt({
        id: promptId,
        agentId: targetAgent.id,
        content: plan.content,
        targetPaneId,
      });
      setShowPlansBrowser(false);
    },
    [codeAgents, createCodeAgentForPlan, isMobile, lastCodeAgentStorageKey, multiAgent]
  );

  // Derive agent statuses from orchestrator activity
  const agentStatuses = useMemo((): Record<AgentType, AgentStatus> => {
    const statuses: Record<AgentType, AgentStatus> = {
      browser: "idle",
      files: "idle",
      pages: "idle",
      obsidian: "idle",
      data: "idle",
      chat: "idle",
      schedule: "idle",
      code: "idle",
    };

    // Only check RECENT activities (last 10) to avoid old stuck activities causing permanent "running".
    // Memory/context prep is a system activity and should not light up any agent tile.
    const recentActivities = orchestrator.agentActivities
      .slice(-10)
      .filter((activity) => !NON_PANEL_ACTIVITY_ACTIONS.has(activity.action));
    
    // First pass: check for running activities (highest priority)
    for (const activity of recentActivities) {
      if (!isPanelAgent(activity.agent)) continue;
      if (activity.status === "running") {
        statuses[activity.agent] = "running";
      }
    }

    // Check current tool calls for running agents
    for (const tc of orchestrator.currentToolCalls) {
      const agent = tc.toolName.startsWith("data_") ? "data"
        : tc.toolName.startsWith("browser_") ? "browser"
        : tc.toolName === "browser_task" ? "browser"
        : tc.toolName.startsWith("files_") ? "files"
        : tc.toolName.startsWith("site_") ? "pages"
        : tc.toolName.startsWith("obsidian_") ? "obsidian"
        : tc.toolName.startsWith("schedule_") ? "schedule"
        : tc.toolName.startsWith("code_") ? "code"
        : null;
      
      if (agent) {
        // Don't let a completed tool-call override a still-running activity
        if (statuses[agent] === "running") continue;
        statuses[agent] = tc.status === "complete" ? "complete"
          : tc.status === "error" ? "error"
          : "running";
      }
    }

    // Second pass: check for complete/error (but don't override running)
    for (const activity of recentActivities) {
      if (!isPanelAgent(activity.agent)) continue;
      if (activity.status === "complete" && statuses[activity.agent] !== "running") {
        statuses[activity.agent] = "complete";
      }
      if (activity.status === "error" && statuses[activity.agent] !== "running") {
        statuses[activity.agent] = "error";
      }
    }

    return statuses;
  }, [orchestrator.currentToolCalls, orchestrator.agentActivities]);

  // Human-readable status messages for current tool operations
  const currentOperations = useMemo(() => {
    const ops: string[] = [];
    for (const tc of orchestrator.currentToolCalls) {
      if (tc.status !== "running") continue;
      
      // Map tool names to user-friendly messages
      const msg = (() => {
        if (tc.toolName === "data_query") {
          const agent = (tc.args?.agent_name || tc.args?.query) as string | undefined;
          return agent ? `Querying ${agent}...` : "Analyzing data...";
        }
        if (tc.toolName === "whatsapp_resolve_recipient") {
          const q = tc.args?.query as string | undefined;
          return q ? `Finding "${q}" in WhatsApp...` : "Resolving WhatsApp contact...";
        }
        if (tc.toolName === "whatsapp_send_text") {
          return "Sending WhatsApp message...";
        }
        if (tc.toolName === "schedule_create") {
          return "Creating schedule...";
        }
        if (tc.toolName === "schedule_list") {
          return "Loading schedules...";
        }
        if (tc.toolName.startsWith("schedule_")) {
          return "Updating schedule...";
        }
        if (tc.toolName.startsWith("browser_")) {
          return "Working in browser...";
        }
        if (tc.toolName === "browser_task") {
          return "Running browser task...";
        }
        if (tc.toolName.startsWith("obsidian_")) {
          return "Accessing Obsidian...";
        }
        if (tc.toolName.startsWith("files_")) {
          return "Processing files...";
        }
        if (tc.toolName.startsWith("site_")) {
          return "Building site...";
        }
        if (tc.toolName === "remember") {
          return "Saving to memory...";
        }
        if (tc.toolName === "recall") {
          return "Searching memory...";
        }
        if (tc.toolName === "terminal_exec") {
          return "Running command...";
        }
        if (tc.toolName.startsWith("linkdb_")) {
          return "Accessing Link Inbox...";
        }
        if (tc.toolName.startsWith("sqlite_")) {
          return "Querying database...";
        }
        return `Running ${tc.toolName.replace(/_/g, " ")}...`;
      })();
      
      ops.push(msg);
    }
    return ops;
  }, [orchestrator.currentToolCalls]);

  const streamingPlaceholderText = useMemo(() => {
    if (orchestrator.preparingMemoryContext) {
      return "Grabbing your memory and building your context…";
    }
    if (currentOperations.length > 0) return currentOperations[0];
    return "Thinking…";
  }, [currentOperations, orchestrator.preparingMemoryContext]);

  // Track when agents were last running (for grace period before hiding panel)
  const [lastRunningTime, setLastRunningTime] = useState<number>(0);
  // Force re-render for grace period countdown
  const [, setTick] = useState(0);
  
  // Check if any agents are running (for adaptive layout)
  // Keep panel open while streaming and for a grace period after completion.
  const hasRunningAgents = useMemo(() => {
    // If the orchestrator is still streaming text/tool events, keep the side panel open
    if (orchestrator.isStreaming && !orchestrator.preparingMemoryContext) {
      return true;
    }

    // If there are any running activities at all (even not in the last 10), keep open
    const anyRunning = orchestrator.agentActivities.some(
      (a) =>
        isPanelAgent(a.agent) &&
        a.status === "running" &&
        !NON_PANEL_ACTIVITY_ACTIONS.has(a.action)
    );
    if (anyRunning) {
      return true;
    }

    const isCurrentlyRunning = Object.values(agentStatuses).some(s => s === "running");
    if (isCurrentlyRunning) {
      return true;
    }
    
    // Grace period: keep showing panel after completion
    const hasRecentlyCompleted = Object.values(agentStatuses).some(s => s === "complete");
    const elapsed = Date.now() - lastRunningTime;
    if (hasRecentlyCompleted && elapsed < 15000) {
      return true;
    }
    
    return false;
  }, [
    agentStatuses,
    lastRunningTime,
    orchestrator.isStreaming,
    orchestrator.preparingMemoryContext,
    orchestrator.agentActivities,
  ]);

  // Update lastRunningTime when agents start running OR any activity is running
  useEffect(() => {
    const isRunning = Object.values(agentStatuses).some(s => s === "running");
    const anyActivityRunning = orchestrator.agentActivities.some(
      (a) =>
        isPanelAgent(a.agent) &&
        a.status === "running" &&
        !NON_PANEL_ACTIVITY_ACTIONS.has(a.action)
    );
    if (isRunning || anyActivityRunning) {
      setLastRunningTime(Date.now());
    }
  }, [agentStatuses, orchestrator.agentActivities]);
  
  // Timer to force re-evaluation of grace period (so panel doesn't stay forever but also doesn't close early)
  useEffect(() => {
    if (lastRunningTime === 0) return;
    const elapsed = Date.now() - lastRunningTime;
    if (elapsed >= 15000) return; // Already past grace period
    
    const remaining = 15000 - elapsed + 100; // +100ms buffer
    const timer = setTimeout(() => setTick(t => t + 1), remaining);
    return () => clearTimeout(timer);
  }, [lastRunningTime]);

  // Keep right activity rail minimized while Pages panel is open.
  useEffect(() => {
    if (showSiteBuilderPanel) {
      setCompactActivity(false);
    }
  }, [showSiteBuilderPanel]);

  // Restore Site Builder panel state after refresh.
  useEffect(() => {
    if (typeof window === "undefined") return;
    didHydrateSiteBuilderRef.current = false;
    didRecoverSiteBuilderFallbackRef.current = false;
    siteBuilderStatusSyncKeyRef.current = null;
    setShowSiteBuilderPanel(false);
    setSiteBuilderExpanded(false);
    setSiteBuilderState({});
    try {
      const raw = window.localStorage.getItem(siteBuilderStorageKey);
      if (!raw) return;
      const parsedUnknown: unknown = JSON.parse(raw);
      const parsed =
        parsedUnknown && typeof parsedUnknown === "object"
          ? (parsedUnknown as {
              showPanel?: unknown;
              expanded?: unknown;
              state?: Record<string, unknown>;
              savedAt?: unknown;
            })
          : null;
      if (!parsed) return;

      const stateRaw =
        parsed.state && typeof parsed.state === "object" ? parsed.state : ({} as Record<string, unknown>);
      const parsedSavedAt =
        typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt)
          ? parsed.savedAt
          : undefined;
      const restoredState = {
        slug: typeof stateRaw.slug === "string" ? stateRaw.slug : undefined,
        status: typeof stateRaw.status === "string" ? stateRaw.status : undefined,
        devPort:
          typeof stateRaw.devPort === "number" && Number.isFinite(stateRaw.devPort)
            ? stateRaw.devPort
            : undefined,
        tunnelNonce: typeof stateRaw.tunnelNonce === "string" ? stateRaw.tunnelNonce : undefined,
        productionUrl: typeof stateRaw.productionUrl === "string" ? stateRaw.productionUrl : undefined,
        deviceId: typeof stateRaw.deviceId === "string" ? stateRaw.deviceId : undefined,
        errorMessage: typeof stateRaw.errorMessage === "string" ? stateRaw.errorMessage : undefined,
        startRequestedAt:
          typeof stateRaw.startRequestedAt === "number" && Number.isFinite(stateRaw.startRequestedAt)
            ? stateRaw.startRequestedAt
            : parsedSavedAt,
      };

      const now = Date.now();
      if (
        restoredState.status === "starting" &&
        restoredState.startRequestedAt &&
        now - restoredState.startRequestedAt >= CONNECTOR_SITE_DEV_START_TIMEOUT_MS
      ) {
        restoredState.status = "error";
        restoredState.errorMessage =
          restoredState.errorMessage || "Timed out waiting for local dev server to start.";
        restoredState.startRequestedAt = undefined;
      } else if (
        restoredState.status === "deploying" &&
        restoredState.startRequestedAt &&
        now - restoredState.startRequestedAt >= CONNECTOR_SITE_DEPLOY_TIMEOUT_MS
      ) {
        restoredState.status = "error";
        restoredState.errorMessage =
          restoredState.errorMessage || "Timed out waiting for deploy to complete.";
        restoredState.startRequestedAt = undefined;
      }

      const hasRenderableSiteState = !!(
        restoredState.slug ||
        restoredState.devPort ||
        restoredState.productionUrl ||
        restoredState.status
      );

      if (hasRenderableSiteState) {
        setSiteBuilderState(restoredState);
        setShowSiteBuilderPanel(parsed.showPanel === true && hasRenderableSiteState);
        setSiteBuilderExpanded(parsed.expanded === true);
        didRecoverSiteBuilderFallbackRef.current = true;
      }
    } catch {
      // ignore invalid localStorage data
    } finally {
      didHydrateSiteBuilderRef.current = true;
    }
  }, [
    siteBuilderStorageKey,
    CONNECTOR_SITE_DEV_START_TIMEOUT_MS,
    CONNECTOR_SITE_DEPLOY_TIMEOUT_MS,
  ]);

  // Persist Site Builder panel state so refresh keeps context.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!didHydrateSiteBuilderRef.current) return;
    try {
      if (!showSiteBuilderPanel) {
        window.localStorage.removeItem(siteBuilderStorageKey);
        return;
      }
      const hasAnyState = !!(
        siteBuilderState.slug ||
        siteBuilderState.status ||
        siteBuilderState.devPort ||
        siteBuilderState.productionUrl ||
        siteBuilderState.errorMessage
      );
      if (!hasAnyState) {
        window.localStorage.removeItem(siteBuilderStorageKey);
        return;
      }
      window.localStorage.setItem(
        siteBuilderStorageKey,
        JSON.stringify({
          showPanel: showSiteBuilderPanel,
          expanded: siteBuilderExpanded,
          state: siteBuilderState,
          savedAt: Date.now(),
        })
      );
    } catch {
      // ignore storage failures
    }
  }, [
    showSiteBuilderPanel,
    siteBuilderExpanded,
    siteBuilderState,
    siteBuilderStorageKey,
  ]);

  // Do not auto-open the panel from inferred/global state.
  // Visibility should only restore from explicit, session-scoped panel state.
  useEffect(() => {
    if (!didHydrateSiteBuilderRef.current) return;
    if (didRecoverSiteBuilderFallbackRef.current) return;
    didRecoverSiteBuilderFallbackRef.current = true;
  }, [
    siteBuilderStorageKey,
  ]);

  // Guard against a stale "starting" state that never transitions.
  useEffect(() => {
    if (!showSiteBuilderPanel) return;
    if (siteBuilderState.status !== "starting") return;
    const startedAt = siteBuilderState.startRequestedAt || Date.now();
    const elapsed = Date.now() - startedAt;
    if (elapsed >= CONNECTOR_SITE_DEV_START_TIMEOUT_MS) {
      setSiteBuilderState((prev) => {
        if (prev.status !== "starting") return prev;
        return {
          ...prev,
          status: "error",
          errorMessage: "Timed out waiting for local dev server to start.",
          startRequestedAt: undefined,
        };
      });
      return;
    }
    const remaining = CONNECTOR_SITE_DEV_START_TIMEOUT_MS - elapsed + 200;
    const timer = setTimeout(() => {
      setSiteBuilderState((prev) => {
        if (prev.status !== "starting") return prev;
        return {
          ...prev,
          status: "error",
          errorMessage: "Timed out waiting for local dev server to start.",
          startRequestedAt: undefined,
        };
      });
    }, remaining);
    return () => clearTimeout(timer);
  }, [
    showSiteBuilderPanel,
    siteBuilderState.status,
    siteBuilderState.startRequestedAt,
    CONNECTOR_SITE_DEV_START_TIMEOUT_MS,
  ]);

  // Guard against a stale "deploying" state that never transitions.
  useEffect(() => {
    if (!showSiteBuilderPanel) return;
    if (siteBuilderState.status !== "deploying") return;
    const startedAt = siteBuilderState.startRequestedAt || Date.now();
    const elapsed = Date.now() - startedAt;
    if (elapsed >= CONNECTOR_SITE_DEPLOY_TIMEOUT_MS) {
      setSiteBuilderState((prev) => {
        if (prev.status !== "deploying") return prev;
        return {
          ...prev,
          status: "error",
          errorMessage: "Timed out waiting for deploy to complete. Ask me to retry deploy.",
          startRequestedAt: undefined,
        };
      });
      return;
    }
    const remaining = CONNECTOR_SITE_DEPLOY_TIMEOUT_MS - elapsed + 200;
    const timer = setTimeout(() => {
      setSiteBuilderState((prev) => {
        if (prev.status !== "deploying") return prev;
        return {
          ...prev,
          status: "error",
          errorMessage: "Timed out waiting for deploy to complete. Ask me to retry deploy.",
          startRequestedAt: undefined,
        };
      });
    }, remaining);
    return () => clearTimeout(timer);
  }, [
    showSiteBuilderPanel,
    siteBuilderState.status,
    siteBuilderState.startRequestedAt,
    CONNECTOR_SITE_DEPLOY_TIMEOUT_MS,
  ]);

  // Reconcile site runtime status from Vercel when local status is ambiguous/stale.
  useEffect(() => {
    if (!showSiteBuilderPanel) {
      siteBuilderStatusSyncKeyRef.current = null;
      return;
    }
    const slug =
      typeof siteBuilderState.slug === "string" && siteBuilderState.slug.trim()
        ? siteBuilderState.slug.trim()
        : "";
    if (!slug) {
      siteBuilderStatusSyncKeyRef.current = null;
      return;
    }

    const currentStatus =
      typeof siteBuilderState.status === "string" && siteBuilderState.status.trim()
        ? siteBuilderState.status.trim().toLowerCase()
        : "";
    const shouldSync = currentStatus === "error" || currentStatus === "deploying";
    if (!shouldSync) {
      siteBuilderStatusSyncKeyRef.current = null;
      return;
    }

    const syncKey = `${slug}::${currentStatus}::${siteBuilderState.productionUrl || ""}`;
    if (siteBuilderStatusSyncKeyRef.current === syncKey) return;
    siteBuilderStatusSyncKeyRef.current = syncKey;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/sites/status?slug=${encodeURIComponent(slug)}&ts=${Date.now()}`,
          {
            cache: "no-store",
            headers: { "cache-control": "no-cache" },
          }
        );
        if (!res.ok || cancelled) return;

        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; site?: Record<string, unknown> }
          | null;
        const site =
          data?.site && typeof data.site === "object" ? (data.site as Record<string, unknown>) : null;
        if (!site || cancelled) return;

        const nextStatus =
          typeof site.status === "string" && site.status.trim()
            ? site.status.trim().toLowerCase()
            : undefined;
        const nextUrl =
          typeof site.latest_deployment_url === "string" && site.latest_deployment_url.trim()
            ? site.latest_deployment_url.trim()
            : undefined;
        const nextError =
          typeof site.last_build_error === "string" && site.last_build_error.trim()
            ? site.last_build_error.trim()
            : undefined;

        setSiteBuilderState((prev) => {
          if (prev.slug && prev.slug !== slug) return prev;
          if (!nextStatus && !nextUrl && !nextError) return prev;
          return {
            ...prev,
            status: nextStatus || prev.status,
            productionUrl: nextUrl ?? prev.productionUrl,
            errorMessage: nextStatus === "error" ? nextError || prev.errorMessage : undefined,
          };
        });
      } catch {
        // best effort reconciliation only
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    showSiteBuilderPanel,
    siteBuilderState.slug,
    siteBuilderState.status,
    siteBuilderState.productionUrl,
  ]);

  // Validate local preview health for restored/stale dev ports.
  // If localhost is not responding, fail fast instead of spinning forever.
  useEffect(() => {
    if (!showSiteBuilderPanel) return;
    if (siteBuilderState.status !== "dev") return;
    const port = siteBuilderState.devPort;
    if (typeof port !== "number" || !Number.isFinite(port) || port <= 0) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const reachable = await isLocalPreviewReachable(port, 3500);
        if (cancelled || reachable) return;
        setSiteBuilderState((prev) => {
          if (prev.status !== "dev") return prev;
          if (prev.devPort !== port) return prev;
          return {
            ...prev,
            status: "error",
            devPort: undefined,
            tunnelNonce: undefined,
            errorMessage: `Local preview on :${port} is not responding. Ask me to restart the site preview.`,
            startRequestedAt: undefined,
          };
        });
      })();
    }, 12000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [showSiteBuilderPanel, siteBuilderState.status, siteBuilderState.devPort]);

  const isBrowserThinking = useMemo(() => {
    return orchestrator.agentActivities.some(
      (a) => a.agent === "browser" && a.status === "running"
    );
  }, [orchestrator.agentActivities]);

  // Extract running context for each agent (for the animated reveal)
  type ObsidianNoteResultType = {
    path: string;
    name: string;
    matches?: number;
    links?: string[];
  };
  
  type RunningContextType = { 
    provider?: string; 
    action?: string; 
    target?: string;
    // Browser: screenshot data from Computer Use
    screenshot?: string;
    pageTitle?: string;
    pageUrl?: string;
    // Obsidian: search results for graph
    obsidianResults?: ObsidianNoteResultType[];
  };
  
  const runningContexts = useMemo((): Record<AgentType, RunningContextType | undefined> => {
    const contexts: Record<AgentType, RunningContextType | undefined> = {
      browser: undefined,
      files: undefined,
      pages: undefined,
      obsidian: undefined,
      data: undefined,
      chat: undefined,
      schedule: undefined,
      code: undefined,
    };

    // Only check RECENT activities to prevent old stuck activities from showing
    const recentActivities = orchestrator.agentActivities.slice(-15);
    
    for (const activity of recentActivities) {
      if (!isPanelAgent(activity.agent)) continue;
      const isRunning = activity.status === "running";
      // Only include completed activities that started during the current session
      // (activity timestamp >= when we started running, with 2s buffer for timing)
      const isFromCurrentSession = activity.timestamp.getTime() >= (lastRunningTime - 2000);
      const isRecentlyCompleted = activity.status === "complete" && isFromCurrentSession;
      
      // Skip non-panel/system activities (memory prep, scaffolding markers, etc.)
      const skipActions = NON_PANEL_ACTIVITY_ACTIONS;
      
      // DEBUG: Log all data agent activities
      if (activity.agent === "data") {
        console.log("[Dashboard] DATA activity:", {
          id: activity.id,
          action: activity.action,
          status: activity.status,
          isRunning,
          isRecentlyCompleted,
          isFromCurrentSession,
          willSkip: skipActions.has(activity.action),
        });
      }
      
      if ((isRunning || isRecentlyCompleted) && !skipActions.has(activity.action)) {
        const metadata = activity.metadata;
        const result = activity.result as { screenshot?: string; url?: string; title?: string } | undefined;
        
        // Debug log for browser screenshot updates
        if (activity.agent === "browser" && result?.screenshot) {
          console.log("[Dashboard] runningContexts: browser screenshot updated", {
            activityId: activity.id,
            screenshotLen: result.screenshot.length,
            url: result.url,
          });
        }
        
        // DEBUG: Log when setting data context (keep for data debugging only)
        if (activity.agent === "data") {
          console.log("[Dashboard] SETTING DATA CONTEXT:", {
            action: activity.action,
            detail: activity.detail,
            metadata,
          });
        }
        
        // Only update context if we don't already have one, or if this is running (takes priority)
        if (!contexts[activity.agent] || isRunning) {
          contexts[activity.agent] = {
            provider: metadata?.provider,
            action: metadata?.title || activity.action,
            target: metadata?.query || metadata?.target || activity.detail,
            // Browser screenshot from Computer Use
            screenshot: result?.screenshot,
            pageUrl: result?.url,
            pageTitle: result?.title,
          };
        }
      }
    }
    
    // For Obsidian: also extract results from completed searches
    const obsidianActivities = orchestrator.agentActivities
      .filter(a => a.agent === "obsidian")
      .slice(-10); // Last 10 obsidian activities
    
    // Collect all note results from search activities
    const allNoteResults: ObsidianNoteResultType[] = [];
    const seenPaths = new Set<string>();
    
    for (const activity of obsidianActivities) {
      const toolName = (activity.metadata as { toolName?: string } | undefined)?.toolName;
      const result = activity.result as { 
        ok?: boolean; 
        results?: Array<{ path?: string; matches?: number; content?: string }>;
        content?: string;
        path?: string;
        note_path?: string;
      } | undefined;
      
      if (toolName === "obsidian_search" && result?.ok !== false && result?.results) {
        for (const r of result.results) {
          if (r.path && !seenPaths.has(r.path)) {
            seenPaths.add(r.path);
            const name = r.path.split("/").pop()?.replace(/\.md$/, "") || r.path;
            // Extract wikilinks from content if available
            const links: string[] = [];
            if (r.content) {
              const linkMatches = r.content.match(/\[\[([^\]]+)\]\]/g);
              if (linkMatches) {
                for (const match of linkMatches) {
                  const link = match.slice(2, -2).split("|")[0]; // Handle [[link|alias]]
                  if (!links.includes(link)) links.push(link);
                }
              }
            }
            allNoteResults.push({ path: r.path, name, matches: r.matches, links });
          }
        }
      } else if (toolName === "obsidian_read" && result?.ok !== false) {
        const path = result?.path || result?.note_path;
        if (path && !seenPaths.has(path)) {
          seenPaths.add(path);
          const name = path.split("/").pop()?.replace(/\.md$/, "") || path;
          const links: string[] = [];
          if (result?.content) {
            const linkMatches = result.content.match(/\[\[([^\]]+)\]\]/g);
            if (linkMatches) {
              for (const match of linkMatches) {
                const link = match.slice(2, -2).split("|")[0];
                if (!links.includes(link)) links.push(link);
              }
            }
          }
          allNoteResults.push({ path, name, links });
        }
      }
    }
    
    // If we have obsidian results, add them to the context
    if (allNoteResults.length > 0) {
      contexts.obsidian = {
        ...contexts.obsidian,
        obsidianResults: allNoteResults.slice(0, 15), // Max 15 nodes
      };
    }

    // For browser: also check recent completed activities for screenshot (in case task completed quickly)
    if (!contexts.browser?.screenshot) {
      const recentBrowserActivities = orchestrator.agentActivities
        .filter(a => a.agent === "browser" && a.status === "complete")
        .slice(-3); // Last 3 completed browser activities
      
      for (const activity of recentBrowserActivities) {
        const result = activity.result as { screenshot?: string; url?: string; title?: string } | undefined;
        if (result?.screenshot) {
          console.log("[runningContexts] Found COMPLETED browser activity with screenshot:", {
            id: activity.id,
            screenshotLen: result.screenshot.length,
          });
          // Only set if we don't already have a running context
          if (!contexts.browser) {
            contexts.browser = {
              action: activity.action,
              screenshot: result.screenshot,
              pageUrl: result.url,
              pageTitle: result.title,
            };
          }
          break;
        }
      }
    }

    // Also check current tool calls
    for (const tc of orchestrator.currentToolCalls) {
      if (tc.status === "running") {
        const agent = tc.toolName.startsWith("data_") ? "data"
          : tc.toolName.startsWith("browser_") ? "browser"
          : tc.toolName.startsWith("file_") ? "files"
          : tc.toolName.startsWith("obsidian_") ? "obsidian"
          : null;
        
        if (agent) {
          const args = tc.args as Record<string, unknown>;
          // Preserve existing screenshot if we have one
          const existing = contexts[agent];
          contexts[agent] = {
            provider: args.provider as string | undefined,
            action: tc.toolName.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase()),
            target: (args.query || args.url || args.path) as string | undefined,
            // Keep existing screenshot data
            screenshot: existing?.screenshot,
            pageUrl: existing?.pageUrl || (args.url as string | undefined),
            pageTitle: existing?.pageTitle,
          };
        }
      }
    }

    // DEBUG: Log final contexts if data has a context
    if (contexts.data) {
      console.log("[Dashboard] FINAL runningContexts.data:", contexts.data);
    }
    
    return contexts;
  }, [orchestrator.agentActivities, orchestrator.currentToolCalls, lastRunningTime]);

  // Derive activity feed from orchestrator activities
  const activityFeed = useMemo((): FeedItem[] => {
    const items: FeedItem[] = [];

    // Add agent activities (from tool executions)
    for (const activity of orchestrator.agentActivities) {
      items.push({
        id: activity.id,
        agent: activity.agent,
        action: activity.action,
        detail: activity.detail,
        timestamp: activity.timestamp,
        status: activity.status === "error" ? "error" as const 
          : activity.status === "complete" ? "complete" as const 
          : "running" as const,
        // Rich data from SSE events
        metadata: activity.metadata,
        summary: activity.summary,
      });
    }

    // Sort by timestamp, most recent last (so new items appear at bottom)
    return items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }, [orchestrator.agentActivities]);

  const orchestratorActivities = orchestrator.agentActivities;

  const runtimeTelemetry = useMemo(() => {
    const asRecord = (value: unknown): Record<string, unknown> | null =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const describeSkillActivity = (
      activity: (typeof orchestratorActivities)[number] | null | undefined
    ): string | null => {
      const toolName =
        typeof activity?.metadata?.toolName === "string" ? activity.metadata.toolName : "";
      if (!toolName) return null;
      const action = humanizeSkillToolName(toolName);
      const target =
        typeof activity?.metadata?.target === "string" ? activity.metadata.target.trim() : "";
      if (toolName.startsWith("skill_registry_")) {
        return target ? `${target} (${action})` : action;
      }
      return action;
    };
    const skillActivities = orchestratorActivities.filter((activity) => {
      const toolName = activity.metadata?.toolName;
      return (
        typeof toolName === "string" &&
        (toolName.startsWith("skill_") || toolName.startsWith("skill_registry_"))
      );
    });
    const runningSkillNames = Array.from(
      new Set(
        skillActivities
          .filter((activity) => activity.status === "running")
          .map((activity) => describeSkillActivity(activity) || "")
          .filter((name) => name.length > 0)
      )
    );
    const latestSkill = [...skillActivities]
      .reverse()
      .find((activity) => typeof activity.metadata?.toolName === "string");
    const lastSkillName = describeSkillActivity(latestSkill);

    const branchSpawnActivities = orchestratorActivities.filter(
      (activity) => activity.metadata?.toolName === "runtime_branch_parallel"
    );
    const getBranchLaunchCount = (
      activity: (typeof orchestratorActivities)[number]
    ): number => {
      const resultRecord = asRecord(activity.result);
      const launchedFromResult =
        typeof resultRecord?.launchedTasks === "number"
          ? resultRecord.launchedTasks
          : typeof resultRecord?.launched_tasks === "number"
            ? resultRecord.launched_tasks
            : null;
      if (
        typeof launchedFromResult === "number" &&
        Number.isFinite(launchedFromResult) &&
        launchedFromResult >= 0
      ) {
        return launchedFromResult;
      }
      const stats = activity.summary?.stats || {};
      const launched =
        typeof stats.launchedBranches === "number"
          ? stats.launchedBranches
          : typeof stats.launchedTasks === "number"
            ? stats.launchedTasks
            : null;
      if (typeof launched === "number" && Number.isFinite(launched) && launched >= 0) {
        return launched;
      }
      const detailText = [
        typeof activity.metadata?.title === "string" ? activity.metadata.title : "",
        typeof activity.detail === "string" ? activity.detail : "",
      ]
        .filter(Boolean)
        .join(" ");
      const match = detailText.match(/(\d+)\s+(?:worker\s+)?branches?/i);
      if (match) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
      }
      return activity.status === "complete" ? 1 : 0;
    };
    const latestBranchSpawn = branchSpawnActivities.length
      ? branchSpawnActivities[branchSpawnActivities.length - 1]
      : null;
    const latestBranchResult = asRecord(latestBranchSpawn?.result);
    const latestBranchResultRows = Array.isArray(latestBranchResult?.results)
      ? latestBranchResult.results
      : [];
    const latestBranchCompleted = latestBranchResultRows.filter((row) => {
      const record = asRecord(row);
      return record?.status === "completed";
    }).length;
    const latestBranchOther = latestBranchResultRows.length - latestBranchCompleted;
    const launchedForLatest = latestBranchSpawn ? getBranchLaunchCount(latestBranchSpawn) : 0;
    const latestBranchDetail =
      (launchedForLatest > 0 && latestBranchSpawn?.status === "complete"
        ? `${launchedForLatest} launched, ${latestBranchCompleted} completed${latestBranchOther > 0 ? `, ${latestBranchOther} incomplete/failed` : ""}`
        : null) ||
      (typeof latestBranchSpawn?.summary?.headline === "string" &&
        latestBranchSpawn.summary.headline.trim()) ||
      (typeof latestBranchSpawn?.detail === "string" && latestBranchSpawn.detail.trim()) ||
      (typeof latestBranchSpawn?.metadata?.subtitle === "string" &&
        latestBranchSpawn.metadata.subtitle.trim()) ||
      null;
    const totalBranchForks = branchSpawnActivities.reduce(
      (sum, activity) => sum + getBranchLaunchCount(activity),
      0
    );

    return {
      totalSkillCalls: skillActivities.length,
      runningSkillNames,
      lastSkillName,
      totalBranchForks,
      latestBranchDetail,
    };
  }, [orchestratorActivities]);

  // #disabled - Voice control removed because of major implementation change (realtime voice)
  // const handleVoiceCommand = useCallback((command: VoiceCommand) => {
  //   console.log("[voice] Command:", command);
  //   // Handle voice commands - for now just type the text
  //   if (command.type === "type_text" && command.text) {
  //     // The orchestrator.sendMessage will be called by UnifiedInput
  //   }
  // }, []);

  // const voice = useVoiceControl({
  //   onCommand: handleVoiceCommand,
  //   onTranscript: (text, isFinal) => {
  //     if (isFinal && text.trim()) {
  //       (async () => {
  //         const wantsObsidian = /(^|\s)@obsidian(\s|$)/i.test(text);
  //         const wantsLocal = /(^|\s)@(obsidian|browser|files)(\s|$)/i.test(text);

  //         let deviceId: string | null =
  //           connectorOk && activeDeviceIdRef.current ? activeDeviceIdRef.current : null;
  //         if (wantsLocal) {
  //           deviceId = await ensureActiveDeviceIdReady();
  //           if (!deviceId) {
  //             openConnectorMenu();
  //             return;
  //           }
  //         }

  //         const ensuredVault = wantsObsidian
  //           ? await ensureObsidianVaultSelected()
  //           : obsidianVaultPath || null;

  //         if (wantsObsidian && !ensuredVault) {
  //           openObsidianSetup();
  //           return;
  //         }

  //         orchestrator.sendMessage(text, {
  //           memoryEnabled,
  //           deviceId: deviceId || undefined,
  //           obsidianVaultPath: ensuredVault || undefined,
  //         });
  //       })();
  //     }
  //   },
  // });

  const loadDataConnections = useCallback(async () => {
    const res = await fetch("/api/datagran/connection", { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        typeof json?.error === "string" ? json.error : "Failed to load data connections"
      );
    }

    const rawConnections = Array.isArray(json?.connections)
      ? (json.connections as Array<Record<string, unknown>>)
      : [];

    const connections = rawConnections.reduce<DataConnection[]>((acc, config) => {
        const platform =
          typeof config.provider === "string" ? (config.provider as PlatformType) : null;
        const id = typeof config.agentId === "string" ? config.agentId : "";
        if (!platform || !id) return acc;
        const fallbackName = platform
          .replace(/_/g, " ")
          .replace(/\b\w/g, (c: string) => c.toUpperCase());
        const status =
          config.status === "expired" || config.status === "error"
            ? config.status
            : "connected";
        acc.push({
          id,
          platform,
          name:
            typeof config.name === "string" && config.name.trim()
              ? config.name.trim()
              : fallbackName,
          connectionId:
            typeof config.connectionId === "string" && config.connectionId.trim()
              ? config.connectionId.trim()
              : undefined,
          status,
          statusMessage:
            typeof config.statusMessage === "string" && config.statusMessage.trim()
              ? config.statusMessage.trim()
              : undefined,
          lastSync:
            typeof config.createdAt === "string" && config.createdAt.trim()
              ? new Date(config.createdAt)
              : undefined,
        });
        return acc;
      }, []);

    setDataConnections(connections);
  }, []);

  // Load user and check auth
  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();

      if (error || !user) {
        router.push("/login");
        return;
      }

      if (!bypassEnterpriseDemo) {
        try {
          const enterpriseRes = await fetch("/api/enterprise-review/access", {
            cache: "no-store",
          });
          const enterpriseJson = await enterpriseRes.json().catch(() => ({}));
          if (enterpriseRes.ok && enterpriseJson?.enabled === true) {
            router.replace(
              typeof enterpriseJson.route === "string" && enterpriseJson.route.trim()
                ? enterpriseJson.route.trim()
                : "/enterprise-review"
            );
            return;
          }
        } catch {
          // ignore
        }
      }

      setUserId(user.id);
      setUserEmail(user.email || undefined);

      try {
        const res = await fetch("/api/workspaces/current");
        const json = await res.json().catch(() => ({}));
        const members = Array.isArray(json?.workspace?.members)
          ? json.workspace.members
          : [];
        setTeamMembers(buildTeamMembers(members));
        if (res.ok && json?.workspace?.id) {
          setWorkspaceInfo({
            id: String(json.workspace.id),
            name: typeof json.workspace.name === "string" ? json.workspace.name : "Workspace",
            role: json.workspace.role === "admin" ? "admin" : "member",
          });
        }
      } catch {
        // ignore
      }

      // Load API key status
      const { data: keys } = await supabase
        .from("user_api_keys")
        .select("provider, created_at")
        .eq("user_id", user.id);

      if (keys) {
        const keyStatus: typeof apiKeys = {};
        for (const key of keys) {
          keyStatus[key.provider as Provider] = {
            configured: true,
            lastUpdated: key.created_at,
          };
        }
        setApiKeys(keyStatus);
      }

      // Load LLM key mode (groovy vs user)
      let userHasKeys = false;
      let userModeExplicitlySet = false;
      try {
        const res = await fetch("/api/user-api-keys");
        const json = await res.json().catch(() => ({}));
        const mode = json?.mode;
        if (mode === "groovy" || mode === "user") {
          setLlmKeyMode(mode);
        }
        if (typeof json?.modeExplicitlySet === "boolean") {
          userModeExplicitlySet = json.modeExplicitlySet;
        }
        if (json?.keyModes && typeof json.keyModes === "object") {
          setLlmKeyModes(json.keyModes);
        }
        // Check if user has any keys configured
        if (json?.keys && typeof json.keys === "object") {
          userHasKeys = Object.keys(json.keys).length > 0;
        }
      } catch {
        // ignore
      }

      // Check if user needs welcome onboarding (first time)
      try {
        const prefsRes = await fetch("/api/user-preferences");
        const prefsJson = await prefsRes.json().catch(() => ({}));
        const connectorMode = prefsJson?.onboardingData?.connectorMode;
        const connectorDeviceIdRaw = prefsJson?.onboardingData?.connectorDeviceId;
        const autoRunRaw = prefsJson?.onboardingData?.autoRunTeamRequests;
        setAutoRunTeamRequests(typeof autoRunRaw === "boolean" ? autoRunRaw : false);
        setPreferredConnectorDeviceId(
          typeof connectorDeviceIdRaw === "string" && connectorDeviceIdRaw.trim()
            ? connectorDeviceIdRaw.trim()
            : null
        );
        const mode: "local" | "groovy" | null =
          connectorMode === "groovy" || connectorMode === "local" ? connectorMode : null;
        setConnectorModePref(mode);
        setPrefersHostedConnector(connectorMode === "groovy");
        // Best-effort: always keep hosted device id (if available) so local mode
        // can avoid auto-selecting hosted connector after refresh.
        try {
          const hmRes = await fetch("/api/hosted-macs/request", { cache: "no-store" });
          const hmJson = await hmRes.json().catch(() => ({}));
          if (hmRes.ok && hmJson?.device?.device_id) {
            setHostedPreferredDeviceId(String(hmJson.device.device_id));
          } else {
            setHostedPreferredDeviceId(null);
          }
        } catch {
          setHostedPreferredDeviceId(null);
        }
        const onboardingCompleted = prefsJson?.onboardingCompleted === true;
        const savedStep = prefsJson?.onboardingStep;
        // Show welcome if: never completed AND user hasn't set up anything yet
        // (no explicit mode choice + no saved keys)
        if (!onboardingCompleted && !userHasKeys && !userModeExplicitlySet) {
          // Resume from saved step if available
          const validSteps = ["welcome", "connector", "api_keys", "chat_agent", "claude_cli", "done"];
          if (savedStep && validSteps.includes(savedStep)) {
            setOnboardingInitialStep(savedStep);
          }
          setShowWelcomeOnboarding(true);
        }
      } catch {
        // ignore API errors - don't block dashboard
      } finally {
        setConnectorPrefsLoaded(true);
      }

      // At this point auth, workspace, key mode, and connector preferences are ready.
      // The remaining loads feed secondary panels and external integration status, so
      // keep them from holding the full-screen dashboard loader.
      setLoading(false);

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      try {
        const aiyraRes = await fetch("/api/aiyra/config?fallback=local", {
          cache: "no-store",
        });
        const aiyraJson = await aiyraRes.json().catch(() => ({}));
        const cfg =
          aiyraRes.ok && aiyraJson?.aiyra && typeof aiyraJson.aiyra === "object"
            ? (aiyraJson.aiyra as Record<string, unknown>)
            : null;
        if (cfg) {
          const wakeSensitivity = Number(cfg.wakeSensitivity);
          const idleTimeoutMs = Number(cfg.idleTimeoutMs);
          const twilio = readAiyraTwilioConfig(cfg);
          setAiyraConfig({
            configured: cfg.configured === true,
            enabled: cfg.enabled === true,
            personaPrompt:
              typeof cfg.personaPrompt === "string" ? cfg.personaPrompt : "",
            voiceId: typeof cfg.voiceId === "string" ? cfg.voiceId : "",
            ttsSpeed: readAiyraTtsSpeed(cfg),
            wakeWord:
              typeof cfg.wakeWord === "string" && cfg.wakeWord.trim()
                ? cfg.wakeWord
                : "hey groovy",
            wakeSensitivity:
              Number.isFinite(wakeSensitivity) && wakeSensitivity >= 0 && wakeSensitivity <= 1
                ? wakeSensitivity
                : 0.5,
            idleTimeoutMs:
              Number.isFinite(idleTimeoutMs) && idleTimeoutMs >= 2000
                ? Math.trunc(idleTimeoutMs)
                : 12000,
            twilioEnabled: twilio.enabled,
            twilioFrom: twilio.from,
            twilioTo: twilio.to,
            updatedAt:
              typeof cfg.updatedAt === "string" ? cfg.updatedAt : null,
          });
        }
      } catch {
        // ignore
      }

      // Load all Files Agents
      const { data: filesAgentsData, error: filesAgentError } = await supabase
        .from("agents")
        .select("id, name, created_at")
        .eq("user_id", user.id)
        .eq("type", "files-agent")
        .order("created_at", { ascending: false });

      console.log("[Dashboard] Files agents query result:", { filesAgentsData, filesAgentError });

      if (filesAgentsData && filesAgentsData.length > 0) {
        setFilesAgents(
          filesAgentsData.map((a) => ({
            id: a.id,
            name: a.name,
            createdAt: a.created_at,
          }))
        );
      }

      // Load all AI Chat agents
      const { data: chatAgentsData } = await supabase
        .from("agents")
        .select("id, name, provider, model, created_at")
        .eq("user_id", user.id)
        .eq("type", "ai-chat")
        .order("created_at", { ascending: false });

      if (chatAgentsData && chatAgentsData.length > 0) {
        setChatAgents(
          chatAgentsData.map((a) => ({
            id: a.id,
            name: a.name,
            provider: a.provider || undefined,
            model: a.model || undefined,
          }))
        );
        // Restore last active chat agent from localStorage
        try {
          const last = window.localStorage.getItem(lastChatAgentStorageKey);
          if (last && chatAgentsData.some((a) => a.id === last)) {
            setActiveChatAgentId(last);
          }
        } catch {
          // ignore
        }
      }

      // Load all Claude Code sessions (only those with valid device+workspace config)
      const { data: codeAgentsData } = await supabase
        .from("claude_code_agent_configs")
        .select("agent_id, workspace_id, code_cli_provider, agents!inner(id, name, created_at), device_workspaces(root_path)")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (codeAgentsData) {
        const mapped: CodeAgentInfo[] = codeAgentsData
          .map((row) => {
            const agent = row.agents as unknown as { id: string; name: string; created_at: string } | null;
            if (!agent) return null;
            const ws = row.device_workspaces as unknown as { root_path?: string } | null;
            const provider = (row as { code_cli_provider?: string }).code_cli_provider;
            return {
              id: agent.id,
              name: agent.name,
              createdAt: agent.created_at,
              workspaceId: row.workspace_id ? String(row.workspace_id) : undefined,
              workspaceRoot: ws?.root_path,
              codeCliProvider: provider === "codex" ? "codex" : "claude",
            } as CodeAgentInfo;
          })
          .filter((a): a is CodeAgentInfo => !!a);
        setCodeAgents(mapped);
        try {
          const last = window.localStorage.getItem(lastCodeAgentStorageKey);
          if (last && mapped.some((a) => a.id === last)) {
            setActiveCodeAgentId(last);
          }
        } catch {
          // ignore
        }
      }

      try {
        await loadDataConnections();
      } catch (e) {
        console.warn("[DataConnections] Failed to load live statuses:", e);
        setDataConnections([]);
      }

      // Load web pixels
      try {
        const pixelsRes = await fetch("/api/datagran/pixel-sites");
        if (pixelsRes.ok) {
          const pixelsData = await pixelsRes.json();
          if (pixelsData.sites) {
            setWebPixels(
              pixelsData.sites.map((site: { id: string; name: string; domain: string; events_7d?: number }) => ({
                id: site.id,
                siteId: site.id,
                siteName: site.name,
                domain: site.domain,
                status: "active" as const,
                eventsLast7Days: site.events_7d,
              }))
            );
          }
        }
      } catch {
        // Pixels API might not be available, ignore
      }
    };

    checkAuth();
  }, [supabase, router, buildTeamMembers, bypassEnterpriseDemo, loadDataConnections]);

  // Load AI Chat sessions when active AI Chat agent changes
  useEffect(() => {
    const agentId = activeChatAgentId || chatAgents[0]?.id || null;
    if (!agentId) {
      setChatSessions([]);
      setActiveChatSessionId(null);
      return;
    }

    const storageKey = `groovy:ai-chat:lastSession:${agentId}`;
    (async () => {
      try {
        const res = await fetch(`/api/chat/sessions?agentId=${encodeURIComponent(agentId)}`);
        const json = await res.json().catch(() => ({}));
        const sessions = Array.isArray(json.sessions) ? json.sessions : [];
        setChatSessions(
          sessions.map((s: { id: string; title?: string; updated_at?: string; created_at?: string }) => ({
            id: String(s.id),
            title: String(s.title || "New chat"),
            updated_at: s.updated_at,
            created_at: s.created_at,
          }))
        );

        let preferred: string | null = null;
        try {
          preferred = window.localStorage.getItem(storageKey);
        } catch {
          preferred = null;
        }
        const chosen =
          (preferred && sessions.some((s: { id: string }) => String(s.id) === preferred) && preferred) ||
          (sessions[0]?.id ? String(sessions[0].id) : null);
        setActiveChatSessionId(chosen);
      } catch {
        // ignore
      }
    })();
  }, [activeChatAgentId, chatAgents]);

  // Load Files sessions when active Files agent changes
  useEffect(() => {
    const agentId = activeFilesAgentId || filesAgents[0]?.id || null;
    if (!agentId) {
      setFilesSessions([]);
      setActiveFilesSessionId(null);
      return;
    }

    const storageKey = `groovy:files:lastSession:${agentId}`;
    (async () => {
      try {
        // Files sessions are loaded from orchestrator agent sessions API
        const res = await fetch(`/api/orchestrator/agent-sessions/list?agentType=files`);
        const json = await res.json().catch(() => ({}));
        const sessions = Array.isArray(json.sessions) ? json.sessions : [];
        setFilesSessions(
          sessions.map((s: { agentSessionId: string; title?: string }) => ({
            id: String(s.agentSessionId),
            title: String(s.title || "Files session"),
          }))
        );

        let preferred: string | null = null;
        try {
          preferred = window.localStorage.getItem(storageKey);
        } catch {
          preferred = null;
        }
        const chosen =
          (preferred && sessions.some((s: { agentSessionId: string }) => String(s.agentSessionId) === preferred) && preferred) ||
          (sessions[0]?.agentSessionId ? String(sessions[0].agentSessionId) : null);
        setActiveFilesSessionId(chosen);
      } catch {
        // ignore
      }
    })();
  }, [activeFilesAgentId, filesAgents]);

  // Initialize active files agent from localStorage
  useEffect(() => {
    if (filesAgents.length > 0) {
      try {
        const last = window.localStorage.getItem(lastFilesAgentStorageKey);
        if (last && filesAgents.some((a) => a.id === last)) {
          setActiveFilesAgentId(last);
        } else {
          setActiveFilesAgentId(filesAgents[0]?.id || null);
        }
      } catch {
        setActiveFilesAgentId(filesAgents[0]?.id || null);
      }
    }
  }, [filesAgents]);

  const refreshCodeAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/claude-code/sessions", { method: "GET" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) return;
      const sessions: Array<{
        id?: unknown;
        name?: unknown;
        createdAt?: unknown;
        workspaceId?: unknown;
        workspaceRoot?: unknown;
        codeCliProvider?: unknown;
      }> = Array.isArray(
        json.sessions
      )
        ? (json.sessions as Array<{
            id?: unknown;
            name?: unknown;
            createdAt?: unknown;
            workspaceId?: unknown;
            workspaceRoot?: unknown;
            codeCliProvider?: unknown;
          }>)
        : [];
      setCodeAgents(
        sessions
          .map((s) => ({
            id: String(s.id || ""),
            name: String(s.name || ""),
            createdAt: s.createdAt ? String(s.createdAt) : undefined,
            workspaceId: s.workspaceId ? String(s.workspaceId) : undefined,
            workspaceRoot: s.workspaceRoot ? String(s.workspaceRoot) : undefined,
            codeCliProvider: (s.codeCliProvider === "codex" ? "codex" : "claude") as CodeCliProvider,
          }))
          .filter((s) => s.id && s.name)
      );
    } catch {
      // ignore
    }
  }, []);

  // Load Datagran Link widget script
  useEffect(() => {
    if (typeof window === "undefined") return;

    console.log("[Datagran Script] Checking if already loaded...");
    
    // Check if already loaded (defer to avoid sync setState)
    const checkLoaded = () => {
      if (window.DatagranLink) {
        console.log("[Datagran Script] Already loaded!");
        setDatagranScriptLoaded(true);
        return true;
      }
      return false;
    };

    if (checkLoaded()) return;

    console.log("[Datagran Script] Loading script...");
    const script = document.createElement("script");
    script.src = "https://www.datagran.io/embed/link.js";
    script.async = true;
    script.onload = () => {
      console.log("[Datagran Script] Script loaded successfully!");
      setDatagranScriptLoaded(true);
    };
    script.onerror = (e) => console.error("[Datagran Script] Failed to load:", e);
    document.head.appendChild(script);
  }, []);

  // Handle sign out
  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  const ensureLinkedFilesSession = useCallback(
    async (orchSessionId: string): Promise<string | null> => {
      try {
        const res = await fetch(
          `/api/orchestrator/agent-sessions?orchestratorSessionId=${encodeURIComponent(
            orchSessionId
          )}&agentType=files`
        );
        const json = await res.json().catch(() => ({}));
        if (res.ok && json?.session?.agentSessionId) return String(json.session.agentSessionId);

        const res2 = await fetch("/api/orchestrator/agent-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orchestratorSessionId: orchSessionId, agentType: "files" }),
        });
        const json2 = await res2.json().catch(() => ({}));
        if (res2.ok && json2?.session?.agentSessionId) return String(json2.session.agentSessionId);
      } catch {
        // ignore
      }
      return null;
    },
    []
  );

  // Open the Files panel with the correct linked session
  const openFilesPanel = useCallback(async () => {
    if (filesAgents.length === 0) {
      openFilesSetup();
      return;
    }
    const orchId = orchestrator.currentSessionId;
    if (orchId) {
      // Ensure we have the linked session ID BEFORE opening the panel
      const sid = await ensureLinkedFilesSession(orchId);
      setFilesPanelSessionId(sid);
    }
    setShowFilesPanel(true);
  }, [ensureLinkedFilesSession, filesAgents.length, openFilesSetup, orchestrator.currentSessionId]);

  const stripTeamMentionsFromMessage = useCallback(
    (message: string) => {
      const regex = /@([a-z0-9_]{1,50})/gi;
      const stripped = message.replace(regex, (full, rawHandle: string, offset: number) => {
        const prev = offset > 0 ? message[offset - 1] : "";
        if (offset > 0 && /[A-Za-z0-9_.%+-]/.test(prev)) return full; // likely email
        const handle = String(rawHandle || "").toLowerCase();
        if (!handle || RESERVED_AGENT_HANDLES.has(handle)) return full;
        if (teamMemberHandleSet.has(handle)) return "";
        return full;
      });
      return stripped.replace(/\s+/g, " ").trim();
    },
    [RESERVED_AGENT_HANDLES, teamMemberHandleSet]
  );

  const fnv1a32 = useCallback((input: string) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      // FNV-1a prime 16777619
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }, []);

  const createWorkspaceTeamRequests = useCallback(
    async (params: {
      sessionId?: string;
      agentId?: string;
      originalMessage: string;
      mentionedHandles: string[];
      requiresConnector: boolean;
    }) => {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const agentId = typeof params.agentId === "string" ? params.agentId : "";
      const mentionedHandles = Array.isArray(params.mentionedHandles) ? params.mentionedHandles : [];
      if ((!sessionId && !agentId) || mentionedHandles.length === 0) return;

      const requestedUserIds = mentionedHandles
        .map((h) => teamMemberByHandle.get(String(h || "").toLowerCase())?.id)
        .filter((x): x is string => typeof x === "string" && x.length > 0);

      if (requestedUserIds.length === 0) return;

      const stripped = stripTeamMentionsFromMessage(params.originalMessage);
      const message = stripped || params.originalMessage.trim();
      if (!message) return;

      // Deduplicate within a short window (avoid double-submit / multi-tab flakiness).
      const bucket = Math.floor(Date.now() / 15000); // 15s
      const dedupeKey = `mention:${bucket}:${fnv1a32(message.toLowerCase())}`;

      await fetch("/api/workspaces/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionId || undefined,
          agentId: agentId || undefined,
          requestedUserIds,
          message,
          dedupeKey,
          expiresInSeconds: 60 * 60,
          requiresConnector: params.requiresConnector,
          provider: "team_mention",
          metadata: {
            originalMessage: params.originalMessage,
            requestedByHandle: myTeamMember?.handle || null,
            requestedByLabel: myTeamMember?.label || userEmail || null,
            mentionedHandles,
          },
        }),
      }).catch(() => {});
    },
    [
      fnv1a32,
      myTeamMember?.handle,
      myTeamMember?.label,
      stripTeamMentionsFromMessage,
      teamMemberByHandle,
      userEmail,
    ]
  );

  // Handle sending a message
  const handleSend = useCallback(
    async (message: string, files?: File[]) => {
      const mentionedHandles = parseTeamMentions(message);
      const shouldShare = mentionedHandles.length > 0;
      // If user explicitly targets Obsidian, ensure we have a vault selected first.
      const wantsObsidian = /(^|\s)@obsidian(\s|$)/i.test(message);
      const wantsChat = /(^|\s)@(chat|ai)(?=$|\s|[:(])/i.test(message);
      // If the user attached files, we route to the Files *document* agent (cloud) and do not require local connector.
      const hasUploads = Array.isArray(files) && files.length > 0;
      const wantsLocal = !hasUploads && /(^|\s)@(obsidian|browser|files|pages|schedule)(\s|$)/i.test(message);

      let deviceId: string | null =
        connectorOk && activeDeviceIdRef.current ? activeDeviceIdRef.current : null;
      if (wantsLocal) {
        deviceId = await ensureActiveDeviceIdReady();
        if (!deviceId) {
          openConnectorMenu();
          return;
        }
      }

      const ensuredVault = wantsObsidian ? await ensureObsidianVaultSelected() : obsidianVaultPath || null;

      if (wantsObsidian && !ensuredVault) {
        // Don't spam connector calls that must fail. Bring user directly to vault setup.
        openObsidianSetup();
        return;
      }

      let sessionId = orchestrator.currentSessionId;
      if (shouldShare && !sessionId) {
        const firstWords = message.split(" ").slice(0, 5).join(" ");
        sessionId = await orchestrator.createSession(
          firstWords + (message.length > 30 ? "..." : "")
        );
      }

      if (shouldShare && sessionId) {
        const agentId = orchestrator.getAgentIdForSession(sessionId) || undefined;
        await shareSessionWithWorkspace(sessionId);
        await createWorkspaceTeamRequests({
          sessionId,
          agentId,
          originalMessage: message,
          mentionedHandles,
          requiresConnector: wantsLocal,
        });
      }

      orchestrator.sendMessage(message, {
        memoryEnabled,
        deviceId: deviceId || undefined,
        obsidianVaultPath: ensuredVault || undefined,
        files,
        // If user selected an AI Chat agent via "/" (or has one active), route @chat to that agent.
        chatAgentId:
          wantsChat
            ? activeChatAgentId || chatAgents[0]?.id || undefined
            : undefined,
        chatAgentName:
          wantsChat
            ? chatAgents.find((a) => a.id === (activeChatAgentId || chatAgents[0]?.id))?.name
            : undefined,
        chatSessionId:
          wantsChat
            ? activeChatSessionId || undefined
            : undefined,
      });
    },
    [
      parseTeamMentions,
      shareSessionWithWorkspace,
      createWorkspaceTeamRequests,
      orchestrator,
      memoryEnabled,
      obsidianVaultPath,
      ensureObsidianVaultSelected,
      ensureActiveDeviceIdReady,
      openConnectorMenu,
      activeChatAgentId,
      activeChatSessionId,
      chatAgents,
      connectorOk,
    ]
  );

  const handleSiteDeploy = useCallback(() => {
    const slug =
      typeof siteBuilderState.slug === "string" && siteBuilderState.slug.trim()
        ? siteBuilderState.slug.trim()
        : "";

    if (!slug) {
      setSiteBuilderState((prev) => ({
        ...prev,
        status: "error",
        errorMessage: "Missing site slug. Start the site again, then deploy.",
      }));
      return;
    }

    const deployMessage =
      `@pages deploy site "${slug}" now using site_publish. ` +
      `Use current files from ~/.groovy/sites/${slug} and return the live URL.`;

    setSiteBuilderState((prev) => ({
      ...prev,
      status: "deploying",
      errorMessage: undefined,
      startRequestedAt: Date.now(),
    }));
    void handleSend(deployMessage);
  }, [handleSend, siteBuilderState.slug]);

  const handleSiteRestartPreview = useCallback((targetSlug?: string) => {
    const slugFromTarget =
      typeof targetSlug === "string" && targetSlug.trim() ? targetSlug.trim() : "";
    const slugFromState =
      typeof siteBuilderState.slug === "string" && siteBuilderState.slug.trim()
        ? siteBuilderState.slug.trim()
        : "";
    const slug = slugFromTarget || slugFromState;

    if (!slug) {
      setSiteBuilderState((prev) => ({
        ...prev,
        status: "error",
        errorMessage: "Missing site slug. Start the site again first.",
      }));
      return;
    }

    setShowSiteBuilderPanel(true);
    setSiteBuilderState((prev) => ({
      ...prev,
      slug,
      status: "starting",
      devPort: undefined,
      tunnelNonce: undefined,
      errorMessage: undefined,
      startRequestedAt: Date.now(),
    }));

    void handleConnectorExecuteWithSiteDetection({
      type: "site_dev_start",
      params: {
        slug,
        sitePath: `~/.groovy/sites/${slug}`,
      },
      toolCallId: `site-dev-restart-${Date.now()}`,
      toolName: "site_dev",
      agent: "pages",
    });
  }, [siteBuilderState.slug, handleConnectorExecuteWithSiteDetection]);

  const handleSiteStopPreview = useCallback((targetSlug?: string) => {
    const slugFromTarget =
      typeof targetSlug === "string" && targetSlug.trim() ? targetSlug.trim() : "";
    const slugFromState =
      typeof siteBuilderState.slug === "string" && siteBuilderState.slug.trim()
        ? siteBuilderState.slug.trim()
        : "";
    const slug = slugFromTarget || slugFromState;

    if (!slug) {
      setSiteBuilderState((prev) => ({
        ...prev,
        status: "error",
        errorMessage: "Missing site slug. Select a site first.",
      }));
      return;
    }

    void handleConnectorExecuteWithSiteDetection({
      type: "site_dev_stop",
      params: {
        slug,
        sitePath: `~/.groovy/sites/${slug}`,
      },
      toolCallId: `site-dev-stop-${Date.now()}`,
      toolName: "site_dev",
      agent: "pages",
    });
  }, [siteBuilderState.slug, handleConnectorExecuteWithSiteDetection]);

  const handleSelectSiteFromManager = useCallback((selection: {
    slug?: string | null;
    status?: string | null;
    productionUrl?: string | null;
  }) => {
    const nextSlug =
      typeof selection.slug === "string" && selection.slug.trim()
        ? selection.slug.trim()
        : undefined;
    const nextStatus =
      typeof selection.status === "string" && selection.status.trim()
        ? selection.status.trim()
        : undefined;
    const nextProductionUrl =
      typeof selection.productionUrl === "string" && selection.productionUrl.trim()
        ? selection.productionUrl.trim()
        : undefined;

    setShowSiteBuilderPanel(Boolean(nextSlug));
    setSiteBuilderState((prev) => {
      if (!nextSlug) {
        return {
          ...prev,
          slug: undefined,
          status: "draft",
          devPort: undefined,
          tunnelNonce: undefined,
          productionUrl: undefined,
          errorMessage: undefined,
          startRequestedAt: undefined,
        };
      }
      return {
        ...prev,
        slug: nextSlug,
        status: nextStatus || prev.status || "draft",
        devPort: undefined,
        tunnelNonce: undefined,
        productionUrl: nextProductionUrl,
        errorMessage: undefined,
        startRequestedAt: undefined,
      };
    });
  }, []);

  const handleCloseSiteBuilderPanel = useCallback(() => {
    setShowSiteBuilderPanel(false);
    setSiteBuilderExpanded(false);
    setSiteBuilderState({});
    siteBuilderStatusSyncKeyRef.current = null;
    try {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(siteBuilderStorageKey);
      }
    } catch {
      // ignore storage failures
    }
  }, [siteBuilderStorageKey]);

  const loadPendingTeamRequests = useCallback(async () => {
    const res = await fetch("/api/workspaces/requests?status=pending", { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    const rows = Array.isArray(json?.requests) ? (json.requests as WorkspaceOrchestratorRequestRow[]) : [];
    if (res.ok && json?.ok === true) {
      setPendingTeamRequests(rows);
    }
  }, []);

  useEffect(() => {
    if (!_userId) return;
    loadPendingTeamRequests().catch(() => {});
  }, [_userId, loadPendingTeamRequests]);

  // Realtime updates for pending team requests
  useEffect(() => {
    if (!_userId) return;

    const channel = supabase
      .channel(`workspace_orch_requests:${_userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "workspace_orchestrator_requests",
          filter: `requested_user_id=eq.${_userId}`,
        },
        () => {
          loadPendingTeamRequests().catch(() => {});
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [_userId, loadPendingTeamRequests, supabase]);

  const dismissTeamRequest = useCallback(async (id: string) => {
    if (!id) return;
    await fetch("/api/workspaces/requests", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "cancel", clientId: teamRequestsClientIdRef.current }),
    }).catch(() => {});
    loadPendingTeamRequests().catch(() => {});
  }, [loadPendingTeamRequests]);

  const runTeamRequest = useCallback((req: WorkspaceOrchestratorRequestRow) => {
    if (!req?.id) return;
    setTeamRequestToRun(req);
  }, []);

  // Execute a queued team request (handles session switching + claim + run + completion)
  useEffect(() => {
    if (!teamRequestToRun) return;
    if (!_userId) return;
    if (isRunningTeamRequestRef.current) return;
    if (orchestrator.isStreaming) return;

    // Ensure we're viewing the right conversation first so sendMessage uses correct history/state.
    const requestSessionId =
      typeof teamRequestToRun.session_id === "string" ? teamRequestToRun.session_id.trim() : "";
    const requestAgentId =
      typeof teamRequestToRun.agent_id === "string" ? teamRequestToRun.agent_id.trim() : "";
    const currentAgentId = orchestrator.getAgentIdForSession(orchestrator.currentSessionId);
    if (requestAgentId) {
      if (currentAgentId !== requestAgentId) {
        const candidateSession = orchestrator.sessions.find((s) => s.agentId === requestAgentId)?.id || null;
        if (candidateSession) {
          orchestrator.selectSession(candidateSession);
          return;
        }
        // If this user hasn't materialized a runtime conversation for the shared agent yet,
        // create/resolve it before running so we never execute in the wrong thread.
        void (async () => {
          try {
            const res = await fetch(`/api/orchestrator/agents/${encodeURIComponent(requestAgentId)}`, {
              cache: "no-store",
            });
            const json = await res.json().catch(() => ({}));
            const resolvedSessionId =
              typeof json?.session?.id === "string" ? json.session.id.trim() : "";
            if (res.ok && resolvedSessionId) {
              orchestrator.selectSession(resolvedSessionId);
            }
          } catch {
            // best-effort
          }
        })();
        return;
      }
    } else if (requestSessionId && orchestrator.currentSessionId !== requestSessionId) {
      orchestrator.selectSession(requestSessionId);
      return;
    }
    if (orchestrator.isLoading) return;

    const req = teamRequestToRun;
    const requestMessageRaw = req.request?.message;
    const requestMessage =
      typeof requestMessageRaw === "string"
        ? requestMessageRaw.trim()
        : String(requestMessageRaw || "").trim();
    if (!requestMessage) {
      setTeamRequestToRun(null);
      return;
    }

    isRunningTeamRequestRef.current = true;
    const startedAt = Date.now();

    (async () => {
      const requiresConnector = req.request?.requiresConnector === true;
      const wantsObsidian = /(^|\s)@obsidian(\s|$)/i.test(requestMessage);
      const wantsChat = /(^|\s)@(chat|ai)(?=$|\s|[:(])/i.test(requestMessage);
      const hasUploads = false;
      const wantsLocal =
        !hasUploads && /(^|\s)@(obsidian|browser|files|pages|schedule)(\s|$)/i.test(requestMessage);

      // Preflight: only claim if we can actually run.
      let deviceId: string | null =
        connectorOk && activeDeviceIdRef.current ? activeDeviceIdRef.current : null;
      if (requiresConnector || wantsLocal) {
        deviceId = await ensureActiveDeviceIdReady();
        if (!deviceId) return;
      }

      const ensuredVault = wantsObsidian
        ? await ensureObsidianVaultSelected()
        : obsidianVaultPath || null;
      if (wantsObsidian && !ensuredVault) return;

      // Claim atomically (multi-tab safe)
      const claimRes = await fetch("/api/workspaces/requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: req.id,
          action: "claim",
          clientId: teamRequestsClientIdRef.current,
        }),
      });
      const claimJson = await claimRes.json().catch(() => ({}));
      if (!claimRes.ok || claimJson?.claimed !== true) {
        return;
      }

      const requestedBy = teamMembers.find((m) => m.id === req.requested_by_user_id) || null;
      const messageMetadata: Record<string, unknown> = {
        workspace_request_id: req.id,
        workspace_request_session_id: req.session_id,
        workspace_request_agent_id: req.agent_id || null,
        workspace_request_requested_by_user_id: req.requested_by_user_id,
        workspace_request_requested_by_handle: requestedBy?.handle || null,
        workspace_request_requested_user_id: req.requested_user_id,
        workspace_request_requested_user_handle: myTeamMember?.handle || null,
      };

      // Wrap in try/catch so exceptions mark request as error (not stuck in "running")
      let ok = false;
      let errorMsg = "Unknown error";
      try {
        const sendResult = await orchestrator.sendMessage(requestMessage, {
          memoryEnabled,
          deviceId: deviceId || undefined,
          obsidianVaultPath: ensuredVault || undefined,
          suppressUserMessage: true,
          messageMetadata,
          chatAgentId:
            wantsChat
              ? activeChatAgentId || chatAgents[0]?.id || undefined
              : undefined,
          chatAgentName:
            wantsChat
              ? chatAgents.find((a) => a.id === (activeChatAgentId || chatAgents[0]?.id))?.name
              : undefined,
          chatSessionId: wantsChat ? activeChatSessionId || undefined : undefined,
        });
        ok = sendResult?.ok === true;
        errorMsg = ok ? "" : String(sendResult?.error || "Failed");
      } catch (err) {
        ok = false;
        errorMsg = err instanceof Error ? err.message : "Exception during execution";
      }

      await fetch("/api/workspaces/requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: req.id,
          action: ok ? "complete" : "error",
          clientId: teamRequestsClientIdRef.current,
          result: {
            ok,
            ranAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
          },
          error: ok ? null : errorMsg,
        }),
      }).catch(() => {});
    })()
      .catch(() => {})
      .finally(() => {
        isRunningTeamRequestRef.current = false;
        setTeamRequestToRun(null);
        loadPendingTeamRequests().catch(() => {});
      });
  }, [
    teamRequestToRun,
    _userId,
    orchestrator,
    connectorOk,
    ensureActiveDeviceIdReady,
    ensureObsidianVaultSelected,
    obsidianVaultPath,
    teamMembers,
    myTeamMember?.handle,
    memoryEnabled,
    activeChatAgentId,
    activeChatSessionId,
    chatAgents,
    loadPendingTeamRequests,
    orchestrator.sessions,
  ]);

  // Auto-run pending requests (one at a time)
  useEffect(() => {
    if (!autoRunTeamRequests) return;
    if (teamRequestToRun) return;
    if (isRunningTeamRequestRef.current) return;
    if (orchestrator.isStreaming) return;
    const next = pendingTeamRequests.find((r) => {
      const msgRaw = r.request?.message;
      const msg = typeof msgRaw === "string" ? msgRaw : String(msgRaw || "");
      const requiresConnector = r.request?.requiresConnector === true;
      const wantsLocal = /(^|\s)@(obsidian|browser|files|pages|schedule)(\s|$)/i.test(msg);
      if (requiresConnector || wantsLocal) return connectorOk;
      return true;
    });
    if (!next) return;
    setTeamRequestToRun(next);
  }, [autoRunTeamRequests, pendingTeamRequests, teamRequestToRun, connectorOk, orchestrator.isStreaming]);

  // WhatsApp pending-send confirmation (dashboard UI buttons)
  const isWhatsAppPendingConsumed = useCallback(
    (pendingMessageId: string) => {
      return orchestrator.messages.some((m) => {
        const meta = (m.metadata as Record<string, unknown> | undefined) || undefined;
        return (
          m.role === "assistant" &&
          !!meta &&
          typeof meta.whatsapp_send_consumed_of === "string" &&
          meta.whatsapp_send_consumed_of === pendingMessageId
        );
      });
    },
    [orchestrator.messages]
  );

  const isTelegramPendingConsumed = useCallback(
    (pendingMessageId: string) => {
      return orchestrator.messages.some((m) => {
        const meta = (m.metadata as Record<string, unknown> | undefined) || undefined;
        return (
          m.role === "assistant" &&
          !!meta &&
          typeof meta.telegram_send_consumed_of === "string" &&
          meta.telegram_send_consumed_of === pendingMessageId
        );
      });
    },
    [orchestrator.messages]
  );

  const currentOrchestratorSessionId = orchestrator.currentSessionId;
  const addOrchestratorLocalMessage = orchestrator.addLocalMessage;
  useEffect(() => {
    const currentSessionId =
      typeof currentOrchestratorSessionId === "string"
        ? currentOrchestratorSessionId.trim()
        : "";
    const health = connectorAiyraVoiceHealth;
    const healthSessionId =
      typeof health?.orchestrator_session_id === "string"
        ? health.orchestrator_session_id.trim()
        : "";
    const state = health?.twilio_supervisor_state || null;
    if (!currentSessionId || !healthSessionId || healthSessionId !== currentSessionId || !state) {
      return;
    }
    const entry = parseTwilioConversationEntry(state);
    if (!entry) return;
    setTwilioConversationThreads((prev) => {
      const existing = prev[currentSessionId] || [];
      const nextEntries = appendTwilioConversationEntry(existing, entry);
      if (nextEntries === existing) return prev;
      return {
        ...prev,
        [currentSessionId]: nextEntries,
      };
    });
  }, [currentOrchestratorSessionId, connectorAiyraVoiceHealth]);
  useEffect(() => {
    const currentSessionId =
      typeof currentOrchestratorSessionId === "string"
        ? currentOrchestratorSessionId.trim()
        : "";
    const health = connectorAiyraVoiceHealth;
    const healthSessionId =
      typeof health?.orchestrator_session_id === "string"
        ? health.orchestrator_session_id.trim()
        : "";
    const state = health?.twilio_supervisor_state || null;
    if (!currentSessionId || !healthSessionId || healthSessionId !== currentSessionId || !state) {
      return;
    }
    if (!isTerminalTwilioConversationState(state)) return;
    const existingEntries = twilioConversationThreads[currentSessionId] || [];
    const currentEntry = parseTwilioConversationEntry(state);
    const summaryEntries = currentEntry
      ? appendTwilioConversationEntry(existingEntries, currentEntry)
      : existingEntries;
    const summary = buildTwilioConversationSummaryMessage({
      state,
      entries: summaryEntries,
    });
    if (!summary) return;
    const existingSummary = orchestrator.messages.some((msg) => {
      const metadata =
        msg.metadata && typeof msg.metadata === "object"
          ? (msg.metadata as Record<string, unknown>)
          : null;
      return (
        metadata?.kind === "twilio_supervisor_summary" &&
        metadata.twilio_summary_key === summary.summaryKey
      );
    });
    if (existingSummary || twilioSummaryPersistedKeysRef.current.has(summary.summaryKey)) {
      return;
    }
    twilioSummaryPersistedKeysRef.current.add(summary.summaryKey);
    void fetch("/api/orchestrator/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: currentSessionId,
        role: "assistant",
        traceId: `twilio-summary:${summary.summaryKey}`,
        content: summary.content,
        metadata: summary.metadata,
      }),
    })
      .then(async (response) => {
        if (response.ok) return;
        throw new Error(await response.text().catch(() => "Failed to persist Twilio summary"));
      })
      .catch(() => {
        twilioSummaryPersistedKeysRef.current.delete(summary.summaryKey);
      });
  }, [
    currentOrchestratorSessionId,
    connectorAiyraVoiceHealth,
    orchestrator.messages,
    twilioConversationThreads,
  ]);
  const conversationMessages = useMemo(() => {
    const currentSessionId =
      typeof currentOrchestratorSessionId === "string"
        ? currentOrchestratorSessionId.trim()
        : "";
    const liveTwilioMessage = buildTwilioConversationStatusMessage({
      currentSessionId: currentOrchestratorSessionId,
      voiceHealth: connectorAiyraVoiceHealth,
      entries: currentSessionId ? twilioConversationThreads[currentSessionId] || [] : [],
    });
    if (!liveTwilioMessage) return orchestrator.messages;
    const filteredMessages = orchestrator.messages.filter(
      (msg) => msg.id !== liveTwilioMessage.id
    );
    const terminalSummaryKey =
      connectorAiyraVoiceHealth?.twilio_supervisor_state &&
      isTerminalTwilioConversationState(connectorAiyraVoiceHealth.twilio_supervisor_state)
        ? buildTwilioConversationSummaryKey(connectorAiyraVoiceHealth.twilio_supervisor_state)
        : "";
    const hasPersistedTerminalSummary =
      !!terminalSummaryKey &&
      filteredMessages.some((msg) => {
        const metadata =
          msg.metadata && typeof msg.metadata === "object"
            ? (msg.metadata as Record<string, unknown>)
            : null;
        return (
          metadata?.kind === "twilio_supervisor_summary" &&
          metadata.twilio_summary_key === terminalSummaryKey
        );
      });
    if (hasPersistedTerminalSummary) return filteredMessages;
    const lastAssistantIdx = [...filteredMessages]
      .map((msg, idx) => ({ msg, idx }))
      .reverse()
      .find((entry) => entry.msg.role === "assistant")?.idx;
    const insertIdx =
      typeof lastAssistantIdx === "number"
        ? Math.min(filteredMessages.length, lastAssistantIdx + 1)
        : filteredMessages.length;
    return [
      ...filteredMessages.slice(0, insertIdx),
      liveTwilioMessage,
      ...filteredMessages.slice(insertIdx),
    ];
  }, [
    currentOrchestratorSessionId,
    connectorAiyraVoiceHealth,
    orchestrator.messages,
    twilioConversationThreads,
  ]);
  const persistOrchestratorAssistant = useCallback(
    async (content: string, metadata: Record<string, unknown>) => {
      const sessionId = currentOrchestratorSessionId;
      if (!sessionId) return;

      // Immediately add to local state for instant UI feedback
      const tempId = `temp-${Date.now()}`;
      addOrchestratorLocalMessage({
        id: tempId,
        role: "assistant",
        content,
        metadata,
        timestamp: new Date(),
      });

      // Persist to DB (Realtime will eventually sync the real ID)
      await fetch("/api/orchestrator/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          role: "assistant",
          content,
          metadata,
        }),
      }).catch(() => {});
    },
    [currentOrchestratorSessionId, addOrchestratorLocalMessage]
  );

  const handleWhatsAppConfirmSend = useCallback(
    async (
      pendingMessageId: string,
      pending: {
        chatId: string;
        recipientDisplay?: string;
        text?: string;
        media?: Array<{
          url?: string;
          localPath?: string;
          storagePath?: string;
          fileId?: string;
          filename?: string;
          caption?: string;
        }>;
      }
    ) => {
      const text = typeof pending?.text === "string" ? pending.text.trim() : "";
      const media = Array.isArray(pending?.media) ? pending.media : [];
      if (!pendingMessageId || !pending?.chatId || (!text && media.length === 0)) return;
      if (whatsappConfirmBusyFor) return;
      if (isWhatsAppPendingConsumed(pendingMessageId)) return;
      const currentOrchSessionId =
        typeof orchestrator.currentSessionId === "string"
          ? orchestrator.currentSessionId.trim()
          : "";
      setWhatsappConfirmBusyFor(pendingMessageId);
      try {
        const results: Array<{
          toolName: "whatsapp_send_text" | "whatsapp_send_media";
          ok: boolean;
          raw: unknown;
          error?: string;
        }> = [];
        const normalizedMedia: Array<{
          url?: string;
          localPath?: string;
          storagePath?: string;
          fileId?: string;
          filename?: string;
          caption?: string;
        }> = [];
        const mediaPrecheckErrors: string[] = [];

        for (let i = 0; i < media.length; i++) {
          const item = media[i] || {};
          const url = typeof item.url === "string" ? item.url.trim() : "";
          const localPath =
            typeof item.localPath === "string" ? item.localPath.trim() : "";
          const storagePath =
            typeof item.storagePath === "string" ? item.storagePath.trim() : "";
          const fileId = typeof item.fileId === "string" ? item.fileId.trim() : "";
          if (!url && !localPath && !storagePath && !fileId) {
            mediaPrecheckErrors.push(`attachment_${i + 1}:missing_reference`);
            continue;
          }
          normalizedMedia.push({
            ...(url ? { url } : {}),
            ...(localPath ? { localPath } : {}),
            ...(storagePath ? { storagePath } : {}),
            ...(fileId ? { fileId } : {}),
            ...(typeof item.filename === "string" && item.filename.trim()
              ? { filename: item.filename.trim() }
              : {}),
            ...(typeof item.caption === "string" && item.caption.trim()
              ? { caption: item.caption.trim() }
              : {}),
          });
        }

        if (media.length > 0 && normalizedMedia.length !== media.length) {
          const errPreview = mediaPrecheckErrors.slice(0, 3).join("; ");
          await persistOrchestratorAssistant(
            `❌ Failed to send${pending.recipientDisplay ? ` to ${pending.recipientDisplay}` : ""}.` +
              (errPreview ? ` Errors: ${errPreview}` : ""),
            {
              whatsapp_send_consumed_of: pendingMessageId,
              whatsapp_send_result: {
                ok: false,
                error: "attachment_precheck_failed",
                details: mediaPrecheckErrors,
              },
            }
          );
          return;
        }

        let mediaFailed = false;
        for (let i = 0; i < normalizedMedia.length; i++) {
          const item = normalizedMedia[i] || {};
          const result = await handleConnectorExecute({
            type: "whatsapp_send_media",
            params: {
              chat_id: pending.chatId,
              recipient_display: pending.recipientDisplay || "",
              pending_message_id: pendingMessageId,
              ...(currentOrchSessionId
                ? { orchestrator_session_id: currentOrchSessionId }
                : {}),
              ...(item.url ? { url: item.url } : {}),
              ...(item.localPath ? { local_path: item.localPath } : {}),
              ...(item.storagePath ? { storage_path: item.storagePath } : {}),
              ...(item.fileId ? { file_id: item.fileId } : {}),
              ...(item.filename ? { filename: item.filename } : {}),
              ...(item.caption ? { caption: item.caption } : {}),
            },
            toolCallId: `whatsapp-send-media-${Date.now()}-${i + 1}`,
            toolName: "whatsapp_send_media",
            agent: "files",
            ...(currentOrchSessionId ? { sessionId: currentOrchSessionId } : {}),
          });
          if (result?.ok !== true) mediaFailed = true;
          results.push({
            toolName: "whatsapp_send_media",
            ok: result?.ok === true,
            raw: result,
            error: typeof result?.error === "string" ? result.error : undefined,
          });
        }

        // Do not send text if any attachment failed — avoids "text-only" sends.
        if (text && !(normalizedMedia.length > 0 && mediaFailed)) {
          const result = await handleConnectorExecute({
            type: "whatsapp_send_text",
            params: {
              chat_id: pending.chatId,
              text,
              pending_message_id: pendingMessageId,
              recipient_display: pending.recipientDisplay || "",
            },
            toolCallId: `whatsapp-send-text-${Date.now()}`,
            toolName: "whatsapp_send_text",
            agent: "files",
          });
          results.push({
            toolName: "whatsapp_send_text",
            ok: result?.ok === true,
            raw: result,
            error: typeof result?.error === "string" ? result.error : undefined,
          });
        } else if (text && normalizedMedia.length > 0 && mediaFailed) {
          results.push({
            toolName: "whatsapp_send_text",
            ok: false,
            raw: { ok: false, skipped: true, error: "skipped_due_media_failure" },
            error: "skipped_due_media_failure",
          });
        }

        const total = results.length;
        const okCount = results.filter((r) => r.ok).length;
        const mediaCount = results.filter((r) => r.toolName === "whatsapp_send_media").length;
        const failed = results.filter((r) => !r.ok);
        let msg = "";
        const to = pending.recipientDisplay ? ` to ${pending.recipientDisplay}` : "";
        if (total > 0 && okCount === total) {
          msg = `✅ Sent${to}.`;
          if (mediaCount > 0) {
            msg += ` (${mediaCount} attachment${mediaCount === 1 ? "" : "s"})`;
          }
        } else if (okCount > 0) {
          const errPreview = failed
            .slice(0, 2)
            .map((f) => f.error || "send_failed")
            .join("; ");
          msg = `⚠️ Partially sent${to} (${okCount}/${total} actions succeeded).`;
          if (errPreview) msg += ` Errors: ${errPreview}`;
        } else {
          const errPreview = failed
            .slice(0, 2)
            .map((f) => f.error || "send_failed")
            .join("; ");
          msg = `❌ Failed to send${to}.`;
          if (errPreview) msg += ` Errors: ${errPreview}`;
        }

        await persistOrchestratorAssistant(msg, {
          whatsapp_send_consumed_of: pendingMessageId,
          whatsapp_send_result:
            results.length === 1
              ? results[0]?.raw
              : results.map((r) => ({
                  toolName: r.toolName,
                  ok: r.ok,
                  error: r.error || undefined,
                  raw: r.raw,
                })),
        });
      } finally {
        setWhatsappConfirmBusyFor(null);
      }
    },
    [
      handleConnectorExecute,
      persistOrchestratorAssistant,
      whatsappConfirmBusyFor,
      isWhatsAppPendingConsumed,
      orchestrator.currentSessionId,
    ]
  );

  const handleWhatsAppCancelSend = useCallback(
    async (pendingMessageId: string) => {
      if (!pendingMessageId) return;
      if (whatsappConfirmBusyFor) return;
      if (isWhatsAppPendingConsumed(pendingMessageId)) return;
      setWhatsappConfirmBusyFor(pendingMessageId);
      try {
        await persistOrchestratorAssistant("Cancelled.", {
          whatsapp_send_consumed_of: pendingMessageId,
          whatsapp_send_cancelled: true,
        });
      } finally {
        setWhatsappConfirmBusyFor(null);
      }
    },
    [persistOrchestratorAssistant, whatsappConfirmBusyFor, isWhatsAppPendingConsumed]
  );

  const handleTelegramConfirmSend = useCallback(
    async (
      pendingMessageId: string,
      pending: {
        chatId: string;
        recipientDisplay?: string;
        text?: string;
        messageThreadId?: number;
        media?: Array<{
          url?: string;
          storagePath?: string;
          fileId?: string;
          filename?: string;
          caption?: string;
        }>;
      }
    ) => {
      const text = typeof pending?.text === "string" ? pending.text.trim() : "";
      const media = Array.isArray(pending?.media) ? pending.media : [];
      if (!pendingMessageId || !pending?.chatId || (!text && media.length === 0)) return;
      if (telegramConfirmBusyFor) return;
      if (isTelegramPendingConsumed(pendingMessageId)) return;
      setTelegramConfirmBusyFor(pendingMessageId);
      try {
        const res = await fetch("/api/telegram/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: pending.chatId,
            text,
            messageThreadId: pending.messageThreadId,
            media,
          }),
        });
        const json = await res.json().catch(() => ({ ok: false }));
        const to = pending.recipientDisplay ? ` to ${pending.recipientDisplay}` : "";
        const msg = json.ok
          ? `✅ Sent via Telegram${to}.`
          : `❌ Failed to send via Telegram${to}. ${json.error || ""}`;
        await persistOrchestratorAssistant(msg, {
          telegram_send_consumed_of: pendingMessageId,
          telegram_send_result: json,
        });
      } finally {
        setTelegramConfirmBusyFor(null);
      }
    },
    [persistOrchestratorAssistant, telegramConfirmBusyFor, isTelegramPendingConsumed]
  );

  const handleTelegramCancelSend = useCallback(
    async (pendingMessageId: string) => {
      if (!pendingMessageId) return;
      if (telegramConfirmBusyFor) return;
      if (isTelegramPendingConsumed(pendingMessageId)) return;
      setTelegramConfirmBusyFor(pendingMessageId);
      try {
        await persistOrchestratorAssistant("Cancelled.", {
          telegram_send_consumed_of: pendingMessageId,
          telegram_send_cancelled: true,
        });
      } finally {
        setTelegramConfirmBusyFor(null);
      }
    },
    [persistOrchestratorAssistant, telegramConfirmBusyFor, isTelegramPendingConsumed]
  );

  // Handle saving API keys
  const handleSaveKeys = async (
    keys: Partial<Record<Provider, string>>,
    mode: "groovy" | "user",
    keyModes?: KeyModes
  ) => {
    const response = await fetch("/api/user-api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keys: Object.keys(keys).length ? keys : undefined,
        mode,
        keyModes,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Failed to save keys");
    }

    // Update local state
    const newKeyStatus = { ...apiKeys };
    if (Object.keys(keys).length > 0) {
      for (const provider of Object.keys(keys) as Provider[]) {
        newKeyStatus[provider] = {
          configured: true,
          lastUpdated: new Date().toISOString(),
        };
      }
    }
    setApiKeys(newKeyStatus);
    setLlmKeyMode(mode);
    if (keyModes) setLlmKeyModes(keyModes);
  };

  // Handle welcome onboarding completion
  const justFinishedOnboardingRef = useRef(false);
  const handleOnboardingComplete = () => {
    justFinishedOnboardingRef.current = true;
    setShowWelcomeOnboarding(false);
  };

  // Handle API keys save from onboarding
  const handleOnboardingSaveKeys = async (
    keys: Partial<Record<Provider, string>>,
    mode: "groovy" | "user"
  ) => {
    await handleSaveKeys(keys, mode);
  };

  const persistConnectorConfig = useCallback(
    async (deviceId: string, configPatch: Record<string, unknown>) => {
      const trimmedDeviceId = typeof deviceId === "string" ? deviceId.trim() : "";
      if (!trimmedDeviceId) return false;
      const normalizedPatch = Object.fromEntries(
        Object.entries(configPatch || {}).filter(([, value]) => value !== undefined)
      );
      if (Object.keys(normalizedPatch).length === 0) return true;
      try {
        const { data, error } = await supabase
          .from("devices")
          .select("connector_config")
          .eq("id", trimmedDeviceId)
          .limit(1)
          .maybeSingle();
        if (error || !data) return false;
        const currentConfig =
          data.connector_config &&
          typeof data.connector_config === "object" &&
          !Array.isArray(data.connector_config)
            ? (data.connector_config as Record<string, unknown>)
            : {};
        const nextConfig = {
          ...currentConfig,
          ...normalizedPatch,
        };
        const { error: updateError } = await supabase
          .from("devices")
          .update({ connector_config: nextConfig })
          .eq("id", trimmedDeviceId);
        return !updateError;
      } catch {
        return false;
      }
    },
    [supabase]
  );

  const sendConnectorConfig = useCallback(
    async (
      config: Record<string, unknown>,
      restart = true,
      options?: { targetDeviceId?: string | null }
    ) => {
      const resolvedDeviceId =
        (typeof options?.targetDeviceId === "string" && options.targetDeviceId.trim()
          ? options.targetDeviceId.trim()
          : "") ||
        activeDeviceIdRef.current ||
        activeDeviceId ||
        preferredConnectorDeviceId ||
        (await ensureActiveDeviceIdReady());
      if (!resolvedDeviceId) return false;
      if (relayStatusRef.current !== "ready") return false;

      const requestId = `cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          pendingConnectorRequests.current.delete(requestId);
          resolve(false);
        }, 20_000);

        pendingConnectorRequests.current.set(requestId, {
          resolve: (result) => resolve(result.ok !== false),
          timeout,
          requestType: "connector_configure",
          deviceId: resolvedDeviceId,
        });

        try {
          relaySend({
            type: "connector_configure",
            request_id: requestId,
            device_id: resolvedDeviceId,
            config,
            restart,
          });
        } catch {
          clearTimeout(timeout);
          pendingConnectorRequests.current.delete(requestId);
          resolve(false);
        }
      });
    },
    [activeDeviceId, ensureActiveDeviceIdReady, preferredConnectorDeviceId, relaySend]
  );

  const configureConnectorWhatsApp = useCallback(
    async (opts: { enabled: boolean; groupName?: string }) => {
      const targetDeviceId =
        activeDeviceIdRef.current ||
        activeDeviceId ||
        preferredConnectorDeviceId ||
        (await ensureActiveDeviceIdReady());
      if (!targetDeviceId) return false;
      const config = {
        whatsapp_enabled: opts.enabled,
        whatsapp_group_name: opts.enabled ? String(opts.groupName || "").trim() : "",
        whatsapp_app_url: "https://gogroovy.ai",
      };
      await persistConnectorConfig(targetDeviceId, config);
      const applied = await sendConnectorConfig(config, true, { targetDeviceId });
      return applied;
    },
    [
      activeDeviceId,
      ensureActiveDeviceIdReady,
      persistConnectorConfig,
      preferredConnectorDeviceId,
      sendConnectorConfig,
    ]
  );

  const configureConnectorAiyra = useCallback(
    async (opts: {
      enabled: boolean;
      wakeWord: string;
      wakeSensitivity: number;
      openWakewordThreshold?: number;
      idleTimeoutMs: number;
      appUrl?: string;
      keywordPath?: string;
      micMode?: AiyraMicMode;
      micName?: string;
    }) => {
      const targetDeviceId =
        (await resolveAiyraConnectorDeviceId()) ||
        activeDeviceIdRef.current ||
        activeDeviceId ||
        preferredConnectorDeviceId ||
        (await ensureActiveDeviceIdReady());
      if (!targetDeviceId) return false;
      const resolvedAppUrl =
        opts.appUrl ||
        (typeof window !== "undefined" && window.location?.origin
          ? window.location.origin
          : "https://gogroovy.ai");
      const config = {
        aiyra_voice_enabled: opts.enabled,
        aiyra_wake_word: opts.wakeWord,
        aiyra_wake_sensitivity: opts.wakeSensitivity,
        ...(Number.isFinite(Number(opts.openWakewordThreshold))
          ? {
              aiyra_openwakeword_threshold: Math.max(
                0,
                Math.min(1, Number(opts.openWakewordThreshold))
              ),
            }
          : {}),
        aiyra_idle_timeout_ms: opts.idleTimeoutMs,
        aiyra_app_url: resolvedAppUrl,
        ...(opts.keywordPath ? { aiyra_wakeword_ppn_path: opts.keywordPath } : {}),
        ...(typeof opts.micMode === "string" ? { aiyra_mic_mode: opts.micMode } : {}),
        ...(typeof opts.micName === "string" ? { aiyra_mic_name: opts.micName } : {}),
      };
      await persistConnectorConfig(targetDeviceId, config);
      const applied = await sendConnectorConfig(config, false, { targetDeviceId });
      return applied;
    },
    [
      activeDeviceId,
      ensureActiveDeviceIdReady,
      persistConnectorConfig,
      preferredConnectorDeviceId,
      resolveAiyraConnectorDeviceId,
      sendConnectorConfig,
    ]
  );

  const pushAiyraAudioDeviceLog = useCallback((message: string) => {
    const timestamp = new Date().toISOString().slice(11, 19);
    const line = `[${timestamp}] ${message}`;
    console.log(`[AiyraMic] ${message}`);
    setAiyraAudioDeviceDebugLog((prev) => [...prev.slice(-59), line]);
  }, []);

  const listAiyraAudioDevices = useCallback(
    async (): Promise<AiyraAudioDeviceListResult> => {
      const emptyResult = (): AiyraAudioDeviceListResult => ({
        devices: [],
        currentDeviceIndex: -1,
        currentMicMode: "computer_default",
        currentMicName: "",
        resolvedDeviceName: "",
      });
      setAiyraAudioDeviceDebugLog([]);
      pushAiyraAudioDeviceLog(`start relay=${String(relayStatusRef.current)}`);
      // Relay can still be "connecting" right after modal open; wait briefly so
      // we don't return an empty list and show only "System default".
      for (let i = 0; i < 20 && relayStatusRef.current !== "ready"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (relayStatusRef.current !== "ready") {
        pushAiyraAudioDeviceLog("abort: relay not ready after wait window");
        return emptyResult();
      }

      const preferredDeviceId = await resolveAiyraConnectorDeviceId();
      const onlineIds = Array.from(onlineDevicesRef.current.keys());
      const candidateDeviceIds = Array.from(
        new Set([
          ...(preferredDeviceId ? [preferredDeviceId] : []),
          ...(activeDeviceIdRef.current ? [activeDeviceIdRef.current] : []),
          ...(activeDeviceId ? [activeDeviceId] : []),
          ...onlineIds,
        ])
      ).filter((id): id is string => typeof id === "string" && id.trim().length > 0);
      pushAiyraAudioDeviceLog(
        `candidates preferred=${preferredDeviceId || "none"} active=${
          activeDeviceIdRef.current || activeDeviceId || "none"
        } online=${onlineIds.length} ids=${candidateDeviceIds.join(",") || "(none)"}`
      );
      if (candidateDeviceIds.length === 0) {
        pushAiyraAudioDeviceLog("abort: no candidate connector device IDs");
        return emptyResult();
      }

      const isDefaultLikeName = (name: string): boolean => {
        const normalized = name.trim().toLowerCase();
        return (
          normalized === "default" ||
          normalized === "system default" ||
          normalized.startsWith("default ")
        );
      };

      const scoreDeviceList = (devices: { index: number; name: string }[]): number => {
        let nonDefaultCount = 0;
        const uniqueNames = new Set<string>();
        for (const device of devices) {
          const normalized = device.name.trim().toLowerCase();
          if (!normalized) continue;
          uniqueNames.add(normalized);
          if (!isDefaultLikeName(normalized)) nonDefaultCount += 1;
        }
        // Prefer lists with real named microphones over default-only lists.
        return nonDefaultCount * 1000 + uniqueNames.size * 10 + devices.length;
      };

      const parseDeviceNamesFromStdout = (stdout: string): string[] => {
        const trimmed = stdout.trim();
        if (!trimmed) return [];
        const lines = trimmed
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        let best: string[] = [];
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i]!;
          try {
            const parsed = JSON.parse(line);
            if (Array.isArray(parsed)) {
              const names = parsed
                .filter((value): value is string => typeof value === "string")
                .map((name) => name.trim())
                .filter(Boolean);
              if (names.length > best.length) {
                best = names;
              }
            }
          } catch {
            // ignore parse errors and keep scanning previous lines
          }
        }
        return best;
      };

      const requestDevicesFrom = async (
        deviceId: string,
        timeoutMs: number
      ): Promise<
        AiyraAudioDeviceListResult & {
          ok: boolean;
        }
      > =>
        new Promise((resolve) => {
          const requestId = `aiyra-devices-${deviceId}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const timeout = setTimeout(() => {
            pendingConnectorRequests.current.delete(requestId);
            pushAiyraAudioDeviceLog(
              `aiyra rpc timeout device=${deviceId} req=${requestId} after=${timeoutMs}ms`
            );
            resolve({ ok: false, ...emptyResult() });
          }, timeoutMs);

          pendingConnectorRequests.current.set(requestId, {
            resolve: (result) => {
              const rawDevices = Array.isArray(result.devices) ? result.devices : [];
              const devices = rawDevices
                .filter(
                  (d: unknown): d is { index: number; name: string } =>
                    d !== null &&
                    typeof d === "object" &&
                    typeof (d as Record<string, unknown>).index === "number" &&
                    typeof (d as Record<string, unknown>).name === "string"
                )
                .map((d) => ({
                  index: Math.trunc(d.index),
                  name: d.name.trim() || `Input ${Math.trunc(d.index)}`,
                }));
              const ok = result.ok !== false;
              const err = typeof result.error === "string" ? result.error : "";
              const currentMicModeRaw =
                typeof result.current_device_mode === "string"
                  ? result.current_device_mode.trim().toLowerCase()
                  : "";
              const currentMicMode: AiyraMicMode =
                currentMicModeRaw === "system_default" ||
                currentMicModeRaw === "specific"
                  ? (currentMicModeRaw as AiyraMicMode)
                  : "computer_default";
              pushAiyraAudioDeviceLog(
                `aiyra rpc result device=${deviceId} req=${requestId} ok=${ok} count=${
                  devices.length
                }${err ? ` err=${err}` : ""}`
              );
              resolve({
                ok: result.ok !== false,
                devices,
                currentDeviceIndex:
                  typeof result.current_device_index === "number"
                    ? Math.trunc(result.current_device_index)
                    : -1,
                currentMicMode,
                currentMicName:
                  typeof result.current_device_name === "string"
                    ? result.current_device_name.trim()
                    : "",
                resolvedDeviceName:
                  typeof result.resolved_device_name === "string"
                    ? result.resolved_device_name.trim()
                    : "",
              });
            },
            timeout,
            requestType: "aiyra_list_audio_devices",
            deviceId,
          });

          try {
            pushAiyraAudioDeviceLog(
              `aiyra rpc send device=${deviceId} req=${requestId}`
            );
            relaySend({
              type: "aiyra_list_audio_devices",
              request_id: requestId,
              device_id: deviceId,
            });
          } catch {
            clearTimeout(timeout);
            pendingConnectorRequests.current.delete(requestId);
            pushAiyraAudioDeviceLog(
              `aiyra rpc send failed device=${deviceId} req=${requestId}`
            );
            resolve({ ok: false, ...emptyResult() });
          }
        });

      const requestDevicesViaTerminalExec = async (
        deviceId: string,
        timeoutMs: number
      ): Promise<
        AiyraAudioDeviceListResult & {
          ok: boolean;
        }
      > =>
        new Promise((resolve) => {
          const requestId = `aiyra-devices-fallback-${deviceId}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const timeout = setTimeout(() => {
            pendingConnectorRequests.current.delete(requestId);
            pushAiyraAudioDeviceLog(
              `fallback timeout device=${deviceId} req=${requestId} after=${timeoutMs}ms`
            );
            resolve({ ok: false, ...emptyResult() });
          }, timeoutMs);

          pendingConnectorRequests.current.set(requestId, {
            resolve: (result) => {
              const stdout = typeof result.stdout === "string" ? result.stdout : "";
              const names = parseDeviceNamesFromStdout(stdout);
              const devices = names.map((name, index) => ({
                index,
                name: name.trim() || `Input ${index}`,
              }));
              const ok = result.ok !== false;
              const exitCode =
                typeof result.exit_code === "number"
                  ? String(result.exit_code)
                  : typeof result.exit_code === "string"
                    ? result.exit_code
                    : "";
              const err = typeof result.error === "string" ? result.error : "";
              pushAiyraAudioDeviceLog(
                `fallback result device=${deviceId} req=${requestId} ok=${ok} count=${
                  devices.length
                }${exitCode ? ` exit=${exitCode}` : ""}${err ? ` err=${err}` : ""}`
              );
              resolve({
                ok: devices.length > 0,
                devices,
                currentDeviceIndex: -1,
                currentMicMode: "computer_default",
                currentMicName: "",
                resolvedDeviceName: "",
              });
            },
            timeout,
            requestType: "terminal_exec",
            deviceId,
          });

          const probeCommand =
            "found=0; " +
            "for d in \"$PWD\" \"$HOME/flow/apps/connector\" \"/Applications/Groovy Connector.app/Contents/Resources\"; do " +
            "if [ -f \"$d/package.json\" ]; then " +
            "if cd \"$d\" && node -e 'import(\"@picovoice/pvrecorder-node\").then((m)=>{const P=m?.PvRecorder||m?.default?.PvRecorder;const out=P?P.getAvailableDevices():[];console.log(JSON.stringify(out));}).catch(()=>process.exit(1));'; then " +
            "found=1; break; " +
            "fi; " +
            "fi; " +
            "done; " +
            "if [ \"$found\" -eq 0 ]; then echo \"[]\"; fi";

          try {
            pushAiyraAudioDeviceLog(
              `fallback send device=${deviceId} req=${requestId}`
            );
            relaySend({
              type: "terminal_exec",
              request_id: requestId,
              device_id: deviceId,
              command: probeCommand,
              timeout_ms: 20_000,
              max_output_chars: 20_000,
            });
          } catch {
            clearTimeout(timeout);
            pendingConnectorRequests.current.delete(requestId);
            pushAiyraAudioDeviceLog(
              `fallback send failed device=${deviceId} req=${requestId}`
            );
            resolve({ ok: false, ...emptyResult() });
          }
        });

      const attempts = candidateDeviceIds.map((deviceId, idx) =>
        requestDevicesFrom(deviceId, idx === 0 ? 15_000 : 10_000)
      );
      const preferredFastResult = await Promise.race([
        attempts[0]!,
        new Promise<AiyraAudioDeviceListResult & { ok: boolean }>((resolve) =>
          setTimeout(() => resolve({ ok: false, ...emptyResult() }), 1200)
        ),
      ]);
      if (preferredFastResult.ok && scoreDeviceList(preferredFastResult.devices) >= 1000) {
        pushAiyraAudioDeviceLog(
          `selected fast preferred list count=${preferredFastResult.devices.length}`
        );
        return preferredFastResult;
      }

      const results = await Promise.all(
        attempts.map((attempt) => attempt.catch(() => ({ ok: false, ...emptyResult() })))
      );
      let bestResult: AiyraAudioDeviceListResult = emptyResult();
      let bestScore = -1;
      for (const result of results) {
        if (!result.ok) continue;
        const score = scoreDeviceList(result.devices);
        if (score > bestScore) {
          bestScore = score;
          bestResult = result;
        }
      }
      if (bestScore > 0) {
        pushAiyraAudioDeviceLog(
          `selected rpc list count=${bestResult.devices.length} score=${bestScore}`
        );
        return bestResult;
      }

      // Compatibility fallback for connectors where aiyra_list_audio_devices is
      // unavailable or intermittently failing: probe via terminal_exec.
      pushAiyraAudioDeviceLog("rpc list empty/low quality -> starting fallback probe");
      const fallbackAttempts = candidateDeviceIds.map((deviceId, idx) =>
        requestDevicesViaTerminalExec(deviceId, idx === 0 ? 20_000 : 12_000)
      );
      const fallbackResults = await Promise.all(
        fallbackAttempts.map((attempt) =>
          attempt.catch(() => ({ ok: false, ...emptyResult() }))
        )
      );
      for (const result of fallbackResults) {
        if (!result.ok) continue;
        const score = scoreDeviceList(result.devices);
        if (score > bestScore) {
          bestScore = score;
          bestResult = result;
        }
      }
      pushAiyraAudioDeviceLog(
        `done final_count=${bestResult.devices.length} final_score=${bestScore}`
      );
      return bestResult;
    },
    [activeDeviceId, pushAiyraAudioDeviceLog, relaySend, resolveAiyraConnectorDeviceId]
  );

  const setOptimisticAiyraVoiceHealth = useCallback(
    (opts: {
      enabled: boolean;
      wakeWord: string;
      wakeSensitivity: number;
      openWakewordThreshold?: number;
      idleTimeoutMs: number;
    }) => {
      const nowIso = new Date().toISOString();
      setConnectorAiyraVoiceHealth((prev) => ({
        status: opts.enabled ? "recovering" : "disabled",
        reason: opts.enabled ? "aiyra_runtime_starting" : "aiyra_voice_disabled",
        detail: opts.enabled
          ? "Starting native Aiyra wake-word runtime"
          : "Aiyra voice runtime disabled in connector config",
        updated_at: nowIso,
        last_healthy_at: prev?.last_healthy_at ?? null,
        last_failure_at: prev?.last_failure_at ?? null,
        listening: false,
        active: false,
        muted: false,
        wake_word: opts.wakeWord,
        wake_sensitivity: opts.wakeSensitivity,
        ...(Number.isFinite(Number(opts.openWakewordThreshold))
          ? {
              openwakeword_threshold: Math.max(
                0,
                Math.min(1, Number(opts.openWakewordThreshold))
              ),
            }
          : {}),
        idle_timeout_ms: opts.idleTimeoutMs,
        wake_hits: prev?.wake_hits ?? 0,
        wake_suppressed: prev?.wake_suppressed ?? 0,
        missed_reports: prev?.missed_reports ?? 0,
        false_trigger_reports: prev?.false_trigger_reports ?? 0,
        session_count: prev?.session_count ?? 0,
        session_error_count: prev?.session_error_count ?? 0,
        reconnect_attempt_count: prev?.reconnect_attempt_count ?? 0,
        last_session_duration_ms: prev?.last_session_duration_ms ?? 0,
        last_metric_event: prev?.last_metric_event ?? "",
        last_metric_at: prev?.last_metric_at ?? null,
        conversation_id: prev?.conversation_id ?? null,
        orchestrator_session_id: prev?.orchestrator_session_id ?? null,
        twilio_supervisor_state: prev?.twilio_supervisor_state ?? null,
      }));
    },
    []
  );

  const saveAiyraConfig = useCallback(
    async (input: {
      apiKey?: string;
      clearApiKey?: boolean;
      enabled: boolean;
      personaPrompt: string;
      voiceId: string;
      ttsSpeed?: number | null;
      wakeWord: string;
      wakeSensitivity: number;
      openWakewordThreshold?: number;
      idleTimeoutMs: number;
      twilioEnabled: boolean;
      twilioFrom: string;
      twilioTo: string;
      keywordPath?: string;
      micMode?: AiyraMicMode;
      micName?: string;
    }) => {
      const effectiveEnabled = input.enabled || !!input.apiKey?.trim();
      const response = await fetch("/api/aiyra/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(input.apiKey ? { apiKey: input.apiKey } : {}),
          ...(input.clearApiKey ? { clearApiKey: true } : {}),
          enabled: effectiveEnabled,
          personaPrompt: input.personaPrompt,
          voiceId: input.voiceId.trim(),
          ...(Object.prototype.hasOwnProperty.call(input, "ttsSpeed")
            ? { ttsSpeed: input.ttsSpeed ?? null }
            : {}),
          wakeWord: input.wakeWord,
          wakeSensitivity: input.wakeSensitivity,
          idleTimeoutMs: input.idleTimeoutMs,
          tools: {
            twilio: {
              enabled: input.twilioEnabled,
              from: input.twilioFrom,
              to: input.twilioTo,
            },
          },
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof json?.error === "string" ? json.error : "Failed to save Aiyra settings"
        );
      }

      const cfg =
        json?.aiyra && typeof json.aiyra === "object"
          ? (json.aiyra as Record<string, unknown>)
          : null;
      if (cfg) {
        const twilio = readAiyraTwilioConfig(cfg);
        setAiyraConfig({
          configured: cfg.configured === true,
          enabled: cfg.enabled === true,
          personaPrompt:
            typeof cfg.personaPrompt === "string" ? cfg.personaPrompt : "",
          voiceId: typeof cfg.voiceId === "string" ? cfg.voiceId : "",
          ttsSpeed: readAiyraTtsSpeed(cfg),
          wakeWord:
            typeof cfg.wakeWord === "string" && cfg.wakeWord.trim()
              ? cfg.wakeWord
              : "hey groovy",
          wakeSensitivity:
            Number.isFinite(Number(cfg.wakeSensitivity)) &&
            Number(cfg.wakeSensitivity) >= 0 &&
            Number(cfg.wakeSensitivity) <= 1
              ? Number(cfg.wakeSensitivity)
              : 0.5,
          idleTimeoutMs:
            Number.isFinite(Number(cfg.idleTimeoutMs)) &&
            Number(cfg.idleTimeoutMs) >= 2000
              ? Math.trunc(Number(cfg.idleTimeoutMs))
              : 12000,
          twilioEnabled: twilio.enabled,
          twilioFrom: twilio.from,
          twilioTo: twilio.to,
          updatedAt: typeof cfg.updatedAt === "string" ? cfg.updatedAt : null,
        });
      }

      const connectorApplied = await configureConnectorAiyra({
        enabled: effectiveEnabled,
        wakeWord: input.wakeWord,
        wakeSensitivity: input.wakeSensitivity,
        openWakewordThreshold: input.openWakewordThreshold,
        idleTimeoutMs: input.idleTimeoutMs,
        keywordPath: input.keywordPath,
        micMode: input.micMode,
        micName: input.micName,
      });
      if (!connectorApplied) {
        throw new Error("Failed to apply Aiyra runtime settings on connector");
      }
      setOptimisticAiyraVoiceHealth({
        enabled: effectiveEnabled,
        wakeWord: input.wakeWord,
        wakeSensitivity: input.wakeSensitivity,
        openWakewordThreshold: input.openWakewordThreshold,
        idleTimeoutMs: input.idleTimeoutMs,
      });
    },
    [configureConnectorAiyra, setOptimisticAiyraVoiceHealth]
  );

  const loadAiyraConfig = useCallback(
    async (input: {
      apiKey: string;
      enabled: boolean;
    }) => {
      const effectiveEnabled = input.enabled || !!input.apiKey.trim();
      const response = await fetch("/api/aiyra/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: input.apiKey,
          enabled: effectiveEnabled,
          autoLoadOnly: true,
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof json?.error === "string" ? json.error : "Failed to load stored Aiyra settings"
        );
      }

      const cfg =
        json?.aiyra && typeof json.aiyra === "object"
          ? (json.aiyra as Record<string, unknown>)
          : null;
      if (cfg) {
        const resolvedEnabled = cfg.enabled === true || effectiveEnabled;
        const resolvedWakeWord =
          typeof cfg.wakeWord === "string" && cfg.wakeWord.trim()
            ? cfg.wakeWord
            : "hey groovy";
        const twilio = readAiyraTwilioConfig(cfg);
        const resolvedWakeSensitivity =
          Number.isFinite(Number(cfg.wakeSensitivity)) &&
          Number(cfg.wakeSensitivity) >= 0 &&
          Number(cfg.wakeSensitivity) <= 1
            ? Number(cfg.wakeSensitivity)
            : 0.5;
        const resolvedIdleTimeoutMs =
          Number.isFinite(Number(cfg.idleTimeoutMs)) &&
          Number(cfg.idleTimeoutMs) >= 2000
            ? Math.trunc(Number(cfg.idleTimeoutMs))
            : 12000;
        setAiyraConfig({
          configured: cfg.configured === true,
          enabled: resolvedEnabled,
          personaPrompt:
            typeof cfg.personaPrompt === "string" ? cfg.personaPrompt : "",
          voiceId: typeof cfg.voiceId === "string" ? cfg.voiceId : "",
          ttsSpeed: readAiyraTtsSpeed(cfg),
          wakeWord: resolvedWakeWord,
          wakeSensitivity: resolvedWakeSensitivity,
          idleTimeoutMs: resolvedIdleTimeoutMs,
          twilioEnabled: twilio.enabled,
          twilioFrom: twilio.from,
          twilioTo: twilio.to,
          updatedAt: typeof cfg.updatedAt === "string" ? cfg.updatedAt : null,
        });

        const connectorApplied = await configureConnectorAiyra({
          enabled: resolvedEnabled,
          wakeWord: resolvedWakeWord,
          wakeSensitivity: resolvedWakeSensitivity,
          idleTimeoutMs: resolvedIdleTimeoutMs,
        });
        if (!connectorApplied) {
          throw new Error("Failed to apply Aiyra runtime settings on connector");
        }
        setOptimisticAiyraVoiceHealth({
          enabled: resolvedEnabled,
          wakeWord: resolvedWakeWord,
          wakeSensitivity: resolvedWakeSensitivity,
          idleTimeoutMs: resolvedIdleTimeoutMs,
        });
      }
    },
    [configureConnectorAiyra, setOptimisticAiyraVoiceHealth]
  );

  const reportAiyraVoiceEvent = useCallback(
    async (kind: "missed_wake" | "false_trigger") => {
      const resolvedDeviceId = await resolveAiyraConnectorDeviceId();
      if (!resolvedDeviceId) return false;
      if (relayStatusRef.current !== "ready") return false;

      const requestId = `aiyra-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          pendingConnectorRequests.current.delete(requestId);
          resolve(false);
        }, 20_000);

        pendingConnectorRequests.current.set(requestId, {
          resolve: (result) => {
            const ok = result.ok !== false;
            const normalizedHealth =
              result.health && typeof result.health === "object"
                ? normalizeConnectorHealth({ aiyra_voice: result.health })?.aiyra_voice || null
                : null;
            if (ok && normalizedHealth) {
              setConnectorAiyraVoiceHealth((prev) =>
                mergeAiyraVoiceHealth(prev, normalizedHealth)
              );
            }
            resolve(ok);
          },
          timeout,
          requestType: "aiyra_voice_report",
          deviceId: resolvedDeviceId,
        });

        try {
          relaySend({
            type: "aiyra_voice_report",
            request_id: requestId,
            device_id: resolvedDeviceId,
            kind,
          });
        } catch {
          clearTimeout(timeout);
          pendingConnectorRequests.current.delete(requestId);
          resolve(false);
        }
      });
    },
    [relaySend, resolveAiyraConnectorDeviceId]
  );

  const setAiyraVoiceMuted = useCallback(
    async (muted: boolean) => {
      const resolvedDeviceId = await resolveAiyraConnectorDeviceId();
      if (!resolvedDeviceId) return false;
      if (relayStatusRef.current !== "ready") return false;

      const requestId = `aiyra-control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          pendingConnectorRequests.current.delete(requestId);
          resolve(false);
        }, 15_000);

        pendingConnectorRequests.current.set(requestId, {
          resolve: (result) => {
            const ok = result.ok !== false;
            const normalizedHealth =
              result.health && typeof result.health === "object"
                ? normalizeConnectorHealth({ aiyra_voice: result.health })?.aiyra_voice || null
                : null;
            const directHealthPatch: Partial<ConnectorAiyraVoiceHealth> | null =
              normalizedHealth ||
              typeof result.active === "boolean" ||
              typeof result.muted === "boolean"
                ? {
                    ...(normalizedHealth || {}),
                    ...(typeof result.active === "boolean"
                      ? { active: result.active }
                      : {}),
                    ...(typeof result.muted === "boolean"
                      ? { muted: result.muted }
                      : {}),
                  }
                : null;
            if (directHealthPatch) {
              setConnectorAiyraVoiceHealth((prev) =>
                mergeAiyraVoiceHealth(prev, directHealthPatch)
              );
            }
            if (ok) {
              setAiyraVoiceMutedOverride(
                typeof result.muted === "boolean" ? result.muted : muted
              );
            }
            resolve(ok);
          },
          timeout,
          requestType: "aiyra_voice_control",
          deviceId: resolvedDeviceId,
        });

        try {
          relaySend({
            type: "aiyra_voice_control",
            request_id: requestId,
            device_id: resolvedDeviceId,
            action: "set_muted",
            muted,
          });
        } catch {
          clearTimeout(timeout);
          pendingConnectorRequests.current.delete(requestId);
          resolve(false);
        }
      });
    },
    [relaySend, resolveAiyraConnectorDeviceId]
  );

  // Refresh connector status
  const refreshConnectorStatus = () => {
    // This triggers a re-render which will update connector status from relay
    relay.reconnect?.();
  };

  const restartConnector = useCallback(() => {
    if (!activeDeviceId) return;
    try {
      relay.send({ type: "connector_restart", device_id: activeDeviceId });
    } catch {
      // ignore
    }
  }, [relay, activeDeviceId]);

  useEffect(() => {
    if (!connectorOk || !activeDeviceId) return;
    if (connectorWhatsAppHealth?.status !== "degraded") return;
    if (!isRestartableWhatsAppIssue(connectorWhatsAppHealth)) return;
    // Connector already initiated restart itself; avoid duplicate restart storms.
    if (connectorWhatsAppHealth?.auto_restart_pending === true) return;
    const now = Date.now();
    if (now - lastAutoRestartForWhatsAppRef.current < 120_000) return;
    lastAutoRestartForWhatsAppRef.current = now;
    try {
      relaySend({ type: "connector_restart", device_id: activeDeviceId });
    } catch {
      // ignore
    }
  }, [
    connectorOk,
    activeDeviceId,
    connectorWhatsAppHealth,
    connectorWhatsAppHealth?.status,
    connectorWhatsAppHealth?.reason,
    connectorWhatsAppHealth?.detail,
    connectorWhatsAppHealth?.auto_restart_pending,
    relaySend,
  ]);

  const updateConnector = useCallback(() => {
    if (!activeDeviceId || !activeConnectorIsHosted) return;
    try {
      relay.send({ type: "connector_update", device_id: activeDeviceId });
    } catch {
      // ignore
    }
  }, [relay, activeDeviceId, activeConnectorIsHosted]);

  const pinHeartbeatToDeviceIfEnabled = useCallback(async (deviceId: string | null) => {
    if (!deviceId) return;
    try {
      const cfgRes = await fetch("/api/heartbeat/config", { cache: "no-store" });
      const cfgJson = await cfgRes.json().catch(() => ({}));
      if (!cfgRes.ok || cfgJson?.enabled !== true) return;
      const delivery =
        cfgJson?.delivery && typeof cfgJson.delivery === "object"
          ? cfgJson.delivery
          : { dashboard: true, whatsapp: true };
      await fetch("/api/heartbeat/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          delivery,
          deviceId,
        }),
      });
    } catch {
      // best-effort; heartbeat can still be manually rebound from settings
    }
  }, []);

  const handleConnectorModeChanged = useCallback(async (next: "local" | "groovy") => {
    if (next === "groovy") {
      setPrefersHostedConnector(true);
      try {
        const hmRes = await fetch("/api/hosted-macs/request", { cache: "no-store" });
        const hmJson = await hmRes.json().catch(() => ({}));
        if (hmRes.ok && hmJson?.device?.device_id) {
          const hostedDeviceId = String(hmJson.device.device_id);
          setHostedPreferredDeviceId(hostedDeviceId);
          connectorModeTargetDeviceIdRef.current = hostedDeviceId;
          await persistPreferredConnectorDeviceId(hostedDeviceId);
        } else {
          setHostedPreferredDeviceId(null);
          connectorModeTargetDeviceIdRef.current = null;
          await persistPreferredConnectorDeviceId(null);
        }
      } catch {
        setHostedPreferredDeviceId(null);
        connectorModeTargetDeviceIdRef.current = null;
        await persistPreferredConnectorDeviceId(null);
      }
      return;
    }
    setPrefersHostedConnector(false);
    const currentHosted = hostedPreferredDeviceId;
    const currentActive = activeDeviceIdRef.current;
    const onlineIds = Array.from(onlineDevicesRef.current.keys());
    const nonHostedOnline =
      onlineIds.find((id) => !currentHosted || id !== currentHosted) || null;
    if (nonHostedOnline) {
      connectorModeTargetDeviceIdRef.current = nonHostedOnline;
      await persistPreferredConnectorDeviceId(nonHostedOnline);
      return;
    }
    if (currentActive && (!currentHosted || currentActive !== currentHosted)) {
      connectorModeTargetDeviceIdRef.current = currentActive;
      await persistPreferredConnectorDeviceId(currentActive);
      return;
    }
    connectorModeTargetDeviceIdRef.current = null;
    await persistPreferredConnectorDeviceId(null);
  }, [hostedPreferredDeviceId, persistPreferredConnectorDeviceId]);

  const persistConnectorModePreference = useCallback(
    async (next: "local" | "groovy") => {
      setConnectorModePrefSaving(true);
      setConnectorModePrefError(null);
      try {
        const res = await fetch("/api/user-preferences", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ onboardingData: { connectorMode: next } }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || "Failed to save connector mode");

        setConnectorModePref(next);
        await handleConnectorModeChanged(next);
        await pinHeartbeatToDeviceIfEnabled(connectorModeTargetDeviceIdRef.current);
        relay.reconnect?.();
      } catch (e) {
        setConnectorModePrefError(e instanceof Error ? e.message : "Failed to save connector mode");
      } finally {
        setConnectorModePrefSaving(false);
      }
    },
    [handleConnectorModeChanged, pinHeartbeatToDeviceIfEnabled, relay]
  );

  // Existing users joining a workspace (via invite): show a banner and default to Groovy Mac when available.
  useEffect(() => {
    if (!joinedFromInvite) return;
    if (joinedWorkspaceProcessedRef.current) return;
    if (!workspaceInfo) return;
    if (!connectorPrefsLoaded) return;

    joinedWorkspaceProcessedRef.current = true;
    setJoinedWorkspaceBannerVisible(true);
    // Clear the query param ASAP so refresh doesn't re-trigger.
    try {
      router.replace("/dashboard");
    } catch {
      // ignore
    }

    (async () => {
      try {
        const hmRes = await fetch("/api/hosted-macs/request", { cache: "no-store" });
        const hmJson = await hmRes.json().catch(() => ({}));

        const status = typeof hmJson?.request?.status === "string" ? String(hmJson.request.status) : null;
        const statusDetail =
          typeof hmJson?.request?.status_detail === "string" ? String(hmJson.request.status_detail) : null;
        const deviceId = typeof hmJson?.device?.device_id === "string" ? String(hmJson.device.device_id) : null;
        const deviceOnline =
          typeof hmJson?.device?.online === "boolean" ? (hmJson.device.online as boolean) : null;
        const lastSeen = hmJson?.device?.last_seen ? String(hmJson.device.last_seen) : null;

        const hasGroovyMac = !!deviceId || status === "ready" || status === "connector_online";
        setWorkspaceHostedMacInfo({
          hasGroovyMac,
          requestStatus: status,
          requestDetail: statusDetail,
          deviceId,
          deviceOnline,
          deviceLastSeen: lastSeen,
        });

        // Default invited members to Groovy Mac if available (they can explicitly switch back).
        if (workspaceInfo.role === "member" && hasGroovyMac && connectorModePref !== "groovy") {
          setJoinedWorkspaceAutoSelectedGroovy(true);
          await persistConnectorModePreference("groovy");
        }
      } catch {
        setWorkspaceHostedMacInfo({
          hasGroovyMac: false,
          requestStatus: null,
          requestDetail: null,
          deviceId: null,
          deviceOnline: null,
          deviceLastSeen: null,
        });
      }
    })();
  }, [
    joinedFromInvite,
    workspaceInfo,
    connectorPrefsLoaded,
    connectorModePref,
    persistConnectorModePreference,
    router,
  ]);

  // Handle activity feed item click
  const handleFeedItemClick = useCallback((item: FeedItem) => {
    if (!isPanelAgent(item.agent)) return;
    setExpandedAgent(item.agent);
  }, []);

  // Refresh data connections
  const handleDataRefresh = useCallback(async () => {
    await loadDataConnections();
  }, [loadDataConnections]);

  // Handle data platform connection using Datagran Link widget
  const handleDataConnect = useCallback(
    async (platform: PlatformType) => {
      console.log("[DataConnect] Starting connection for platform:", platform);
      console.log("[DataConnect] Script loaded:", datagranScriptLoaded);
      console.log("[DataConnect] DatagranLink available:", !!window.DatagranLink);

      // Check if Datagran Link widget is loaded
      if (!datagranScriptLoaded || !window.DatagranLink) {
        const error = "Datagran widget not loaded. Please refresh the page.";
        console.error("[DataConnect] Error:", error);
        throw new Error(error);
      }

      // Get link token from server (map platform to Datagran provider name)
      const datagranProvider = getDatagranProvider(platform);
      console.log("[DataConnect] Fetching link token for provider:", datagranProvider);
      const res = await fetch("/api/datagran/link-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: datagranProvider }),
      });

      const json = await res.json();
      console.log("[DataConnect] Link token response:", json);
      
      if (!res.ok) {
        const error = json.error || "Failed to get link token";
        console.error("[DataConnect] API Error:", error);
        throw new Error(error);
      }

      const linkToken = json.linkToken || json.link_token;
      if (!linkToken) {
        const error = "No link token in response";
        console.error("[DataConnect] Error:", error);
        throw new Error(error);
      }

      console.log("[DataConnect] Opening Datagran Link widget...");
      // Open Datagran Link widget
      return new Promise<void>((resolve, reject) => {
        window.DatagranLink!.open({
          linkToken,
          onSuccess: async (payload: { connection_id: string }) => {
            console.log("[DataConnect] OAuth success:", payload);
            try {
              // Create the agent with the connection_id from OAuth
              const createRes = await fetch("/api/agents", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: "datagran",
                  name: datagranProvider.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
                  datagranProvider,
                  connectionId: payload.connection_id,
                }),
              });
              
              if (!createRes.ok) {
                const errJson = await createRes.json().catch(() => ({}));
                console.error("[DataConnect] Agent creation failed:", errJson);
                throw new Error(errJson.error || "Failed to create agent");
              }
              
              console.log("[DataConnect] Agent created successfully");
              await handleDataRefresh();
              resolve();
            } catch (e) {
              console.error("[DataConnect] Error:", e);
              reject(e);
            }
          },
          onExit: () => {
            console.log("[DataConnect] User closed widget");
            // User closed the widget without completing
            resolve();
          },
        });
      });
    },
    [datagranScriptLoaded, handleDataRefresh]
  );

  // Reconnect an existing Datagran integration (same agent/config).
  const handleDataReconnect = useCallback(
    async (agentId: string) => {
      if (!datagranScriptLoaded || !window.DatagranLink) {
        throw new Error("Datagran widget not loaded. Please refresh the page.");
      }

      const res = await fetch("/api/datagran/link-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to get reconnect link token");
      }

      const linkToken = json.linkToken || json.link_token;
      if (!linkToken) {
        throw new Error("No link token in reconnect response");
      }

      return new Promise<void>((resolve, reject) => {
        window.DatagranLink!.open({
          linkToken,
          onSuccess: async () => {
            try {
              await handleDataRefresh();
              resolve();
            } catch (e) {
              reject(e);
            }
          },
          onExit: () => resolve(),
        });
      });
    },
    [datagranScriptLoaded, handleDataRefresh]
  );

  // Handle re-authorization for expired OAuth connections
  const needsReauth = orchestrator.needsReauth;
  const clearNeedsReauth = orchestrator.clearNeedsReauth;
  const handleReauth = useCallback(async () => {
    const reauthInfo = needsReauth;
    if (!reauthInfo?.linkToken) {
      console.error("[Reauth] No link token available");
      return;
    }

    if (!datagranScriptLoaded || !window.DatagranLink) {
      console.error("[Reauth] Datagran widget not loaded");
      return;
    }

    console.log("[Reauth] Opening Datagran Link widget for re-authorization:", reauthInfo.provider);
    
    return new Promise<void>((resolve) => {
      window.DatagranLink!.open({
        linkToken: reauthInfo.linkToken!,
        onSuccess: async () => {
          console.log("[Reauth] Re-authorization successful");
          clearNeedsReauth();
          await handleDataRefresh();
          resolve();
        },
        onExit: () => {
          console.log("[Reauth] User closed widget");
          resolve();
        },
      });
    });
  }, [needsReauth, clearNeedsReauth, datagranScriptLoaded, handleDataRefresh]);

  // Handle data platform connection using an existing Datagran connection ID + API key
  const handleDataConnectWithId = useCallback(
    async (platform: PlatformType, connectionId: string, apiKey: string, name: string) => {
      console.log("[DataConnectWithId] Saving connection:", platform, connectionId, name);
      
      const datagranProvider = getDatagranProvider(platform);
      
      // Create the agent with the existing connection ID and user's API key
      const res = await fetch("/api/datagran/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: datagranProvider,
          connectionId,
          apiKey,
          name,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to save connection");
      }

      console.log("[DataConnectWithId] Agent created:", json);
      await handleDataRefresh();
    },
    [handleDataRefresh]
  );

  // Handle data platform disconnection
  const handleDataDisconnect = useCallback(
    async (connectionId: string) => {
      const res = await fetch(`/api/agents?id=${connectionId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to disconnect");
      }

      setDataConnections((prev) => prev.filter((c) => c.id !== connectionId));
    },
    []
  );

  // Handle data connection rename
  const handleDataRename = useCallback(
    async (connectionId: string, newName: string) => {
      const res = await fetch("/api/agents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: connectionId, name: newName }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to rename");
      }

      setDataConnections((prev) =>
        prev.map((c) => (c.id === connectionId ? { ...c, name: newName } : c))
      );
    },
    []
  );

  // Compute whether to show settings initially
  const shouldShowSettings = useMemo(() => {
    if (loading) return false;
    const providers: Provider[] = ["anthropic", "openai", "google", "xai", "claude_cli"];
    const hasPerProvider = Object.keys(llmKeyModes).length > 0;
    const needsUserKey = (p: Provider) => (hasPerProvider ? llmKeyModes[p] : llmKeyMode) === "user";
    return providers.some((p) => needsUserKey(p) && !apiKeys[p]?.configured);
  }, [loading, apiKeys, llmKeyMode, llmKeyModes]);

  // Show settings modal when needed (but not right after onboarding)
  useEffect(() => {
    if (justFinishedOnboardingRef.current) {
      justFinishedOnboardingRef.current = false;
      return;
    }
    if (shouldShowSettings && !showSettings) {
      // Use timeout to defer the state update and avoid cascading renders
      const timer = setTimeout(() => openApiSettings(), 0);
      return () => clearTimeout(timer);
    }
  }, [shouldShowSettings, showSettings]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-zinc-500">Loading...</p>
        </div>
      </div>
    );
  }

  // Show welcome onboarding for first-time users
  if (showWelcomeOnboarding) {
    return (
      <>
        <WelcomeOnboarding
          initialStep={onboardingInitialStep}
          connectorOnline={connectorVisibleOnline}
          pairingRebindFromDeviceId={
            !connectorVisibleOnline &&
            activeDeviceId &&
            (!hostedPreferredDeviceId || activeDeviceId !== hostedPreferredDeviceId)
              ? activeDeviceId
              : null
          }
          onRefreshConnector={refreshConnectorStatus}
          onConnectorModeChanged={handleConnectorModeChanged}
          onConfigureWhatsApp={(groupName: string) =>
            configureConnectorWhatsApp({ enabled: true, groupName })
          }
          onDisablePersonalWhatsApp={() =>
            configureConnectorWhatsApp({ enabled: false })
          }
          onSaveApiKeys={handleOnboardingSaveKeys}
          onCreateChatAgent={() => setShowChatAgentCreate(true)}
          chatAgentCount={chatAgents.length}
          onComplete={handleOnboardingComplete}
        />
        <ChatAgentCreateModal
          isOpen={showChatAgentCreate}
          onClose={() => setShowChatAgentCreate(false)}
          onCreated={(created) => {
            setChatAgents((prev) => [
              { id: created.id, name: created.name, provider: created.provider, model: created.model },
              ...prev,
            ]);
            setShowChatAgentCreate(false);
          }}
        />
      </>
    );
  }

  // ========== MOBILE LAYOUT ==========
  if (isMobile) {
    return (
      <div className="h-[100dvh] bg-[var(--bg-primary)] flex flex-col overflow-hidden">
        {/* Noise overlay */}
        <div className="noise-overlay" />

        {/* Background effects */}
        <div className="fixed inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/4 w-[400px] h-[400px] bg-cyan-500/5 rounded-full blur-[100px]" />
          <div className="absolute bottom-0 right-1/4 w-[300px] h-[300px] bg-violet-500/5 rounded-full blur-[100px]" />
        </div>

        {/* Mobile Header */}
        <MobileHeader
          title="Groovy"
          subtitle={mobileTab === "code" && activeCodeAgentId ? activeCodeAgent?.name : undefined}
          relayStatus={relay.status}
          localConnectorOnline={connectorVisibleOnline}
          connectorChecking={connectorChecking}
        />

        {/* Main content area - full screen views */}
        {/* Reserve space for fixed bottom nav + iOS safe area (real devices) */}
        <main
          className="relative z-10 flex-1 flex flex-col min-h-0 overflow-hidden"
          style={{ paddingBottom: "calc(var(--bottom-nav-height) + var(--safe-area-inset-bottom))" }}
        >
          <AnimatePresence mode="wait">
            {/* CHAT TAB */}
            {mobileTab === "chat" && (
              <motion.div
                key="chat"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
                className="flex-1 flex flex-col min-h-0"
              >
                {/* Agent strip */}
                <MobileAgentStrip
                  onAgentTap={() => {
                    // Future: quick-insert @agent into the chat input
                  }}
                  connectorOnline={connectorVisibleOnline}
                />

                {/* Mobile session bar */}
                <div className="flex items-center justify-between px-4 py-2 border-b border-white/5">
                  <button
                    onClick={() => setShowSessionList(!showSessionList)}
                    className="flex items-center gap-2 text-sm text-zinc-300 hover:text-white transition-colors"
                  >
                    <MessageSquare className="w-4 h-4 text-cyan-400" />
                    <span className="truncate max-w-[180px]">
                      {orchestrator.sessions.find(s => s.id === orchestrator.currentSessionId)?.title || "New Agent"}
                    </span>
                    <ChevronDown className={`w-4 h-4 text-zinc-500 transition-transform ${showSessionList ? "rotate-180" : ""}`} />
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        const sid = orchestrator.currentSessionId;
                        if (sid) shareSessionWithWorkspace(sid);
                      }}
                      disabled={
                        !orchestrator.currentSessionId ||
                        !!orchestrator.sessions.find((s) => s.id === orchestrator.currentSessionId)?.shared
                      }
                      className="text-xs text-zinc-400 hover:text-cyan-400 transition-colors disabled:opacity-40 disabled:hover:text-zinc-400"
                    >
                      Share with all
                    </button>
                    <button
                      onClick={() => orchestrator.createSession()}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-xs"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      New
                    </button>
                  </div>
                </div>

                {/* Mobile session list dropdown */}
                <AnimatePresence>
                  {showSessionList && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden border-b border-white/5 bg-zinc-900/80"
                    >
                      <div className="max-h-48 overflow-y-auto">
                        {orchestrator.sessions.length === 0 ? (
                          <div className="px-4 py-3 text-xs text-zinc-500 text-center">
                            No agent sessions yet
                          </div>
                        ) : (
                          orchestrator.sessions.map((session) => (
                            <div
                              key={session.id}
                              className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${
                                session.id === orchestrator.currentSessionId
                                  ? "bg-cyan-500/10 border-l-2 border-cyan-400"
                                  : "hover:bg-white/5 border-l-2 border-transparent"
                              }`}
                            >
                              {editingSessionId === session.id ? (
                                <div className="flex-1 flex items-center gap-2">
                                  <input
                                    type="text"
                                    value={editingTitle}
                                    onChange={(e) => setEditingTitle(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        orchestrator.renameSession(session.id, editingTitle);
                                        setEditingSessionId(null);
                                      } else if (e.key === "Escape") {
                                        setEditingSessionId(null);
                                      }
                                    }}
                                    className="flex-1 bg-zinc-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-white outline-none focus:border-cyan-500"
                                    autoFocus
                                  />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      orchestrator.renameSession(session.id, editingTitle);
                                      setEditingSessionId(null);
                                    }}
                                    className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/20"
                                    title="Save"
                                  >
                                    <Check className="w-4 h-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingSessionId(null)}
                                    className="p-2 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10"
                                    title="Cancel"
                                  >
                                    <X className="w-4 h-4" />
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      orchestrator.selectSession(session.id);
                                      setShowSessionList(false);
                                      setEditingSessionId(null);
                                    }}
                                    className="flex-1 min-w-0 flex items-center gap-3 text-left"
                                  >
                                    <MessageSquare
                                      className={`w-4 h-4 shrink-0 ${
                                        session.id === orchestrator.currentSessionId
                                          ? "text-cyan-400"
                                          : "text-zinc-500"
                                      }`}
                                    />
                                    <div className="min-w-0">
                                      <div
                                        className={`text-sm truncate ${
                                          session.id === orchestrator.currentSessionId
                                            ? "text-white"
                                            : "text-zinc-300"
                                        }`}
                                      >
                                        {session.title || "Untitled"}
                                      </div>
                                      <div className="text-[10px] text-zinc-600">
                                        {session.updatedAt
                                          ? new Date(session.updatedAt).toLocaleDateString()
                                          : ""}
                                        {typeof session.messageCount === "number"
                                          ? ` · ${session.messageCount} msgs`
                                          : ""}
                                      </div>
                                    </div>
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingSessionId(session.id);
                                      setEditingTitle(session.title || "");
                                    }}
                                    className="p-2 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10"
                                    title="Rename"
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (confirm("Delete this chat?")) {
                                        orchestrator.deleteSession(session.id);
                                      }
                                    }}
                                    className="p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-200 hover:bg-red-500/20"
                                    title="Delete"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
                  {joinedWorkspaceBannerVisible &&
                    !joinedWorkspaceBannerDismissed &&
                    (() => {
                      const wsName = workspaceInfo?.name || "Workspace";
                      const role = workspaceInfo?.role || "member";
                      const currentMode: "local" | "groovy" =
                        connectorModePref === "groovy" ? "groovy" : "local";
                      const modeLabel =
                        currentMode === "groovy" ? "Groovy Mac (workspace)" : "Local (your computer)";
                      const hm = workspaceHostedMacInfo;
                      const hasGroovyMac = hm?.hasGroovyMac === true;
                      const deviceShort = hm?.deviceId ? hm.deviceId.slice(0, 8) : "";
                      const onlineLabel =
                        hm?.deviceOnline === true
                          ? "online"
                          : hm?.deviceOnline === false
                            ? "offline"
                            : null;

                      return (
                        <div className="rounded-2xl border border-white/10 bg-cyan-500/5 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-xs text-cyan-200 flex items-center gap-2">
                                <AlertCircle className="w-3.5 h-3.5" />
                                Joined workspace
                              </div>
                              <div className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                                You&apos;re now in <span className="text-zinc-200">{wsName}</span> ({role}). Connector
                                mode: <span className="text-zinc-200">{modeLabel}</span>.
                              </div>
                              <div className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                                {hm === null ? (
                                  <>Checking workspace Groovy Mac…</>
                                ) : hasGroovyMac ? (
                                  <>
                                    Workspace Groovy Mac:{" "}
                                    <span className="text-zinc-200">{onlineLabel || "unknown"}</span>
                                    {deviceShort ? <span className="text-zinc-600">{` · ${deviceShort}`}</span> : null}
                                    {hm.requestStatus ? (
                                      <span className="text-zinc-600">{` · ${hm.requestStatus}`}</span>
                                    ) : null}
                                  </>
                                ) : (
                                  <>No workspace Groovy Mac found. Local is recommended.</>
                                )}
                              </div>
                              {role === "member" && hasGroovyMac && (
                                <div className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                                  {joinedWorkspaceAutoSelectedGroovy ? (
                                    <>
                                      We set you to <span className="text-zinc-200">Groovy Mac</span> by default for
                                      this workspace.
                                    </>
                                  ) : (
                                    <>
                                      Default for this workspace is <span className="text-zinc-200">Groovy Mac</span>.
                                    </>
                                  )}{" "}
                                  You can switch to{" "}
                                  <span className="text-zinc-200">Local</span> anytime.
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setJoinedWorkspaceBannerDismissed(true);
                                setJoinedWorkspaceBannerVisible(false);
                              }}
                              className="shrink-0 px-2 py-1 rounded-md bg-white/5 border border-white/10 text-xs text-zinc-200 hover:bg-white/10"
                              title="Dismiss"
                            >
                              Dismiss
                            </button>
                          </div>

                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => setShowSettings(true)}
                              className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-zinc-200 hover:bg-white/10"
                            >
                              Open settings
                            </button>
                            {hasGroovyMac && (
                              <button
                                type="button"
                                onClick={() => persistConnectorModePreference("groovy")}
                                disabled={connectorModePrefSaving || currentMode === "groovy"}
                                className="px-3 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-xs text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50"
                              >
                                {connectorModePrefSaving && currentMode !== "groovy" ? "Switching…" : "Use Groovy Mac"}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => persistConnectorModePreference("local")}
                              disabled={connectorModePrefSaving || currentMode === "local"}
                              className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-50"
                            >
                              {connectorModePrefSaving && currentMode !== "local" ? "Switching…" : "Use local"}
                            </button>
                          </div>

                          {connectorModePrefError && (
                            <div className="mt-2 text-[11px] text-red-300">{connectorModePrefError}</div>
                          )}
                        </div>
                      );
                    })()}
                  {pendingTeamRequests.length > 0 &&
                    (() => {
                      const sid = orchestrator.currentSessionId;
                      const aid = orchestrator.getAgentIdForSession(sid);
                      const inSession = sid
                        ? pendingTeamRequests.filter((r) => {
                            const rowAgentId =
                              typeof r.agent_id === "string" ? r.agent_id.trim() : "";
                            const rowSessionId =
                              typeof r.session_id === "string" ? r.session_id.trim() : "";
                            if (aid && rowAgentId) return rowAgentId === aid;
                            return rowSessionId === sid;
                          })
                        : [];
                      const otherCount = pendingTeamRequests.length - inSession.length;
                      const rows = inSession.slice(0, 3);
                      return (
                        <div className="rounded-2xl border border-white/10 bg-amber-500/5 p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-xs text-amber-200 flex items-center gap-2">
                              <AlertCircle className="w-3.5 h-3.5" />
                              Team requests
                              <span className="text-[10px] text-amber-200/70">
                                ({pendingTeamRequests.length})
                              </span>
                            </div>
                            {otherCount > 0 && (
                              <div className="text-[10px] text-zinc-500">
                                {otherCount} in other chats
                              </div>
                            )}
                          </div>

                          {rows.length === 0 ? (
                            <div className="mt-2 text-[11px] text-zinc-500">
                              Open the shared chat to run the request.
                            </div>
                          ) : (
                            <div className="mt-2 space-y-2">
                              {rows.map((r) => {
                                const requestedBy =
                                  teamMembers.find((m) => m.id === r.requested_by_user_id) ||
                                  null;
                                const msgRaw = r.request?.message;
                                const msg =
                                  typeof msgRaw === "string"
                                    ? msgRaw
                                    : String(msgRaw || "");
                                return (
                                  <div
                                    key={r.id}
                                    className="rounded-xl border border-white/10 bg-black/20 p-2"
                                  >
                                    <div className="text-[10px] text-zinc-500">
                                      From{" "}
                                      <span className="text-zinc-300">
                                        {requestedBy?.handle
                                          ? `@${requestedBy.handle}`
                                          : requestedBy?.label || "teammate"}
                                      </span>
                                    </div>
                                    <div className="text-xs text-zinc-200 mt-1 whitespace-pre-wrap">
                                      {msg}
                                    </div>
                                    {!autoRunTeamRequests && (
                                      <div className="mt-2 flex flex-wrap gap-2">
                                        <button
                                          type="button"
                                          onClick={() => runTeamRequest(r)}
                                          className="px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-xs text-amber-100 hover:bg-amber-500/20"
                                        >
                                          Run
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => dismissTeamRequest(r.id)}
                                          className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-zinc-200 hover:bg-white/10"
                                        >
                                          Dismiss
                                        </button>
                                      </div>
                                    )}
                                    {autoRunTeamRequests && (
                                      <div className="mt-2 text-[11px] text-zinc-500">
                                        Auto-run enabled.
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  {conversationMessages.length === 0 ? (
<div className="h-full flex items-center justify-center">
                    <div className="text-center px-6">
                        <h2 className="text-lg font-semibold text-white mb-2">
                          Welcome to Groovy
                        </h2>
                        <p className="text-sm text-zinc-500">
                          Ask me anything or use @browser, @obsidian, @files, @data
                        </p>
                      </div>
                    </div>
                  ) : (
                    conversationMessages.map((msg) => (
                      <motion.div
                        key={msg.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
                      >
                        <div
                          className={`max-w-[95%] sm:max-w-[85%] rounded-2xl px-4 py-3 ${
                            msg.role === "user"
                              ? "bg-cyan-500/10 border border-cyan-500/20 text-white"
                              : "bg-white/5 border border-white/10 text-zinc-300"
                          }`}
                        >
                          {/* Show attached files for user messages */}
                          {msg.role === "user" &&
                            msg.metadata &&
                            Array.isArray((msg.metadata as { files?: unknown }).files) &&
                            ((msg.metadata as { files: Array<{ id: string; name: string }> }).files).length > 0 && (
                              <div className="mb-2 flex flex-wrap gap-2">
                                {(msg.metadata as { files: Array<{ id: string; name: string }> }).files.map((f, idx) => (
                                  <div
                                    key={`${msg.id}-file-${idx}`}
                                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-xs"
                                  >
                                    <Paperclip className="w-3 h-3" />
                                    <span className="truncate max-w-[150px]">{f.name}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          {msg.metadata &&
                            typeof (msg.metadata as Record<string, unknown>).workspace_request_id === "string" && (
                              <div className="mb-1 text-[10px] text-zinc-500">
                                Team reply
                                {typeof (msg.metadata as Record<string, unknown>).workspace_request_requested_user_handle ===
                                  "string" &&
                                  Boolean(
                                    (msg.metadata as Record<string, unknown>)
                                      .workspace_request_requested_user_handle
                                  ) && (
                                    <>
                                      {" "}
                                      ·{" "}
                                      <span className="text-zinc-300">
                                        @{String(
                                          (msg.metadata as Record<string, unknown>)
                                            .workspace_request_requested_user_handle
                                        )}
                                      </span>
                                    </>
                                  )}
                              </div>
                            )}
                          {(() => {
                            const twilioLiveBody = renderTwilioConversationLiveBody(
                              (msg.metadata as Record<string, unknown> | undefined) || undefined
                            );
                            if (twilioLiveBody) return twilioLiveBody;
                            return (
                              <p className="text-sm whitespace-pre-wrap">
                                {msg.role === "assistant"
                                  ? msg.content.replace(/\[Saving [^\]]+\.\.\.\]\s*/gi, "").trim()
                                  : msg.content}
                              </p>
                            );
                          })()}

                          {/* Heartbeat reauth buttons */}
                          {msg.role === "assistant" && msg.metadata &&
                            (() => {
                              const meta = msg.metadata as Record<string, unknown>;
                              if (meta.kind !== "heartbeat_reauth") return null;
                              const reauth = meta.reauth as Array<{ provider: string; label: string; url: string }> | undefined;
                              if (!reauth || reauth.length === 0) return null;
                              return (
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {reauth.map((r) => (
                                    <a
                                      key={r.provider}
                                      href={r.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/30 text-xs text-white hover:bg-amber-500/30 transition-colors"
                                    >
                                      Reconnect {r.label}
                                    </a>
                                  ))}
                                </div>
                              );
                            })()}

                          {/* WhatsApp pending-send confirmation (dashboard UI) */}
                          {msg.role === "assistant" &&
                            msg.metadata &&
                            (() => {
                              const meta = msg.metadata as Record<string, unknown>;
                              const pending = meta.whatsapp_pending_send as
                                | {
                                    chatId?: unknown;
                                    recipientDisplay?: unknown;
                                    text?: unknown;
                                    media?: unknown;
                                  }
                                | undefined;
                              const chatId = typeof pending?.chatId === "string" ? pending.chatId : "";
                              const text = typeof pending?.text === "string" ? pending.text : "";
                              const media = Array.isArray(pending?.media)
                                ? pending.media
                                : [];
                              const recipientDisplay =
                                typeof pending?.recipientDisplay === "string" ? pending.recipientDisplay : "";
                              const busy = whatsappConfirmBusyFor === msg.id;
                              if (!chatId || (!text.trim() && media.length === 0)) return null;
                              if (isWhatsAppPendingConsumed(msg.id)) return null;
                              return (
                                <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
                                  <div className="text-xs text-zinc-400">
                                    Ready to send on WhatsApp{recipientDisplay ? ` to ${recipientDisplay}` : ""}.
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    <button
                                      className="px-3 py-1.5 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-xs text-white hover:bg-cyan-500/30 disabled:opacity-50"
                                      disabled={busy}
                                      onClick={() =>
                                        handleWhatsAppConfirmSend(msg.id, {
                                          chatId,
                                          recipientDisplay: recipientDisplay || undefined,
                                          text,
                                          media: media as Array<{
                                            url?: string;
                                            localPath?: string;
                                            storagePath?: string;
                                            fileId?: string;
                                            filename?: string;
                                            caption?: string;
                                          }>,
                                        })
                                      }
                                    >
                                      {busy ? "Sending…" : "Confirm send"}
                                    </button>
                                    <button
                                      className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-50"
                                      disabled={busy}
                                      onClick={() => handleWhatsAppCancelSend(msg.id)}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              );
                            })()}

                          {/* Telegram pending-send confirmation (dashboard UI) */}
                          {msg.role === "assistant" &&
                            msg.metadata &&
                            (() => {
                              const meta = msg.metadata as Record<string, unknown>;
                              const pending = meta.telegram_pending_send as
                                | {
                                    chatId?: unknown;
                                    recipientDisplay?: unknown;
                                    text?: unknown;
                                    messageThreadId?: unknown;
                                    media?: unknown;
                                  }
                                | undefined;
                              const chatId = typeof pending?.chatId === "string" ? pending.chatId : "";
                              const text = typeof pending?.text === "string" ? pending.text : "";
                              const media = Array.isArray(pending?.media) ? pending.media : [];
                              const recipientDisplay =
                                typeof pending?.recipientDisplay === "string" ? pending.recipientDisplay : "";
                              const messageThreadId =
                                typeof pending?.messageThreadId === "number" ? pending.messageThreadId : undefined;
                              const busy = telegramConfirmBusyFor === msg.id;
                              if (!chatId || (!text.trim() && media.length === 0)) return null;
                              if (isTelegramPendingConsumed(msg.id)) return null;
                              return (
                                <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
                                  <div className="text-xs text-zinc-400">
                                    Ready to send on Telegram{recipientDisplay ? ` to ${recipientDisplay}` : ""}.
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    <button
                                      className="px-3 py-1.5 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-xs text-white hover:bg-cyan-500/30 disabled:opacity-50"
                                      disabled={busy}
                                      onClick={() =>
                                        handleTelegramConfirmSend(msg.id, {
                                          chatId,
                                          recipientDisplay: recipientDisplay || undefined,
                                          text,
                                          messageThreadId,
                                          media: media as Array<{
                                            url?: string;
                                            storagePath?: string;
                                            fileId?: string;
                                            filename?: string;
                                            caption?: string;
                                          }>,
                                        })
                                      }
                                    >
                                      {busy ? "Sending…" : "Confirm send"}
                                    </button>
                                    <button
                                      className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-50"
                                      disabled={busy}
                                      onClick={() => handleTelegramCancelSend(msg.id)}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              );
                            })()}
                          {/* Generated images (from AI Chat) - Mobile */}
                          {msg.role === "assistant" &&
                            msg.metadata &&
                            Array.isArray((msg.metadata as { generated_images?: unknown }).generated_images) &&
                            (msg.metadata as { generated_images: Array<{ mediaType: string; base64: string }> })
                              .generated_images.length > 0 && (
                              <div className="mt-3 grid grid-cols-1 gap-2">
                                {(msg.metadata as { generated_images: Array<{ mediaType: string; base64: string }> })
                                  .generated_images.map((img, idx) => (
                                    <div
                                      key={`img-${idx}`}
                                      className="rounded-xl overflow-hidden border border-white/10 bg-black/20"
                                    >
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img
                                        src={`data:${img.mediaType};base64,${img.base64}`}
                                        alt={`Generated image ${idx + 1}`}
                                        className="w-full max-h-[300px] object-contain"
                                      />
                                    </div>
                                  ))}
                              </div>
                            )}
                          <p className="text-[10px] text-zinc-600 mt-1">
                            {msg.timestamp.toLocaleTimeString()}
                          </p>
                        </div>
                        {/* Generated files (from Files agent / data_query) - Mobile */}
                        {msg.role === "assistant" &&
                          msg.metadata &&
                          Array.isArray((msg.metadata as { generated_files?: unknown }).generated_files) &&
                          (msg.metadata as { generated_files: Array<{ name?: string; filename?: string; url?: string; mediaType?: string; mime_type?: string; storage_path?: string; file_id?: string }> })
                            .generated_files.length > 0 && (
                            <div className="mt-2 w-full space-y-2">
                              {(msg.metadata as { generated_files: Array<{ name?: string; filename?: string; url?: string; mediaType?: string; mime_type?: string; storage_path?: string; file_id?: string }> })
                                .generated_files.map((f, idx) => {
                                  const fileName = f.filename || f.name || "file";
                                  const mimeType = f.mime_type || f.mediaType || "file";
                                  // Prefer stable same-origin proxy URLs over expiring signed URLs.
                                  const fileUrl =
                                    (f.storage_path
                                      ? `/api/datagran/files?storagePath=${encodeURIComponent(f.storage_path)}&agentId=generated`
                                      : null) ||
                                    (f.file_id
                                      ? `/api/datagran/files?fileId=${encodeURIComponent(f.file_id)}&agentId=generated`
                                      : null) ||
                                    (typeof f.url === "string" && f.url ? f.url : null);
                                  const isImage =
                                    typeof mimeType === "string" && mimeType.startsWith("image/");
                                  return (
                                    <div
                                      key={`${fileName}-${idx}`}
                                      className="rounded-xl border border-white/10 bg-black/20 overflow-hidden"
                                    >
                                      {isImage && fileUrl ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                          src={fileUrl}
                                          alt={fileName}
                                          className="w-full max-h-[320px] object-contain bg-black/30"
                                        />
                                      ) : null}
                                      <a
                                        href={fileUrl || "#"}
                                        target={fileUrl ? "_blank" : undefined}
                                        rel={fileUrl ? "noreferrer" : undefined}
                                        className={`flex items-center justify-between gap-3 px-3 py-2 ${isImage ? "border-t border-white/10" : ""} ${
                                          fileUrl
                                            ? "hover:bg-white/5"
                                            : "opacity-60 cursor-not-allowed"
                                        }`}
                                        onClick={(e) => {
                                          if (!fileUrl) e.preventDefault();
                                        }}
                                      >
                                        <div className="min-w-0">
                                          <div className="text-xs text-white truncate">{fileName}</div>
                                          <div className="text-[10px] text-zinc-500 truncate">
                                            {mimeType}
                                          </div>
                                        </div>
                                        <Download className="w-4 h-4 text-zinc-400 shrink-0" />
                                      </a>
                                    </div>
                                  );
                                })}
                            </div>
                          )}
                      </motion.div>
                    ))
                  )}

                  {/* Streaming content */}
                  {orchestrator.isStreaming && orchestrator.streamingContent && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex justify-start"
                    >
                      <div className="max-w-[95%] sm:max-w-[85%] rounded-2xl px-4 py-3 bg-white/5 border border-white/10">
                        <p className="text-sm text-zinc-300 whitespace-pre-wrap">
                          {orchestrator.streamingContent.replace(/\[Saving [^\]]+\.\.\.\]\s*/gi, "").trim()}
                          <span className="inline-block w-2 h-4 bg-cyan-400 ml-1 animate-pulse" />
                        </p>
                      </div>
                    </motion.div>
                  )}

                  {/* Working indicator (streaming but no content yet) */}
                  {orchestrator.isStreaming && !orchestrator.streamingContent && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex justify-start"
                    >
                      <div className="max-w-[95%] sm:max-w-[85%] rounded-2xl px-4 py-3 bg-white/5 border border-white/10">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2 text-sm text-zinc-300">
                            <Loader2 className="w-4 h-4 animate-spin text-rose-400" />
                            <span>{streamingPlaceholderText}</span>
                            <span className="inline-block w-2 h-4 bg-rose-400 animate-pulse" />
                          </div>
                          {currentOperations.length > 1 && (
                            <div className="text-xs text-zinc-500 pl-6">
                              +{currentOperations.length - 1} more operation{currentOperations.length > 2 ? "s" : ""}
                            </div>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {/* Re-authorization required banner */}
                  {orchestrator.needsReauth && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex justify-start"
                    >
                      <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-amber-500/10 border border-amber-500/30">
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center gap-2 text-sm text-amber-200">
                            <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                            <span>
                              {orchestrator.needsReauth.provider.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())} connection expired
                            </span>
                          </div>
                          <button
                            onClick={handleReauth}
                            disabled={!orchestrator.needsReauth.linkToken}
                            className="flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <RefreshCw className="w-4 h-4" />
                            Re-authorize Connection
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {/* Error banner (billing, network, etc.) */}
                  {orchestrator.error && !orchestrator.isStreaming && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex justify-start"
                    >
                      <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-rose-500/10 border border-rose-500/30">
                        <div className="flex items-start gap-2 text-sm text-rose-200">
                          <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
                          <span>{orchestrator.error}</span>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </div>

                {/* Mobile input */}
                <div className="border-t border-white/5 bg-zinc-950/90 backdrop-blur-xl p-3">
                  <UnifiedInput
                    onSend={handleSend}
                    isStreaming={orchestrator.isStreaming}
                    onCancel={handleCancelOrchestratorStream}
                    memoryEnabled={memoryEnabled}
                    onMemoryToggle={() => setMemoryEnabled((prev) => !prev)}
                    // #disabled - voice props removed because of major implementation change (realtime voice)
                    placeholder="Message Groovy..."
                    chatAgents={chatAgents}
                    activeChatAgentId={activeChatAgentId}
                    teamMembers={teamMembers}
                    onSelectChatAgent={(id) => {
                      setActiveChatAgentId(id);
                      try {
                        window.localStorage.setItem(lastChatAgentStorageKey, id);
                      } catch {
                        // ignore
                      }
                    }}
              chatSessions={chatSessions}
              activeChatSessionId={activeChatSessionId}
              onSelectChatSession={(id) => {
                setActiveChatSessionId(id);
                const agentId = activeChatAgentId || chatAgents[0]?.id;
                if (agentId) {
                  try {
                    window.localStorage.setItem(`groovy:ai-chat:lastSession:${agentId}`, id);
                  } catch {
                    // ignore
                  }
                }
              }}
              onCreateChatSession={async () => {
                const agentId = activeChatAgentId || chatAgents[0]?.id;
                if (!agentId) return null;
                const res = await fetch("/api/chat/sessions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ agentId, title: "New chat" }),
                });
                const json = await res.json().catch(() => ({}));
                if (!res.ok) return null;
                const created = json.session as { id: string; title: string } | undefined;
                if (!created?.id) return null;
                setChatSessions((prev) => [created, ...prev]);
                setActiveChatSessionId(created.id);
                try {
                  window.localStorage.setItem(`groovy:ai-chat:lastSession:${agentId}`, created.id);
                } catch {
                  // ignore
                }
                return { id: created.id, title: created.title || "New chat" };
              }}
              filesAgents={filesAgents}
              activeFilesAgentId={activeFilesAgentId}
              onSelectFilesAgent={(id) => {
                setActiveFilesAgentId(id);
                try {
                  window.localStorage.setItem(lastFilesAgentStorageKey, id);
                } catch {
                  // ignore
                }
              }}
              filesSessions={filesSessions}
              activeFilesSessionId={activeFilesSessionId}
              onSelectFilesSession={(id) => {
                setActiveFilesSessionId(id);
                const agentId = activeFilesAgentId || filesAgents[0]?.id;
                if (agentId) {
                  try {
                    window.localStorage.setItem(`groovy:files:lastSession:${agentId}`, id);
                  } catch {
                    // ignore
                  }
                }
              }}
              codeSessions={codeAgents.map((a) => ({ id: a.id, name: a.name }))}
              activeCodeSessionId={activeCodeAgentId}
              onSelectCodeSession={(id) => {
                setActiveCodeAgentId(id);
                try {
                  window.localStorage.setItem(lastCodeAgentStorageKey, id);
                } catch {
                  // ignore
                }
                setMainPane("code");
                setShowCodeSessions(false);
              }}
              onCreateFilesSession={async () => {
                const agentId = activeFilesAgentId || filesAgents[0]?.id;
                if (!agentId) return null;
                // Create via orchestrator agent-sessions API
                const orchId = orchestrator.currentSessionId;
                if (!orchId) return null;
                const res = await fetch("/api/orchestrator/agent-sessions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ orchestratorSessionId: orchId, agentType: "files" }),
                });
                const json = await res.json().catch(() => ({}));
                if (!res.ok || !json.session?.agentSessionId) return null;
                const created = { id: String(json.session.agentSessionId), title: "Files session" };
                setFilesSessions((prev) => [created, ...prev]);
                setActiveFilesSessionId(created.id);
                try {
                  window.localStorage.setItem(`groovy:files:lastSession:${agentId}`, created.id);
                } catch {
                  // ignore
                }
                return created;
              }}
                  />
                </div>
              </motion.div>
            )}

            {/* CODE TAB */}
            {mobileTab === "code" && (
              <motion.div
                key="code"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.2 }}
                className="flex-1 flex flex-col min-h-0"
              >
                {activeCodeAgentId ? (
                  <div className="flex-1 flex flex-col min-h-0">
                    <ClaudeCliChatPanel
                      key={activeCodeAgentId}
                      agentId={activeCodeAgentId}
                      agentName={activeCodeAgent?.name}
                      codeCliProvider={activeCodeAgent?.codeCliProvider}
                      queuedPrompt={
                        pendingCodePrompt &&
                        !pendingCodePrompt.targetPaneId &&
                        pendingCodePrompt.agentId === activeCodeAgentId
                          ? { id: pendingCodePrompt.id, content: pendingCodePrompt.content }
                          : null}
                      onQueuedPromptHandled={handleQueuedCodePromptHandled}
                      onBack={() => {
                        setActiveCodeAgentId(null);
                        setShowCodeSessions(true);
                      }}
                      onPlans={() => setShowPlansBrowser(true)}
                    />
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center p-6">
                    <div className="text-center">
                      <TerminalIcon className="w-12 h-12 text-zinc-600 mx-auto mb-4" />
                      <h3 className="text-lg font-semibold text-white mb-2">No Code Session</h3>
                      <p className="text-sm text-zinc-500 mb-4">
                        Create or select a Claude Code session
                      </p>
                      <div className="flex items-center justify-center gap-3">
                        <button
                          onClick={() => setShowCodeSessions(true)}
                          className="px-4 py-2 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-sm"
                        >
                          Manage Sessions
                        </button>
                        <button
                          onClick={() => setShowPlansBrowser(true)}
                          className="px-4 py-2 rounded-xl bg-white/5 text-zinc-300 border border-white/10 text-sm flex items-center gap-2 hover:bg-white/10"
                        >
                          <FileText className="w-4 h-4" />
                          Browse Plans
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {/* ACTIVITY TAB */}
            {mobileTab === "activity" && (
              <motion.div
                key="activity"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                transition={{ duration: 0.2 }}
                className="flex-1 min-h-0 overflow-hidden"
              >
                <div className="h-full flex flex-col min-h-0">
                  <div className="px-3 py-2 border-b border-white/5 bg-zinc-950/40">
                    <div className="text-[11px] text-zinc-300">
                      {runtimeTelemetry.runningSkillNames.length > 0
                        ? `Skill activity: ${runtimeTelemetry.runningSkillNames.join(", ")}`
                        : runtimeTelemetry.totalSkillCalls > 0
                          ? `Skill activity: ${runtimeTelemetry.totalSkillCalls} (last: ${runtimeTelemetry.lastSkillName || "unknown"})`
                          : "Skill activity: none yet"}
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-1 truncate">
                      {runtimeTelemetry.totalBranchForks > 0
                        ? `Branches created: ${runtimeTelemetry.totalBranchForks} | ${runtimeTelemetry.latestBranchDetail || "latest recorded"}`
                        : "Branches created: none yet"}
                    </div>
                  </div>
                  <div className="flex-1 min-h-0">
                  <ActivityFeed
                    items={activityFeed}
                    onItemClick={handleFeedItemClick}
                  />
                  </div>
                </div>
              </motion.div>
            )}

            {/* MORE TAB */}
            {mobileTab === "more" && (
              <motion.div
                key="more"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                transition={{ duration: 0.2 }}
                className="flex-1 overflow-y-auto p-4 space-y-4"
              >
                {/* Agent tiles in a compact grid */}
                <div className="grid grid-cols-2 gap-3">
                  {(["browser", "files", "pages", "obsidian", "data", "code", "chat", "schedule"] as AgentType[]).map((agent) => {
                    const agentConfig: Record<AgentType, { 
                      icon: typeof Globe; 
                      name: string; 
                      color: string; 
                      bgColor: string; 
                      borderColor: string;
                      glowColor: string;
                    }> = {
                      browser: { 
                        icon: Globe, 
                        name: "Browser", 
                        color: "text-cyan-400", 
                        bgColor: "bg-cyan-500/15", 
                        borderColor: "border-cyan-500/30",
                        glowColor: "rgba(34,211,238,0.3)"
                      },
                      files: { 
                        icon: FolderOpen, 
                        name: "Files", 
                        color: "text-amber-400", 
                        bgColor: "bg-amber-500/15", 
                        borderColor: "border-amber-500/30",
                        glowColor: "rgba(251,191,36,0.3)"
                      },
                      pages: {
                        icon: FileText,
                        name: "Pages",
                        color: "text-indigo-400",
                        bgColor: "bg-indigo-500/15",
                        borderColor: "border-indigo-500/30",
                        glowColor: "rgba(99,102,241,0.3)",
                      },
                      obsidian: { 
                        icon: BookOpen, 
                        name: "Notes", 
                        color: "text-violet-400", 
                        bgColor: "bg-violet-500/15", 
                        borderColor: "border-violet-500/30",
                        glowColor: "rgba(167,139,250,0.3)"
                      },
                      data: { 
                        icon: BarChart3, 
                        name: "Data", 
                        color: "text-emerald-400", 
                        bgColor: "bg-emerald-500/15", 
                        borderColor: "border-emerald-500/30",
                        glowColor: "rgba(16,185,129,0.3)"
                      },
                      chat: { 
                        icon: MessageSquare, 
                        name: "AI Chat", 
                        color: "text-rose-400", 
                        bgColor: "bg-rose-500/15", 
                        borderColor: "border-rose-500/30",
                        glowColor: "rgba(251,113,133,0.3)"
                      },
                      schedule: { 
                        icon: Clock, 
                        name: "Schedule", 
                        color: "text-blue-400", 
                        bgColor: "bg-blue-500/15", 
                        borderColor: "border-blue-500/30",
                        glowColor: "rgba(59,130,246,0.3)"
                      },
                      code: { 
                        icon: TerminalIcon, 
                        name: "Code", 
                        color: "text-sky-400", 
                        bgColor: "bg-sky-500/15", 
                        borderColor: "border-sky-500/30",
                        glowColor: "rgba(14,165,233,0.3)"
                      },
                    };
                    const config = agentConfig[agent];
                    const AgentIcon = config.icon;
                    const isRunning = agentStatuses[agent] === "running";
                    
                    return (
                      <button
                        key={agent}
                        onClick={() => {
                          if (agent === "data") setShowDataPanel(true);
                          if (agent === "files") openFilesPanel();
                          if (agent === "pages") setShowSiteBuilderPanel(true);
                          if (agent === "obsidian") openObsidianSetup();
                          if (agent === "chat" && chatAgents.length > 0) {
                            setActiveChatAgentId(chatAgents[0].id);
                            setShowChatPanel(true);
                          } else if (agent === "chat") {
                            if (llmKeyMode === "user" && !hasAnyUserKeys) openApiSettings();
                            else openChatAgentCreate();
                          }
                          if (agent === "schedule") setShowSchedulePanel(true);
                          if (agent === "code") setShowCodeSessions(true);
                        }}
                        className={`p-4 rounded-xl border text-left active:scale-95 transition-all ${
                          isRunning 
                            ? `${config.bgColor} ${config.borderColor}` 
                            : "bg-white/5 border-white/10 hover:bg-white/10"
                        }`}
                        style={{
                          boxShadow: isRunning ? `0 0 20px -4px ${config.glowColor}` : undefined
                        }}
                      >
                        <div className={`w-10 h-10 rounded-xl ${config.bgColor} flex items-center justify-center mb-3`}>
                          <AgentIcon className={`w-5 h-5 ${config.color}`} />
                        </div>
                        <div className="text-sm font-medium text-white">{config.name}</div>
                        <div className={`text-xs ${isRunning ? config.color : "text-zinc-500"}`}>
                          {isRunning ? "Active" : "Ready"}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Scheduled jobs (inline, mobile) */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xs text-zinc-500 uppercase tracking-wider">Scheduled Jobs</h3>
                    <button
                      onClick={() => refreshMobileScheduledJobs()}
                      disabled={mobileScheduledJobsLoading}
                      className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
                      title="Refresh scheduled jobs"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${
                          mobileScheduledJobsLoading ? "animate-spin" : ""
                        }`}
                      />
                      Refresh
                    </button>
                  </div>

                  {mobileScheduledJobsError && (
                    <div className="px-1 text-xs text-red-400">{mobileScheduledJobsError}</div>
                  )}

                  {mobileScheduledJobsLoading && mobileScheduledJobs.length === 0 ? (
                    <div className="px-1 text-xs text-zinc-500">Loading…</div>
                  ) : mobileScheduledJobs.length === 0 ? (
                    <div className="px-1 text-xs text-zinc-500">
                      No scheduled jobs yet. Create one in chat with{" "}
                      <span className="text-zinc-200">@schedule</span>.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {mobileScheduledJobs.slice(0, 6).map((j) => {
                        const isRunning = runningScheduledJobs.has(j.id);
                        const isEnabled = !!j.enabled;
                        const scheduleLabel = formatScheduleCompact(j.schedule);
                        const detail = getScheduledJobDetailCompact(j);

                        return (
                          <div
                            key={j.id}
                            className="rounded-xl border border-white/10 bg-black/20 p-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm text-white font-medium truncate">
                                  {j.name || "Scheduled task"}
                                </div>
                                <div className="mt-0.5 text-[11px] text-zinc-500 truncate">
                                  {scheduleLabel}
                                  {!isEnabled ? " · paused" : ""}
                                  {j.skip_next_run ? " · skip next" : ""}
                                </div>
                                <div className="mt-1 text-[11px] text-zinc-600 font-mono line-clamp-2">
                                  {detail}
                                </div>
                              </div>

                              <button
                                onClick={() => triggerScheduledJob(j.id, j.device_id)}
                                disabled={isRunning || relay.status !== "ready"}
                                className={`shrink-0 px-3 py-1.5 rounded-lg border text-xs ${
                                  isRunning
                                    ? "bg-blue-500/20 border-blue-500/30 text-blue-200"
                                    : "bg-emerald-500/10 border-emerald-500/20 text-emerald-200 hover:bg-emerald-500/20"
                                } disabled:opacity-60`}
                                title={
                                  relay.status !== "ready"
                                    ? "Connector offline"
                                    : isRunning
                                      ? "Job is running…"
                                      : "Run this job now"
                                }
                              >
                                {isRunning ? (
                                  <span className="inline-flex items-center gap-1.5">
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    Running
                                  </span>
                                ) : (
                                  "Run"
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}

                      <button
                        onClick={() => setShowSchedulePanel(true)}
                        className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-xs text-zinc-300 hover:bg-white/10 transition-colors"
                      >
                        View all scheduled jobs ({mobileScheduledJobs.length})
                      </button>
                    </div>
                  )}
                </div>

                {/* Quick actions */}
                <div className="space-y-2">
                  <h3 className="text-xs text-zinc-500 uppercase tracking-wider px-1">Quick Actions</h3>
                  
                  <button
                    onClick={() => setShowCodeSessions(true)}
                    className="w-full p-4 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-left flex items-center gap-3"
                  >
                    <TerminalIcon className="w-5 h-5 text-cyan-400" />
                    <div>
                      <div className="text-sm font-medium text-white">Code Sessions</div>
                      <div className="text-xs text-zinc-500">{codeAgents.length} session{codeAgents.length === 1 ? "" : "s"}</div>
                    </div>
                  </button>

                  <button
                    onClick={() => setShowPlansBrowser(true)}
                    className="w-full p-4 rounded-xl bg-white/5 border border-white/10 text-left flex items-center gap-3"
                  >
                    <FileText className="w-5 h-5 text-zinc-400" />
                    <div>
                      <div className="text-sm font-medium text-white">Plans</div>
                      <div className="text-xs text-zinc-500">Browse Claude Code plans</div>
                    </div>
                  </button>

                  <button
                    onClick={() => router.push("/dashboard/skills")}
                    className="w-full p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-left flex items-center gap-3"
                  >
                    <BookOpen className="w-5 h-5 text-emerald-400" />
                    <div>
                      <div className="text-sm font-medium text-white">Skills Manager</div>
                      <div className="text-xs text-zinc-500">Git-owned agent context</div>
                    </div>
                  </button>

                  {workspaceInfo?.role === "admin" && (
                    <button
                      onClick={() => router.push("/dashboard/cells")}
                      className="w-full p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-left flex items-center gap-3"
                    >
                      <CellIcon className="w-5 h-5 text-emerald-400" />
                      <div>
                        <div className="text-sm font-medium text-white">Living Cells</div>
                        <div className="text-xs text-zinc-500">Track signal, health, and AI efficiency</div>
                      </div>
                    </button>
                  )}

                  <button
                    onClick={() => setShowIntegrationsPanel(true)}
                    className="w-full p-4 rounded-xl bg-white/5 border border-white/10 text-left flex items-center gap-3"
                  >
                    <Plug className="w-5 h-5 text-cyan-400" />
                    <div>
                      <div className="text-sm font-medium text-white">Integrations</div>
                      <div className="text-xs text-zinc-500">Enterprise extensions</div>
                    </div>
                  </button>

                  <button
                    onClick={openApiSettings}
                    className="w-full p-4 rounded-xl bg-white/5 border border-white/10 text-left flex items-center gap-3"
                  >
                    <Settings className="w-5 h-5 text-zinc-400" />
                    <div>
                      <div className="text-sm font-medium text-white">Settings</div>
                      <div className="text-xs text-zinc-500">API keys</div>
                    </div>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Mobile Bottom Navigation */}
        <MobileBottomNav
          activeTab={mobileTab}
          onTabChange={setMobileTab}
          hasActivity={activityFeed.length > 0}
          codeSessionActive={!!activeCodeAgentId}
          isStreaming={orchestrator.isStreaming}
        />

        {/* Modals (same as desktop) */}
        <SettingsModal
          isOpen={showSettings}
          onClose={() => { setShowSettings(false); setSettingsFocusSection(undefined); }}
          onSave={handleSaveKeys}
          currentKeys={apiKeys}
          currentKeyMode={llmKeyMode}
          currentKeyModes={llmKeyModes}
          currentUserEmail={userEmail || null}
          onSignOut={handleSignOut}
          focusSection={settingsFocusSection}
          autoRunTeamRequests={autoRunTeamRequests}
          onSetAutoRunTeamRequests={persistAutoRunTeamRequests}
          onConnectorModeChanged={handleConnectorModeChanged}
          activeDeviceId={activeDeviceId}
          connectorOnline={connectorVisibleOnline}
          connectorWhatsAppHealth={connectorWhatsAppHealth}
          connectorAiyraVoiceHealth={connectorAiyraVoiceHealth}
          isHostedConnectorActive={activeConnectorIsHosted}
          connectorVersion={connectorVersion}
          minConnectorVersion={MIN_CONNECTOR_VERSION}
          connectorDownloadUrl={connectorGuide.downloadUrl}
          aiyraConfig={aiyraConfig}
          onLoadAiyraConfig={loadAiyraConfig}
          onSaveAiyraConfig={saveAiyraConfig}
          onReportAiyraVoiceEvent={reportAiyraVoiceEvent}
          onListAiyraAudioDevices={listAiyraAudioDevices}
          aiyraAudioDeviceDebugLog={aiyraAudioDeviceDebugLog}
          onRefreshConnector={refreshConnectorStatus}
          onRestartConnector={restartConnector}
          onUpdateConnector={updateConnector}
        />

        <ChatAgentCreateModal
          isOpen={showChatAgentCreate}
          onClose={() => setShowChatAgentCreate(false)}
          onCreated={(created) => {
            setChatAgents((prev) => [
              { id: created.id, name: created.name, provider: created.provider, model: created.model },
              ...prev,
            ]);
            setActiveChatAgentId(created.id);
            try {
              window.localStorage.setItem(lastChatAgentStorageKey, created.id);
            } catch {
              // ignore
            }
            setShowChatPanel(true);
            setMobileTab("chat");
          }}
        />

        <ObsidianSetupModal
          isOpen={showObsidianSetup}
          onClose={() => setShowObsidianSetup(false)}
          isLocalConnected={connectorOk && !!activeDeviceId}
          vaults={obsidianVaults}
          selectedVault={obsidianVaultPath}
          onSelectVault={(path: string) => {
            setObsidianVaultPath(path);
            try {
              window.localStorage.setItem(lastVaultStorageKey, path);
            } catch {
              // ignore
            }
          }}
          onRefreshVaults={async () => {
            if (!connectorOk || !activeDeviceId) return [];
            const result = await handleConnectorExecute({
              type: "obsidian_discover",
              params: {},
              toolCallId: `obsidian-discover-refresh-${Date.now()}`,
              toolName: "obsidian_discover",
              agent: "obsidian",
            });
            if (result.ok && Array.isArray(result.vaults)) {
              const vaults = result.vaults as ObsidianVault[];
              setObsidianVaults(vaults);
              return vaults;
            }
            return [];
          }}
        />

        <FilesAgentSetupModal
          isOpen={showFilesSetup}
          onClose={() => setShowFilesSetup(false)}
          filesAgents={filesAgents}
          onRefreshAgents={async () => {
            const { data: newFilesAgents } = await supabase
              .from("agents")
              .select("id, name, created_at")
              .eq("type", "files-agent")
              .order("created_at", { ascending: false });
            if (newFilesAgents) {
              setFilesAgents(
                newFilesAgents.map((a) => ({
                  id: a.id,
                  name: a.name,
                  createdAt: a.created_at,
                }))
              );
            }
          }}
          onCreated={() => {}}
          onDeleted={() => {}}
        />

        {/* Code Sessions Modal */}
        {showCodeSessions && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              className="w-full max-h-[85vh] bg-zinc-900 border-t border-white/10 rounded-t-3xl overflow-hidden shadow-2xl flex flex-col"
            >
              <div className="flex items-center justify-between p-4 border-b border-white/10">
                <h2 className="text-lg font-semibold text-white">Code Sessions</h2>
                <button
                  onClick={() => setShowCodeSessions(false)}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="px-4 pt-3 pb-1">
                <button
                  onClick={() => {
                    setShowCodeSessions(false);
                    setShowPlansBrowser(true);
                  }}
                  className="w-full p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-left flex items-center gap-3"
                >
                  <FileText className="w-5 h-5 text-cyan-400" />
                  <div>
                    <div className="text-sm font-medium text-white">Browse Plans</div>
                    <div className="text-xs text-zinc-500">View and run Claude Code plans</div>
                  </div>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <ClaudeCodeSessionsPanel
                  deviceId={activeDeviceId}
                  relayStatus={relay.status}
                  relaySend={relay.send}
                  relaySubscribe={relay.subscribe}
                  sessions={codeAgents}
                  onRefreshSessions={refreshCodeAgents}
                  isMobile={isMobile}
                  onOpenSession={(agentId) => {
                    setActiveCodeAgentId(agentId);
                    setMobileTab("code");
                    setShowCodeSessions(false);
                    try {
                      window.localStorage.setItem(lastCodeAgentStorageKey, agentId);
                    } catch {}
                  }}
                  onClose={() => setShowCodeSessions(false)}
                />
              </div>
            </motion.div>
          </div>
        )}

        {/* Plans Browser Modal (mobile) */}
        {showPlansBrowser && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              className="w-full max-h-[85vh] bg-zinc-900 border-t border-white/10 rounded-t-3xl overflow-hidden shadow-2xl flex flex-col"
            >
              <PlansBrowser
                plans={claudePlans.plans}
                isLoading={claudePlans.isLoading}
                error={claudePlans.error}
                onRefresh={claudePlans.refresh}
                codeAgents={codeAgents.map((a) => ({
                  id: a.id,
                  name: a.name,
                  codeCliProvider: a.codeCliProvider,
                }))}
                onExecute={handleExecutePlan}
                onClose={() => setShowPlansBrowser(false)}
              />
            </motion.div>
          </div>
        )}
      </div>
    );
  }

  // ========== DESKTOP LAYOUT ==========
  return (
    <div className="h-screen bg-[var(--bg-primary)] flex flex-col overflow-hidden">
      {/* Noise overlay */}
      <div className="noise-overlay" />

      {/* Background effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-cyan-500/5 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-violet-500/5 rounded-full blur-[150px]" />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-white/5 bg-[var(--bg-primary)]/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Image
              src="/Groovy_no_bg.png"
              alt="Groovy"
              width={280}
              height={80}
              className="h-20 w-auto"
              unoptimized
              priority
            />

            {/* Connector status with dropdown */}
            <div className="relative">
              <button
                ref={connectorButtonRef}
                onClick={toggleConnectorMenu}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all ${
                  connectorHasWhatsAppIssue
                    ? "bg-red-500/10 text-red-300 hover:bg-red-500/15"
                    : connectorVisibleOnline
                    ? "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15"
                    : isConnected
                    ? "bg-amber-500/10 text-amber-400 hover:bg-amber-500/15"
                    : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700"
                }`}
              >
                {connectorHasWhatsAppIssue ? (
                  <AlertCircle className="w-3.5 h-3.5" />
                ) : connectorVisibleOnline ? (
                  <Laptop2 className="w-3.5 h-3.5" />
                ) : isConnected ? (
                  <Wifi className="w-3.5 h-3.5" />
                ) : (
                  <WifiOff className="w-3.5 h-3.5" />
                )}
                <span>
                  {connectorHasWhatsAppIssue
                    ? connectorWhatsAppStatus === "recovering"
                      ? "WhatsApp Recovering"
                      : "WhatsApp Degraded"
                    : connectorVisibleOnline
                    ? "Machine Connected"
                    : isConnected
                    ? "Relay Only"
                    : "Offline"}
                </span>
                <ChevronDown className="w-3 h-3" />
              </button>
            </div>

            {/* Voice status indicator */}
            {(() => {
              const voiceHealth = connectorAiyraVoiceHealth;
              const isVoiceConfigured = aiyraConfig?.enabled === true;
              const metricEvent = String(voiceHealth?.last_metric_event || "")
                .trim()
                .toLowerCase();
              const metricAtMs = voiceHealth?.last_metric_at
                ? Date.parse(voiceHealth.last_metric_at)
                : NaN;
              const healthUpdatedAtMs = voiceHealth?.updated_at
                ? Date.parse(voiceHealth.updated_at)
                : NaN;
              const activeStatusStaleMs = 6500;
              const endedRecently =
                metricEvent === "voice_session_ended" &&
                Number.isFinite(metricAtMs) &&
                Date.now() - metricAtMs < 15000;
              const hasRecentVoiceActivity =
                Number.isFinite(metricAtMs) &&
                Date.now() - metricAtMs < 8_000 &&
                AIYRA_RECENT_UI_ACTIVITY_EVENTS.includes(
                  metricEvent as (typeof AIYRA_RECENT_UI_ACTIVITY_EVENTS)[number]
                );
              const hasFreshActiveFlag =
                voiceHealth?.active === true &&
                !endedRecently &&
                Number.isFinite(healthUpdatedAtMs) &&
                Date.now() - healthUpdatedAtMs < activeStatusStaleMs;
              const isVoiceActive =
                !endedRecently &&
                (hasFreshActiveFlag ||
                  hasRecentVoiceActivity ||
                  voiceWakePulseActive);
              const isVoiceRecovering = voiceHealth?.status === "recovering";
              const isVoiceDegraded = voiceHealth?.status === "degraded";
              const isVoiceListening =
                voiceHealth?.listening === true ||
                (!isVoiceActive &&
                  !isVoiceRecovering &&
                  !isVoiceDegraded &&
                  (voiceHealth?.status === "healthy" ||
                    (isVoiceConfigured && connectorOk)));
              const isVoiceDisabled =
                !isVoiceConfigured ||
                voiceHealth?.status === "disabled";
              const isVoiceMuted =
                isVoiceActive && typeof aiyraVoiceMutedOverride === "boolean"
                  ? aiyraVoiceMutedOverride
                  : voiceHealth?.muted === true;
              const configuredMicName =
                typeof voiceHealth?.configured_mic_name === "string"
                  ? voiceHealth.configured_mic_name.trim()
                  : "";
              const resolvedDeviceName =
                typeof voiceHealth?.resolved_device_name === "string"
                  ? voiceHealth.resolved_device_name.trim()
                  : "";
              const micSelectionFallbackReason =
                typeof voiceHealth?.mic_selection_fallback_reason === "string"
                  ? voiceHealth.mic_selection_fallback_reason.trim()
                  : "";
              const micInputLevelRaw = Number(voiceHealth?.mic_input_level);
              const micInputUpdatedAtMs =
                typeof voiceHealth?.mic_input_updated_at === "string"
                  ? Date.parse(voiceHealth.mic_input_updated_at)
                  : NaN;
              const liveMicLevel =
                isVoiceActive &&
                !isVoiceMuted &&
                Number.isFinite(micInputLevelRaw) &&
                Number.isFinite(micInputUpdatedAtMs) &&
                Date.now() - micInputUpdatedAtMs < 1800
                  ? Math.max(0, Math.min(1, micInputLevelRaw))
                  : 0;
              const wakeWord =
                voiceHealth?.wake_word || aiyraConfig?.wakeWord || "hey groovy";
              const lowMicGainDetected = voiceHealth?.low_mic_gain_detected === true;
              const lowMicGainMessage =
                typeof voiceHealth?.low_mic_gain_message === "string" &&
                voiceHealth.low_mic_gain_message.trim()
                  ? voiceHealth.low_mic_gain_message.trim()
                  : "Microphone gain appears to be too low. Please increase your microphone volume.";
              const lowMicGainMaxEnergy = Number(
                voiceHealth?.low_mic_gain_max_energy_observed
              );
              const lowMicGainThreshold = Number(voiceHealth?.low_mic_gain_threshold);
              const lowMicGainDetails =
                Number.isFinite(lowMicGainMaxEnergy) &&
                Number.isFinite(lowMicGainThreshold)
                  ? `Detected ${Math.round(lowMicGainMaxEnergy)} / required ${Math.round(
                      lowMicGainThreshold
                    )}`
                  : "";
              const voiceDetail =
                typeof voiceHealth?.detail === "string" ? voiceHealth.detail.trim() : "";
              const visibleVoiceDetail =
                voiceDetail && voiceDetail !== "Connected to Aiyra voice session."
                  ? voiceDetail
                  : "";
              const isVoiceLowMicGain =
                lowMicGainDetected &&
                !isVoiceDisabled &&
                voiceHealth?.reason === "aiyra_low_mic_gain" &&
                isVoiceActive;
              const micRouteDetail =
                micSelectionFallbackReason === "specific_device_missing" && configuredMicName
                  ? `Selected mic "${configuredMicName}" is unavailable${
                      resolvedDeviceName ? `; connector is seeing "${resolvedDeviceName}" instead.` : "."
                    }`
                  : configuredMicName && resolvedDeviceName && configuredMicName !== resolvedDeviceName
                  ? `Configured mic "${configuredMicName}", using "${resolvedDeviceName}".`
                  : resolvedDeviceName
                  ? `Using "${resolvedDeviceName}".`
                  : configuredMicName
                  ? `Configured mic "${configuredMicName}".`
                  : "";

              if (isVoiceDisabled && !localConnectorOnline) return null;

              const tooltip = isVoiceLowMicGain
                ? `${lowMicGainMessage}${lowMicGainDetails ? ` (${lowMicGainDetails})` : ""}`
                : isVoiceActive
                ? visibleVoiceDetail ||
                  (isVoiceMuted
                    ? "Voice session active (mic muted)"
                    : "Voice session active")
                : isVoiceListening
                ? `Listening for "${wakeWord}"`
                : isVoiceRecovering
                ? "Voice connecting..."
                : isVoiceDegraded
                ? `Voice error: ${voiceHealth?.detail || voiceHealth?.reason || "degraded"}`
                : isVoiceDisabled
                ? "Voice not enabled"
                : "Voice idle";
              const tooltipWithMicDetails = micRouteDetail
                ? `${tooltip} ${micRouteDetail}`.trim()
                : tooltip;

              return (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openSettingsToSection("aiyra-voice")}
                    title={tooltipWithMicDetails}
                    className={`relative flex items-center gap-1.5 rounded-lg transition-all ${
                      isVoiceLowMicGain
                        ? "bg-amber-500/15 text-amber-200 border border-amber-400/40 px-2.5 py-1.5"
                        : isVoiceActive
                        ? "bg-red-500/20 text-red-300 border border-red-400/40 px-2.5 py-1.5"
                        : isVoiceListening
                        ? "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15 w-8 h-8 justify-center"
                        : isVoiceRecovering
                        ? "bg-amber-500/10 text-amber-400 w-8 h-8 justify-center"
                        : isVoiceDegraded
                        ? "bg-red-500/10 text-red-400 hover:bg-red-500/15 w-8 h-8 justify-center"
                        : "bg-zinc-800/60 text-zinc-600 hover:bg-zinc-700/60 hover:text-zinc-400 w-8 h-8 justify-center"
                    }`}
                  >
                    {isVoiceLowMicGain ? (
                      <>
                        <AlertCircle className="w-3.5 h-3.5" />
                        <VoiceMicLevelMeter level={liveMicLevel} muted={isVoiceMuted} />
                        <span className="text-[11px] font-semibold tracking-wide uppercase">
                          Low Mic
                        </span>
                      </>
                    ) : isVoiceActive ? (
                      <>
                        <span className="relative flex h-2.5 w-2.5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                        </span>
                        {isVoiceMuted ? (
                          <MicOff className="w-3.5 h-3.5" />
                        ) : (
                          <Mic className="w-3.5 h-3.5" />
                        )}
                        <VoiceMicLevelMeter level={liveMicLevel} muted={isVoiceMuted} />
                        <span
                          className={
                            visibleVoiceDetail
                              ? "max-w-[180px] truncate text-[11px] font-medium tracking-normal"
                              : "text-[11px] font-semibold tracking-wide uppercase"
                          }
                        >
                          {visibleVoiceDetail || "Live"}
                        </span>
                      </>
                    ) : isVoiceListening ? (
                      <>
                        <Mic className="w-4 h-4 relative z-10" />
                        <span className="absolute bottom-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400 z-20" />
                      </>
                    ) : isVoiceRecovering ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : isVoiceDegraded ? (
                      <MicOff className="w-4 h-4" />
                    ) : (
                      <MicOff className="w-4 h-4" />
                    )}
                  </button>
                  {isVoiceActive && (
                    <button
                      onClick={async () => {
                        if (aiyraVoiceMutePending) return;
                        setAiyraVoiceMutePending(true);
                        try {
                          await setAiyraVoiceMuted(!isVoiceMuted);
                        } finally {
                          setAiyraVoiceMutePending(false);
                        }
                      }}
                      disabled={aiyraVoiceMutePending}
                      title={isVoiceMuted ? "Unmute mic" : "Mute mic"}
                      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold tracking-wide uppercase transition-all ${
                        isVoiceMuted
                          ? "border-amber-400/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/20"
                          : "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white"
                      } ${aiyraVoiceMutePending ? "cursor-wait opacity-70" : ""}`}
                    >
                      {aiyraVoiceMutePending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : isVoiceMuted ? (
                        <Mic className="w-3.5 h-3.5" />
                      ) : (
                        <MicOff className="w-3.5 h-3.5" />
                      )}
                      <span>{isVoiceMuted ? "Unmute" : "Mute"}</span>
                    </button>
                  )}
                </div>
              );
            })()}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => router.push("/dashboard/skills")}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/15 transition-all"
              title="Manage agent skills and instructions"
            >
              <BookOpen className="w-4 h-4" />
              <span className="text-xs font-medium">Skills</span>
            </button>

            <button
              onClick={() => setShowIntegrationsPanel(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 hover:bg-cyan-500/15 transition-all"
              title="Manage integrations"
            >
              <Plug className="w-4 h-4" />
              <span className="text-xs font-medium">Integrations</span>
            </button>

            {workspaceInfo?.role === "admin" && (
              <button
                onClick={() => router.push("/dashboard/cells")}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-zinc-500 hover:text-emerald-300 hover:bg-emerald-500/10 transition-all"
                title="Living cells"
              >
                <CellIcon className="w-5 h-5" />
              </button>
            )}

            {/* Settings */}
            <button
              onClick={openApiSettings}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main
        className={`relative z-10 flex-1 max-w-7xl mx-auto w-full px-4 md:px-6 py-4 md:py-6 flex flex-col gap-4 md:gap-6 min-h-0 overflow-x-hidden ${
          multiAgent.viewMode === "multi" ? "overflow-y-hidden" : "overflow-y-auto"
        }`}
      >

        {/* Multi-agent grid (replaces everything below when active) */}
        {multiAgent.viewMode === "multi" && (
          <div className="flex-1 min-h-0 overflow-hidden -mx-4 md:-mx-6 -my-4 md:-my-6">
            <AgentGrid
              viewMode={multiAgent.viewMode}
              onSetViewMode={multiAgent.setViewMode}
              gridCols={multiAgent.gridCols}
              onSetGridCols={multiAgent.setGridCols}
              panes={multiAgent.panes}
              sessions={multiAgent.sessions}
              chatSubAgents={chatAgents.map((a) => ({ id: a.id, name: a.name }))}
              codeSubAgents={codeAgents.map((a) => ({ id: a.id, name: a.name, codeCliProvider: a.codeCliProvider }))}
              onAddPane={multiAgent.addPane}
              onRemovePane={multiAgent.removePane}
              onSetPaneSession={multiAgent.setPaneSession}
              onSetPaneKind={multiAgent.setPaneKind}
              onSetPaneChatAgent={multiAgent.setPaneChatAgent}
              onSetPaneCodeAgent={multiAgent.setPaneCodeAgent}
              onCreateCodeAgent={createCodeAgentFromMultiView}
              onPickCodeWorkspace={pickCodeWorkspaceForMultiView}
              canCreateCodeAgent={!!activeDeviceId}
              createCodeAgentDisabledReason={
                activeDeviceId ? undefined : "Connect the Groovy Connector to create Code agents."
              }
              queuedPrompt={
                pendingCodePrompt?.targetPaneId
                  ? { id: pendingCodePrompt.id, content: pendingCodePrompt.content, targetPaneId: pendingCodePrompt.targetPaneId }
                  : null
              }
              onQueuedPromptHandled={handleQueuedCodePromptHandled}
              onOpenPlans={() => setShowPlansBrowser(true)}
              handshakes={multiAgent.handshakes}
              onHandshakeConnect={multiAgent.connectHandshake}
              onHandshakeDisconnect={multiAgent.disconnectHandshake}
              onSendPaneMessage={multiAgent.sendPaneMessage}
              onCreateSession={multiAgent.createSession}
              singleViewContent={null}
            />
          </div>
        )}

        {multiAgent.viewMode === "single" && (
        <>
        {/* View mode toggle */}
        <div className="flex justify-end shrink-0 -mb-2">
          <button
            onClick={() => multiAgent.setViewMode("multi")}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-[11px] text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            title="Switch to multi-agent view"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
            Multi-Agent
          </button>
        </div>

        {/* Agent particles - compact floating pills */}
        <div className="shrink-0 overflow-visible py-3">
          <AgentParticles
            agents={[
              {
                id: "browser" as const,
                status: agentStatuses.browser,
                runningContext: runningContexts.browser,
              },
              {
                id: "files" as const,
                status: agentStatuses.files,
                runningContext: runningContexts.files,
                filesAgentConfigured: filesAgents.length > 0,
              },
              {
                id: "pages" as const,
                status: agentStatuses.pages,
                runningContext: runningContexts.pages,
              },
              {
                id: "obsidian" as const,
                status: agentStatuses.obsidian,
                runningContext: runningContexts.obsidian,
                obsidianConfigured: !!obsidianVaultPath,
                isLocalConnected: connectorVisibleOnline,
              },
              {
                id: "data" as const,
                status: agentStatuses.data,
                runningContext: runningContexts.data,
                dataConnections,
              },
              {
                id: "schedule" as const,
                status: agentStatuses.schedule,
                runningContext: runningContexts.schedule,
              },
              {
                id: "code" as const,
                status: "idle" as AgentStatus,
                codeSessionCount: codeAgents.length,
                activeCodeSessionId: activeCodeAgentId,
              },
              {
                id: "chat" as const,
                status: agentStatuses.chat || ("idle" as AgentStatus),
                runningContext: runningContexts.chat,
                chatConfigured: chatAgents.length > 0,
                chatAgentId: activeChatAgentId,
              },
            ]}
            onAgentAction={(agent, action) => {
              if (agent === "files") {
                if (action === "open") openFilesPanel();
                else if (action === "configure") openFilesSetup();
              } else if (agent === "pages") {
                if (action === "open") {
                  setShowSiteBuilderPanel(true);
                } else if (action === "settings") {
                  setShowPagesManagerModal(true);
                }
              } else if (agent === "obsidian") {
                if (action === "settings" || action === "configure") openObsidianSetup();
              } else if (agent === "data") {
                if (action === "open") setShowDataPanel(true);
              } else if (agent === "schedule") {
                if (action === "open") setShowSchedulePanel(true);
              } else if (agent === "code") {
                if (action === "open") setShowCodeSessions(true);
              } else if (agent === "chat") {
                if (action === "open" && chatAgents.length > 0) {
                  setActiveChatAgentId(chatAgents[0].id);
                  setShowChatPanel(true);
                } else if (action === "configure") {
                  if (llmKeyMode === "user" && !hasAnyUserKeys) openApiSettings();
                  else openChatAgentCreate();
                }
              }
            }}
          />
        </div>

        <OnboardingChecklist
          connectorOk={connectorVisibleOnline}
          connectorOnline={connectorVisibleOnline}
          connectorWhatsAppHealth={connectorWhatsAppHealth}
          chatAgentsCount={chatAgents.length}
          onOpenConnectorMenu={openConnectorMenu}
          onOpenChatAgentCreate={openChatAgentCreate}
          onOpenObsidian={openObsidianSetup}
          onOpenFiles={openFilesSetup}
        />

        {/* MOBILE: Running agent visualization (top, collapsible) */}
        <div className="lg:hidden">
          <AnimatePresence>
            {hasRunningAgents && !showSiteBuilderPanel && (
              <RunningAgentPanel
                runningAgents={[
                  { agent: "browser", status: agentStatuses.browser, runningContext: runningContexts.browser },
                  { agent: "files", status: agentStatuses.files, runningContext: runningContexts.files },
                  { agent: "pages", status: agentStatuses.pages, runningContext: runningContexts.pages },
                  { agent: "obsidian", status: agentStatuses.obsidian, runningContext: runningContexts.obsidian },
                  { agent: "data", status: agentStatuses.data, runningContext: runningContexts.data },
                  { agent: "code", status: agentStatuses.code, runningContext: runningContexts.code },
                  { agent: "chat", status: agentStatuses.chat, runningContext: runningContexts.chat },
                  { agent: "schedule", status: agentStatuses.schedule, runningContext: runningContexts.schedule },
                ]}
                layout="top"
              />
            )}
          </AnimatePresence>
        </div>

        {/* Conversation + Activity area - ADAPTIVE LAYOUT */}
        <div className="flex-1 flex gap-4 min-h-0">
          {/* Left: Running agent visualization (ONLY when agent is active, desktop only) */}
          <AnimatePresence mode="wait">
            {hasRunningAgents && !showSiteBuilderPanel && (
              <motion.div
                key="running-panel"
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 320 }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="hidden lg:block shrink-0 h-full"
              >
                <RunningAgentPanel
                  runningAgents={[
                    { agent: "browser", status: agentStatuses.browser, runningContext: runningContexts.browser },
                    { agent: "files", status: agentStatuses.files, runningContext: runningContexts.files },
                    { agent: "pages", status: agentStatuses.pages, runningContext: runningContexts.pages },
                    { agent: "obsidian", status: agentStatuses.obsidian, runningContext: runningContexts.obsidian },
                    { agent: "data", status: agentStatuses.data, runningContext: runningContexts.data },
                    { agent: "code", status: agentStatuses.code, runningContext: runningContexts.code },
                    { agent: "chat", status: agentStatuses.chat, runningContext: runningContexts.chat },
                    { agent: "schedule", status: agentStatuses.schedule, runningContext: runningContexts.schedule },
                  ]}
                  layout="side"
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Left: Site Builder preview panel (inline) */}
          <AnimatePresence>
            {showSiteBuilderPanel && !siteBuilderExpanded && (
              <motion.div
                key="site-builder-inline"
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.2 }}
                className="hidden lg:block shrink-0 h-full w-[480px]"
              >
                <SiteBuilderPanel
                  slug={siteBuilderState.slug}
                  status={siteBuilderState.status}
                  errorMessage={siteBuilderState.errorMessage}
                  devPort={siteBuilderState.devPort}
                  tunnelNonce={siteBuilderState.tunnelNonce}
                  deviceId={siteBuilderState.deviceId}
                  productionUrl={siteBuilderState.productionUrl}
                  expanded={false}
                  onClose={handleCloseSiteBuilderPanel}
                  onToggleExpand={() => setSiteBuilderExpanded(true)}
                  onDeploy={handleSiteDeploy}
                  onRestartPreview={handleSiteRestartPreview}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Chat panel - grows to fill space */}
          <div className="flex-1 bg-zinc-900/40 border border-white/5 rounded-2xl flex flex-col overflow-hidden min-w-0">
            {mainPane === "code" ? (
              <>
                {activeCodeAgentId ? (
                  <div className="flex-1 flex flex-col min-h-0">
                    {/* Header with session switcher and back button */}
                    <div className="px-4 py-2 border-b border-white/5 flex items-center justify-between shrink-0">
                      <div className="flex items-center gap-2">
                        <TerminalIcon className="w-4 h-4 text-cyan-400" />
                        <span className="text-sm text-zinc-200">
                          {activeCodeAgent?.name || "Code Session"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setShowPlansBrowser(true)}
                          className="px-3 py-1.5 rounded-lg bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white transition-colors text-xs flex items-center gap-1.5"
                        >
                          <FileText className="w-3 h-3" />
                          Plans
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowCodeSessions(true)}
                          className="px-3 py-1.5 rounded-lg bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white transition-colors text-xs"
                        >
                          Switch
                        </button>
                        <button
                          type="button"
                          onClick={() => setMainPane("chat")}
                          className="px-3 py-1.5 rounded-lg bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white transition-colors text-xs"
                        >
                          Chat
                        </button>
                      </div>
                    </div>
                    {/* Chat panel */}
                    <div className="flex-1 min-h-0">
                      <ClaudeCliChatPanel
                        key={activeCodeAgentId || "none"}
                        agentId={activeCodeAgentId}
                        agentName={activeCodeAgent?.name}
                        codeCliProvider={activeCodeAgent?.codeCliProvider}
                        queuedPrompt={
                          pendingCodePrompt &&
                          !pendingCodePrompt.targetPaneId &&
                          pendingCodePrompt.agentId === activeCodeAgentId
                            ? { id: pendingCodePrompt.id, content: pendingCodePrompt.content }
                            : null
                        }
                        onQueuedPromptHandled={handleQueuedCodePromptHandled}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col min-h-0">
                    <div className="px-4 py-2 border-b border-white/5 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <TerminalIcon className="w-4 h-4 text-cyan-400" />
                        <span className="text-sm text-zinc-200">Claude Code</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setMainPane("chat")}
                        className="px-3 py-1.5 rounded-lg bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white transition-colors text-xs"
                      >
                        Chat
                      </button>
                    </div>
                    <div className="flex-1 flex items-center justify-center p-4">
                      <div className="text-center">
                        <TerminalIcon className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
                        <p className="text-sm text-zinc-400 mb-3">No code session selected</p>
                        <button
                          onClick={() => setShowCodeSessions(true)}
                          className="px-4 py-2 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-sm hover:bg-cyan-500/30 transition-colors"
                        >
                          Select Session
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Session header */}
                <div className="px-4 py-2 border-b border-white/5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowSessionList(!showSessionList)}
                      className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
                    >
                      <MessageSquare className="w-4 h-4" />
                      <span className="font-medium">
                        {orchestrator.sessions.find(s => s.id === orchestrator.currentSessionId)?.title || "New Agent"}
                      </span>
                      <span className="text-zinc-600 text-xs">
                        ({orchestrator.sessions.length} agents)
                      </span>
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (activeCodeAgentId) {
                          setMainPane("code");
                        } else {
                          setShowCodeSessions(true);
                        }
                      }}
                      className={`px-3 py-2 rounded-xl border transition-colors text-xs ${
                        activeCodeAgentId
                          ? "bg-cyan-500/15 border-cyan-500/20 text-cyan-200 hover:bg-cyan-500/20"
                          : "bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      Code
                    </button>
                    <button
                      onClick={() => {
                        const sid = orchestrator.currentSessionId;
                        if (sid) shareSessionWithWorkspace(sid);
                      }}
                      disabled={
                        !orchestrator.currentSessionId ||
                        !!orchestrator.sessions.find((s) => s.id === orchestrator.currentSessionId)?.shared
                      }
                      className="text-xs text-zinc-500 hover:text-cyan-400 transition-colors disabled:opacity-40 disabled:hover:text-zinc-500"
                    >
                      Share with all
                    </button>
                    <button
                      onClick={() => orchestrator.createSession()}
                      className="flex items-center gap-1 text-xs text-zinc-500 hover:text-cyan-400 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      New
                    </button>
                  </div>
                </div>

            {/* Session list dropdown */}
            {showSessionList && (
              <div className="border-b border-white/5 bg-zinc-900/60 max-h-48 overflow-y-auto">
                {orchestrator.sessions.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-zinc-500 text-center">
                    No agent sessions yet
                  </div>
                ) : (
                  orchestrator.sessions.map((session) => (
                    <div
                      key={session.id}
                      className={`px-4 py-2 flex items-center gap-2 hover:bg-white/5 cursor-pointer ${
                        session.id === orchestrator.currentSessionId ? "bg-white/5" : ""
                      }`}
                    >
                      {editingSessionId === session.id ? (
                        <div className="flex-1 flex items-center gap-2">
                          <input
                            type="text"
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                orchestrator.renameSession(session.id, editingTitle);
                                setEditingSessionId(null);
                              } else if (e.key === "Escape") {
                                setEditingSessionId(null);
                              }
                            }}
                            className="flex-1 bg-zinc-800 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none focus:border-cyan-500"
                            autoFocus
                          />
                          <button
                            onClick={() => {
                              orchestrator.renameSession(session.id, editingTitle);
                              setEditingSessionId(null);
                            }}
                            className="text-emerald-400 hover:text-emerald-300"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setEditingSessionId(null)}
                            className="text-zinc-500 hover:text-white"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <>
                          <div
                            className="flex-1 min-w-0"
                            onClick={() => {
                              orchestrator.selectSession(session.id);
                              setShowSessionList(false);
                            }}
                          >
                            <p className="text-xs text-white truncate">{session.title}</p>
                            <p className="text-[10px] text-zinc-600">
                              {new Date(session.updatedAt).toLocaleDateString()} · {session.messageCount || 0} msgs
                            </p>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingSessionId(session.id);
                              setEditingTitle(session.title);
                            }}
                            className="text-zinc-600 hover:text-white p-1"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm("Delete this chat?")) {
                                orchestrator.deleteSession(session.id);
                              }
                            }}
                            className="text-zinc-600 hover:text-red-400 p-1"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {pendingTeamRequests.length > 0 &&
                (() => {
                  const sid = orchestrator.currentSessionId;
                  const aid = orchestrator.getAgentIdForSession(sid);
                  const inSession = sid
                    ? pendingTeamRequests.filter((r) => {
                        const rowAgentId = typeof r.agent_id === "string" ? r.agent_id.trim() : "";
                        const rowSessionId = typeof r.session_id === "string" ? r.session_id.trim() : "";
                        if (aid && rowAgentId) return rowAgentId === aid;
                        return rowSessionId === sid;
                      })
                    : [];
                  const otherCount = pendingTeamRequests.length - inSession.length;
                  const rows = inSession.slice(0, 2);
                  return (
                    <div className="rounded-2xl border border-white/10 bg-amber-500/5 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs text-amber-200 flex items-center gap-2">
                          <AlertCircle className="w-3.5 h-3.5" />
                          Team requests
                          <span className="text-[10px] text-amber-200/70">({pendingTeamRequests.length})</span>
                        </div>
                        {otherCount > 0 && (
                          <div className="text-[10px] text-zinc-500">{otherCount} in other chats</div>
                        )}
                      </div>

                      {rows.length === 0 ? (
                        <div className="mt-2 text-[11px] text-zinc-500">
                          Open the shared chat to run the request.
                        </div>
                      ) : (
                        <div className="mt-2 space-y-2">
                          {rows.map((r) => {
                            const requestedBy = teamMembers.find((m) => m.id === r.requested_by_user_id) || null;
                            const msgRaw = r.request?.message;
                            const msg = typeof msgRaw === "string" ? msgRaw : String(msgRaw || "");
                            return (
                              <div key={r.id} className="rounded-xl border border-white/10 bg-black/20 p-2">
                                <div className="text-[10px] text-zinc-500">
                                  From{" "}
                                  <span className="text-zinc-300">
                                    {requestedBy?.handle ? `@${requestedBy.handle}` : requestedBy?.label || "teammate"}
                                  </span>
                                </div>
                                <div className="text-xs text-zinc-200 mt-1 whitespace-pre-wrap">{msg}</div>
                                {!autoRunTeamRequests && (
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    <button
                                      type="button"
                                      onClick={() => runTeamRequest(r)}
                                      className="px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-xs text-amber-100 hover:bg-amber-500/20"
                                    >
                                      Run
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => dismissTeamRequest(r.id)}
                                      className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-zinc-200 hover:bg-white/10"
                                    >
                                      Dismiss
                                    </button>
                                  </div>
                                )}
                                {autoRunTeamRequests && (
                                  <div className="mt-2 text-[11px] text-zinc-500">Auto-run enabled.</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}
              {conversationMessages.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center max-w-md">
                    <h2 className="text-xl font-semibold text-white mb-2">
                      Welcome to Groovy
                    </h2>
                    <p className="text-sm text-zinc-500 mb-4">
                      I can help you browse the web, manage files, search your
                      Obsidian notes, and analyze your marketing data.
                    </p>
                    <p className="text-xs text-zinc-600">
                      Try: &ldquo;Search my notes for meeting ideas&rdquo; or &ldquo;@browser go
                      to google.com&rdquo;
                    </p>
                  </div>
                </div>
              ) : (
                conversationMessages.map((msg) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex flex-col ${
                      msg.role === "user" ? "items-end" : "items-start"
                    }`}
                  >
                    <div
                      className={`max-w-[95%] sm:max-w-[80%] rounded-2xl px-4 py-3 ${
                        msg.role === "user"
                          ? "bg-cyan-500/10 border border-cyan-500/20 text-white"
                          : "bg-white/5 border border-white/10 text-zinc-300"
                      }`}
                    >
                      {/* Show attached files for user messages */}
                      {msg.role === "user" &&
                        msg.metadata &&
                        Array.isArray((msg.metadata as { files?: unknown }).files) &&
                        ((msg.metadata as { files: Array<{ id: string; name: string }> }).files).length > 0 && (
                          <div className="mb-2 flex flex-wrap gap-2">
                            {(msg.metadata as { files: Array<{ id: string; name: string }> }).files.map((f, idx) => (
                              <div
                                key={`${msg.id}-file-${idx}`}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-xs"
                              >
                                <Paperclip className="w-3 h-3" />
                                <span className="truncate max-w-[150px]">{f.name}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      {msg.metadata &&
                        typeof (msg.metadata as Record<string, unknown>).workspace_request_id === "string" && (
                          <div className="mb-1 text-[10px] text-zinc-500">
                            Team reply
                            {typeof (msg.metadata as Record<string, unknown>)
                              .workspace_request_requested_user_handle === "string" &&
                              Boolean(
                                (msg.metadata as Record<string, unknown>).workspace_request_requested_user_handle
                              ) && (
                                <>
                                  {" "}
                                  ·{" "}
                                  <span className="text-zinc-300">
                                    @{String(
                                      (msg.metadata as Record<string, unknown>).workspace_request_requested_user_handle
                                    )}
                                  </span>
                                </>
                              )}
                          </div>
                        )}
                      {(() => {
                        const twilioLiveBody = renderTwilioConversationLiveBody(
                          (msg.metadata as Record<string, unknown> | undefined) || undefined
                        );
                        if (twilioLiveBody) return twilioLiveBody;
                        return (
                          <p className="text-sm whitespace-pre-wrap">
                            {msg.role === "assistant"
                              ? msg.content.replace(/\[Saving [^\]]+\.\.\.\]\s*/gi, "").trim()
                              : msg.content}
                          </p>
                        );
                      })()}

                      {/* Heartbeat reauth buttons */}
                      {msg.role === "assistant" && msg.metadata &&
                        (() => {
                          const meta = msg.metadata as Record<string, unknown>;
                          if (meta.kind !== "heartbeat_reauth") return null;
                          const reauth = meta.reauth as Array<{ provider: string; label: string; url: string }> | undefined;
                          if (!reauth || reauth.length === 0) return null;
                          return (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {reauth.map((r) => (
                                <a
                                  key={r.provider}
                                  href={r.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/30 text-xs text-white hover:bg-amber-500/30 transition-colors"
                                >
                                  Reconnect {r.label}
                                </a>
                              ))}
                            </div>
                          );
                        })()}

                      {/* WhatsApp pending-send confirmation (dashboard UI) */}
                      {msg.role === "assistant" &&
                        msg.metadata &&
                        (() => {
                          const meta = msg.metadata as Record<string, unknown>;
                          const pending = meta.whatsapp_pending_send as
                            | {
                                chatId?: unknown;
                                recipientDisplay?: unknown;
                                text?: unknown;
                                media?: unknown;
                              }
                            | undefined;
                          const chatId = typeof pending?.chatId === "string" ? pending.chatId : "";
                          const text = typeof pending?.text === "string" ? pending.text : "";
                          const media = Array.isArray(pending?.media)
                            ? pending.media
                            : [];
                          const recipientDisplay =
                            typeof pending?.recipientDisplay === "string" ? pending.recipientDisplay : "";
                          const busy = whatsappConfirmBusyFor === msg.id;
                          if (!chatId || (!text.trim() && media.length === 0)) return null;
                          if (isWhatsAppPendingConsumed(msg.id)) return null;
                          return (
                            <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
                              <div className="text-xs text-zinc-400">
                                Ready to send on WhatsApp{recipientDisplay ? ` to ${recipientDisplay}` : ""}.
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <button
                                  className="px-3 py-1.5 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-xs text-white hover:bg-cyan-500/30 disabled:opacity-50"
                                  disabled={busy}
                                  onClick={() =>
                                    handleWhatsAppConfirmSend(msg.id, {
                                      chatId,
                                      recipientDisplay: recipientDisplay || undefined,
                                      text,
                                      media: media as Array<{
                                        url?: string;
                                        localPath?: string;
                                        storagePath?: string;
                                        fileId?: string;
                                        filename?: string;
                                        caption?: string;
                                      }>,
                                    })
                                  }
                                >
                                  {busy ? "Sending…" : "Confirm send"}
                                </button>
                                <button
                                  className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-50"
                                  disabled={busy}
                                  onClick={() => handleWhatsAppCancelSend(msg.id)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          );
                        })()}

                      {/* Telegram pending-send confirmation (dashboard UI) */}
                      {msg.role === "assistant" &&
                        msg.metadata &&
                        (() => {
                          const meta = msg.metadata as Record<string, unknown>;
                          const pending = meta.telegram_pending_send as
                            | {
                                chatId?: unknown;
                                recipientDisplay?: unknown;
                                text?: unknown;
                                messageThreadId?: unknown;
                                media?: unknown;
                              }
                            | undefined;
                          const chatId = typeof pending?.chatId === "string" ? pending.chatId : "";
                          const text = typeof pending?.text === "string" ? pending.text : "";
                          const media = Array.isArray(pending?.media) ? pending.media : [];
                          const recipientDisplay =
                            typeof pending?.recipientDisplay === "string" ? pending.recipientDisplay : "";
                          const messageThreadId =
                            typeof pending?.messageThreadId === "number" ? pending.messageThreadId : undefined;
                          const busy = telegramConfirmBusyFor === msg.id;
                          if (!chatId || (!text.trim() && media.length === 0)) return null;
                          if (isTelegramPendingConsumed(msg.id)) return null;
                          return (
                            <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
                              <div className="text-xs text-zinc-400">
                                Ready to send on Telegram{recipientDisplay ? ` to ${recipientDisplay}` : ""}.
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <button
                                  className="px-3 py-1.5 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-xs text-white hover:bg-cyan-500/30 disabled:opacity-50"
                                  disabled={busy}
                                  onClick={() =>
                                    handleTelegramConfirmSend(msg.id, {
                                      chatId,
                                      recipientDisplay: recipientDisplay || undefined,
                                      text,
                                      messageThreadId,
                                      media: media as Array<{
                                        url?: string;
                                        storagePath?: string;
                                        fileId?: string;
                                        filename?: string;
                                        caption?: string;
                                      }>,
                                    })
                                  }
                                >
                                  {busy ? "Sending…" : "Confirm send"}
                                </button>
                                <button
                                  className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-50"
                                  disabled={busy}
                                  onClick={() => handleTelegramCancelSend(msg.id)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          );
                        })()}
                      <p className="text-[10px] text-zinc-600 mt-1">
                        {msg.timestamp.toLocaleTimeString()}
                      </p>
                    </div>
                    {/* Generated files — rendered OUTSIDE bubble so they get full width on mobile */}
                    {msg.role === "assistant" &&
                      msg.metadata &&
                      Array.isArray((msg.metadata as { generated_files?: unknown }).generated_files) &&
                      (msg.metadata as { generated_files: Array<{ name?: string; filename?: string; url?: string; mediaType?: string; mime_type?: string; storage_path?: string; file_id?: string }> })
                        .generated_files.length > 0 && (
                        <div className="mt-2 w-full space-y-2">
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
                              const isImage = typeof mimeType === "string" && mimeType.startsWith("image/");
                              return (
                                <div
                                  key={`${fileName}-${idx}`}
                                  className="rounded-xl border border-white/10 bg-black/20 overflow-hidden"
                                >
                                  {isImage && fileUrl ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                      src={fileUrl}
                                      alt={fileName}
                                      className="w-full max-h-[420px] object-contain bg-black/30"
                                    />
                                  ) : null}
                                  <a
                                    href={fileUrl || "#"}
                                    target={fileUrl ? "_blank" : undefined}
                                    rel={fileUrl ? "noreferrer" : undefined}
                                    className={`flex items-center justify-between gap-3 px-3 py-2 ${isImage ? "border-t border-white/10" : ""} ${
                                      fileUrl
                                        ? "hover:bg-white/5"
                                        : "opacity-60 cursor-not-allowed"
                                    }`}
                                    onClick={(e) => {
                                      if (!fileUrl) e.preventDefault();
                                    }}
                                  >
                                    <div className="min-w-0">
                                      <div className="text-xs text-white truncate">{fileName}</div>
                                      <div className="text-[10px] text-zinc-500 truncate">
                                        {mimeType}
                                      </div>
                                    </div>
                                    <Download className="w-4 h-4 text-zinc-400 shrink-0" />
                                  </a>
                                </div>
                              );
                            })}
                        </div>
                      )}
                    {/* Generated images (from AI Chat) */}
                    {msg.role === "assistant" &&
                      msg.metadata &&
                      Array.isArray((msg.metadata as { generated_images?: unknown }).generated_images) &&
                      (msg.metadata as { generated_images: Array<{ mediaType: string; base64: string }> })
                        .generated_images.length > 0 && (
                        <div className="mt-2 w-full grid grid-cols-1 gap-2">
                          {(msg.metadata as { generated_images: Array<{ mediaType: string; base64: string }> })
                            .generated_images.map((img, idx) => (
                              <div
                                key={`img-${idx}`}
                                className="rounded-xl overflow-hidden border border-white/10 bg-black/20"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={`data:${img.mediaType};base64,${img.base64}`}
                                  alt={`Generated image ${idx + 1}`}
                                  className="w-full max-h-[400px] object-contain"
                                />
                              </div>
                            ))}
                        </div>
                      )}
                  </motion.div>
                ))
              )}

              {/* Streaming content */}
              {orchestrator.isStreaming && orchestrator.streamingContent && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex justify-start"
                >
                  <div className="max-w-[95%] sm:max-w-[80%] rounded-2xl px-4 py-3 bg-white/5 border border-white/10">
                    <p className="text-sm text-zinc-300 whitespace-pre-wrap">
                      {orchestrator.streamingContent.replace(/\[Saving [^\]]+\.\.\.\]\s*/gi, "").trim()}
                      <span className="inline-block w-2 h-4 bg-cyan-400 ml-1 animate-pulse" />
                    </p>
                  </div>
                </motion.div>
              )}

              {/* Working indicator (streaming but no content yet, e.g. AI Chat image generation) */}
              {orchestrator.isStreaming && !orchestrator.streamingContent && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex justify-start"
                >
                  <div className="max-w-[95%] sm:max-w-[80%] rounded-2xl px-4 py-3 bg-white/5 border border-white/10">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2 text-sm text-zinc-300">
                        <Loader2 className="w-4 h-4 animate-spin text-rose-400" />
                        <span>{streamingPlaceholderText}</span>
                        <span className="inline-block w-2 h-4 bg-rose-400 animate-pulse" />
                      </div>
                      {currentOperations.length > 1 && (
                        <div className="text-xs text-zinc-500 pl-6">
                          +{currentOperations.length - 1} more operation{currentOperations.length > 2 ? "s" : ""}
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}

            {/* Thinking indicator (e.g. browser_task continues client-side after orchestrator stream ends) */}
            {!orchestrator.isStreaming && isBrowserThinking && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex justify-start"
              >
                <div className="max-w-[80%] rounded-2xl px-4 py-3 bg-white/5 border border-white/10">
                  <div className="flex items-center gap-2 text-sm text-zinc-300">
                    <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
                    <span>Working…</span>
                    <span className="inline-block w-2 h-4 bg-cyan-400 animate-pulse" />
                  </div>
                </div>
              </motion.div>
            )}

            {/* Re-authorization required banner */}
            {orchestrator.needsReauth && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex justify-start"
              >
                <div className="max-w-[80%] rounded-2xl px-4 py-3 bg-amber-500/10 border border-amber-500/30">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-sm text-amber-200">
                      <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                      <span>
                        {orchestrator.needsReauth.provider.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())} connection expired
                      </span>
                    </div>
                    <button
                      onClick={handleReauth}
                      disabled={!orchestrator.needsReauth.linkToken}
                      className="flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Re-authorize Connection
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Error banner (billing, network, etc.) */}
            {orchestrator.error && !orchestrator.isStreaming && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex justify-start"
              >
                <div className="max-w-[80%] rounded-2xl px-4 py-3 bg-rose-500/10 border border-rose-500/30">
                  <div className="flex items-start gap-2 text-sm text-rose-200">
                    <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
                    <span>{orchestrator.error}</span>
                  </div>
                </div>
              </motion.div>
            )}
            </div>
              </>
            )}
          </div>

          {/* Right: Activity - compact strip when agents are running or Pages is open */}
          <div className="hidden lg:block shrink-0 h-full">
            <AnimatePresence mode="wait">
              {hasRunningAgents || showSiteBuilderPanel ? (
                <motion.div
                  key="compact"
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: compactActivity ? 280 : 56 }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  className="h-full"
                >
                  <CompactActivityStrip
                    activities={orchestrator.agentActivities.map(a => ({
                      id: a.id,
                      agent: a.agent,
                      action: a.action,
                      detail: typeof a.detail === "string" ? a.detail : (a.detail as { path?: string; target?: string } | undefined)?.path || (a.detail as { path?: string; target?: string } | undefined)?.target,
                      status: a.status,
                      timestamp: a.timestamp,
                    }))}
                    onExpand={() => setCompactActivity(!compactActivity)}
                    isExpanded={compactActivity}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="full"
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: 340 }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  className="h-full"
                >
                  <div className="h-full flex flex-col bg-zinc-900/40 border border-white/5 rounded-2xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-white/5">
                      <h3 className="text-sm font-semibold text-white">Activity</h3>
                    </div>
                    <div className="px-4 py-2 border-b border-white/5 bg-zinc-950/40">
                      <div className="text-[11px] text-zinc-300">
                        {runtimeTelemetry.runningSkillNames.length > 0
                          ? `Skill activity: ${runtimeTelemetry.runningSkillNames.join(", ")}`
                          : runtimeTelemetry.totalSkillCalls > 0
                            ? `Skill activity: ${runtimeTelemetry.totalSkillCalls} (last: ${runtimeTelemetry.lastSkillName || "unknown"})`
                            : "Skill activity: none yet"}
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-1 truncate">
                        {runtimeTelemetry.totalBranchForks > 0
                          ? `Branches created: ${runtimeTelemetry.totalBranchForks} | ${runtimeTelemetry.latestBranchDetail || "latest recorded"}`
                          : "Branches created: none yet"}
                      </div>
                    </div>
                    <div className="flex-1 min-h-0">
                      <ActivityFeed
                        items={activityFeed}
                        onItemClick={handleFeedItemClick}
                      />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        </>
        )}
      </main>

      {/* Unified input (fixed at bottom) */}
      {mainPane === "chat" && multiAgent.viewMode === "single" && (
        <div className="relative z-10 border-t border-white/5 bg-[var(--bg-primary)]/80 backdrop-blur-xl">
          <div className="max-w-4xl mx-auto px-6 py-4">
            <UnifiedInput
              onSend={handleSend}
              isStreaming={orchestrator.isStreaming}
              onCancel={handleCancelOrchestratorStream}
              memoryEnabled={memoryEnabled}
              onMemoryToggle={() => setMemoryEnabled((prev) => !prev)}
              // #disabled - voice props removed because of major implementation change (realtime voice)
              chatAgents={chatAgents}
              activeChatAgentId={activeChatAgentId}
              teamMembers={teamMembers}
              onSelectChatAgent={(id) => {
                setActiveChatAgentId(id);
                try {
                  window.localStorage.setItem(lastChatAgentStorageKey, id);
                } catch {
                  // ignore
                }
              }}
              chatSessions={chatSessions}
              activeChatSessionId={activeChatSessionId}
              onSelectChatSession={(id) => {
                setActiveChatSessionId(id);
                const agentId = activeChatAgentId || chatAgents[0]?.id;
                if (agentId) {
                  try {
                    window.localStorage.setItem(`groovy:ai-chat:lastSession:${agentId}`, id);
                  } catch {
                    // ignore
                  }
                }
              }}
              onCreateChatSession={async () => {
                const agentId = activeChatAgentId || chatAgents[0]?.id;
                if (!agentId) return null;
                const res = await fetch("/api/chat/sessions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ agentId, title: "New chat" }),
                });
                const json = await res.json().catch(() => ({}));
                if (!res.ok) return null;
                const created = json.session as { id: string; title: string } | undefined;
                if (!created?.id) return null;
                setChatSessions((prev) => [created, ...prev]);
                setActiveChatSessionId(created.id);
                try {
                  window.localStorage.setItem(`groovy:ai-chat:lastSession:${agentId}`, created.id);
                } catch {
                  // ignore
                }
                return { id: created.id, title: created.title || "New chat" };
              }}
              filesAgents={filesAgents}
              activeFilesAgentId={activeFilesAgentId}
              onSelectFilesAgent={(id) => {
                setActiveFilesAgentId(id);
                try {
                  window.localStorage.setItem(lastFilesAgentStorageKey, id);
                } catch {
                  // ignore
                }
              }}
              filesSessions={filesSessions}
              activeFilesSessionId={activeFilesSessionId}
              onSelectFilesSession={(id) => {
                setActiveFilesSessionId(id);
                const agentId = activeFilesAgentId || filesAgents[0]?.id;
                if (agentId) {
                  try {
                    window.localStorage.setItem(`groovy:files:lastSession:${agentId}`, id);
                  } catch {
                    // ignore
                  }
                }
              }}
              codeSessions={codeAgents.map((a) => ({ id: a.id, name: a.name }))}
              activeCodeSessionId={activeCodeAgentId}
              onSelectCodeSession={(id) => {
                setActiveCodeAgentId(id);
                try {
                  window.localStorage.setItem(lastCodeAgentStorageKey, id);
                } catch {
                  // ignore
                }
                setMainPane("code");
                setShowCodeSessions(false);
              }}
              onCreateFilesSession={async () => {
                const agentId = activeFilesAgentId || filesAgents[0]?.id;
                if (!agentId) return null;
                // Create via orchestrator agent-sessions API
                const orchId = orchestrator.currentSessionId;
                if (!orchId) return null;
                const res = await fetch("/api/orchestrator/agent-sessions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ orchestratorSessionId: orchId, agentType: "files" }),
                });
                const json = await res.json().catch(() => ({}));
                if (!res.ok || !json.session?.agentSessionId) return null;
                const created = { id: String(json.session.agentSessionId), title: "Files session" };
                setFilesSessions((prev) => [created, ...prev]);
                setActiveFilesSessionId(created.id);
                try {
                  window.localStorage.setItem(`groovy:files:lastSession:${agentId}`, created.id);
                } catch {
                  // ignore
                }
                return created;
              }}
            />
          </div>
        </div>
      )}

      {/* Settings modal */}
      <SettingsModal
        isOpen={showSettings}
        onClose={() => { setShowSettings(false); setSettingsFocusSection(undefined); }}
        onSave={handleSaveKeys}
        currentKeys={apiKeys}
        currentKeyMode={llmKeyMode}
        currentKeyModes={llmKeyModes}
        currentUserEmail={userEmail || null}
        onSignOut={handleSignOut}
        focusSection={settingsFocusSection}
        autoRunTeamRequests={autoRunTeamRequests}
        onSetAutoRunTeamRequests={persistAutoRunTeamRequests}
        onConnectorModeChanged={handleConnectorModeChanged}
        activeDeviceId={activeDeviceId}
        connectorOnline={connectorVisibleOnline}
        connectorWhatsAppHealth={connectorWhatsAppHealth}
        connectorAiyraVoiceHealth={connectorAiyraVoiceHealth}
        isHostedConnectorActive={activeConnectorIsHosted}
        connectorVersion={connectorVersion}
        minConnectorVersion={MIN_CONNECTOR_VERSION}
        connectorDownloadUrl={connectorGuide.downloadUrl}
        aiyraConfig={aiyraConfig}
        onLoadAiyraConfig={loadAiyraConfig}
        onSaveAiyraConfig={saveAiyraConfig}
        onReportAiyraVoiceEvent={reportAiyraVoiceEvent}
        onListAiyraAudioDevices={listAiyraAudioDevices}
        aiyraAudioDeviceDebugLog={aiyraAudioDeviceDebugLog}
        onRefreshConnector={refreshConnectorStatus}
        onRestartConnector={restartConnector}
        onUpdateConnector={updateConnector}
      />

      <ChatAgentCreateModal
        isOpen={showChatAgentCreate}
        onClose={() => setShowChatAgentCreate(false)}
        onCreated={(created) => {
          setChatAgents((prev) => [
            { id: created.id, name: created.name, provider: created.provider, model: created.model },
            ...prev,
          ]);
          setActiveChatAgentId(created.id);
          try {
            window.localStorage.setItem(lastChatAgentStorageKey, created.id);
          } catch {
            // ignore
          }
          setShowChatPanel(true);
        }}
      />

      <ObsidianSetupModal
        isOpen={showObsidianSetup}
        onClose={() => setShowObsidianSetup(false)}
        isLocalConnected={connectorOk && !!activeDeviceId}
        vaults={obsidianVaults}
        selectedVault={obsidianVaultPath}
        onSelectVault={(path: string) => {
          setObsidianVaultPath(path);
          try {
            window.localStorage.setItem(lastVaultStorageKey, path);
          } catch {
            // ignore
          }
        }}
        onRefreshVaults={async () => {
          if (!connectorOk || !activeDeviceId) return [];
          const result = await handleConnectorExecute({
            type: "obsidian_discover",
            params: {},
            toolCallId: `obsidian-discover-refresh-${Date.now()}`,
            toolName: "obsidian_discover",
            agent: "obsidian",
          });
          if (result.ok && Array.isArray(result.vaults)) {
            const vaults = result.vaults as ObsidianVault[];
            setObsidianVaults(vaults);
            return vaults;
          }
          return [];
        }}
      />

      <FilesAgentSetupModal
        isOpen={showFilesSetup}
        onClose={() => setShowFilesSetup(false)}
        filesAgents={filesAgents}
        onRefreshAgents={async () => {
          const { data: newFilesAgents } = await supabase
            .from("agents")
            .select("id, name, created_at")
            .eq("type", "files-agent")
            .order("created_at", { ascending: false });
          if (newFilesAgents) {
            setFilesAgents(
              newFilesAgents.map((a) => ({
                id: a.id,
                name: a.name,
                createdAt: a.created_at,
              }))
            );
          }
        }}
        onCreated={() => {}}
        onDeleted={() => {}}
      />

      {/* Data integrations panel */}
      <DataIntegrationsPanel
        isOpen={showDataPanel}
        onClose={() => setShowDataPanel(false)}
        connections={dataConnections}
        pixels={webPixels}
        onConnect={handleDataConnect}
        onConnectWithId={handleDataConnectWithId}
        onReconnect={handleDataReconnect}
        onDisconnect={handleDataDisconnect}
        onRename={handleDataRename}
        onRefresh={handleDataRefresh}
      />

      {/* Enterprise integrations panel */}
      <IntegrationsPanel
        isOpen={showIntegrationsPanel}
        onClose={() => setShowIntegrationsPanel(false)}
        agentId={orchestrator.getAgentIdForSession(orchestrator.currentSessionId) || ""}
      />

      <SchedulePanel 
        isOpen={showSchedulePanel} 
        onClose={() => setShowSchedulePanel(false)} 
        onTriggerJob={triggerScheduledJob}
        runningJobIds={runningScheduledJobs}
      />

      <PagesManagerModal
        isOpen={showPagesManagerModal}
        onClose={() => setShowPagesManagerModal(false)}
        activeSlug={siteBuilderState.slug}
        onUseInPanel={handleSelectSiteFromManager}
        onStartPreview={(targetSlug) => {
          setShowSiteBuilderPanel(true);
          handleSiteRestartPreview(targetSlug);
        }}
        onStopPreview={handleSiteStopPreview}
      />

      {/* Site Builder Panel (expanded modal mode only) */}
      {showSiteBuilderPanel && siteBuilderExpanded && (
        <SiteBuilderPanel
          slug={siteBuilderState.slug}
          status={siteBuilderState.status}
          errorMessage={siteBuilderState.errorMessage}
          devPort={siteBuilderState.devPort}
          tunnelNonce={siteBuilderState.tunnelNonce}
          deviceId={siteBuilderState.deviceId}
          productionUrl={siteBuilderState.productionUrl}
          expanded={true}
          onClose={handleCloseSiteBuilderPanel}
          onToggleExpand={() => setSiteBuilderExpanded(false)}
          onDeploy={handleSiteDeploy}
          onRestartPreview={handleSiteRestartPreview}
        />
      )}

      {/* Files Agent Panel Modal */}
      {showFilesPanel && filesAgents.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-2xl h-[80vh] bg-zinc-900 border border-white/10 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
          >
            <div className="flex items-center justify-between p-4 border-b border-white/10">
              <h2 className="text-lg font-semibold text-white">Files Agent</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const newId = await orchestrator.createSession("New Agent");
                    if (newId) {
                      orchestrator.selectSession(newId);
                      const linked = await ensureLinkedFilesSession(newId);
                      setFilesPanelSessionId(linked);
                    }
                  }}
                  className="px-3 py-2 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors text-xs"
                  title="Create a new paired chat + Files session"
                >
                  New session
                </button>
                <button
                  onClick={() => {
                    setFilesPanelSessionId(null);
                    setShowFilesPanel(false);
                  }}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="flex-1 p-4 overflow-hidden">
              <FilesAgentPanel
                agentId={filesAgents[0].id}
                agentName={filesAgents[0].name}
                initialSessionId={filesPanelSessionId}
              />
            </div>
          </motion.div>
        </div>
      )}

      {/* AI Chat Panel Modal */}
      {showChatPanel && activeChatAgentId && chatAgents.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-2xl h-[80vh] bg-zinc-900 border border-rose-500/20 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
          >
            <div className="flex items-center justify-between p-4 border-b border-white/10">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-rose-500/10 flex items-center justify-center">
                  <MessageSquare className="w-4 h-4 text-rose-400" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">AI Chat</h2>
                  <p className="text-xs text-zinc-500">
                    {chatAgents.find((a) => a.id === activeChatAgentId)?.name || "Chat"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (llmKeyMode === "user" && !hasAnyUserKeys) openApiSettings();
                    else openChatAgentCreate();
                  }}
                  className="px-3 py-2 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-200 hover:bg-rose-500/15 transition-colors text-xs flex items-center gap-2"
                  title="Create a new AI Chat agent"
                >
                  <Plus className="w-4 h-4" />
                  New agent
                </button>
                {chatAgents.length > 1 && (
                  <select
                    value={activeChatAgentId || ""}
                    onChange={(e) => {
                      const newId = e.target.value;
                      setActiveChatAgentId(newId);
                      try {
                        window.localStorage.setItem(lastChatAgentStorageKey, newId);
                      } catch {
                        // ignore
                      }
                    }}
                    className="px-3 py-2 rounded-xl bg-white/5 text-zinc-300 text-xs border border-white/10"
                  >
                    {chatAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  onClick={() => setShowChatPanel(false)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="flex-1 p-4 overflow-hidden">
              <ChatPanel
                agentId={activeChatAgentId}
                agentName={chatAgents.find((a) => a.id === activeChatAgentId)?.name || "Chat"}
                provider={chatAgents.find((a) => a.id === activeChatAgentId)?.provider || null}
                model={chatAgents.find((a) => a.id === activeChatAgentId)?.model || null}
              />
            </div>
          </motion.div>
        </div>
      )}

      {/* Code Sessions Modal */}
      {showCodeSessions && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-2xl h-[80vh] bg-zinc-900 border border-white/10 rounded-2xl overflow-hidden shadow-2xl flex flex-col p-4"
          >
            <ClaudeCodeSessionsPanel
              deviceId={activeDeviceId}
              relayStatus={relay.status}
              relaySend={relay.send}
              relaySubscribe={relay.subscribe}
              sessions={codeAgents}
              onRefreshSessions={refreshCodeAgents}
              isMobile={isMobile}
              onOpenSession={(agentId) => {
                setActiveCodeAgentId(agentId);
                try {
                  window.localStorage.setItem(lastCodeAgentStorageKey, agentId);
                } catch {
                  // ignore
                }
                setMainPane("code");
                setShowCodeSessions(false);
              }}
              onClose={() => setShowCodeSessions(false)}
            />
          </motion.div>
        </div>
      )}

      {/* Plans Browser Modal */}
      {showPlansBrowser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-2xl h-[80vh] bg-zinc-900 border border-white/10 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
          >
            <PlansBrowser
              plans={claudePlans.plans}
              isLoading={claudePlans.isLoading}
              error={claudePlans.error}
              onRefresh={claudePlans.refresh}
              codeAgents={codeAgents.map((a) => ({
                id: a.id,
                name: a.name,
                codeCliProvider: a.codeCliProvider,
              }))}
              onExecute={handleExecutePlan}
              onClose={() => setShowPlansBrowser(false)}
            />
          </motion.div>
        </div>
      )}

      {/* Connector dropdown menu (portal to escape blur/stacking contexts) */}
      {showConnectorMenu &&
        connectorMenuPos &&
        typeof window !== "undefined" &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[9998]"
              onClick={() => setShowConnectorMenu(false)}
            />
            <div
              className="fixed z-[9999] w-72 rounded-xl overflow-hidden"
              style={{
                top: connectorMenuPos.top,
                left: connectorMenuPos.left,
                background: "#09090b",
                border: "1px solid #27272a",
                boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.8)",
                maxHeight: "min(500px, calc(100vh - 100px))",
              }}
            >
              <div className="overflow-y-auto" style={{ maxHeight: "inherit" }}>
                {/* Header */}
                <div className="p-3 border-b border-zinc-800">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                      connectorHasWhatsAppIssue
                        ? "bg-red-500/10"
                        : connectorVisibleOnline
                          ? "bg-emerald-500/10"
                          : "bg-zinc-800"
                    }`}>
                      <Laptop2
                        className={`w-4 h-4 ${
                          connectorHasWhatsAppIssue
                            ? "text-red-300"
                            : connectorVisibleOnline
                              ? "text-emerald-400"
                              : "text-zinc-500"
                        }`}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs ${
                            connectorHasWhatsAppIssue
                              ? "text-red-300"
                              : connectorVisibleOnline
                                ? "text-emerald-400"
                                : "text-zinc-500"
                          }`}
                        >
                          {connectorHasWhatsAppIssue
                            ? connectorWhatsAppStatus === "recovering"
                              ? "Connected · WhatsApp recovering"
                              : "Connected · WhatsApp degraded"
                            : connectorVisibleOnline
                              ? "Connected"
                              : "Offline"}
                        </span>
                        {connectorVisibleOnline && connectorVersion && (
                          <span className="text-xs text-zinc-600">v{connectorVersion}</span>
                        )}
                      </div>
                      {connectorHasWhatsAppIssue && (
                        <div className="text-[10px] text-zinc-500 mt-0.5 truncate">
                          {connectorWhatsAppHealth?.detail ||
                            connectorWhatsAppHealth?.reason ||
                            "WhatsApp bridge is unhealthy. Restart recommended."}
                        </div>
                      )}
                      {/* Debug info - shows why connector appears offline */}
                      {!connectorVisibleOnline && (
                        <div className="text-[10px] text-zinc-600 mt-0.5">
                          relay:{relay.status} local:{localConnectorOnline ? "y" : "n"} dev:{activeDeviceId ? "y" : "n"}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Update notice - compact */}
                {connectorVisibleOnline && isVersionOutdated(connectorVersion, MIN_CONNECTOR_VERSION) && (
                  <div className="p-3 border-b border-zinc-800 bg-zinc-900/50">
                    <p className="text-xs text-zinc-400 mb-2">
                      Update to v{MIN_CONNECTOR_VERSION} for browser, files, and Obsidian support. Local connectors
                      auto-update in the background when idle.
                    </p>
                    {activeConnectorIsHosted ? (
                      <button
                        type="button"
                        onClick={updateConnector}
                        disabled={!canHostedSelfUpdate}
                        className="flex items-center justify-center gap-2 w-full px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-200 hover:bg-zinc-700 text-xs transition-all disabled:opacity-50"
                        title="Self-update the hosted Groovy Mac connector now"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Self-update hosted Mac
                      </button>
                    ) : (
                      <a
                        href={connectorGuide.downloadUrl}
                        className="flex items-center justify-center gap-2 w-full px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-200 hover:bg-zinc-700 text-xs transition-all"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download manually (fallback)
                      </a>
                    )}
                    <details className="mt-2">
                      <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400">
                        Installation help
                      </summary>
                      {activeConnectorIsHosted ? (
                        <div className="mt-2 text-xs text-zinc-500 space-y-1 pl-2 border-l border-zinc-800">
                          <p>Hosted mode: no DMG download needed (this connector runs on Groovy Mac).</p>
                          <p>Use “Self-update hosted Mac” to update and restart it.</p>
                        </div>
                      ) : (
                        <div className="mt-2 text-xs text-zinc-500 space-y-1 pl-2 border-l border-zinc-800">
                          <p>Local mode auto-updates in background. Use manual download only if needed.</p>
                          {connectorGuide.installSteps.map((stepText, idx) => (
                            <p key={`connector-help-${idx}`}>{idx + 1}. {stepText}</p>
                          ))}
                          <p>
                            Restart with{" "}
                            <code className="bg-zinc-800 px-1 rounded">{connectorGuide.restartHint}</code>
                          </p>
                          <p>{connectorGuide.blockedHint}</p>
                        </div>
                      )}
                    </details>
                  </div>
                )}

                {!connectorVisibleOnline && !prefersHostedConnector && (
                  <div className="p-3 border-b border-zinc-800 bg-amber-500/5">
                    <p className="text-xs text-zinc-400 mb-2">
                      Connector offline. Download the latest v{MIN_CONNECTOR_VERSION} connector and reopen it to reconnect this computer.
                    </p>
                    <a
                      href={connectorGuide.downloadUrl}
                      className="flex items-center justify-center gap-2 w-full px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-200 hover:bg-zinc-700 text-xs transition-all"
                      title={`Download ${connectorGuide.downloadFileLabel}`}
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download latest connector
                    </a>
                    <details className="mt-2">
                      <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400">
                        Installation help
                      </summary>
                      <div className="mt-2 text-xs text-zinc-500 space-y-1 pl-2 border-l border-zinc-800">
                        {connectorGuide.installSteps.map((stepText, idx) => (
                          <p key={`connector-offline-menu-help-${idx}`}>{idx + 1}. {stepText}</p>
                        ))}
                        <p>
                          Restart with{" "}
                          <code className="bg-zinc-800 px-1 rounded">{connectorGuide.restartHint}</code>
                        </p>
                        <p>{connectorGuide.blockedHint}</p>
                      </div>
                    </details>
                  </div>
                )}

                {/* Claude CLI status */}
                {connectorOk && claudeCliInstalled === true && (
                  <div className="p-3 border-b border-zinc-800 bg-emerald-500/5">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <p className="text-xs text-emerald-300 font-medium">Claude CLI installed</p>
                    </div>
                  </div>
                )}
                {connectorOk && claudeCliInstalled === false && (
                  <div className="p-3 border-b border-zinc-800 bg-red-500/5">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-red-300 font-medium mb-1">
                          Claude CLI not installed
                        </p>
                        <p className="text-xs text-zinc-400 mb-2">
                          Code Agent and Browser Agent require Claude CLI. Install it on the connector machine:
                        </p>
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/40 border border-white/10 font-mono text-[11px] text-cyan-300 mb-2">
                          <code>{connectorGuide.platform === "windows"
                            ? "npm install -g @anthropic-ai/claude-code"
                            : "curl -fsSL https://claude.ai/install.sh | bash"}</code>
                        </div>
                        <a
                          href="https://code.claude.com/docs/en/overview"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-zinc-500 hover:text-cyan-300 transition-colors underline"
                        >
                          Documentation
                        </a>
                      </div>
                    </div>
                  </div>
                )}

                {/* Restart connector (when online) */}
                {connectorOk && activeDeviceId && (
                  <div className="p-3 border-b border-zinc-800">
                    <button
                      onClick={() => {
                        try {
                          relay.send({ type: "connector_restart", device_id: activeDeviceId });
                        } catch {
                          // ignore
                        }
                      }}
                      className="w-full px-3 py-2 rounded-md bg-white/5 text-zinc-300 hover:bg-white/10 text-xs transition-all"
                      title={
                        connectorGuide.platform === "windows"
                          ? "Ask local connector to restart (auto-relaunches via Task Scheduler/Startup)"
                          : "Ask local connector to restart (auto-relaunches via LaunchAgent)"
                      }
                    >
                      Restart Connector
                    </button>
                    <p className="text-[10px] text-zinc-600 mt-1">
                      If it gets stuck after sleep/wake, this forces a clean reconnect.
                    </p>
                  </div>
                )}

                {/* Capabilities - always show */}
                <div className="p-3 border-b border-zinc-800">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-zinc-500">Capabilities</span>
                    <button
                      onClick={testConnectorCapabilities}
                      disabled={!connectorOk || connectorCapabilities.testing}
                      className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {connectorCapabilities.testing ? "Testing..." : "Test"}
                    </button>
                  </div>
                  <div className="flex gap-4">
                    {[
                      { key: "browser", icon: Globe, label: "Browser" },
                      { key: "files", icon: FolderOpen, label: "Files" },
                      { key: "obsidian", icon: BookOpen, label: "Obsidian" },
                    ].map(({ key, icon: Icon, label }) => {
                      const cap = connectorCapabilities[key as keyof typeof connectorCapabilities];
                      const status = typeof cap === "object" ? cap : null;
                      return (
                        <div key={key} className="flex flex-col items-center gap-1" title={status?.error || label}>
                          <Icon className={`w-4 h-4 ${
                            status?.ok ? "text-emerald-400" : status ? "text-red-400" : "text-zinc-600"
                          }`} />
                          <span className="text-[10px] text-zinc-500">{label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Pairing code */}
                <div className="p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-zinc-500">Pairing Code</span>
                  </div>
                  {!pairingCode ? (
                    <button
                      onClick={generatePairingCode}
                      disabled={pairingLoading}
                      className="w-full px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-xs transition-all disabled:opacity-50"
                    >
                      {pairingLoading ? "Generating..." : "Generate Code"}
                    </button>
                  ) : (
                    <div className="flex items-center justify-between p-2 rounded-md bg-zinc-800">
                      <code className="text-sm text-cyan-400 tracking-wide">{pairingCode}</code>
                      <button
                        onClick={async () => {
                          await navigator.clipboard.writeText(pairingCode);
                          setPairingCopied(true);
                          setTimeout(() => setPairingCopied(false), 1500);
                        }}
                        className="px-2 py-0.5 rounded text-xs text-zinc-400 hover:text-zinc-200 transition-all"
                      >
                        {pairingCopied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  )}
                  <p className="text-[10px] text-zinc-600 mt-1">Enter in connector app when prompted</p>
                </div>

                {/* Download link when offline */}
                {!connectorOk && (
                  <div className="p-3 border-t border-zinc-800">
                    <a
                      href={connectorGuide.downloadUrl}
                      className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-md bg-cyan-600 text-white hover:bg-cyan-500 text-xs font-medium transition-all"
                      title={`Download ${connectorGuide.downloadFileLabel}`}
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download latest connector
                    </a>
                  </div>
                )}
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
