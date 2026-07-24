"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Key,
  Save,
  Loader2,
  Check,
  Eye,
  EyeOff,
  ExternalLink,
  AlertCircle,
  AlertTriangle,
  Wifi,
  WifiOff,
  Download,
  RotateCw,
  Power,
  Copy,
  Users,
  UserRound,
  MailPlus,
  UserMinus,
  LogOut,
  BarChart3,
  Settings,
  MessageSquare,
  Mic,
  Heart,
  Wrench,
  CreditCard,
  Send,
  Plug,
} from "lucide-react";
import { UsageDashboardContent } from "@/components/usage/UsageDashboardContent";
import { BillingCardSetupForm } from "@/components/billing/BillingCardSetupForm";
import { IntegrationSettingsSection } from "@/components/command-center/IntegrationSettingsSection";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useConnectorInstallGuide } from "@/lib/connector/installGuide";
import {
  readConnectorPlatformOverride,
  writeConnectorPlatformOverride,
  type ConnectorPlatformOverride,
} from "@/lib/connector/override";
import { detectConnectorPlatformFromNavigator, type ConnectorClientPlatform } from "@/lib/connector/platform";

import type { Provider, LlmKeyMode, KeyModes } from "@/lib/keys/resolveKeyMode";
import { isServerKeyEligibleProvider } from "@/lib/keys/providerKeyPolicy";
import { useEdition } from "@/hooks/useEdition";

// Kept for backwards-compat with existing imports; not used by this modal anymore.
export type FilesAgentInfo = { id: string; name: string; createdAt?: string };
export type ObsidianVault = { name: string; path: string };
export type SettingsFocusSection =
  | "account"
  | "connector"
  | "billing"
  | "api-keys"
  | "integrations"
  | "files-agent"
  | "obsidian"
  | "aiyra-voice";

type ConnectorWhatsAppHealth = {
  status?: "healthy" | "degraded" | "recovering" | "disabled" | "unknown";
  reason?: string;
  detail?: string;
  auto_restart_pending?: boolean;
  updated_at?: string | null;
};

type ConnectorAiyraVoiceHealth = {
  status?: "healthy" | "degraded" | "recovering" | "disabled" | "unknown";
  reason?: string;
  detail?: string;
  updated_at?: string | null;
  listening?: boolean;
  active?: boolean;
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

const DEFAULT_OPENWAKEWORD_THRESHOLD = 0.27;
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

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSave: (keys: Partial<Record<Provider, string>>, mode: LlmKeyMode, keyModes?: KeyModes) => Promise<void>;
  currentKeys: Partial<Record<Provider, { configured: boolean; lastUpdated?: string }>>;
  currentKeyMode?: LlmKeyMode;
  currentKeyModes?: KeyModes;
  serverProviderKeysAllowed?: boolean;
  currentUserEmail?: string | null;
  currentOrchestratorSessionId?: string | null;
  currentOrchestratorAgentId?: string | null;
  onSignOut?: () => void | Promise<void>;
  autoRunTeamRequests?: boolean;
  onSetAutoRunTeamRequests?: (next: boolean) => void | Promise<void>;
  onConnectorModeChanged?: (next: "local" | "groovy") => void | Promise<void>;
  activeDeviceId?: string | null;
  connectorOnline?: boolean;
  connectorWhatsAppHealth?: ConnectorWhatsAppHealth | null;
  connectorAiyraVoiceHealth?: ConnectorAiyraVoiceHealth | null;
  isHostedConnectorActive?: boolean;
  connectorVersion?: string | null;
  minConnectorVersion?: string;
  connectorSupportsInPlaceUpdate?: boolean;
  connectorDownloadUrl?: string;
  aiyraConfig?: AiyraConfigSnapshot;
  onLoadAiyraConfig?: (input: {
    apiKey: string;
    enabled: boolean;
  }) => Promise<void>;
  onSaveAiyraConfig?: (input: {
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
  }) => Promise<void>;
  onReportAiyraVoiceEvent?: (
    kind: "missed_wake" | "false_trigger"
  ) => Promise<boolean>;
  onListAiyraAudioDevices?: () => Promise<AiyraAudioDeviceListResult>;
  aiyraAudioDeviceDebugLog?: string[];
  onRefreshConnector?: () => void;
  onRestartConnector?: () => void;
  onUpdateConnector?: () => void;
  // Legacy props (ignored)
  filesAgents?: FilesAgentInfo[];
  onFilesAgentCreated?: () => void;
  focusSection?: SettingsFocusSection;
  isLocalConnected?: boolean;
  obsidianVaults?: ObsidianVault[];
  selectedObsidianVault?: string;
  onSelectObsidianVault?: (path: string) => void;
  onRefreshObsidianVaults?: () => Promise<ObsidianVault[]>;
};

const DEFAULT_AIYRA_TTS_SPEED = 1.03;

function normalizeAiyraTtsSpeed(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_AIYRA_TTS_SPEED;
  return Math.round(Math.max(0.5, Math.min(2, n)) * 100) / 100;
}

function formatAiyraTtsSpeedInput(value: unknown): string {
  return String(normalizeAiyraTtsSpeed(value));
}

function parseAiyraTtsSpeedInput(value: string): number | null {
  const raw = value.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error("ttsSpeed must be a number between 0.5 and 2.0");
  }
  return normalizeAiyraTtsSpeed(n);
}

type WorkspaceRole = "admin" | "member";
type WorkspaceMember = { user_id: string; role: WorkspaceRole; email?: string | null };
type WorkspaceInfo = {
  id: string;
  name: string;
  billing_admin_user_id: string;
  role: WorkspaceRole;
  members: WorkspaceMember[];
};

type WorkspaceInvite = {
  id: string;
  email: string;
  token: string;
  expires_at: string;
  created_at: string;
};

type BillingStatus = {
  workspaceId: string;
  role: WorkspaceRole;
  cardOnFile: boolean;
  cardBrand: string | null;
  cardLast4: string | null;
  balances: {
    freeCreditUsdRemaining: number;
    paidCreditUsdBalance: number;
    availableBalanceUsd: number;
  };
  policy: {
    initialTopupCompleted: boolean;
    autoTopupEnabled: boolean;
    autoTopupAmountUsd: number;
    monthlyLimitUsd: number | null;
    monthSpendUsd: number;
  };
  pricing: {
    model: string;
    modelPassThrough: boolean;
    groovyFeeRatePercent: number;
    externalKeyFeeRatePercent?: number;
    explanation: string;
    addonsExplanation?: string;
    tokenConsumptionBillingEnabled?: boolean;
    resellerBillingEnabled?: boolean;
    billingPolicyReason?: string;
  };
  addons?: {
    groovyMac?: {
      enabled: boolean;
      memberCount: number;
      billedSeats: number;
      minSeats: number;
      unitPriceUsd: number;
      monthlyUsd: number;
    };
    kapsoAllowlist?: {
      enabled: boolean;
      allowlistedUsers: number;
      unitPriceUsd: number;
      monthlyUsd: number;
    };
    recurringMonthlyUsd: number;
  } | null;
};

type SettingsSection =
  | "account"
  | "connector"
  | "aiyra-voice"
  | "api-keys"
  | "integrations"
  | "billing"
  | "team"
  | "usage"
  | "whatsapp"
  | "telegram"
  | "heartbeat"
  | "agent-runtime"
  | "advanced";

const SECTION_NAV: { id: SettingsSection; label: string; icon: typeof Settings }[] = [
  { id: "account", label: "Account", icon: UserRound },
  { id: "connector", label: "Connector", icon: Wifi },
  { id: "aiyra-voice", label: "Aiyra Voice", icon: Mic },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "team", label: "Team", icon: Users },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "whatsapp", label: "WhatsApp", icon: MessageSquare },
  { id: "telegram", label: "Telegram", icon: Send },
  { id: "heartbeat", label: "Heartbeat", icon: Heart },
  { id: "agent-runtime", label: "Agent Runtime", icon: Settings },
  { id: "advanced", label: "Advanced", icon: Wrench },
];

const PROVIDER_INFO: Record<Provider, { name: string; placeholder: string; helpUrl: string; description?: string }> = {
  anthropic: {
    name: "Anthropic (Claude)",
    placeholder: "sk-ant-...",
    helpUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    name: "OpenAI",
    placeholder: "sk-...",
    helpUrl: "https://platform.openai.com/api-keys",
  },
  google: {
    name: "Google (Gemini)",
    placeholder: "AIza...",
    helpUrl: "https://aistudio.google.com/app/apikey",
  },
  xai: {
    name: "xAI (Grok)",
    placeholder: "xai-...",
    helpUrl: "https://console.x.ai/",
  },
  claude_cli: {
    name: "Claude Headless CLI",
    placeholder: "sk-ant-oat01-...",
    helpUrl: "https://docs.claude.com/en/docs/claude-code/headless",
    description: "OAuth token from `claude setup-token`. Uses your Claude.ai plan for headless CLI runs.",
  },
  codex_cli: {
    name: "Codex Headless CLI",
    placeholder: "sk-...",
    helpUrl: "https://platform.openai.com/api-keys",
    description: "Optional OpenAI API key for headless Codex CLI runs. Leave unset to use the connector machine's `codex login` session.",
  },
  azure_openai: {
    name: "Azure OpenAI",
    placeholder: "Azure OpenAI key",
    helpUrl: "https://learn.microsoft.com/azure/ai-services/openai/",
  },
  aws_bedrock: {
    name: "AWS Bedrock",
    placeholder: "AWS access secret",
    helpUrl: "https://docs.aws.amazon.com/bedrock/",
  },
  groq: {
    name: "Groq",
    placeholder: "gsk_...",
    helpUrl: "https://console.groq.com/keys",
  },
  mistral: {
    name: "Mistral",
    placeholder: "Mistral API key",
    helpUrl: "https://console.mistral.ai/api-keys/",
  },
  other: {
    name: "Other provider",
    placeholder: "Provider API key",
    helpUrl: "/docs/reference-infrastructure",
  },
};

const PROVIDER_ORDER: Provider[] = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "azure_openai",
  "aws_bedrock",
  "groq",
  "mistral",
  "other",
  "claude_cli",
  "codex_cli",
];

function providerManagedModeLabel(provider: Provider): string {
  if (provider === "codex_cli" || provider === "claude_cli") return "Local login";
  return "Server env";
}

function providerUserModeLabel(provider: Provider): string {
  return provider === "codex_cli" ? "API key" : "Own key";
}

function buildInitialProviderModes(
  globalMode: LlmKeyMode,
  keyModes?: KeyModes,
  allowServerProviderKeys = true
): KeyModes {
  const out: KeyModes = {};
  for (const p of PROVIDER_ORDER) {
    const m = keyModes?.[p];
    out[p] =
      !allowServerProviderKeys && isServerKeyEligibleProvider(p)
        ? "user"
        : m === "groovy" || m === "user"
          ? m
          : p === "claude_cli" || p === "codex_cli"
            ? "groovy"
            : globalMode;
  }
  return out;
}

function resolveInitialSettingsSection({
  focusSection,
  currentKeyMode,
  currentKeyModes,
  currentKeys,
}: {
  focusSection?: SettingsFocusSection;
  currentKeyMode: LlmKeyMode;
  currentKeyModes?: KeyModes;
  currentKeys: Partial<Record<Provider, { configured: boolean; lastUpdated?: string }>>;
}): SettingsSection {
  if (focusSection === "account") return "account";
  if (focusSection === "connector") return "connector";
  if (focusSection === "billing") return "billing";
  if (focusSection === "api-keys") return "api-keys";
  if (focusSection === "integrations") return "integrations";
  if (focusSection === "aiyra-voice") return "aiyra-voice";
  const hasPerProvider = Object.keys(currentKeyModes || {}).length > 0;
  const providerReady = (provider: Provider) => {
    const mode = hasPerProvider ? currentKeyModes?.[provider] : currentKeyMode;
    return mode === "groovy" || currentKeys[provider]?.configured === true;
  };
  return providerReady("anthropic") || providerReady("openai")
    ? "connector"
    : "api-keys";
}

type HeartbeatIntegrations = {
  gmail: boolean;
  google_calendar: boolean;
  upready_readiness: boolean;
};

function normalizeHeartbeatIntegrations(value: unknown): HeartbeatIntegrations {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    gmail: v.gmail === true,
    google_calendar: v.google_calendar === true,
    upready_readiness: v.upready_readiness === true,
  };
}

function isRestartableWhatsAppIssue(
  health: ConnectorWhatsAppHealth | null | undefined
): boolean {
  if (!health) return false;
  const combined = `${String(health.reason || "")}; ${String(
    health.detail || ""
  )}`.toLowerCase();
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

function isWhatsAppBrowserRuntimeIssue(
  health: ConnectorWhatsAppHealth | null | undefined
): boolean {
  if (!health) return false;
  const combined = `${String(health.reason || "")}; ${String(
    health.detail || ""
  )}`.toLowerCase();
  return (
    combined.includes("could not find chrome") ||
    combined.includes(".cache/puppeteer") ||
    combined.includes("puppeteer browser") ||
    combined.includes("puppeteer browsers install")
  );
}

export function SettingsModal({
  isOpen,
  onClose,
  onSave,
  currentKeys,
  currentKeyMode = "groovy",
  currentKeyModes,
  serverProviderKeysAllowed = false,
  currentUserEmail,
  currentOrchestratorSessionId,
  currentOrchestratorAgentId,
  onSignOut,
  focusSection,
  autoRunTeamRequests,
  onSetAutoRunTeamRequests,
  onConnectorModeChanged,
  activeDeviceId = null,
  connectorOnline,
  connectorWhatsAppHealth,
  connectorAiyraVoiceHealth,
  isHostedConnectorActive = false,
  connectorVersion,
  minConnectorVersion,
  connectorSupportsInPlaceUpdate = false,
  connectorDownloadUrl,
  aiyraConfig,
  onLoadAiyraConfig,
  onSaveAiyraConfig,
  onReportAiyraVoiceEvent,
  onListAiyraAudioDevices,
  aiyraAudioDeviceDebugLog,
  onRefreshConnector,
  onRestartConnector,
  onUpdateConnector,
}: SettingsModalProps) {
  const edition = useEdition();
  const connectorGuide = useConnectorInstallGuide();
  const resolvedConnectorOpenWakewordThreshold = Number.isFinite(
    Number(connectorAiyraVoiceHealth?.openwakeword_threshold)
  )
    ? Number(connectorAiyraVoiceHealth?.openwakeword_threshold)
    : null;
  const [activeSection, setActiveSection] = useState<SettingsSection>(() =>
    resolveInitialSettingsSection({
      focusSection,
      currentKeyMode,
      currentKeyModes,
      currentKeys,
    })
  );
  const prevFocusSectionRef = useRef(focusSection);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (focusSection && focusSection !== prevFocusSectionRef.current && isOpen) {
      setActiveSection(
        resolveInitialSettingsSection({
          focusSection,
          currentKeyMode,
          currentKeyModes,
          currentKeys,
        })
      );
    }
    prevFocusSectionRef.current = focusSection;
  }, [focusSection, isOpen, currentKeyMode, currentKeyModes, currentKeys]);
  useEffect(() => {
    if (edition.selfHosted && activeSection === "billing") {
      setActiveSection("account");
    }
  }, [activeSection, edition.selfHosted]);
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [showKeys, setShowKeys] = useState<Partial<Record<Provider, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [keyMode, setKeyMode] = useState<LlmKeyMode>(currentKeyMode);
  const [initialKeyMode, setInitialKeyMode] = useState<LlmKeyMode>(currentKeyMode);
  const [perProviderModes, setPerProviderModes] = useState<KeyModes>(() =>
    buildInitialProviderModes(currentKeyMode, currentKeyModes, serverProviderKeysAllowed)
  );
  const [initialProviderModes, setInitialProviderModes] = useState<KeyModes>(() =>
    buildInitialProviderModes(currentKeyMode, currentKeyModes, serverProviderKeysAllowed)
  );
  const [copiedRePair, setCopiedRePair] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [teamActionLoading, setTeamActionLoading] = useState<string | null>(null);
  const [teamActionError, setTeamActionError] = useState<string | null>(null);
  const [allowlist, setAllowlist] = useState<Array<{ phone_e164: string; user_id?: string | null }>>([]);
  const [allowlistPhone, setAllowlistPhone] = useState("");
  const [allowlistLoading, setAllowlistLoading] = useState(false);
  const [companyWhatsappStatus, setCompanyWhatsappStatus] = useState<string | null>(null);
  const [companyWhatsappSetupUrl, setCompanyWhatsappSetupUrl] = useState<string | null>(null);
  const [companyWhatsappLoading, setCompanyWhatsappLoading] = useState(false);
  const [phoneEntry, setPhoneEntry] = useState<string>("");
  const [phoneCode, setPhoneCode] = useState<string | null>(null);
  const [phoneVerified, setPhoneVerified] = useState<boolean>(false);
  const [groups, setGroups] = useState<Array<{ id: string; group_name: string }>>([]);
  const [groupName, setGroupName] = useState("");
  const [connectorMode, setConnectorMode] = useState<"local" | "groovy" | null>(null);
  const [connectorModeSaving, setConnectorModeSaving] = useState(false);
  const [connectorModeError, setConnectorModeError] = useState<string | null>(null);
  const [aiyraApiKey, setAiyraApiKey] = useState("");
  const [aiyraClearApiKey, setAiyraClearApiKey] = useState(false);
  const [aiyraEnabled, setAiyraEnabled] = useState(aiyraConfig?.enabled === true);
  const [aiyraPersonaPrompt, setAiyraPersonaPrompt] = useState(aiyraConfig?.personaPrompt || "");
  const [aiyraVoiceId, setAiyraVoiceId] = useState(aiyraConfig?.voiceId || "");
  const [aiyraTtsSpeed, setAiyraTtsSpeed] = useState(
    formatAiyraTtsSpeedInput(aiyraConfig?.ttsSpeed)
  );
  const [aiyraWakeWord, setAiyraWakeWord] = useState(aiyraConfig?.wakeWord || "hey groovy");
  const [aiyraWakeSensitivity, setAiyraWakeSensitivity] = useState(
    Number.isFinite(Number(aiyraConfig?.wakeSensitivity)) ? Number(aiyraConfig?.wakeSensitivity) : 0.5
  );
  const [aiyraOpenWakewordThreshold, setAiyraOpenWakewordThreshold] = useState(
    resolvedConnectorOpenWakewordThreshold ?? DEFAULT_OPENWAKEWORD_THRESHOLD
  );
  const [aiyraOpenWakewordThresholdTouched, setAiyraOpenWakewordThresholdTouched] = useState(
    false
  );
  const [aiyraIdleTimeoutMs, setAiyraIdleTimeoutMs] = useState(
    Number.isFinite(Number(aiyraConfig?.idleTimeoutMs)) ? Number(aiyraConfig?.idleTimeoutMs) : 12000
  );
  const [aiyraTwilioEnabled, setAiyraTwilioEnabled] = useState(aiyraConfig?.twilioEnabled === true);
  const [aiyraTwilioFrom, setAiyraTwilioFrom] = useState(aiyraConfig?.twilioFrom || "");
  const [aiyraTwilioTo, setAiyraTwilioTo] = useState(aiyraConfig?.twilioTo || "");
  const [showAiyraApiKey, setShowAiyraApiKey] = useState(false);
  const [aiyraKeywordPath, setAiyraKeywordPath] = useState("");
  const [aiyraMicMode, setAiyraMicMode] = useState<AiyraMicMode>("computer_default");
  const [aiyraMicName, setAiyraMicName] = useState("");
  const [aiyraResolvedMicName, setAiyraResolvedMicName] = useState("");
  const [aiyraAudioDevices, setAiyraAudioDevices] = useState<AiyraAudioDevice[]>([]);
  const [aiyraDevicesLoading, setAiyraDevicesLoading] = useState(false);
  const [aiyraSaving, setAiyraSaving] = useState(false);
  const [aiyraReportLoading, setAiyraReportLoading] = useState<null | "missed_wake" | "false_trigger">(null);
  const [platformOverride, setPlatformOverride] = useState<ConnectorPlatformOverride>("auto");
  const [detectedPlatform, setDetectedPlatform] = useState<ConnectorClientPlatform>("unknown");
  const [hostedMacInfo, setHostedMacInfo] = useState<{
    request?: { id: string; status: string; status_detail?: string | null } | null;
    device?: { device_id: string; online: boolean; last_seen?: string | null } | null;
  } | null>(null);
  const [hostedMacActionLoading, setHostedMacActionLoading] = useState<null | "restart" | "update">(
    null
  );

  // ── Heartbeat state ──
  const [agentRuntimeHandshakeTurns, setAgentRuntimeHandshakeTurns] = useState(8);
  const [agentRuntimeMaxBranches, setAgentRuntimeMaxBranches] = useState(4);
  const [agentRuntimeMaxTurnsPerBranch, setAgentRuntimeMaxTurnsPerBranch] = useState(8);
  const [agentRuntimeBranchMode, setAgentRuntimeBranchMode] = useState<"read_write" | "read_only">("read_write");
  const [agentRuntimeSaving, setAgentRuntimeSaving] = useState(false);
  const [agentRuntimeSaved, setAgentRuntimeSaved] = useState(false);
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(false);
  const [heartbeatLoading, setHeartbeatLoading] = useState(false);
  const [heartbeatRuns, setHeartbeatRuns] = useState<Array<{ id: string; status: string; created_at: string; duration_ms: number | null }>>([]);
  const [heartbeatIntegrations, setHeartbeatIntegrations] = useState<HeartbeatIntegrations>({
    gmail: false,
    google_calendar: false,
    upready_readiness: false,
  });
  const [heartbeatToggling, setHeartbeatToggling] = useState(false);
  const [heartbeatDeviceId, setHeartbeatDeviceId] = useState<string | null>(null);
  const [heartbeatDelivery, setHeartbeatDelivery] = useState({ whatsapp: true, telegram: false });
  const [heartbeatDeliverySaving, setHeartbeatDeliverySaving] = useState(false);
  const [heartbeatRebinding, setHeartbeatRebinding] = useState(false);
  const [heartbeatRebindMessage, setHeartbeatRebindMessage] = useState<string | null>(null);
  const [upreadyConnected, setUpreadyConnected] = useState(false);
  const [upreadyLinkedEmail, setUpreadyLinkedEmail] = useState<string | null>(null);
  const [upreadyEmailInput, setUpreadyEmailInput] = useState("");
  const [upreadyLoading, setUpreadyLoading] = useState(false);
  const [upreadyActionLoading, setUpreadyActionLoading] = useState<null | "send" | "disconnect">(null);
  const [upreadyMessage, setUpreadyMessage] = useState<string | null>(null);
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [telegramBotUsername, setTelegramBotUsername] = useState<string | null>(null);
  const [telegramGroupCount, setTelegramGroupCount] = useState(0);
  const [telegramContactCount, setTelegramContactCount] = useState(0);
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [telegramBotTokenInput, setTelegramBotTokenInput] = useState("");
  const [telegramConnecting, setTelegramConnecting] = useState(false);
  const [telegramDisconnecting, setTelegramDisconnecting] = useState(false);
  const [telegramMessage, setTelegramMessage] = useState<string | null>(null);
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingActionLoading, setBillingActionLoading] = useState<
    null | "setup_card" | "topup" | "save_limit" | "save_auto_topup" | "reconcile_addons" | "personal_portal"
  >(null);
  const [topupSuccess, setTopupSuccess] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [showCardSetup, setShowCardSetup] = useState(false);
  const [stripeSetupClientSecret, setStripeSetupClientSecret] = useState<string | null>(null);
  const [stripePublishableKey, setStripePublishableKey] = useState<string | null>(null);
  const [monthlyLimitInput, setMonthlyLimitInput] = useState("");

  const REPAIR_CONNECTOR_COMMANDS = connectorGuide.repairCommands;

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        // Legacy fallback
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  };

  const formatUsd = (value: number) => `$${(Number.isFinite(value) ? value : 0).toFixed(2)}`;

  const refreshBillingStatus = async () => {
    if (edition.selfHosted) {
      setBillingStatus(null);
      setBillingLoading(false);
      return;
    }
    setBillingLoading(true);
    setBillingError(null);
    try {
      const res = await fetch("/api/billing/status", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBillingError(typeof json?.error === "string" ? json.error : "Failed to load billing status");
        setBillingStatus(null);
        return;
      }
      setBillingStatus(json as BillingStatus);
      const limit = (json as BillingStatus)?.policy?.monthlyLimitUsd;
      setMonthlyLimitInput(typeof limit === "number" && Number.isFinite(limit) ? String(limit) : "");
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : "Failed to load billing status");
      setBillingStatus(null);
    } finally {
      setBillingLoading(false);
    }
  };

  const startCardSetup = async () => {
    setBillingActionLoading("setup_card");
    setBillingError(null);
    try {
      const res = await fetch("/api/billing/stripe/setup-intent", {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBillingError(typeof json?.error === "string" ? json.error : "Failed to start card setup");
        return;
      }
      const clientSecret =
        typeof json?.clientSecret === "string" && json.clientSecret.trim()
          ? json.clientSecret.trim()
          : "";
      const publishableKey =
        typeof json?.publishableKey === "string" && json.publishableKey.trim()
          ? json.publishableKey.trim()
          : "";
      if (!clientSecret || !publishableKey) {
        setBillingError("Missing Stripe setup details from server.");
        return;
      }
      setStripeSetupClientSecret(clientSecret);
      setStripePublishableKey(publishableKey);
      setShowCardSetup(true);
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : "Failed to start card setup");
    } finally {
      setBillingActionLoading(null);
    }
  };

  const handleTopup = async () => {
    setBillingActionLoading("topup");
    setBillingError(null);
    try {
      const res = await fetch("/api/billing/topup", {
        method: "POST",
        headers: {
          "idempotency-key": `settings-topup-${Date.now()}`,
        },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBillingError(typeof json?.error === "string" ? json.error : "Failed to charge topup");
        return;
      }
      const invoice = (json as { invoice?: { amountUsd?: number } }).invoice;
      setSuccessMessage(
        `Added ${formatUsd(invoice?.amountUsd || 10)} to Groovy wallet.`
      );
      setSuccess(true);
      setTopupSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        setTopupSuccess(false);
      }, 4000);
      await refreshBillingStatus();
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : "Failed to charge topup");
    } finally {
      setBillingActionLoading(null);
    }
  };

  const saveMonthlyLimit = async () => {
    setBillingActionLoading("save_limit");
    setBillingError(null);
    try {
      const trimmed = monthlyLimitInput.trim();
      const nextLimit =
        trimmed === ""
          ? null
          : (() => {
              const n = Number(trimmed);
              return Number.isFinite(n) && n > 0 ? n : NaN;
            })();
      if (typeof nextLimit === "number" && !Number.isFinite(nextLimit)) {
        setBillingError("Monthly limit must be a positive number or empty.");
        return;
      }

      const res = await fetch("/api/billing/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyLimitUsd: nextLimit }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBillingError(typeof json?.error === "string" ? json.error : "Failed to save billing limit");
        return;
      }
      setSuccessMessage(nextLimit === null ? "Monthly billing limit removed." : "Monthly billing limit updated.");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 1800);
      await refreshBillingStatus();
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : "Failed to save billing limit");
    } finally {
      setBillingActionLoading(null);
    }
  };

  const saveAutoTopupEnabled = async (nextEnabled: boolean) => {
    setBillingActionLoading("save_auto_topup");
    setBillingError(null);
    try {
      const res = await fetch("/api/billing/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoTopupEnabled: nextEnabled }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBillingError(
          typeof json?.error === "string"
            ? json.error
            : "Failed to update auto top-up setting"
        );
        return;
      }
      setSuccessMessage(nextEnabled ? "Automatic top-up enabled." : "Automatic top-up disabled.");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 1800);
      await refreshBillingStatus();
    } catch (e) {
      setBillingError(
        e instanceof Error ? e.message : "Failed to update auto top-up setting"
      );
    } finally {
      setBillingActionLoading(null);
    }
  };

  const reconcileAddonBilling = async () => {
    setBillingActionLoading("reconcile_addons");
    setBillingError(null);
    try {
      const res = await fetch("/api/billing/addons/reconcile", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBillingError(
          typeof json?.error === "string"
            ? json.error
            : "Failed to resync addon billing"
        );
        return;
      }
      setSuccessMessage("Addon billing quantities resynced.");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 1800);
      await refreshBillingStatus();
    } catch (e) {
      setBillingError(
        e instanceof Error ? e.message : "Failed to resync addon billing"
      );
    } finally {
      setBillingActionLoading(null);
    }
  };

  const openPersonalBillingPortal = async () => {
    setBillingActionLoading("personal_portal");
    setBillingError(null);
    try {
      const res = await fetch("/api/licenses/personal/billing-portal", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || typeof json?.url !== "string") {
        throw new Error(typeof json?.error === "string" ? json.error : "Failed to open Stripe billing portal");
      }
      window.location.href = json.url;
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : "Failed to open Stripe billing portal");
      setBillingActionLoading(null);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setKeys({});
    setShowKeys({});
    setError(null);
    setSuccess(false);
    setSuccessMessage(null);
    setKeyMode(currentKeyMode);
    setInitialKeyMode(currentKeyMode);
    const init = buildInitialProviderModes(
      currentKeyMode,
      currentKeyModes,
      serverProviderKeysAllowed
    );
    setPerProviderModes(init);
    setInitialProviderModes(init);
    setInviteError(null);
    setInviteEmail("");
    setTeamActionLoading(null);
    setTeamActionError(null);
    setConnectorMode(null);
    setConnectorModeSaving(false);
    setConnectorModeError(null);
    setAiyraApiKey("");
    setAiyraClearApiKey(false);
    setAiyraKeywordPath("");
    setAiyraSaving(false);
    setAiyraReportLoading(null);
    setShowAiyraApiKey(false);
    setPlatformOverride(readConnectorPlatformOverride());
    setDetectedPlatform(
      typeof window !== "undefined"
        ? detectConnectorPlatformFromNavigator(window.navigator)
        : "unknown"
    );
    setHostedMacInfo(null);
    setHostedMacActionLoading(null);
    setHeartbeatEnabled(false);
    setHeartbeatRuns([]);
    setHeartbeatIntegrations(normalizeHeartbeatIntegrations(null));
    setHeartbeatToggling(false);
    setHeartbeatDeviceId(null);
    setHeartbeatDelivery({ whatsapp: true, telegram: false });
    setHeartbeatDeliverySaving(false);
    setHeartbeatRebinding(false);
    setHeartbeatRebindMessage(null);
    setUpreadyConnected(false);
    setUpreadyLinkedEmail(null);
    setUpreadyEmailInput("");
    setUpreadyLoading(false);
    setUpreadyActionLoading(null);
    setUpreadyMessage(null);
    setBillingStatus(null);
    setBillingLoading(false);
    setBillingActionLoading(null);
    setBillingError(null);
    setShowCardSetup(false);
    setStripeSetupClientSecret(null);
    setStripePublishableKey(null);
    setMonthlyLimitInput("");
    setActiveSection(
      resolveInitialSettingsSection({
        focusSection,
        currentKeyMode,
        currentKeyModes,
        currentKeys,
      })
    );
  }, [
    isOpen,
    focusSection,
    currentKeyMode,
    currentKeyModes,
    currentKeys,
    aiyraConfig,
    serverProviderKeysAllowed,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    setAiyraEnabled(aiyraConfig?.enabled === true);
    setAiyraPersonaPrompt(aiyraConfig?.personaPrompt || "");
    setAiyraVoiceId(aiyraConfig?.voiceId || "");
    setAiyraTtsSpeed(formatAiyraTtsSpeedInput(aiyraConfig?.ttsSpeed));
    setAiyraWakeWord(aiyraConfig?.wakeWord || "hey groovy");
    setAiyraWakeSensitivity(
      Number.isFinite(Number(aiyraConfig?.wakeSensitivity))
        ? Number(aiyraConfig?.wakeSensitivity)
        : 0.5
    );
    setAiyraIdleTimeoutMs(
      Number.isFinite(Number(aiyraConfig?.idleTimeoutMs))
        ? Number(aiyraConfig?.idleTimeoutMs)
        : 12000
    );
    setAiyraTwilioEnabled(aiyraConfig?.twilioEnabled === true);
    setAiyraTwilioFrom(aiyraConfig?.twilioFrom || "");
    setAiyraTwilioTo(aiyraConfig?.twilioTo || "");
  }, [isOpen, aiyraConfig]);

  useEffect(() => {
    if (!isOpen) return;
    setAiyraOpenWakewordThresholdTouched(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || aiyraOpenWakewordThresholdTouched) return;
    setAiyraOpenWakewordThreshold(
      resolvedConnectorOpenWakewordThreshold ?? DEFAULT_OPENWAKEWORD_THRESHOLD
    );
  }, [isOpen, resolvedConnectorOpenWakewordThreshold, aiyraOpenWakewordThresholdTouched]);

  // Load heartbeat config when modal opens
  useEffect(() => {
    if (!isOpen) return;
    const refreshHeartbeat = async () => {
      setHeartbeatLoading(true);
      try {
        const res = await fetch("/api/heartbeat/config", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) return;
        setHeartbeatEnabled(json.enabled === true);
        setHeartbeatRuns(Array.isArray(json.runs) ? json.runs : []);
        setHeartbeatIntegrations(normalizeHeartbeatIntegrations(json.integrations));
        setHeartbeatDeviceId(typeof json.deviceId === "string" && json.deviceId ? json.deviceId : null);
        if (json.delivery && typeof json.delivery === "object") {
          setHeartbeatDelivery({
            whatsapp: json.delivery.whatsapp === true,
            telegram: json.delivery.telegram === true,
          });
        }
      } catch {
        // ignore
      } finally {
        setHeartbeatLoading(false);
      }
    };
    refreshHeartbeat().catch(() => {});
  }, [isOpen]);

  const refreshUpreadyLink = useCallback(async () => {
    setUpreadyLoading(true);
    try {
      const res = await fetch("/api/upready/link", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const connected = json?.connected === true;
      setUpreadyConnected(connected);
      setUpreadyLinkedEmail(
        connected && typeof json?.link?.upreadyEmail === "string"
          ? json.link.upreadyEmail
          : null
      );
    } catch {
      // ignore
    } finally {
      setUpreadyLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    refreshUpreadyLink().catch(() => {});
  }, [isOpen, refreshUpreadyLink]);

  useEffect(() => {
    if (!isOpen) return;
    const refreshTelegram = async () => {
      setTelegramLoading(true);
      try {
        const res = await fetch("/api/telegram/setup", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) return;
        setTelegramConnected(json.connected === true);
        setTelegramBotUsername(typeof json.botUsername === "string" ? json.botUsername : null);
        setTelegramGroupCount(typeof json.groupCount === "number" ? json.groupCount : 0);
        setTelegramContactCount(typeof json.contactCount === "number" ? json.contactCount : 0);
      } catch {
        // ignore
      } finally {
        setTelegramLoading(false);
      }
    };
    refreshTelegram().catch(() => {});
  }, [isOpen]);

  const connectTelegram = async () => {
    const token = telegramBotTokenInput.trim();
    if (!token) return;
    setTelegramConnecting(true);
    setTelegramMessage(null);
    try {
      const res = await fetch("/api/telegram/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", botToken: token }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTelegramMessage(json.error || "Failed to connect bot");
        return;
      }
      setTelegramConnected(true);
      setTelegramBotUsername(json.botUsername || null);
      setTelegramBotTokenInput("");
      setTelegramMessage(`Connected @${json.botUsername || "bot"}`);
    } catch (err) {
      setTelegramMessage(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setTelegramConnecting(false);
    }
  };

  const disconnectTelegram = async () => {
    setTelegramDisconnecting(true);
    setTelegramMessage(null);
    try {
      const res = await fetch("/api/telegram/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect" }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setTelegramMessage(json.error || "Disconnect failed");
        return;
      }
      setTelegramConnected(false);
      setTelegramBotUsername(null);
      setTelegramGroupCount(0);
      setTelegramContactCount(0);
      setTelegramMessage("Telegram bot disconnected");
    } catch (err) {
      setTelegramMessage(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setTelegramDisconnecting(false);
    }
  };

  const refreshHeartbeatIntegrations = async () => {
    try {
      const cfgRes = await fetch("/api/heartbeat/config", { cache: "no-store" });
      const cfgJson = await cfgRes.json().catch(() => ({}));
      if (cfgRes.ok) {
        setHeartbeatIntegrations(normalizeHeartbeatIntegrations(cfgJson.integrations));
      }
    } catch {
      // ignore
    }
  };

  const sendUpreadyLinkConfirmation = async () => {
    const email = upreadyEmailInput.trim();
    if (!email) {
      setError("Enter your Upready email first.");
      return;
    }
    setUpreadyActionLoading("send");
    setUpreadyMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/upready/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof json?.error === "string" ? json.error : "Failed to send confirmation email");
        return;
      }
      setUpreadyMessage(
        typeof json?.message === "string"
          ? json.message
          : "Confirmation email sent. Open it and confirm the link."
      );
    } catch {
      setError("Failed to send confirmation email");
    } finally {
      setUpreadyActionLoading(null);
    }
  };

  const disconnectUpready = async () => {
    setUpreadyActionLoading("disconnect");
    setUpreadyMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/upready/link", { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof json?.error === "string" ? json.error : "Failed to disconnect Upready");
        return;
      }
      setUpreadyConnected(false);
      setUpreadyLinkedEmail(null);
      setUpreadyMessage("Upready disconnected.");
      await refreshHeartbeatIntegrations();
    } catch {
      setError("Failed to disconnect Upready");
    } finally {
      setUpreadyActionLoading(null);
    }
  };

  const updateHeartbeatDelivery = async (next: { whatsapp: boolean; telegram: boolean }) => {
    setHeartbeatDeliverySaving(true);
    setError(null);
    try {
      const res = await fetch("/api/heartbeat/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: heartbeatEnabled,
          delivery: { dashboard: true, ...next },
          ...(heartbeatDeviceId ? { deviceId: heartbeatDeviceId } : activeDeviceId ? { deviceId: activeDeviceId } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof json?.error === "string" ? json.error : "Failed to update delivery channel");
        return;
      }
      setHeartbeatDelivery(next);
    } catch {
      setError("Failed to update delivery channel");
    } finally {
      setHeartbeatDeliverySaving(false);
    }
  };

  const toggleHeartbeat = async (next: boolean) => {
    setHeartbeatToggling(true);
    setError(null);
    try {
      const res = await fetch("/api/heartbeat/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: next,
          ...(activeDeviceId ? { deviceId: activeDeviceId } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof json?.error === "string" ? json.error : "Failed to update heartbeat");
        return;
      }
      setHeartbeatEnabled(json.enabled === true);
      if (typeof json?.deviceId === "string" && json.deviceId) {
        setHeartbeatDeviceId(json.deviceId);
      }
      // Refresh config so runs/integration badges stay current.
      try {
        const cfgRes = await fetch("/api/heartbeat/config", { cache: "no-store" });
        const cfgJson = await cfgRes.json().catch(() => ({}));
        if (cfgRes.ok) {
          setHeartbeatRuns(Array.isArray(cfgJson.runs) ? cfgJson.runs : []);
          setHeartbeatIntegrations(normalizeHeartbeatIntegrations(cfgJson.integrations));
          setHeartbeatDeviceId(
            typeof cfgJson.deviceId === "string" && cfgJson.deviceId ? cfgJson.deviceId : null
          );
        }
      } catch {
        // ignore
      }
    } catch {
      setError("Failed to update heartbeat");
    } finally {
      setHeartbeatToggling(false);
    }
  };

  const rebindHeartbeatToCurrentConnector = async () => {
    if (!activeDeviceId) {
      setError("No active connector selected in this session.");
      return;
    }
    setHeartbeatRebinding(true);
    setHeartbeatRebindMessage(null);
    setError(null);
    try {
      // Read existing delivery config so rebind only changes the target device.
      const cfgRes = await fetch("/api/heartbeat/config", { cache: "no-store" });
      const cfgJson = await cfgRes.json().catch(() => ({}));
      const enabled =
        cfgRes.ok && typeof cfgJson?.enabled === "boolean" ? cfgJson.enabled : heartbeatEnabled;
      const delivery =
        cfgRes.ok && cfgJson?.delivery && typeof cfgJson.delivery === "object"
          ? cfgJson.delivery
          : { dashboard: true, whatsapp: true };

      const res = await fetch("/api/heartbeat/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          delivery,
          deviceId: activeDeviceId,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof json?.error === "string" ? json.error : "Failed to rebind heartbeat");
        return;
      }

      setHeartbeatEnabled(json.enabled === true);
      const nextDeviceId =
        typeof json?.deviceId === "string" && json.deviceId ? json.deviceId : activeDeviceId;
      setHeartbeatDeviceId(nextDeviceId);
      setHeartbeatRebindMessage("Heartbeat pinned to current connector.");
      setTimeout(() => setHeartbeatRebindMessage(null), 2000);
    } catch {
      setError("Failed to rebind heartbeat");
    } finally {
      setHeartbeatRebinding(false);
    }
  };

  useEffect(() => {
    if (!isOpen || edition.loading) return;
    (async () => {
      setWorkspaceLoading(true);
      try {
        // Determine connector mode (local vs groovy mac) from user preferences.
        const prefsRes = await fetch("/api/user-preferences", { cache: "no-store" });
        const prefsJson = await prefsRes.json().catch(() => ({}));
        const modeRaw = prefsJson?.onboardingData?.connectorMode;
        const mode: "local" | "groovy" | null = edition.selfHosted
          ? "local"
          : modeRaw === "groovy" || modeRaw === "local"
            ? modeRaw
            : null;
        setConnectorMode(mode);
        const bc = prefsJson?.branchController;
        if (bc && typeof bc === "object") {
          const n = (v: unknown, d: number) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
          setAgentRuntimeMaxBranches(Math.max(1, Math.min(12, Math.trunc(n(bc.maxBranches, 4)))));
          setAgentRuntimeMaxTurnsPerBranch(Math.max(1, Math.min(64, Math.trunc(n(bc.maxTurnsPerBranch, 8)))));
          if (bc.mode === "read_only") setAgentRuntimeBranchMode("read_only");
        }
        const hsTurns = prefsJson?.onboardingData?.handshakeMaxTurnsPerWindow;
        if (typeof hsTurns === "number" && Number.isFinite(hsTurns) && hsTurns > 0) {
          setAgentRuntimeHandshakeTurns(Math.max(2, Math.min(20, Math.trunc(hsTurns))));
        }
        if (mode === "groovy") {
          const hmRes = await fetch("/api/hosted-macs/request", { cache: "no-store" });
          const hmJson = await hmRes.json().catch(() => ({}));
          if (hmRes.ok && hmJson?.request) {
            setHostedMacInfo({
              request: {
                id: String(hmJson.request.id),
                status: String(hmJson.request.status || ""),
                status_detail:
                  typeof hmJson.request.status_detail === "string"
                    ? hmJson.request.status_detail
                    : null,
              },
              device: hmJson.device?.device_id
                ? {
                    device_id: String(hmJson.device.device_id),
                    online: Boolean(hmJson.device.online),
                    last_seen: hmJson.device.last_seen ? String(hmJson.device.last_seen) : null,
                  }
                : null,
            });
          }
        }

        const res = await fetch("/api/workspaces/current", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.workspace) {
          setWorkspace(json.workspace);
          if (json.workspace.role === "admin") {
            const invRes = await fetch("/api/workspaces/invites", { cache: "no-store" });
            const invJson = await invRes.json().catch(() => ({}));
            if (invRes.ok) {
              setInvites(Array.isArray(invJson.invites) ? invJson.invites : []);
            }
            if (!edition.selfHosted) {
              const listRes = await fetch("/api/workspaces/whatsapp-allowlist", { cache: "no-store" });
              const listJson = await listRes.json().catch(() => ({}));
              if (listRes.ok) {
                setAllowlist(Array.isArray(listJson.allowlist) ? listJson.allowlist : []);
              }
              const cwRes = await fetch("/api/workspaces/company-whatsapp", { cache: "no-store" });
              const cwJson = await cwRes.json().catch(() => ({}));
              if (cwRes.ok && cwJson.companyWhatsapp) {
                setCompanyWhatsappStatus(String(cwJson.companyWhatsapp.status || ""));
                setCompanyWhatsappSetupUrl(
                  typeof cwJson.companyWhatsapp.setup_link_url === "string"
                    ? cwJson.companyWhatsapp.setup_link_url
                    : null
                );
              } else {
                setCompanyWhatsappStatus(null);
              }
            } else {
              setAllowlist([]);
              setCompanyWhatsappStatus(null);
              setCompanyWhatsappSetupUrl(null);
            }
            const groupsRes = await fetch("/api/workspaces/whatsapp-groups", { cache: "no-store" });
            const groupsJson = await groupsRes.json().catch(() => ({}));
            if (groupsRes.ok) {
              setGroups(Array.isArray(groupsJson.groups) ? groupsJson.groups : []);
            }
          }
        }
        if (!edition.selfHosted) {
          const phoneRes = await fetch("/api/workspaces/phones", { cache: "no-store" });
          const phoneJson = await phoneRes.json().catch(() => ({}));
          if (phoneRes.ok && phoneJson.phone) {
            setPhoneEntry(String(phoneJson.phone.phone_e164 || ""));
            setPhoneCode(phoneJson.phone.verification_code || null);
            setPhoneVerified(!!phoneJson.phone.verified_at);
          }
          await refreshBillingStatus();
        }
      } catch {
        // ignore
      } finally {
        setWorkspaceLoading(false);
      }
    })();
  }, [edition.loading, edition.selfHosted, isOpen]);

  const requestHostedMacAction = async (action: "restart" | "update") => {
    setHostedMacActionLoading(action);
    try {
      const res = await fetch("/api/hosted-macs/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Request failed");
      setSuccessMessage(
        action === "restart" ? "Restart requested. We'll handle it." : "Update requested. We'll handle it."
      );
      setSuccess(true);
      setTimeout(() => setSuccess(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setHostedMacActionLoading(null);
    }
  };

  const setConnectorModePreference = async (next: "local" | "groovy") => {
    if (edition.selfHosted && next === "groovy") {
      setConnectorModeError("Groovy-hosted Macs are unavailable in the self-hosted edition.");
      return;
    }
    setConnectorModeSaving(true);
    setConnectorModeError(null);
    setConnectorMode(next);
    try {
      const prefsRes = await fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboardingData: { connectorMode: next } }),
      });
      const prefsJson = await prefsRes.json().catch(() => ({}));
      if (!prefsRes.ok) throw new Error(prefsJson?.error || "Failed to save");

      if (next === "groovy") {
        const hmRes = await fetch("/api/hosted-macs/request", { cache: "no-store" });
        const hmJson = await hmRes.json().catch(() => ({}));
        if (hmRes.ok && hmJson?.request) {
          setHostedMacInfo({
            request: {
              id: String(hmJson.request.id),
              status: String(hmJson.request.status || ""),
              status_detail:
                typeof hmJson.request.status_detail === "string" ? hmJson.request.status_detail : null,
            },
            device: hmJson.device?.device_id
              ? {
                  device_id: String(hmJson.device.device_id),
                  online: Boolean(hmJson.device.online),
                  last_seen: hmJson.device.last_seen ? String(hmJson.device.last_seen) : null,
                }
              : null,
          });
        } else {
          setHostedMacInfo(null);
        }
      } else {
        setHostedMacInfo(null);
      }

      try {
        await onConnectorModeChanged?.(next);
      } catch {
        // ignore
      }
      onRefreshConnector?.();
    } catch (e) {
      setConnectorModeError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setConnectorModeSaving(false);
    }
  };

  const setPlatformOverridePreference = (next: ConnectorPlatformOverride) => {
    setPlatformOverride(next);
    writeConnectorPlatformOverride(next);
    setSuccessMessage("Install guide platform updated.");
    setSuccess(true);
    setTimeout(() => setSuccess(false), 1400);
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteError(null);
    try {
      const res = await fetch("/api/workspaces/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to invite");
      setInvites((prev) => [json.invite, ...prev]);
      setInviteEmail("");
      if (json?.emailSent === true) {
        setSuccessMessage("Invite email sent.");
        setSuccess(true);
        setTimeout(() => setSuccess(false), 1500);
      } else if (typeof json?.emailError === "string" && json.emailError) {
        setSuccessMessage("Invite created, but email failed. Share the link below.");
        setSuccess(true);
        setTimeout(() => setSuccess(false), 2500);
      }
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : "Failed to invite");
    } finally {
      setInviting(false);
    }
  };

  const leaveWorkspace = async () => {
    if (!workspace) return;
    const ok = window.confirm(
      "Leave this workspace?\n\nYou'll lose access to shared chats, shared connectors, and team requests."
    );
    if (!ok) return;

    setTeamActionLoading("leave");
    setTeamActionError(null);
    try {
      const res = await fetch("/api/workspaces/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "leave" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to leave");
      // After leaving, dashboard will auto-create a personal workspace on next load.
      window.location.href = "/dashboard";
    } catch (e) {
      setTeamActionError(e instanceof Error ? e.message : "Failed to leave");
    } finally {
      setTeamActionLoading(null);
    }
  };

  const removeWorkspaceMember = async (userId: string) => {
    if (!workspace) return;
    const target = workspace.members.find((m) => m.user_id === userId);
    const label = target?.email || userId.slice(0, 8);
    const ok = window.confirm(`Remove ${label} from this workspace?`);
    if (!ok) return;

    setTeamActionLoading(`remove:${userId}`);
    setTeamActionError(null);
    try {
      const res = await fetch("/api/workspaces/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", userId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to remove member");
      setWorkspace((prev) =>
        prev ? { ...prev, members: prev.members.filter((m) => m.user_id !== userId) } : prev
      );
    } catch (e) {
      setTeamActionError(e instanceof Error ? e.message : "Failed to remove member");
    } finally {
      setTeamActionLoading(null);
    }
  };

  const addAllowlist = async () => {
    if (!allowlistPhone.trim()) return;
    setAllowlistLoading(true);
    try {
      const res = await fetch("/api/workspaces/whatsapp-allowlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_e164: allowlistPhone.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.entry) {
        setAllowlist((prev) => [json.entry, ...prev]);
        setAllowlistPhone("");
      }
    } finally {
      setAllowlistLoading(false);
    }
  };

  const removeAllowlist = async (phone: string) => {
    setAllowlistLoading(true);
    try {
      await fetch(`/api/workspaces/whatsapp-allowlist?phone=${encodeURIComponent(phone)}`, {
        method: "DELETE",
      });
      setAllowlist((prev) => prev.filter((p) => p.phone_e164 !== phone));
    } finally {
      setAllowlistLoading(false);
    }
  };

  const requestPhoneVerification = async () => {
    if (!phoneEntry.trim()) return;
    const res = await fetch("/api/workspaces/phones", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_e164: phoneEntry.trim() }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      setPhoneCode(json.phone?.verification_code || null);
      setPhoneVerified(false);
    }
  };

  const addGroup = async () => {
    if (!groupName.trim()) return;
    const res = await fetch("/api/workspaces/whatsapp-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_name: groupName.trim() }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.group) {
      setGroups((prev) => [json.group, ...prev]);
      setGroupName("");
    }
  };

  const removeGroup = async (id: string) => {
    await fetch(`/api/workspaces/whatsapp-groups?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setGroups((prev) => prev.filter((g) => g.id !== id));
  };

  const createCompanyWhatsapp = async () => {
    setCompanyWhatsappLoading(true);
    try {
      const res = await fetch("/api/workspaces/company-whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setup_link" }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setCompanyWhatsappStatus(String(json?.companyWhatsapp?.status || "pending"));
        if (json?.setupLinkUrl) {
          setCompanyWhatsappSetupUrl(String(json.setupLinkUrl));
          // Auto-open the setup link so user can complete immediately
          window.open(String(json.setupLinkUrl), "_blank");
        }
      }
    } finally {
      setCompanyWhatsappLoading(false);
    }
  };

  const handleSave = async () => {
    const keysToSave = Object.fromEntries(Object.entries(keys).filter(([, v]) => v && v.trim()));

    if (!serverProviderKeysAllowed) {
      const hasPrimaryKey = ["anthropic", "openai"].some(
        (provider) =>
          currentKeys[provider as Provider]?.configured ||
          typeof keysToSave[provider] === "string"
      );
      if (!hasPrimaryKey) {
        setError("Add an Anthropic or OpenAI API key so the orchestrator can run.");
        return;
      }
    }

    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      // Derive legacy global mode from non-headless providers only.
      const effectiveGlobalMode: LlmKeyMode = !serverProviderKeysAllowed
        ? "user"
        : PROVIDER_ORDER
        .filter((provider) => provider !== "claude_cli" && provider !== "codex_cli")
        .some((provider) => perProviderModes[provider] === "user")
        ? "user"
        : "groovy";
      await onSave(keysToSave, effectiveGlobalMode, perProviderModes);
      setSuccessMessage(Object.keys(keysToSave).length > 0 ? "API keys saved!" : "Settings saved!");
      setSuccess(true);
      setKeys({});
      setInitialProviderModes(perProviderModes);
      setTimeout(() => onClose(), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const loadAiyraAudioDevices = useCallback(async () => {
    if (!onListAiyraAudioDevices) return;
    setAiyraDevicesLoading(true);
    try {
      const result = await onListAiyraAudioDevices();
      const devices = Array.isArray(result?.devices) ? result.devices : [];
      setAiyraAudioDevices(devices);
      if (
        result?.currentMicMode === "computer_default" ||
        result?.currentMicMode === "system_default" ||
        result?.currentMicMode === "specific"
      ) {
        setAiyraMicMode(result.currentMicMode);
      }
      if (typeof result?.currentMicName === "string") {
        setAiyraMicName(result.currentMicName);
      }
      if (typeof result?.resolvedDeviceName === "string") {
        setAiyraResolvedMicName(result.resolvedDeviceName);
      }
    } catch {
      setAiyraAudioDevices([]);
    } finally {
      setAiyraDevicesLoading(false);
    }
  }, [onListAiyraAudioDevices]);

  useEffect(() => {
    if (activeSection === "aiyra-voice" && isOpen && onListAiyraAudioDevices) {
      loadAiyraAudioDevices();
    }
  }, [activeSection, isOpen, loadAiyraAudioDevices, onListAiyraAudioDevices]);

  const handleSaveAiyraVoice = async () => {
    if (!onSaveAiyraConfig) {
      setError("Aiyra voice save handler is not available.");
      return;
    }
    setAiyraSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const wakeSensitivity = Math.max(
        0,
        Math.min(1, Number.isFinite(Number(aiyraWakeSensitivity)) ? Number(aiyraWakeSensitivity) : 0.5)
      );
      const openWakewordThreshold = Math.max(
        0,
        Math.min(
          1,
          Number.isFinite(Number(aiyraOpenWakewordThreshold))
            ? Number(aiyraOpenWakewordThreshold)
            : DEFAULT_OPENWAKEWORD_THRESHOLD
        )
      );
      const idleTimeoutMs = Math.max(
        2000,
        Math.min(
          120000,
          Math.trunc(Number.isFinite(Number(aiyraIdleTimeoutMs)) ? Number(aiyraIdleTimeoutMs) : 12000)
        )
      );
      const ttsSpeed = parseAiyraTtsSpeedInput(aiyraTtsSpeed);
      const nextEnabled = aiyraEnabled || !!aiyraApiKey.trim();
      if (nextEnabled && !aiyraEnabled) {
        setAiyraEnabled(true);
      }
      await onSaveAiyraConfig({
        ...(aiyraApiKey.trim() ? { apiKey: aiyraApiKey.trim() } : {}),
        ...(aiyraClearApiKey ? { clearApiKey: true } : {}),
        enabled: nextEnabled,
        personaPrompt: aiyraPersonaPrompt.trim(),
        voiceId: aiyraVoiceId.trim(),
        ttsSpeed,
        wakeWord: (aiyraWakeWord || "").trim() || "hey groovy",
        wakeSensitivity,
        ...(aiyraOpenWakewordThresholdTouched ||
        resolvedConnectorOpenWakewordThreshold !== null
          ? { openWakewordThreshold }
          : {}),
        idleTimeoutMs,
        twilioEnabled: aiyraTwilioEnabled,
        twilioFrom: aiyraTwilioFrom.trim(),
        twilioTo: aiyraTwilioTo.trim(),
        keywordPath: aiyraKeywordPath.trim() || undefined,
        micMode: aiyraMicMode,
        micName: aiyraMicMode === "specific" ? aiyraMicName : "",
      });
      setSuccessMessage("Aiyra voice settings saved.");
      setSuccess(true);
      setAiyraApiKey("");
      setAiyraClearApiKey(false);
      setTimeout(() => setSuccess(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save Aiyra voice settings");
    } finally {
      setAiyraSaving(false);
    }
  };

  const handleLoadStoredAiyraConfig = async () => {
    if (!onLoadAiyraConfig) {
      setError("Aiyra config load handler is not available.");
      return;
    }
    const apiKey = aiyraApiKey.trim();
    if (!apiKey) {
      setError("Paste an Aiyra API key first.");
      return;
    }
    setAiyraSaving(true);
    setError(null);
    setSuccess(false);
    setAiyraEnabled(true);
    try {
      await onLoadAiyraConfig({
        apiKey,
        enabled: true,
      });
      setSuccessMessage("Loaded stored Aiyra config.");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load stored Aiyra config");
    } finally {
      setAiyraSaving(false);
    }
  };

  const handleReportAiyraVoiceEvent = async (
    kind: "missed_wake" | "false_trigger"
  ) => {
    if (!onReportAiyraVoiceEvent) return;
    setAiyraReportLoading(kind);
    setError(null);
    try {
      const ok = await onReportAiyraVoiceEvent(kind);
      if (ok) {
        setSuccessMessage(
          kind === "missed_wake"
            ? "Reported missed wake."
            : "Reported false trigger."
        );
        setSuccess(true);
        setTimeout(() => setSuccess(false), 1400);
      } else {
        setError("Failed to send voice report to connector.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to report voice event");
    } finally {
      setAiyraReportLoading(null);
    }
  };

  const hasKeyInput = Object.values(keys).some((v) => !!v?.trim());
  const modesChanged = PROVIDER_ORDER.some(
    (p) => (perProviderModes[p] || keyMode) !== (initialProviderModes[p] || initialKeyMode)
  );
  const heartbeatBoundToCurrentConnector =
    !!heartbeatDeviceId && !!activeDeviceId && heartbeatDeviceId === activeDeviceId;
  const heartbeatBoundToDifferentConnector =
    heartbeatEnabled &&
    !!heartbeatDeviceId &&
    !!activeDeviceId &&
    heartbeatDeviceId !== activeDeviceId;
  const heartbeatStatusDot = !heartbeatEnabled
    ? "#52525b"
    : heartbeatBoundToDifferentConnector
      ? "#f59e0b"
      : "#34d399";
  const heartbeatStatusLabel = !heartbeatEnabled
    ? "Heartbeat is off"
    : heartbeatBoundToDifferentConnector
      ? "Heartbeat is on (another connector)"
      : "Heartbeat is on";
  const connectorWhatsAppStatus =
    connectorWhatsAppHealth?.status || "unknown";
  const connectorHasWhatsAppIssue =
    connectorOnline === true &&
    (connectorWhatsAppStatus === "degraded" ||
      connectorWhatsAppStatus === "recovering");
  const connectorIssueRestartable =
    connectorHasWhatsAppIssue &&
    isRestartableWhatsAppIssue(connectorWhatsAppHealth);
  const connectorWhatsAppBrowserIssue =
    connectorHasWhatsAppIssue &&
    isWhatsAppBrowserRuntimeIssue(connectorWhatsAppHealth);
  const connectorStatusLabel = connectorHasWhatsAppIssue
    ? connectorWhatsAppStatus === "recovering"
      ? "Online · WhatsApp recovering"
      : "Online · WhatsApp degraded"
    : connectorOnline
      ? "Online"
      : "Offline";
  const connectorAiyraStatus = connectorAiyraVoiceHealth?.status || "unknown";
  const connectorAiyraLowMicGain = connectorAiyraVoiceHealth?.low_mic_gain_detected === true;
  const connectorAiyraLowMicGainMessage =
    typeof connectorAiyraVoiceHealth?.low_mic_gain_message === "string" &&
    connectorAiyraVoiceHealth.low_mic_gain_message.trim()
      ? connectorAiyraVoiceHealth.low_mic_gain_message.trim()
      : "Microphone gain appears to be too low. Please increase your microphone volume.";
  const connectorAiyraLowMicGainMaxEnergy = Number(
    connectorAiyraVoiceHealth?.low_mic_gain_max_energy_observed
  );
  const connectorAiyraLowMicGainThreshold = Number(
    connectorAiyraVoiceHealth?.low_mic_gain_threshold
  );
  const connectorAiyraLowMicGainDetails =
    Number.isFinite(connectorAiyraLowMicGainMaxEnergy) &&
    Number.isFinite(connectorAiyraLowMicGainThreshold)
      ? `Detected ${Math.round(connectorAiyraLowMicGainMaxEnergy)} / required ${Math.round(
          connectorAiyraLowMicGainThreshold
        )}.`
      : "";
  const connectorAiyraIssue =
    connectorOnline === true &&
    (connectorAiyraStatus === "degraded" ||
      connectorAiyraStatus === "recovering" ||
      connectorAiyraLowMicGain);
  const connectorAiyraListening = connectorAiyraVoiceHealth?.listening === true;
  const connectorAiyraActive = connectorAiyraVoiceHealth?.active === true;
  const aiyraMetricEvent = (connectorAiyraVoiceHealth?.last_metric_event || "")
    .trim()
    .toLowerCase();
  const aiyraMetricAtMs = connectorAiyraVoiceHealth?.last_metric_at
    ? Date.parse(connectorAiyraVoiceHealth.last_metric_at)
    : NaN;
  const aiyraHasRecentWakeMetric =
    Number.isFinite(aiyraMetricAtMs) &&
    Date.now() - aiyraMetricAtMs < 8_000 &&
    AIYRA_RECENT_UI_ACTIVITY_EVENTS.includes(
      aiyraMetricEvent as (typeof AIYRA_RECENT_UI_ACTIVITY_EVENTS)[number]
    );
  const connectorAiyraActiveUi = connectorAiyraActive || aiyraHasRecentWakeMetric;
  const connectorAiyraListeningUi =
    connectorAiyraListening || (!connectorAiyraActiveUi && connectorAiyraStatus === "healthy");
  const selectedAiyraMicValue =
    aiyraMicMode === "specific"
      ? `specific:${encodeURIComponent(aiyraMicName)}`
      : aiyraMicMode;
  const selectedSpecificMicAvailable =
    aiyraMicMode !== "specific"
      ? true
      : aiyraAudioDevices.some((device) => device.name === aiyraMicName);
  const aiyraMicStatusText =
    aiyraMicMode === "computer_default"
      ? aiyraResolvedMicName
        ? `Currently using ${aiyraResolvedMicName}. This ignores fragile OS default changes and prefers built-in/display microphones.`
        : "Prefers a built-in/display computer microphone instead of the OS system default."
      : aiyraMicMode === "system_default"
        ? "Uses whatever your operating system marks as the default input device."
        : selectedSpecificMicAvailable
          ? aiyraResolvedMicName
            ? `Pinned to ${aiyraMicName}. Currently resolved to ${aiyraResolvedMicName}.`
            : `Pinned to ${aiyraMicName}.`
          : aiyraMicName
            ? `Pinned to ${aiyraMicName}, but it is not currently available. The connector will fall back to the computer microphone until it reappears.`
            : "Choose a specific microphone to pin by name.";
  const canSelfUpdateActiveConnector =
    connectorOnline === true &&
    connectorSupportsInPlaceUpdate &&
    !!onUpdateConnector;
  const canSelfUpdateActiveHostedConnector =
    connectorMode === "groovy" &&
    isHostedConnectorActive &&
    canSelfUpdateActiveConnector;
  const canSelfUpdateLocalConnector =
    connectorMode !== "groovy" &&
    canSelfUpdateActiveConnector;

  if (!isOpen) return null;

  // ── Section renderers ──

  const handleSaveAgentRuntime = async () => {
    setAgentRuntimeSaving(true);
    setAgentRuntimeSaved(false);
    try {
      const res = await fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchController: {
            maxBranches: agentRuntimeMaxBranches,
            maxTurnsPerBranch: agentRuntimeMaxTurnsPerBranch,
            mode: agentRuntimeBranchMode,
          },
          onboardingData: {
            handshakeMaxTurnsPerWindow: agentRuntimeHandshakeTurns,
          },
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      setAgentRuntimeSaved(true);
      setTimeout(() => setAgentRuntimeSaved(false), 2000);
    } catch {
      // ignore
    } finally {
      setAgentRuntimeSaving(false);
    }
  };

  const renderConnectorSection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white mb-1">Connector</h3>
        <p className="text-sm text-zinc-500">Manage your connector status and mode.</p>
      </div>

      {(typeof connectorOnline === "boolean" || onRefreshConnector || onRestartConnector) && (
        <div className="space-y-4">
          {/* Status */}
          <div className="p-4 rounded-xl bg-black/30 border border-white/10">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {connectorHasWhatsAppIssue ? (
                  <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
                    <AlertTriangle className="w-4.5 h-4.5 text-amber-300" />
                  </div>
                ) : connectorOnline ? (
                  <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                    <Wifi className="w-4.5 h-4.5 text-emerald-400" />
                  </div>
                ) : (
                  <div className="w-9 h-9 rounded-lg bg-zinc-800 flex items-center justify-center">
                    <WifiOff className="w-4.5 h-4.5 text-zinc-500" />
                  </div>
                )}
                <div>
                  <div className="text-sm font-medium text-zinc-200">
                    {connectorMode === "groovy" ? "Groovy Mac Connector" : "Local Connector"}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {connectorStatusLabel}
                    {connectorOnline && connectorVersion ? ` · v${connectorVersion}` : ""}
                    {connectorMode === "groovy" &&
                      hostedMacInfo?.device?.device_id &&
                      ` · ${hostedMacInfo.device.device_id.slice(0, 8)}`}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {onRefreshConnector && (
                  <button
                    type="button"
                    onClick={onRefreshConnector}
                    className="px-3 py-1.5 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 text-xs transition-all flex items-center gap-1.5"
                    title="Refresh connector status"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                    Refresh
                  </button>
                )}
                {onRestartConnector && connectorOnline && (
                  <button
                    type="button"
                    onClick={onRestartConnector}
                    className="px-3 py-1.5 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 text-xs transition-all flex items-center gap-1.5"
                    title={
                      connectorMode === "groovy"
                        ? "Ask the Groovy Mac connector to restart"
                        : "Ask the local connector to restart"
                    }
                  >
                    <Power className="w-3.5 h-3.5" />
                    Restart
                  </button>
                )}
              </div>
            </div>
            {connectorHasWhatsAppIssue && (
              <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2">
                <div className="text-[11px] text-amber-100">
                  WhatsApp bridge looks unhealthy.
                </div>
                <div className="text-[11px] text-zinc-400 mt-1">
                  {connectorWhatsAppHealth?.detail ||
                    connectorWhatsAppHealth?.reason ||
                    "Detached-frame or restart-loop was detected."}
                </div>
                <div className="text-[11px] text-zinc-400 mt-1">
                  {connectorWhatsAppHealth?.auto_restart_pending
                    ? "Automatic restart was requested. You can still click Restart if it doesn't recover quickly."
                    : connectorWhatsAppBrowserIssue
                      ? "The connector could not find a Chromium browser. Update to the latest connector or install Chrome, then restart."
                    : connectorIssueRestartable
                      ? "Click Restart to force a clean reconnect now."
                      : "This looks like a config/auth issue; restart may not fix it."}
                </div>
              </div>
            )}
          </div>

          {connectorMode !== "groovy" && connectorOnline === false && (
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm text-amber-200 font-medium">
                    Update or reinstall connector
                  </div>
                  <div className="text-xs text-zinc-400 mt-1">
                    The connector is offline. Download the latest v{minConnectorVersion || "latest"} build, then open it and reconnect.
                  </div>
                </div>
                <a
                  href={connectorDownloadUrl || connectorGuide.downloadUrl}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 text-zinc-200 hover:bg-white/10 text-xs transition-all"
                  title={`Download ${connectorGuide.downloadFileLabel}`}
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </a>
              </div>
              <details className="mt-3">
                <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400">
                  Installation help
                </summary>
                <div className="mt-2 text-xs text-zinc-500 space-y-1 pl-3 border-l border-zinc-700">
                  {connectorGuide.installSteps.map((stepText, idx) => (
                    <p key={`connector-offline-help-${connectorGuide.platform}-${idx}`}>
                      {idx + 1}. {stepText}
                    </p>
                  ))}
                  <p>
                    Restart with:{" "}
                    <code className="bg-zinc-800 px-1 rounded">{connectorGuide.restartHint}</code>
                  </p>
                  <p>{connectorGuide.blockedHint}</p>
                </div>
              </details>
            </div>
          )}

          {/* Mode selection */}
          <div className="p-4 rounded-xl bg-black/30 border border-white/10">
            <div className="text-xs text-zinc-500 mb-2">Connector mode</div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConnectorModePreference("local")}
                disabled={connectorModeSaving || connectorMode === "local"}
                className={`flex-1 px-4 py-2.5 rounded-lg border text-sm transition-all disabled:opacity-50 ${
                  connectorMode === "local"
                    ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
                    : "bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10"
                }`}
                title="Use the connector running on your computer"
              >
                Local (your computer)
              </button>
              {!edition.selfHosted ? (
                <button
                  type="button"
                  onClick={() => setConnectorModePreference("groovy")}
                  disabled={connectorModeSaving || connectorMode === "groovy"}
                  className={`flex-1 px-4 py-2.5 rounded-lg border text-sm transition-all disabled:opacity-50 ${
                    connectorMode === "groovy"
                      ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
                      : "bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10"
                  }`}
                  title="Use the workspace Groovy Mac connector (shared)"
                >
                  Groovy Mac (workspace)
                </button>
              ) : null}
            </div>
            <div className="text-xs text-zinc-500 mt-3 leading-relaxed">
              {edition.selfHosted
                ? "The connector runs on your computer and connects to this deployment."
                : "Local runs on your computer. Groovy Mac runs on a shared hosted machine for this workspace."}
            </div>
            {connectorModeError && (
              <div className="text-xs text-red-300 mt-2">{connectorModeError}</div>
            )}
          </div>

          <div className="p-4 rounded-xl bg-black/30 border border-white/10">
            <div className="text-xs text-zinc-500 mb-2">Install guide platform</div>
            <div className="flex gap-2">
              {(["auto", "macos", "windows"] as ConnectorPlatformOverride[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPlatformOverridePreference(p)}
                  className={`px-3 py-2 rounded-lg border text-xs transition-all ${
                    platformOverride === p
                      ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
                      : "bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10"
                  }`}
                >
                  {p === "auto" ? "Auto" : p === "macos" ? "macOS" : "Windows"}
                </button>
              ))}
            </div>
            <div className="text-xs text-zinc-500 mt-3 leading-relaxed">
              Detected:{" "}
              <span className="text-zinc-300">
                {detectedPlatform === "unknown"
                  ? "unknown"
                  : detectedPlatform === "macos"
                    ? "macOS"
                    : "Windows"}
              </span>
              {" "}· Using guide:{" "}
              <span className="text-zinc-300">{connectorGuide.title}</span>
            </div>
          </div>

          {connectorMode === "groovy" && hostedMacInfo?.request && (
            <div className="p-4 rounded-xl bg-black/30 border border-white/10">
              <div className="text-xs text-zinc-500">
                Hosted request:{" "}
                <span className="text-zinc-300">{hostedMacInfo.request.status || "unknown"}</span>
                {hostedMacInfo.request.status_detail
                  ? ` · ${hostedMacInfo.request.status_detail}`
                  : ""}
              </div>
            </div>
          )}

          {/* Hosted Groovy Mac: update action */}
          {connectorMode === "groovy" && workspace?.role === "admin" && (
            <div className="p-4 rounded-xl bg-black/30 border border-white/10">
              <div className="text-xs text-zinc-400 mb-2">Groovy Mac management</div>
              <div className="flex gap-2">
                {canSelfUpdateActiveHostedConnector && (
                  <button
                    type="button"
                    onClick={() => onUpdateConnector?.()}
                    className="px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-200 hover:bg-amber-500/15 text-xs transition-all"
                    title="Self-update hosted connector and restart"
                  >
                    Self-update hosted Mac
                  </button>
                )}
                <button
                  type="button"
                  disabled={hostedMacActionLoading === "update"}
                  onClick={() => requestHostedMacAction("update")}
                  className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 text-xs transition-all disabled:opacity-50"
                  title="Request hosted connector update"
                >
                  {hostedMacActionLoading === "update" ? "Requesting…" : "Request update"}
                </button>
              </div>
              {connectorOnline && !isHostedConnectorActive && (
                <div className="text-xs text-zinc-500 mt-2">
                  Hosted connector is not active in this session. You can still request an update.
                </div>
              )}
            </div>
          )}

          {connectorMode === "groovy" && connectorOnline === false && workspace?.role === "admin" && (
            <div className="p-4 rounded-xl bg-white/5 border border-white/10">
              <div className="text-sm text-zinc-200 font-medium">Need help?</div>
              <div className="text-xs text-zinc-500 mt-1">
                This connector runs on your Groovy Mac. There&apos;s nothing to download on your computer.
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={hostedMacActionLoading === "restart"}
                  onClick={() => requestHostedMacAction("restart")}
                  className="px-3 py-1.5 rounded-lg bg-white/5 text-zinc-200 hover:bg-white/10 text-xs disabled:opacity-50"
                >
                  {hostedMacActionLoading === "restart" ? "Requesting…" : "Request restart"}
                </button>
              </div>
            </div>
          )}

          {/* Soft update nag */}
          {connectorOnline &&
            connectorVersion &&
            minConnectorVersion &&
            (connectorMode === "groovy" || connectorDownloadUrl) && (
              (() => {
                const parse = (v: string) => v.split(".").map((n) => Number(n || 0));
                const a = parse(connectorVersion);
                const b = parse(minConnectorVersion);
                let outdated = false;
                for (let i = 0; i < 3; i++) {
                  if ((a[i] || 0) < (b[i] || 0)) {
                    outdated = true;
                    break;
                  }
                  if ((a[i] || 0) > (b[i] || 0)) break;
                }
                if (!outdated) return null;
                return (
                  <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm text-amber-200 font-medium">
                          Update available
                        </div>
                        <div className="text-xs text-zinc-400 mt-1">
                          {connectorMode === "groovy"
                            ? canSelfUpdateActiveHostedConnector
                              ? `You're on v${connectorVersion}. Latest is v${minConnectorVersion}. Use Self-update hosted Mac to install the latest connector.`
                              : `You're on v${connectorVersion}. Latest is v${minConnectorVersion}. Use Request update and we will handle it.`
                            : canSelfUpdateLocalConnector
                              ? `You're on v${connectorVersion}. Latest is v${minConnectorVersion}. Use Update now to install the latest connector, then it will restart itself.`
                              : `You're on v${connectorVersion}. Latest is v${minConnectorVersion}. Download and install it once; future versions can update in place.`}
                        </div>
                      </div>
                      {connectorMode === "groovy" ? (
                        workspace?.role === "admin" ? (
                          canSelfUpdateActiveHostedConnector ? (
                            <button
                              type="button"
                              disabled={hostedMacActionLoading === "update"}
                              onClick={() => onUpdateConnector?.()}
                              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 text-zinc-200 hover:bg-white/10 text-xs transition-all disabled:opacity-50"
                              title="Self-update the Groovy Mac connector now"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                              Self-update hosted Mac
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={hostedMacActionLoading === "update"}
                              onClick={() => requestHostedMacAction("update")}
                              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 text-zinc-200 hover:bg-white/10 text-xs transition-all disabled:opacity-50"
                              title="Request Groovy Mac connector update"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                              Request update
                            </button>
                          )
                        ) : null
                      ) : canSelfUpdateLocalConnector ? (
                        <button
                          type="button"
                          onClick={() => onUpdateConnector?.()}
                          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 text-zinc-200 hover:bg-white/10 text-xs transition-all"
                          title="Update the local connector and restart it"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          Update now
                        </button>
                      ) : (
                        <a
                          href={connectorDownloadUrl || connectorGuide.downloadUrl}
                          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 text-zinc-200 hover:bg-white/10 text-xs transition-all"
                          title={`Download connector v${minConnectorVersion}`}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          Download manually
                        </a>
                      )}
                    </div>
                    <details className="mt-3">
                      <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400">
                        Installation help
                      </summary>
                      {connectorMode === "groovy" ? (
                        <div className="mt-2 text-xs text-zinc-500 space-y-1 pl-3 border-l border-zinc-700">
                          <p>Hosted mode: no DMG download needed (this connector runs on Groovy Mac).</p>
                          <p>
                            {canSelfUpdateActiveHostedConnector
                              ? 'Use "Self-update hosted Mac" to update and restart it.'
                              : 'Click "Request update" and we will redeploy it.'}
                          </p>
                          <p>If you want to update your own machine, switch to Local and use Download.</p>
                        </div>
                      ) : (
                        <div className="mt-2 text-xs text-zinc-500 space-y-1 pl-3 border-l border-zinc-700">
                          <p>
                            {canSelfUpdateLocalConnector
                              ? "Local mode can update in place while the connector is online. Use manual download only if needed."
                              : "This installed connector is too old to self-update. Install the latest connector manually once; future updates can run in place."}
                          </p>
                          {connectorGuide.installSteps.map((stepText, idx) => (
                            <p key={`${connectorGuide.platform}-${idx}`}>{idx + 1}. {stepText}</p>
                          ))}
                          <p>
                            Restart with:{" "}
                            <code className="bg-zinc-800 px-1 rounded">{connectorGuide.restartHint}</code>
                          </p>
                          <p>{connectorGuide.blockedHint}</p>
                        </div>
                      )}
                    </details>
                  </div>
                );
              })()
            )}
        </div>
      )}
    </div>
  );

  const renderAccountSection = () => {
    const email = typeof currentUserEmail === "string" && currentUserEmail.trim()
      ? currentUserEmail.trim()
      : null;
    const initial = email ? email.charAt(0).toUpperCase() : "G";

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-medium text-white mb-1">Account</h3>
          <p className="text-sm text-zinc-500">Manage your signed-in Groovy account.</p>
        </div>

        <div className="p-4 rounded-xl bg-black/30 border border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-500 to-violet-500 flex items-center justify-center text-sm font-bold text-white uppercase shrink-0">
              {initial}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-white truncate">
                {email || "Groovy account"}
              </div>
              <div className="text-xs text-zinc-500">Signed in</div>
            </div>
          </div>

          {onSignOut && (
            <button
              type="button"
              onClick={() => void onSignOut()}
              className="mt-4 w-full px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 hover:bg-red-500/15 hover:text-red-200 transition-all text-sm flex items-center justify-center gap-2"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderAiyraVoiceSection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white mb-1">Aiyra Voice</h3>
        <p className="text-sm text-zinc-500">
          Native wake-word runtime configuration and Aiyra account settings.
        </p>
      </div>

      <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
        <div
          className={`rounded-xl border px-3 py-2.5 flex items-center gap-3 ${
            connectorAiyraActiveUi
              ? "border-emerald-400/40 bg-emerald-500/10"
              : connectorAiyraListeningUi
                ? "border-cyan-400/35 bg-cyan-500/10"
                : "border-white/10 bg-black/20"
          }`}
        >
          <div className="relative h-9 w-9 shrink-0">
            {(connectorAiyraActiveUi || connectorAiyraListeningUi) && (
              <motion.span
                className={`absolute inset-0 rounded-full ${
                  connectorAiyraActiveUi ? "bg-emerald-400/40" : "bg-cyan-400/35"
                }`}
                animate={{ scale: [1, 1.6], opacity: [0.7, 0] }}
                transition={{ duration: 1.1, repeat: Infinity, ease: "easeOut" }}
              />
            )}
            <div
              className={`relative h-9 w-9 rounded-full border flex items-center justify-center ${
                connectorAiyraLowMicGain
                  ? "border-amber-300/60 bg-amber-500/15"
                  : connectorAiyraActiveUi
                  ? "border-emerald-300/60 bg-emerald-500/15"
                  : connectorAiyraListeningUi
                    ? "border-cyan-300/60 bg-cyan-500/15"
                    : "border-white/15 bg-black/40"
              }`}
            >
              {connectorAiyraLowMicGain ? (
                <AlertTriangle className="w-4 h-4 text-amber-300" />
              ) : (
                <Mic
                  className={`w-4 h-4 ${
                    connectorAiyraActiveUi
                      ? "text-emerald-300"
                      : connectorAiyraListeningUi
                        ? "text-cyan-300"
                        : "text-zinc-500"
                  }`}
                />
              )}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-xs text-zinc-200">
              {connectorAiyraLowMicGain
                ? "Mic gain too low"
                : connectorAiyraActiveUi
                ? "Mic live now"
                : connectorAiyraListeningUi
                  ? `Listening for "${connectorAiyraVoiceHealth?.wake_word || "hey groovy"}"`
                  : "Mic idle"}
            </div>
            <div className="text-[11px] text-zinc-500">
              {connectorAiyraLowMicGain
                ? connectorAiyraLowMicGainMessage
                : connectorAiyraActiveUi
                ? "Wake phrase detected. Aiyra voice session is open."
                : connectorAiyraListeningUi
                  ? "Say the wake phrase to activate instantly."
                  : "Enable runtime and save to start listening."}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="text-sm text-zinc-300">Connector runtime status</div>
          <div className="text-xs text-zinc-500">
            {connectorAiyraLowMicGain
              ? "warning"
              : connectorAiyraVoiceHealth?.status || "unknown"}
          </div>
        </div>
        <div className="text-xs text-zinc-500">
          {connectorAiyraLowMicGain
            ? `${connectorAiyraLowMicGainMessage}${
                connectorAiyraLowMicGainDetails
                  ? ` ${connectorAiyraLowMicGainDetails}`
                  : ""
              }`
            : connectorAiyraIssue
            ? connectorAiyraVoiceHealth?.detail ||
              connectorAiyraVoiceHealth?.reason ||
              "Aiyra runtime is degraded."
            : connectorAiyraVoiceHealth?.detail ||
              (connectorAiyraVoiceHealth?.listening
                ? "Listening for wake phrase."
                : "Not listening yet.")}
        </div>
        <div className="text-xs text-zinc-600">
          {connectorAiyraLowMicGain
            ? "Increase input volume, move closer, or choose another microphone."
            : connectorAiyraVoiceHealth?.active
            ? "Voice session active now."
            : connectorAiyraVoiceHealth?.listening
              ? "Wake-word detector is active."
              : "Wake-word detector is idle."}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
          <div className="rounded-lg bg-black/30 border border-white/5 px-2.5 py-2">
            <div className="text-[10px] text-zinc-500">Wake hits</div>
            <div className="text-xs text-zinc-300">
              {Number(connectorAiyraVoiceHealth?.wake_hits || 0)}
            </div>
          </div>
          <div className="rounded-lg bg-black/30 border border-white/5 px-2.5 py-2">
            <div className="text-[10px] text-zinc-500">Suppressed</div>
            <div className="text-xs text-zinc-300">
              {Number(connectorAiyraVoiceHealth?.wake_suppressed || 0)}
            </div>
          </div>
          <div className="rounded-lg bg-black/30 border border-white/5 px-2.5 py-2">
            <div className="text-[10px] text-zinc-500">Sessions</div>
            <div className="text-xs text-zinc-300">
              {Number(connectorAiyraVoiceHealth?.session_count || 0)}
            </div>
          </div>
          <div className="rounded-lg bg-black/30 border border-white/5 px-2.5 py-2">
            <div className="text-[10px] text-zinc-500">Session errors</div>
            <div className="text-xs text-zinc-300">
              {Number(connectorAiyraVoiceHealth?.session_error_count || 0)}
            </div>
          </div>
        </div>
        <div className="text-[11px] text-zinc-600">
          Last metric: {connectorAiyraVoiceHealth?.last_metric_event || "none"}
          {connectorAiyraVoiceHealth?.last_metric_at
            ? ` · ${new Date(connectorAiyraVoiceHealth.last_metric_at).toLocaleTimeString()}`
            : ""}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            disabled={!onReportAiyraVoiceEvent || aiyraReportLoading !== null}
            onClick={() => handleReportAiyraVoiceEvent("missed_wake")}
            className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 text-xs transition-all disabled:opacity-50"
          >
            {aiyraReportLoading === "missed_wake" ? "Reporting…" : "Report missed wake"}
          </button>
          <button
            type="button"
            disabled={!onReportAiyraVoiceEvent || aiyraReportLoading !== null}
            onClick={() => handleReportAiyraVoiceEvent("false_trigger")}
            className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 text-xs transition-all disabled:opacity-50"
          >
            {aiyraReportLoading === "false_trigger" ? "Reporting…" : "Report false trigger"}
          </button>
        </div>
      </div>

      <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-4">
        <label className="flex items-center justify-between text-sm text-zinc-300">
          <span>Enable Aiyra wake-word runtime</span>
          <input
            type="checkbox"
            checked={aiyraEnabled}
            onChange={(e) => setAiyraEnabled(e.target.checked)}
            className="h-4 w-4 accent-cyan-500"
          />
        </label>

        <div className="space-y-2">
          <div className="text-xs text-zinc-500">Aiyra API key</div>
          <div className="relative">
            <input
              type={showAiyraApiKey ? "text" : "password"}
              value={aiyraApiKey}
              onChange={(e) => {
                const nextApiKey = e.target.value;
                setAiyraApiKey(nextApiKey);
                if (nextApiKey.trim()) {
                  setAiyraEnabled(true);
                  if (aiyraClearApiKey) {
                    setAiyraClearApiKey(false);
                  }
                }
              }}
              placeholder={aiyraConfig?.configured ? "Configured. Paste new key to rotate..." : "Paste your Aiyra key"}
              className="w-full px-3 py-2.5 pr-10 rounded-lg bg-black/40 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-cyan-500/50 transition-colors font-mono text-sm"
            />
            <button
              type="button"
              onClick={() => setShowAiyraApiKey((prev) => !prev)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
            >
              {showAiyraApiKey ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-500">
            <input
              type="checkbox"
              checked={aiyraClearApiKey}
              onChange={(e) => setAiyraClearApiKey(e.target.checked)}
              className="h-3.5 w-3.5 accent-cyan-500"
            />
            Clear stored key
          </label>
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={handleLoadStoredAiyraConfig}
              disabled={aiyraSaving || !onLoadAiyraConfig || !aiyraApiKey.trim()}
              className="px-3.5 py-2 rounded-lg bg-cyan-500 text-black font-medium text-xs hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
            >
              {aiyraSaving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Loading...
                </>
              ) : (
                <>
                  <RotateCw className="w-3.5 h-3.5" />
                  Load stored config
                </>
              )}
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs text-zinc-500">Persona prompt</div>
          <textarea
            value={aiyraPersonaPrompt}
            onChange={(e) => setAiyraPersonaPrompt(e.target.value)}
            placeholder="You are Groovy..."
            rows={4}
            className="w-full px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-cyan-500/50 transition-colors text-sm resize-y"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="space-y-1">
            <div className="text-xs text-zinc-500">Voice ID</div>
            <input
              value={aiyraVoiceId}
              onChange={(e) => setAiyraVoiceId(e.target.value)}
              placeholder="alloy"
              className="w-full px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-cyan-500/50 transition-colors text-sm"
            />
          </label>
          <label className="space-y-1">
            <div className="text-xs text-zinc-500">Voice speed</div>
            <input
              type="number"
              min={0.5}
              max={2}
              step={0.01}
              value={aiyraTtsSpeed}
              onChange={(e) => setAiyraTtsSpeed(e.target.value)}
              placeholder="1.03"
              className="w-full px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-cyan-500/50 transition-colors text-sm"
            />
          </label>
          <label className="space-y-1">
            <div className="text-xs text-zinc-500">Wake phrase</div>
            <input
              value={aiyraWakeWord}
              onChange={(e) => setAiyraWakeWord(e.target.value)}
              placeholder="hey groovy"
              className="w-full px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-cyan-500/50 transition-colors text-sm"
            />
          </label>
        </div>

        <div className="text-[11px] text-zinc-600">
          Voice speed applies to ElevenLabs only. Leave it blank for the default `1.03`; `1.08`
          is a good normal-speed setting.
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1">
            <div className="text-xs text-zinc-500">
              Wake sensitivity ({aiyraWakeSensitivity.toFixed(2)})
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={aiyraWakeSensitivity}
              onChange={(e) => setAiyraWakeSensitivity(Number(e.target.value))}
              className="w-full accent-cyan-500"
            />
            <div className="text-[11px] text-zinc-600">
              Used by Porcupine only. OpenWakeWord uses the threshold slider below.
            </div>
          </label>
          <label className="space-y-1">
            <div className="text-xs text-zinc-500">
              OpenWakeWord threshold ({aiyraOpenWakewordThreshold.toFixed(2)})
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={aiyraOpenWakewordThreshold}
              onChange={(e) => {
                setAiyraOpenWakewordThreshold(Number(e.target.value));
                setAiyraOpenWakewordThresholdTouched(true);
              }}
              className="w-full accent-cyan-500"
            />
            <div className="text-[11px] text-zinc-600">
              Lower = easier trigger, higher = stricter.
            </div>
          </label>
          <label className="space-y-1">
            <div className="text-xs text-zinc-500">Idle timeout (ms)</div>
            <input
              type="number"
              min={2000}
              max={120000}
              step={500}
              value={aiyraIdleTimeoutMs}
              onChange={(e) => setAiyraIdleTimeoutMs(Number(e.target.value))}
              className="w-full px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-cyan-500/50 transition-colors text-sm"
            />
          </label>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/20 p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm text-zinc-300">Twilio supervision</div>
              <div className="text-xs text-zinc-500">
                Lets Aiyra start supervised outbound calls and SMS threads.
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-zinc-300 select-none">
              <input
                type="checkbox"
                checked={aiyraTwilioEnabled}
                onChange={(e) => setAiyraTwilioEnabled(e.target.checked)}
                className="h-4 w-4 accent-cyan-500"
              />
              Enabled
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="space-y-1">
              <div className="text-xs text-zinc-500">Default From number</div>
              <input
                value={aiyraTwilioFrom}
                onChange={(e) => setAiyraTwilioFrom(e.target.value)}
                placeholder="+15551234567"
                className="w-full px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-cyan-500/50 transition-colors text-sm"
              />
            </label>
            <label className="space-y-1">
              <div className="text-xs text-zinc-500">Default To number</div>
              <input
                value={aiyraTwilioTo}
                onChange={(e) => setAiyraTwilioTo(e.target.value)}
                placeholder="Leave blank for dynamic per-turn To"
                className="w-full px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-cyan-500/50 transition-colors text-sm"
              />
            </label>
          </div>

          <div className="text-[11px] text-zinc-600">
            Leave the default `To` blank if you want the agent to resolve or choose the destination each turn.
          </div>

          {connectorAiyraVoiceHealth?.twilio_supervisor_state ? (
            <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-1">
              <div className="text-[11px] text-zinc-500">Latest supervised thread</div>
              <div className="text-sm text-zinc-300">
                {connectorAiyraVoiceHealth.twilio_supervisor_state.summary ||
                  connectorAiyraVoiceHealth.twilio_supervisor_state.rawText ||
                  "Supervisor update received."}
              </div>
              <div className="text-[11px] text-zinc-500">
                {[
                  connectorAiyraVoiceHealth.twilio_supervisor_state.childKind
                    ? String(
                        connectorAiyraVoiceHealth.twilio_supervisor_state.childKind
                      ).toUpperCase()
                    : null,
                  connectorAiyraVoiceHealth.twilio_supervisor_state.status || null,
                  connectorAiyraVoiceHealth.twilio_supervisor_state.stage || null,
                  connectorAiyraVoiceHealth.twilio_supervisor_state.messageSid
                    ? `message ${connectorAiyraVoiceHealth.twilio_supervisor_state.messageSid}`
                    : connectorAiyraVoiceHealth.twilio_supervisor_state.callSid
                      ? `call ${connectorAiyraVoiceHealth.twilio_supervisor_state.callSid}`
                      : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs text-zinc-500">Microphone</div>
            <button
              type="button"
              onClick={loadAiyraAudioDevices}
              disabled={aiyraDevicesLoading}
              className="text-[10px] text-cyan-500 hover:text-cyan-400 disabled:opacity-50"
            >
              {aiyraDevicesLoading ? "Loading..." : "Refresh"}
            </button>
          </div>
          <CustomSelect
            value={selectedAiyraMicValue}
            onChange={(value) => {
              if (value === "computer_default") {
                setAiyraMicMode("computer_default");
                setAiyraMicName("");
                setAiyraResolvedMicName("");
                return;
              }
              if (value === "system_default") {
                setAiyraMicMode("system_default");
                setAiyraMicName("");
                setAiyraResolvedMicName("");
                return;
              }
              if (value.startsWith("specific:")) {
                const nextMicName = decodeURIComponent(value.slice("specific:".length));
                setAiyraMicMode("specific");
                setAiyraMicName(nextMicName);
                setAiyraResolvedMicName(nextMicName);
              }
            }}
            options={[
              {
                value: "computer_default",
                label: "Computer microphone (recommended)",
              },
              { value: "system_default", label: "System default" },
              ...(aiyraMicMode === "specific" &&
              aiyraMicName &&
              !selectedSpecificMicAvailable
                ? [
                    {
                      value: `specific:${encodeURIComponent(aiyraMicName)}`,
                      label: `${aiyraMicName} (currently unavailable)`,
                    },
                  ]
                : []),
              ...aiyraAudioDevices.map((device) => ({
                value: `specific:${encodeURIComponent(device.name)}`,
                label: `Use ${device.name}`,
              })),
            ]}
            ariaLabel="Microphone"
          />
          <div className="text-[11px] text-zinc-600">{aiyraMicStatusText}</div>
          {aiyraAudioDevices.length === 0 && !aiyraDevicesLoading && (
            <div className="text-[11px] text-zinc-600">
              Connect your connector to see available microphones.
            </div>
          )}
          {!!aiyraAudioDeviceDebugLog?.length && (
            <details className="rounded-lg border border-white/10 bg-black/20 p-2">
              <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300">
                Microphone diagnostics ({aiyraAudioDeviceDebugLog.length})
              </summary>
              <div className="mt-2 max-h-40 overflow-auto rounded bg-black/50 p-2 font-mono text-[10px] leading-4 text-zinc-300">
                {aiyraAudioDeviceDebugLog.map((line, idx) => (
                  <div key={`${idx}-${line}`}>{line}</div>
                ))}
              </div>
            </details>
          )}
        </div>

        <details className="rounded-lg border border-white/10 bg-black/20 p-3">
          <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-300">
            Advanced: custom wake-word model path (.ppn)
          </summary>
          <div className="mt-2 space-y-1">
            <input
              value={aiyraKeywordPath}
              onChange={(e) => setAiyraKeywordPath(e.target.value)}
              placeholder="/absolute/path/to/custom-model.ppn"
              className="w-full px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-cyan-500/50 transition-colors text-sm"
            />
            <div className="text-[11px] text-zinc-600">
              Optional override. Most users should leave this empty.
            </div>
          </div>
        </details>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSaveAiyraVoice}
          disabled={aiyraSaving || !onSaveAiyraConfig}
          className="px-5 py-2.5 rounded-xl bg-cyan-500 text-black font-medium text-sm hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
        >
          {aiyraSaving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              Save
            </>
          )}
        </button>
      </div>
    </div>
  );

  const renderApiKeysSection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white mb-1">API Keys</h3>
        <p className="text-sm text-zinc-500">
          {serverProviderKeysAllowed
            ? "Choose your key source per provider. This self-hosted deployment explicitly allows server environment keys."
            : "Hosted Groovy uses your provider accounts directly. Add an Anthropic or OpenAI key for the orchestrator; other providers are optional. CLI agents may use their authenticated local login."} Keys are encrypted with AES-256-GCM.
        </p>
      </div>

      <div className="space-y-3">
        {PROVIDER_ORDER.map((provider) => {
          const info = PROVIDER_INFO[provider];
          const providerMode = perProviderModes[provider] || keyMode;
          const isUser = providerMode === "user";
          const isConfigured = currentKeys[provider]?.configured;
          const managedModeLabel = providerManagedModeLabel(provider);
          const userModeLabel = providerUserModeLabel(provider);
          return (
            <div key={provider} className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium text-zinc-300">{info.name}</label>
                  {isConfigured && isUser && (
                    <span className="text-xs text-emerald-400 flex items-center gap-1">
                      <Check className="w-3 h-3" />
                      Configured
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {(serverProviderKeysAllowed || provider === "claude_cli" || provider === "codex_cli") && <button
                    type="button"
                    onClick={() => setPerProviderModes((prev) => ({ ...prev, [provider]: "groovy" }))}
                    className={`px-3 py-1.5 rounded-lg text-xs border transition-all ${
                      !isUser
                        ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-300"
                        : "bg-white/5 border-white/10 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {managedModeLabel}
                  </button>}
                  <button
                    type="button"
                    onClick={() => setPerProviderModes((prev) => ({ ...prev, [provider]: "user" }))}
                    className={`px-3 py-1.5 rounded-lg text-xs border transition-all ${
                      isUser
                        ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-300"
                        : "bg-white/5 border-white/10 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {userModeLabel}
                  </button>
                </div>
              </div>
              {info.description && (
                <p className="text-xs text-zinc-600 leading-relaxed">{info.description}</p>
              )}
              {isUser && (
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showKeys[provider] ? "text" : "password"}
                      value={keys[provider] || ""}
                      onChange={(e) => setKeys((prev) => ({ ...prev, [provider]: e.target.value }))}
                      placeholder={isConfigured ? "Enter new key to replace..." : info.placeholder}
                      className="w-full px-3 py-2.5 pr-9 rounded-lg bg-black/30 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-cyan-500/50 transition-colors font-mono text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKeys((prev) => ({ ...prev, [provider]: !prev[provider] }))}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      {showKeys[provider] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <a
                    href={info.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1 transition-colors shrink-0"
                  >
                    Get key
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Save button for API keys */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          onClick={handleSave}
          disabled={saving || (!hasKeyInput && !modesChanged)}
          className="px-5 py-2.5 rounded-xl bg-cyan-500 text-black font-medium text-sm hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
        >
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              Save
            </>
          )}
        </button>
      </div>
    </div>
  );

  const renderTeamSection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white mb-1">Team</h3>
        <p className="text-sm text-zinc-500">Manage your workspace, members, and invites.</p>
      </div>

      {workspaceLoading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500 p-4">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading workspace…
        </div>
      ) : workspace ? (
        <div className="space-y-4">
          {/* Workspace info */}
          <div className="p-4 rounded-xl bg-black/30 border border-white/10">
            <div className="text-xs text-zinc-500 mb-1">Workspace</div>
            <div className="text-base text-white font-medium">{workspace.name}</div>
            <div className="text-sm text-zinc-500 mt-1">
              You are{" "}
              <span className="text-zinc-300">{workspace.role}</span>
              {" · "}Plan owned by{" "}
              <span className="text-zinc-300">
                {workspace.members.find((m) => m.role === "admin")?.email || "admin"}
              </span>
            </div>
          </div>

          {/* Auto-run team requests */}
          {typeof autoRunTeamRequests === "boolean" && onSetAutoRunTeamRequests && (
            <div className="p-4 rounded-xl bg-black/30 border border-white/10 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm text-zinc-300">Team requests</div>
                <div className="text-xs text-zinc-500 mt-1">
                  Auto-run requests when someone @mentions you in a shared chat.
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-zinc-300 select-none">
                <input
                  type="checkbox"
                  checked={autoRunTeamRequests}
                  onChange={(e) => onSetAutoRunTeamRequests(e.target.checked)}
                  className="accent-cyan-400"
                />
                Auto-run
              </label>
            </div>
          )}

          {/* Members */}
          <div className="p-4 rounded-xl bg-black/30 border border-white/10">
            <div className="text-xs text-zinc-500 mb-3">Members</div>
            <div className="space-y-2">
              {workspace.members.length === 0 && (
                <div className="text-sm text-zinc-600">No members yet</div>
              )}
              {workspace.members.map((m) => (
                <div key={`${m.user_id}-${m.role}`} className="flex items-center justify-between py-1">
                  <span className="text-sm text-zinc-300">{m.email || m.user_id.slice(0, 8)}</span>
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full border border-white/10 text-xs text-zinc-400">
                      {m.role}
                    </span>
                    {workspace.role === "admin" && m.role === "member" && (
                      <button
                        type="button"
                        onClick={() => removeWorkspaceMember(m.user_id)}
                        disabled={teamActionLoading === `remove:${m.user_id}`}
                        className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-zinc-200 hover:bg-white/10 text-xs disabled:opacity-50 inline-flex items-center gap-1"
                        title="Remove member from workspace"
                      >
                        <UserMinus className="w-3 h-3" />
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Invite */}
          {workspace.role === "admin" && (
            <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
              <div className="text-xs text-zinc-500">Invite a member</div>
              <div className="flex gap-2">
                <input
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="email@company.com"
                  className="flex-1 px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/50 transition-colors"
                />
                <button
                  type="button"
                  onClick={handleInvite}
                  disabled={inviting || !inviteEmail.trim()}
                  className="px-4 py-2.5 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 text-sm disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <MailPlus className="w-3.5 h-3.5" />
                  Invite
                </button>
              </div>
              {inviteError && <div className="text-sm text-red-300">{inviteError}</div>}
              {invites.length > 0 && (
                <div className="text-xs text-zinc-500 space-y-2">
                  <div>Pending invites: {invites.length}</div>
                  {invites.slice(0, 5).map((inv) => (
                    <div key={inv.id} className="flex items-center justify-between gap-2 py-1">
                      <div className="min-w-0">
                        <div className="text-sm text-zinc-300 truncate">{inv.email}</div>
                        <div className="text-xs text-zinc-600 truncate">
                          {(typeof window !== "undefined" ? window.location.origin : "") +
                            `/invite/${inv.token}`}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          const link =
                            (typeof window !== "undefined" ? window.location.origin : "") +
                            `/invite/${inv.token}`;
                          await copyText(link);
                        }}
                        className="shrink-0 px-2 py-1 rounded-md bg-white/5 border border-white/10 text-zinc-200 hover:bg-white/10 text-xs inline-flex items-center gap-1"
                        title="Copy invite link"
                      >
                        <Copy className="w-3 h-3" />
                        Copy
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Leave workspace */}
          <div className="p-4 rounded-xl bg-black/30 border border-white/10">
            <div className="text-sm text-zinc-400">Leave workspace</div>
            <div className="text-xs text-zinc-500 mt-1">
              This will remove your access to this team. You&apos;ll get a new personal workspace automatically.
            </div>
            {teamActionError && <div className="text-xs text-red-300 mt-2">{teamActionError}</div>}
            <button
              type="button"
              onClick={leaveWorkspace}
              disabled={teamActionLoading === "leave"}
              className="mt-3 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-200 hover:bg-red-500/15 text-sm disabled:opacity-50 inline-flex items-center gap-2"
              title="Leave this workspace"
            >
              {teamActionLoading === "leave" ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LogOut className="w-4 h-4" />
              )}
              Leave workspace
            </button>
            {workspace.role === "admin" && (
              <div className="text-xs text-zinc-500 mt-2">
                If you&apos;re the last admin, you can&apos;t leave until another admin exists.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="text-sm text-zinc-500 p-4">Workspace not available.</div>
      )}
    </div>
  );

  const renderUsageSection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white mb-1">Usage</h3>
        <p className="text-sm text-zinc-500">Token and tool usage across your workspace.</p>
      </div>
      <UsageDashboardContent />
    </div>
  );

  const renderBillingSection = () => {
    const cardOnFile = !!billingStatus?.cardOnFile;
    const canManageBilling = billingStatus?.role === "admin";
    const initialCompleted = !!billingStatus?.policy.initialTopupCompleted;
    const autoTopupEnabled = billingStatus?.policy.autoTopupEnabled !== false;
    const monthlyLimitUsd = billingStatus?.policy.monthlyLimitUsd ?? null;
    const monthSpendUsd = billingStatus?.policy.monthSpendUsd ?? 0;
    const monthlyLimitActive =
      typeof monthlyLimitUsd === "number" &&
      Number.isFinite(monthlyLimitUsd) &&
      monthlyLimitUsd > 0;
    const limitReached =
      typeof monthlyLimitUsd === "number" &&
      Number.isFinite(monthlyLimitUsd) &&
      monthSpendUsd >= monthlyLimitUsd;
    const tokenBillingEnabled = billingStatus?.pricing?.tokenConsumptionBillingEnabled === true;

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-medium text-white mb-1">Billing</h3>
          <p className="text-sm text-zinc-500">
            {billingStatus?.pricing?.explanation ||
              "Groovy does not charge a percentage over token usage by default. Connect your own model provider keys."}
          </p>
          {billingStatus?.pricing?.addonsExplanation ? (
            <p className="text-xs text-zinc-500 mt-1">
              {billingStatus.pricing.addonsExplanation}
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <div className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-cyan-400/15 text-cyan-200">
                <CreditCard className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm font-medium text-white">Personal license and Stripe billing</div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                  Buy Groovy Personal, see your license key, manage activated devices, open invoices,
                  or cancel renewal from the account portal. Company use still goes through enterprise sales.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={openPersonalBillingPortal}
                disabled={billingActionLoading === "personal_portal"}
                className="inline-flex items-center gap-2 rounded-lg bg-cyan-400 px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-cyan-300"
              >
                {billingActionLoading === "personal_portal" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Manage or cancel
              </button>
              <a
                href="/account/license"
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-white/10"
              >
                Account portal
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        </div>

        {billingLoading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500 p-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading billing status...
          </div>
        ) : null}

        {billingError ? (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-300">
            {billingError}
          </div>
        ) : null}

        {billingStatus ? (
          <>
            <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
              <div className="text-xs text-zinc-500">
                {tokenBillingEnabled ? "Usage billing balance" : "Token usage analytics"}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="text-[11px] text-zinc-500">Free credit</div>
                  <div className="text-lg text-white font-medium">
                    {formatUsd(billingStatus.balances.freeCreditUsdRemaining)}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="text-[11px] text-zinc-500">Paid balance</div>
                  <div className="text-lg text-white font-medium">
                    {formatUsd(billingStatus.balances.paidCreditUsdBalance)}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="text-[11px] text-zinc-500">Available total</div>
                  <div className="text-lg text-white font-medium">
                    {formatUsd(billingStatus.balances.availableBalanceUsd)}
                  </div>
                </div>
              </div>
              <div className="text-xs text-zinc-500">
                Monthly spend: <span className="text-zinc-300">{formatUsd(monthSpendUsd)}</span>
                {typeof monthlyLimitUsd === "number" ? (
                  <>
                    {" "}
                    / Limit: <span className="text-zinc-300">{formatUsd(monthlyLimitUsd)}</span>
                  </>
                ) : (
                  <> / Limit: <span className="text-zinc-300">No limit</span></>
                )}
              </div>
              {limitReached ? (
                <div className="text-xs text-amber-300">
                  Monthly limit reached. Paid usage is blocked until your next monthly reset or limit increase.
                </div>
              ) : null}
              {tokenBillingEnabled ? (
                <div className="rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-zinc-500 space-y-1">
                  <div>
                    <span className="text-zinc-300">Authorized reseller billing:</span> token-consumption billing is enabled for this workspace.
                  </div>
                  <div>
                    <span className="text-zinc-300">Provider charges:</span> reseller usage can be exported separately from Groovy license billing.
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-100">
                  Token-consumption billing is disabled. Connect your own provider keys; usage here is informational unless an enterprise reseller license explicitly enables billing.
                </div>
              )}
            </div>

            {billingStatus.addons ? (
              <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
                <div className="text-sm text-zinc-300">Recurring addons (subscriptions)</div>
                <div className="text-xs text-zinc-500">
                  Estimated recurring monthly:{" "}
                  <span className="text-zinc-300">
                    {formatUsd(billingStatus.addons.recurringMonthlyUsd || 0)}
                  </span>
                </div>
                <div className="text-[11px] text-zinc-600">
                  Addon subscriptions are separate from wallet auto top-up.
                </div>
                <div className="text-xs text-zinc-500 space-y-1">
                  <div>
                    Groovy Mac:{" "}
                    {billingStatus.addons.groovyMac?.enabled ? (
                      <>
                        <span className="text-zinc-300">
                          {billingStatus.addons.groovyMac?.billedSeats || 0}
                        </span>{" "}
                        seats ×{" "}
                        <span className="text-zinc-300">
                          {formatUsd(billingStatus.addons.groovyMac?.unitPriceUsd || 0)}
                        </span>
                      </>
                    ) : (
                      <span className="text-zinc-400">disabled</span>
                    )}
                  </div>
                  <div>
                    Kapso allowlist:{" "}
                    {billingStatus.addons.kapsoAllowlist?.enabled ? (
                      <>
                        <span className="text-zinc-300">
                          {billingStatus.addons.kapsoAllowlist?.allowlistedUsers || 0}
                        </span>{" "}
                        users ×{" "}
                        <span className="text-zinc-300">
                          {formatUsd(billingStatus.addons.kapsoAllowlist?.unitPriceUsd || 0)}
                        </span>
                      </>
                    ) : (
                      <span className="text-zinc-400">disabled</span>
                    )}
                  </div>
                </div>
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={reconcileAddonBilling}
                    disabled={
                      billingActionLoading === "reconcile_addons" || !canManageBilling
                    }
                    className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-zinc-200 text-xs disabled:opacity-50 inline-flex items-center gap-2"
                  >
                    {billingActionLoading === "reconcile_addons" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : null}
                    Resync addon billing
                  </button>
                  <div className="text-[11px] text-zinc-600 mt-1">
                    Recalculates member/allowlist quantities and pushes them to Stripe now.
                  </div>
                </div>
              </div>
            ) : null}

            <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
              <div className="text-sm text-zinc-300">Payment method</div>
              <div className="text-xs text-zinc-500">
                {cardOnFile
                  ? billingStatus?.cardLast4
                    ? `${(billingStatus.cardBrand || "Card").replace(/^./, (c) => c.toUpperCase())} •••• ${billingStatus.cardLast4}`
                    : "Card on file"
                  : tokenBillingEnabled
                    ? "No card on file. Add a card to enable reseller usage billing."
                    : "No card required for token usage. Personal license billing is managed through Stripe Checkout and the account portal."}
              </div>
              {!showCardSetup ? (
                <button
                  type="button"
                  onClick={startCardSetup}
                  disabled={billingActionLoading === "setup_card" || !canManageBilling}
                  className="px-4 py-2 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 text-sm disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {billingActionLoading === "setup_card" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : null}
                  {cardOnFile ? "Replace card" : "Add card"}
                </button>
              ) : null}
              {showCardSetup && stripeSetupClientSecret && stripePublishableKey ? (
                <BillingCardSetupForm
                  clientSecret={stripeSetupClientSecret}
                  publishableKey={stripePublishableKey}
                  onError={(message) => setBillingError(message || null)}
                  onSuccess={async () => {
                    setShowCardSetup(false);
                    setStripeSetupClientSecret(null);
                    setStripePublishableKey(null);
                    setSuccessMessage("Payment method saved.");
                    setSuccess(true);
                    setTimeout(() => setSuccess(false), 1800);
                    await refreshBillingStatus();
                  }}
                  onCancel={() => {
                    setShowCardSetup(false);
                    setStripeSetupClientSecret(null);
                    setStripePublishableKey(null);
                  }}
                />
              ) : null}
            </div>

            <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
              <div className="text-sm text-zinc-300">Top-up, auto-refill, and limits</div>
              <div className="text-xs text-zinc-500">
                Wallet funds are purchased through Stripe in <span className="text-zinc-300">$10.00</span> invoices.
                {tokenBillingEnabled
                  ? " They cover authorized reseller token-consumption billing."
                  : " Wallet top-ups are disabled for normal personal and enterprise licenses."}
              </div>
              <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs text-zinc-500">Automatic wallet top-up</div>
                    <div
                      className={`text-sm font-medium ${
                        autoTopupEnabled ? "text-emerald-200" : "text-zinc-300"
                      }`}
                    >
                      {autoTopupEnabled ? "Enabled" : "Disabled"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => saveAutoTopupEnabled(!autoTopupEnabled)}
                    disabled={billingActionLoading === "save_auto_topup" || !canManageBilling || !tokenBillingEnabled}
                    className={`px-3 py-2 rounded-lg border text-xs disabled:opacity-50 inline-flex items-center gap-2 ${
                      autoTopupEnabled
                        ? "bg-emerald-500/20 border-emerald-500/30 text-emerald-200"
                        : "bg-white/5 border-white/10 text-zinc-200"
                    }`}
                  >
                    {billingActionLoading === "save_auto_topup" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : null}
                    {autoTopupEnabled ? "Disable" : "Enable"}
                  </button>
                </div>
                <div className="text-[11px] text-zinc-600">
                  {tokenBillingEnabled
                    ? "When enabled, Groovy refills automatically right after a debit if wallet balance is low."
                    : "Automatic wallet top-up is available only for authorized reseller billing."}
                </div>
                {monthlyLimitActive ? (
                  <div className="text-[11px] text-amber-300">
                    Monthly limit is set, so automatic top-up is currently suppressed.
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                onClick={handleTopup}
                disabled={billingActionLoading === "topup" || topupSuccess || !cardOnFile || !canManageBilling || !tokenBillingEnabled}
                className={`px-4 py-2 rounded-lg border text-sm disabled:opacity-50 inline-flex items-center gap-2 transition-colors ${
                  topupSuccess
                    ? "bg-emerald-500/20 border-emerald-500/30 text-emerald-200"
                    : "bg-white/5 border-white/10 text-zinc-200"
                }`}
              >
                {billingActionLoading === "topup" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : topupSuccess ? (
                  <Check className="w-4 h-4" />
                ) : null}
                {topupSuccess
                  ? "Payment successful"
                  : initialCompleted
                    ? "Add $10 funds"
                    : "Initial $10 purchase"}
              </button>
              {topupSuccess ? (
                <div className="text-[11px] text-zinc-500">
                  Charge will appear as <span className="text-zinc-400">The Wolfpack</span>. Parent company of Groovy.
                </div>
              ) : !tokenBillingEnabled ? (
                <div className="text-xs text-emerald-300">Token billing top-ups are disabled for this license.</div>
              ) : !cardOnFile ? (
                <div className="text-xs text-amber-300">Add a card first to purchase funds.</div>
              ) : null}

              <div className="pt-2 space-y-2">
                <div className="text-xs text-zinc-500">Monthly spending limit (USD)</div>
                <div className="flex gap-2">
                  <input
                    value={monthlyLimitInput}
                    onChange={(e) => setMonthlyLimitInput(e.target.value)}
                    placeholder="Empty = no limit"
                    className="flex-1 px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/50 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={saveMonthlyLimit}
                    disabled={billingActionLoading === "save_limit" || !canManageBilling}
                    className="px-4 py-2.5 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 text-sm disabled:opacity-50 inline-flex items-center gap-2"
                  >
                    {billingActionLoading === "save_limit" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : null}
                    Save
                  </button>
                </div>
                <div className="text-[11px] text-zinc-600">
                  If a monthly limit is set, automatic top-up is suppressed and paid usage stops when the limit is reached.
                </div>
                {!canManageBilling ? (
                  <div className="text-[11px] text-zinc-500">
                    Only workspace admins can manage payment methods and billing limits.
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : !billingLoading ? (
          <div className="text-sm text-zinc-500 p-4">Billing is not available right now.</div>
        ) : null}
      </div>
    );
  };

  const renderWhatsappSection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white mb-1">WhatsApp</h3>
        <p className="text-sm text-zinc-500">
          {edition.selfHosted
            ? "Manage the Personal WhatsApp groups used by your local connector."
            : "Company WhatsApp, DM allowlist, phone verification, and groups."}
        </p>
      </div>

      {workspaceLoading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500 p-4">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      ) : workspace ? (
        <div className="space-y-4">
          {/* Company WhatsApp setup */}
          {!edition.selfHosted && workspace.role === "admin" && !companyWhatsappStatus && (
            <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
              <div className="text-sm text-zinc-300">Company WhatsApp (Kapso)</div>
              <div className="text-xs text-zinc-500">
                Provision a number programmatically and enable DM access for your team.
              </div>
              <div className="text-xs text-amber-200/80">
                Requires Meta (Facebook) Business access. If you don&apos;t have a Business yet, Kapso/Meta will guide you to create one during setup.
              </div>
              <button
                type="button"
                onClick={createCompanyWhatsapp}
                disabled={companyWhatsappLoading}
                className="px-4 py-2 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 text-sm disabled:opacity-50"
              >
                {companyWhatsappLoading ? "Creating…" : "Enable Company WhatsApp"}
              </button>
              {companyWhatsappSetupUrl && (
                <a
                  href={companyWhatsappSetupUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-cyan-300 underline"
                >
                  Open Kapso setup link
                </a>
              )}
            </div>
          )}

          {/* Company WhatsApp status + allowlist */}
          {!edition.selfHosted && workspace.role === "admin" && companyWhatsappStatus && (
            <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
              <div className="text-sm text-zinc-300">
                Company WhatsApp (Kapso) · <span className="text-zinc-400">{companyWhatsappStatus}</span>
              </div>
              {companyWhatsappStatus !== "active" && companyWhatsappSetupUrl && (
                <a
                  href={companyWhatsappSetupUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-cyan-300 underline"
                >
                  Open Kapso setup link
                </a>
              )}
              {companyWhatsappStatus !== "active" && (
                <div className="text-xs text-zinc-500">
                  Finish setup to enable DM allowlist.
                </div>
              )}
              {companyWhatsappStatus === "active" && (
                <div className="text-xs text-zinc-500">DM allowlist</div>
              )}
              <div className="flex gap-2">
                <input
                  value={allowlistPhone}
                  onChange={(e) => setAllowlistPhone(e.target.value)}
                  placeholder="+15551234567"
                  className="flex-1 px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/50 transition-colors"
                />
                <button
                  type="button"
                  onClick={addAllowlist}
                  disabled={allowlistLoading || !allowlistPhone.trim() || companyWhatsappStatus !== "active"}
                  className="px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-zinc-300 text-sm disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              {allowlist.length > 0 && (
                <div className="text-sm text-zinc-500 space-y-1.5">
                  {allowlist.slice(0, 5).map((entry) => (
                    <div key={entry.phone_e164} className="flex items-center justify-between py-1">
                      <span>{entry.phone_e164}</span>
                      <button
                        type="button"
                        onClick={() => removeAllowlist(entry.phone_e164)}
                        className="text-zinc-400 hover:text-white text-xs"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Phone verification */}
          {!edition.selfHosted && companyWhatsappStatus === "active" && (
            <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
              <div className="text-sm text-zinc-300">Verify your phone (DM access)</div>
              <div className="flex gap-2">
                <input
                  value={phoneEntry}
                  onChange={(e) => setPhoneEntry(e.target.value)}
                  placeholder="+15551234567"
                  className="flex-1 px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/50 transition-colors"
                />
                <button
                  type="button"
                  onClick={requestPhoneVerification}
                  className="px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-zinc-300 text-sm"
                >
                  {phoneVerified ? "Verified" : "Send code"}
                </button>
              </div>
              {phoneCode && !phoneVerified && (
                <div className="text-xs text-zinc-500">
                  DM Groovy: <span className="text-zinc-300 font-mono">verify {phoneCode}</span>
                </div>
              )}
              {phoneVerified && (
                <div className="text-xs text-emerald-300">Verified</div>
              )}
            </div>
          )}

          {/* WhatsApp Groups */}
          {workspace.role === "admin" && (
            <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
              <div className="text-sm text-zinc-300">WhatsApp Groups (Personal)</div>
              <div className="flex gap-2">
                <input
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Group name"
                  className="flex-1 px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/50 transition-colors"
                />
                <button
                  type="button"
                  onClick={addGroup}
                  className="px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-zinc-300 text-sm"
                >
                  Add
                </button>
              </div>
              {groups.length > 0 && (
                <div className="text-sm text-zinc-500 space-y-1.5">
                  {groups.slice(0, 5).map((g) => (
                    <div key={g.id} className="flex items-center justify-between py-1">
                      <span>{g.group_name}</span>
                      <button
                        type="button"
                        onClick={() => removeGroup(g.id)}
                        className="text-zinc-400 hover:text-white text-xs"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!workspace || workspace.role !== "admin" ? (
            <div className="text-sm text-zinc-500 p-4">
              WhatsApp settings are managed by workspace admins.
            </div>
          ) : null}
        </div>
      ) : (
        <div className="text-sm text-zinc-500 p-4">Workspace not available.</div>
      )}
    </div>
  );

  const renderTelegramSection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white mb-1">Telegram</h3>
        <p className="text-sm text-zinc-500">
          Connect a Telegram bot to receive messages and heartbeats. Create a bot via{" "}
          <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">
            @BotFather
          </a>{" "}
          and paste the token below.
        </p>
      </div>

      {/* Connection status */}
      <div className="p-4 rounded-xl bg-black/30 border border-white/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${telegramConnected ? "bg-emerald-400" : "bg-zinc-600"}`} />
            <div className="text-sm font-medium text-zinc-200">
              {telegramLoading ? "Loading..." : telegramConnected ? `@${telegramBotUsername}` : "Not connected"}
            </div>
          </div>
          {telegramConnected && (
            <div className="flex items-center gap-3 text-xs text-zinc-500">
              <span>{telegramGroupCount} group{telegramGroupCount !== 1 ? "s" : ""}</span>
              <span>{telegramContactCount} contact{telegramContactCount !== 1 ? "s" : ""}</span>
            </div>
          )}
        </div>
      </div>

      {/* Connect / Disconnect */}
      {!telegramConnected ? (
        <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
          <div className="text-sm text-zinc-300">Enter your bot token from @BotFather:</div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="password"
              value={telegramBotTokenInput}
              onChange={(e) => setTelegramBotTokenInput(e.target.value)}
              placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
              className="flex-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/50 transition-colors font-mono"
            />
            <button
              type="button"
              onClick={connectTelegram}
              disabled={telegramConnecting || !telegramBotTokenInput.trim()}
              className="px-4 py-2 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed text-sm whitespace-nowrap"
            >
              {telegramConnecting ? "Connecting..." : "Connect Bot"}
            </button>
          </div>
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-black/30 border border-white/10">
          <div className="flex items-center justify-between">
            <div className="text-sm text-zinc-300">
              Bot is active and receiving messages.
            </div>
            <button
              type="button"
              onClick={disconnectTelegram}
              disabled={telegramDisconnecting}
              className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-zinc-200 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed text-xs"
            >
              {telegramDisconnecting ? "Disconnecting..." : "Disconnect"}
            </button>
          </div>
        </div>
      )}

      {/* Setup instructions */}
      {!telegramConnected && (
        <div className="p-4 rounded-xl bg-black/30 border border-white/10">
          <div className="text-xs text-zinc-500 mb-2">How to create your bot:</div>
          <ol className="text-xs text-zinc-400 space-y-1.5 list-decimal list-inside">
            <li>Open Telegram and message <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">@BotFather</a></li>
            <li>Send <code className="text-cyan-400">/newbot</code>, choose a name and username</li>
            <li>Copy the bot token and paste it above, then click <span className="text-white">Connect Bot</span></li>
          </ol>
          <div className="text-xs text-zinc-500 mt-3 mb-2">After connecting:</div>
          <ol className="text-xs text-zinc-400 space-y-1.5 list-decimal list-inside" start={4}>
            <li>Add the bot to any Telegram group</li>
            <li>Send <code className="text-cyan-400">/register</code> in the group to activate it</li>
            <li>You can also DM the bot directly for private conversations</li>
          </ol>
        </div>
      )}

      {/* Post-connection guidance */}
      {telegramConnected && (
        <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
          <div className="text-xs text-zinc-500 mb-1">Bot commands:</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-start gap-2">
              <code className="text-cyan-400 shrink-0">/register</code>
              <span className="text-zinc-400">Activate bot in a group</span>
            </div>
            <div className="flex items-start gap-2">
              <code className="text-cyan-400 shrink-0">/start</code>
              <span className="text-zinc-400">Start a private chat</span>
            </div>
            <div className="flex items-start gap-2">
              <code className="text-cyan-400 shrink-0">/new</code>
              <span className="text-zinc-400">Reset conversation</span>
            </div>
            <div className="flex items-start gap-2">
              <code className="text-cyan-400 shrink-0">/code</code>
              <span className="text-zinc-400">Run a Claude Code task</span>
            </div>
            <div className="flex items-start gap-2">
              <code className="text-cyan-400 shrink-0">@{telegramBotUsername}</code>
              <span className="text-zinc-400">Mention in groups</span>
            </div>
          </div>
          <div className="text-[11px] text-zinc-500 mt-2">
            To receive heartbeats via Telegram, go to Settings &rarr; Heartbeat and set your delivery channel.
          </div>
        </div>
      )}

      {telegramMessage && (
        <div className={`text-xs ${telegramMessage.startsWith("Connected") || telegramMessage.startsWith("Telegram bot disconnected") ? "text-emerald-300" : "text-red-400"}`}>
          {telegramMessage}
        </div>
      )}
    </div>
  );

  const renderHeartbeatSection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white mb-1">Heartbeat</h3>
        <p className="text-sm text-zinc-500">
          Every hour, Groovy checks your memory, calendar, email, and Upready readiness data (if connected) — then sends a quick check-in via WhatsApp, Telegram, or your dashboard.
        </p>
      </div>

      {/* Toggle */}
      <div className="p-4 rounded-xl bg-black/30 border border-white/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: heartbeatStatusDot }} />
            <div className="text-sm font-medium text-zinc-200">
              {heartbeatStatusLabel}
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={heartbeatEnabled}
              disabled={heartbeatToggling || heartbeatLoading}
              onChange={(e) => toggleHeartbeat(e.target.checked)}
            />
            <div className="w-11 h-6 bg-zinc-700 rounded-full peer peer-checked:bg-cyan-600 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full peer-disabled:opacity-50" />
          </label>
        </div>
        {heartbeatBoundToDifferentConnector && (
          <div className="mt-2 text-xs text-amber-300">
            Heartbeat is enabled, but it is pinned to a different connector. Rebind it if you want this machine to run it.
          </div>
        )}
      </div>

      {/* Delivery channel */}
      <div className="p-4 rounded-xl bg-black/30 border border-white/10">
        <div className="text-xs text-zinc-500 mb-3">Delivery channel</div>
        <div className="flex flex-wrap gap-2">
          {([
            { key: "whatsapp" as const, label: "WhatsApp" },
            { key: "telegram" as const, label: "Telegram" },
          ]).map(({ key, label }) => {
            const active = heartbeatDelivery[key];
            return (
              <button
                key={key}
                type="button"
                disabled={heartbeatDeliverySaving || heartbeatLoading || (active && !(heartbeatDelivery.whatsapp && heartbeatDelivery.telegram))}
                onClick={() => {
                  const next = { ...heartbeatDelivery, [key]: !active };
                  updateHeartbeatDelivery(next);
                }}
                className={`px-3 py-1.5 rounded-lg border text-xs transition-colors ${
                  active
                    ? "border-cyan-500/40 text-cyan-300 bg-cyan-500/10"
                    : "border-white/10 text-zinc-500 bg-white/5 hover:bg-white/10"
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {label} {active ? "on" : "off"}
              </button>
            );
          })}
        </div>
        <div className="text-[11px] text-zinc-600 mt-2">
          Dashboard delivery is always enabled. Select at least one messaging channel.
        </div>
      </div>

      <div className="p-4 rounded-xl bg-black/30 border border-white/10">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="text-xs text-zinc-500">Heartbeat target connector</div>
            <div className="text-sm text-zinc-300">
              {heartbeatDeviceId ? `Device ${heartbeatDeviceId.slice(0, 8)}` : "Not pinned"}
            </div>
            <div className="text-xs text-zinc-500">
              Current connector:{" "}
              {activeDeviceId ? `Device ${activeDeviceId.slice(0, 8)}` : "No active connector"}
            </div>
          </div>
          <button
            type="button"
            onClick={() => rebindHeartbeatToCurrentConnector()}
            disabled={
              !activeDeviceId ||
              heartbeatLoading ||
              heartbeatToggling ||
              heartbeatRebinding ||
              heartbeatBoundToCurrentConnector
            }
            className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-zinc-200 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed text-xs"
            title="Pin heartbeat job to the connector currently selected in this dashboard session"
          >
            {heartbeatRebinding
              ? "Rebinding..."
              : heartbeatBoundToCurrentConnector
                ? "Pinned to current connector"
                : "Rebind to current connector"}
          </button>
        </div>
        {heartbeatRebindMessage && (
          <div className="mt-2 text-xs text-emerald-300">{heartbeatRebindMessage}</div>
        )}
      </div>

      {/* Integration status */}
      <div className="p-4 rounded-xl bg-black/30 border border-white/10">
        <div className="text-xs text-zinc-500 mb-3">Integrations</div>
        <div className="flex flex-wrap gap-3">
          <div className={`text-xs px-3 py-1.5 rounded-lg border ${
            heartbeatIntegrations.gmail
              ? "border-emerald-500/30 text-emerald-300 bg-emerald-500/10"
              : "border-white/10 text-zinc-500 bg-white/5"
          }`}>
            Gmail {heartbeatIntegrations.gmail ? "connected" : "not connected"}
          </div>
          <div className={`text-xs px-3 py-1.5 rounded-lg border ${
            heartbeatIntegrations.google_calendar
              ? "border-emerald-500/30 text-emerald-300 bg-emerald-500/10"
              : "border-white/10 text-zinc-500 bg-white/5"
          }`}>
            Calendar {heartbeatIntegrations.google_calendar ? "connected" : "not connected"}
          </div>
          <div className={`text-xs px-3 py-1.5 rounded-lg border ${
            heartbeatIntegrations.upready_readiness
              ? "border-emerald-500/30 text-emerald-300 bg-emerald-500/10"
              : "border-white/10 text-zinc-500 bg-white/5"
          }`}>
            Upready {heartbeatIntegrations.upready_readiness ? "connected" : "not connected"}
          </div>
        </div>
      </div>

      {/* Upready link management */}
      <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm text-zinc-200">Upready readiness link</div>
            <div className="text-xs text-zinc-500">
              {upreadyConnected
                ? `Linked as ${upreadyLinkedEmail || "unknown email"}`
                : "Link your Upready email to pull readiness scores into Heartbeat and Orchestrator."}
            </div>
          </div>
          <div className={`text-xs px-2 py-1 rounded border ${
            upreadyConnected
              ? "border-emerald-500/30 text-emerald-300 bg-emerald-500/10"
              : "border-white/10 text-zinc-500 bg-white/5"
          }`}>
            {upreadyLoading ? "Checking..." : upreadyConnected ? "Connected" : "Not connected"}
          </div>
        </div>

        {!upreadyConnected && (
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="email"
              value={upreadyEmailInput}
              onChange={(e) => setUpreadyEmailInput(e.target.value)}
              placeholder="you@upready-email.com"
              className="flex-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/50 transition-colors"
            />
            <button
              type="button"
              onClick={sendUpreadyLinkConfirmation}
              disabled={upreadyActionLoading === "send"}
              className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-zinc-200 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed text-xs"
            >
              {upreadyActionLoading === "send" ? "Sending..." : "Send confirmation email"}
            </button>
          </div>
        )}

        {upreadyConnected && (
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={disconnectUpready}
              disabled={upreadyActionLoading === "disconnect"}
              className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-zinc-200 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed text-xs"
            >
              {upreadyActionLoading === "disconnect" ? "Disconnecting..." : "Disconnect Upready"}
            </button>
          </div>
        )}

        {upreadyMessage && (
          <div className="text-xs text-emerald-300">{upreadyMessage}</div>
        )}
      </div>

      {/* Run log */}
      {heartbeatRuns.length > 0 && (
        <div className="p-4 rounded-xl bg-black/30 border border-white/10">
          <div className="text-xs text-zinc-500 mb-3">Recent runs ({heartbeatRuns.length})</div>
          <div className="max-h-60 overflow-y-auto space-y-1.5">
            {heartbeatRuns.slice(0, 50).map((run) => {
              const d = new Date(run.created_at);
              const timeStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
              const dur = typeof run.duration_ms === "number" ? `${(run.duration_ms / 1000).toFixed(1)}s` : "";
              const statusColor = run.status === "success" ? "text-emerald-400" : run.status === "skipped" ? "text-amber-400" : "text-red-400";
              return (
                <div key={run.id} className="flex items-center justify-between text-xs py-1">
                  <span className="text-zinc-500">{timeStr}</span>
                  <div className="flex items-center gap-3">
                    {dur && <span className="text-zinc-600">{dur}</span>}
                    <span className={statusColor}>{run.status}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {heartbeatEnabled && heartbeatRuns.length === 0 && !heartbeatLoading && (
        <div className="p-4 rounded-xl bg-black/30 border border-white/10">
          <div className="text-sm text-zinc-600">No runs yet. The first one will happen within the hour.</div>
        </div>
      )}
    </div>
  );

  const renderAgentRuntimeSection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white mb-1">Agent Runtime</h3>
        <p className="text-sm text-zinc-500">Control how agents manage sessions, branches, and handshake collaboration.</p>
      </div>

      <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-5">
        <div>
          <h4 className="text-sm font-medium text-zinc-200 mb-3">Handshake (Agent-to-Agent)</h4>
          <div className="space-y-2">
            <label className="flex items-center justify-between">
              <div>
                <span className="text-sm text-zinc-300">Max turns per window</span>
                <p className="text-[11px] text-zinc-500 mt-0.5">How many back-and-forth handshake turns are allowed in a 2-minute window before the loop guard stops them.</p>
              </div>
              <input
                type="number"
                min={2}
                max={20}
                value={agentRuntimeHandshakeTurns}
                onChange={(e) => setAgentRuntimeHandshakeTurns(Math.max(2, Math.min(20, Number(e.target.value) || 8)))}
                className="w-16 text-center text-sm rounded-lg bg-white/5 border border-white/10 text-white px-2 py-1.5 outline-none"
              />
            </label>
          </div>
        </div>

        <div className="border-t border-white/5 pt-4">
          <h4 className="text-sm font-medium text-zinc-200 mb-3">Branch Controller</h4>
          <div className="space-y-3">
            <label className="flex items-center justify-between">
              <div>
                <span className="text-sm text-zinc-300">Max branches per agent</span>
                <p className="text-[11px] text-zinc-500 mt-0.5">Maximum concurrent hidden worker branches the orchestrator can keep active for an agent, including the main branch (1-12).</p>
              </div>
              <input
                type="number"
                min={1}
                max={12}
                value={agentRuntimeMaxBranches}
                onChange={(e) => setAgentRuntimeMaxBranches(Math.max(1, Math.min(12, Number(e.target.value) || 4)))}
                className="w-16 text-center text-sm rounded-lg bg-white/5 border border-white/10 text-white px-2 py-1.5 outline-none"
              />
            </label>
            <label className="flex items-center justify-between">
              <div>
                <span className="text-sm text-zinc-300">Max turns per branch</span>
                <p className="text-[11px] text-zinc-500 mt-0.5">Execution budget for each hidden worker branch when the orchestrator fans work out in parallel (1-64).</p>
              </div>
              <input
                type="number"
                min={1}
                max={64}
                value={agentRuntimeMaxTurnsPerBranch}
                onChange={(e) => setAgentRuntimeMaxTurnsPerBranch(Math.max(1, Math.min(64, Number(e.target.value) || 8)))}
                className="w-16 text-center text-sm rounded-lg bg-white/5 border border-white/10 text-white px-2 py-1.5 outline-none"
              />
            </label>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-zinc-300">Branch mode</span>
              <CustomSelect
                value={agentRuntimeBranchMode}
                onChange={(nextValue) =>
                  setAgentRuntimeBranchMode(
                    nextValue as "read_write" | "read_only",
                  )
                }
                options={[
                  { value: "read_write", label: "Read & Write" },
                  { value: "read_only", label: "Read Only" },
                ]}
                className="w-40"
                ariaLabel="Branch mode"
                size="sm"
              />
            </div>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSaveAgentRuntime}
        disabled={agentRuntimeSaving}
        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-500/15 border border-cyan-500/20 text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50 transition-colors text-sm"
      >
        {agentRuntimeSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : agentRuntimeSaved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
        {agentRuntimeSaving ? "Saving..." : agentRuntimeSaved ? "Saved" : "Save"}
      </button>
    </div>
  );

  const renderAdvancedSection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white mb-1">Advanced</h3>
        <p className="text-sm text-zinc-500">Advanced options and troubleshooting.</p>
      </div>

      {connectorMode === "groovy" ? (
        <div className="p-4 rounded-xl bg-black/30 border border-white/10">
          <div className="text-sm text-zinc-400 leading-relaxed">
            Hosted Groovy Mac connectors are managed by Groovy. Use &quot;Restart&quot;, &quot;Self-update hosted Mac&quot;, or &quot;Request update&quot; in the Connector section.
          </div>
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500/70 mt-0.5 shrink-0" />
            <div className="text-sm text-zinc-400 leading-relaxed">
              <span className="text-zinc-300 font-medium">Switch Flow account:</span>{" "}
              Run these commands in Terminal to clear local pairing, then re-open the Connector app and enter a new pairing code.
            </div>
          </div>
          <div className="relative">
            <pre className="bg-black/40 text-xs text-zinc-400 p-4 pr-20 rounded-lg font-mono overflow-x-auto whitespace-pre leading-relaxed border border-white/5">
{REPAIR_CONNECTOR_COMMANDS}
            </pre>
            <button
              type="button"
              onClick={async () => {
                const ok = await copyText(REPAIR_CONNECTOR_COMMANDS);
                setCopiedRePair(ok);
                if (ok) setTimeout(() => setCopiedRePair(false), 1500);
              }}
              className="absolute top-3 right-3 px-2.5 py-1.5 rounded bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-zinc-200 text-xs transition-all flex items-center gap-1"
            >
              {copiedRePair ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copiedRePair ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const renderActiveSection = () => {
    switch (activeSection) {
      case "account":
        return renderAccountSection();
      case "connector":
        return renderConnectorSection();
      case "aiyra-voice":
        return renderAiyraVoiceSection();
      case "api-keys":
        return renderApiKeysSection();
      case "integrations":
        return (
          <IntegrationSettingsSection
            currentSessionId={currentOrchestratorSessionId}
            currentOrchestratorAgentId={currentOrchestratorAgentId}
          />
        );
      case "billing":
        return renderBillingSection();
      case "team":
        return renderTeamSection();
      case "usage":
        return renderUsageSection();
      case "whatsapp":
        return renderWhatsappSection();
      case "telegram":
        return renderTelegramSection();
      case "heartbeat":
        return renderHeartbeatSection();
      case "agent-runtime":
        return renderAgentRuntimeSection();
      case "advanced":
        return renderAdvancedSection();
      default:
        return renderConnectorSection();
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-[#0a0a0f]"
      >
        {/* Header */}
        <div className="h-14 border-b border-white/10 flex items-center justify-between px-4 sm:px-6 bg-[#0a0a0f]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center">
              <Settings className="w-4 h-4 text-zinc-400" />
            </div>
            <h1 className="text-base font-medium text-white">Settings</h1>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex h-[calc(100vh-3.5rem)] flex-col md:flex-row">
          {/* Left sidebar */}
          <nav className="w-full md:w-56 border-b md:border-b-0 md:border-r border-white/10 py-2 md:py-4 px-3 shrink-0 overflow-x-auto md:overflow-y-auto">
            <div className="flex md:flex-col gap-1 min-w-max md:min-w-0">
              {SECTION_NAV.filter(
                (section) => !edition.selfHosted || section.id !== "billing"
              ).map((section) => {
                const Icon = section.icon;
                const isActive = activeSection === section.id;
                return (
                  <button
                    key={section.id}
                    onClick={() => setActiveSection(section.id)}
                    className={`md:w-full w-auto shrink-0 flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left text-sm transition-all whitespace-nowrap ${
                      isActive
                        ? "bg-white/10 text-white"
                        : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {section.label}
                  </button>
                );
              })}
            </div>
          </nav>

          {/* Main content */}
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto p-4 sm:p-6 md:p-8">
              {/* Error / Success banners */}
              {error && (
                <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <p className="text-sm text-red-300">{error}</p>
                  <button
                    onClick={() => setError(null)}
                    className="ml-auto text-red-400 hover:text-red-300"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {success && successMessage && (
                <div className="mb-6 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  <p className="text-sm text-emerald-300">{successMessage}</p>
                </div>
              )}

              {renderActiveSection()}
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
