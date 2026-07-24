"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CalendarClock,
  ChevronDown,
  ImagePlus,
  Lock,
  LoaderCircle,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { AppNav } from "@/components/AppNav";
import { ChannelSettingsModal } from "@/components/chat/ChannelSettingsModal";
import {
  ChannelCreateModal,
  type ChannelCreateInput,
  type ChannelSkillOption,
} from "@/components/chat/ChannelCreateModal";
import {
  ChatMentionMenu,
  type ChatMentionOption,
} from "@/components/chat/ChatMentionMenu";
import { PeopleInviteModal } from "@/components/chat/PeopleInviteModal";
import { ChannelScheduledTasksPanel } from "@/components/chat/ChannelScheduledTasksPanel";
import { RoomNotificationMenu } from "@/components/notifications/RoomNotificationControl";
import { WorkspaceSwitcher } from "@/components/workspaces/WorkspaceSwitcher";
import type {
  ChannelScheduleAction,
  ChannelScheduledTask,
} from "@/lib/chat/channelSchedules";
import {
  isVisionImageFile,
  MAX_INLINE_IMAGE_FILES,
  prepareInlineImageFiles,
  VISION_IMAGE_ACCEPT,
} from "@/lib/orchestrator/inlineImages.client";
import {
  DEFAULT_TEAM_CHAT_MIND_HANDLE,
  teamChatMentionHandle,
} from "@/lib/chat/mentions";
import {
  incomingUnreadDisposition,
  normalizeUnreadCount,
} from "@/lib/chat/unread";
import {
  chatClientMessageId,
  isPendingChatMessage,
  mergeChatMessages,
  reconcileChatMessages,
} from "@/lib/chat/messageMerge";
import {
  selectedChannelAgents,
} from "@/lib/chat/channelAgentRoster";

type Channel = {
  id: string;
  kind: "channel" | "dm";
  name: string;
  slug: string;
  topic: string | null;
  profile_id: string | null;
  orchestrator_mode: "mention" | "always" | "off";
  orchestrator_instructions: string | null;
  visibility: "workspace" | "private";
  created_by: string;
  unread_count?: number;
};

type Message = {
  id: string;
  channel_id: string;
  author_type: "user" | "orchestrator" | "agent" | "system";
  author_user_id: string | null;
  author_agent_id: string | null;
  profile_id: string | null;
  content: string;
  reply_to_message_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

type MessageImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

type Profile = {
  id: string;
  name: string;
  slug: string;
  surface: string;
  authorization_stance: string;
  memory_scope: string;
  inherit_workspace_skills: boolean;
  inherit_workspace_integrations: boolean;
  workspace_id: string | null;
  is_default: boolean;
};

type Agent = {
  id: string;
  name: string;
  harness: string;
  model: string | null;
  deviceOnline: boolean;
};

type Person = {
  user_id: string;
  email?: string | null;
  role?: "admin" | "member" | "guest";
};

type ChannelMember = {
  id?: string;
  channel_id: string;
  member_type: "user" | "agent" | "orchestrator";
  user_id: string | null;
  agent_id: string | null;
};

type ChannelSkillAssignment = {
  id: string;
  channel_id: string;
  artifact_id: string;
  created_at?: string;
};

type ActiveOrchestratorRun = {
  id: string;
  trace_id: string;
  status: "running" | "stop_requested" | "redirect_requested";
  profile_id: string | null;
  started_by: string | null;
  control_requested_by: string | null;
  started_at: string;
  control_requested_at: string | null;
};

type ActiveAgentTask = {
  id: string;
  status: "queued" | "running" | "awaiting_approval";
  title: string;
  agentId: string;
  agentName: string;
  traceId: string | null;
};

type ActiveWork = {
  orchestrator: ActiveOrchestratorRun | null;
  agents: ActiveAgentTask[];
};

type SidebarSection = "channels" | "direct" | "people" | "agents";
type OpeningConversation = {
  id: string;
  label: string;
  kind: "agent" | "person";
};

function SidebarSectionHeader({
  action,
  collapsed,
  controls,
  count,
  label,
  onToggle,
  unreadCount = 0,
}: {
  action?: ReactNode;
  collapsed: boolean;
  controls: string;
  count: number;
  label: string;
  onToggle: () => void;
  unreadCount?: number;
}) {
  return (
    <div className="flex items-center gap-1 px-2 pb-1 pt-4 text-[10px] uppercase tracking-widest text-[var(--text-secondary)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/30"
        aria-expanded={!collapsed}
        aria-controls={controls}
      >
        <ChevronDown
          className={`h-3 w-3 shrink-0 transition-transform ${
            collapsed ? "-rotate-90" : ""
          }`}
        />
        <span className="truncate">{label}</span>
        {unreadCount > 0 ? (
          <span
            className="flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-300 px-1.5 text-[8px] font-bold normal-case tracking-normal text-[#071014] shadow-[0_0_12px_rgba(34,211,238,0.28)]"
            aria-label={`${unreadCount} unread ${
              unreadCount === 1 ? "message" : "messages"
            }`}
          >
            {unreadCount > 99 ? "99+ new" : `${unreadCount} new`}
          </span>
        ) : null}
        <span className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[9px] tabular-nums text-zinc-500">
          {count}
        </span>
      </button>
      {action}
    </div>
  );
}

function channelUnreadCount(channel: Channel): number {
  return normalizeUnreadCount(channel.unread_count);
}

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="ml-2 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-cyan-300 px-1.5 text-[9px] font-bold tabular-nums text-[#071014] shadow-[0_0_14px_rgba(34,211,238,0.3)]"
      aria-label={`${count} unread ${count === 1 ? "message" : "messages"}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function SidebarRoomButton({
  active,
  channel,
  onSelect,
}: {
  active: boolean;
  channel: Channel;
  onSelect: (channelId: string) => void;
}) {
  const unread = channelUnreadCount(channel);
  const hasUnread = unread > 0 && !active;
  const unreadLabel = `${unread} unread ${
    unread === 1 ? "message" : "messages"
  }`;
  return (
    <button
      type="button"
      onClick={() => onSelect(channel.id)}
      aria-label={hasUnread ? `${channel.name}, ${unreadLabel}` : channel.name}
      className={`relative flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition ${
        active
          ? "bg-[var(--bg-tertiary)] text-white"
          : hasUnread
            ? "bg-cyan-400/[0.07] font-medium text-white shadow-[inset_3px_0_0_rgba(34,211,238,0.72)] hover:bg-cyan-400/[0.11]"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
      }`}
    >
      {channel.kind === "dm" ? (
        <span
          className={`mr-2 ${
            hasUnread
              ? "text-cyan-300 drop-shadow-[0_0_6px_rgba(34,211,238,0.75)]"
              : "text-[var(--accent-green)]"
          }`}
        >
          ●
        </span>
      ) : channel.visibility === "private" ? (
        <Lock
          className={`mr-2 h-3.5 w-3.5 shrink-0 ${
            hasUnread ? "text-cyan-300" : "text-zinc-500"
          }`}
          aria-label="Private channel"
        />
      ) : (
        <span
          className={`mr-2 ${
            hasUnread ? "text-cyan-300" : "text-zinc-500"
          }`}
        >
          #
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{channel.name}</span>
      {hasUnread ? <UnreadBadge count={unread} /> : null}
    </button>
  );
}

function SidebarLoadingState() {
  return (
    <div
      className="animate-pulse px-2 py-3 motion-reduce:animate-none"
      aria-label="Loading workspace navigation"
    >
      {[2, 1, 2, 3].map((rows, sectionIndex) => (
        <div key={sectionIndex} className="mb-5">
          <div className="mb-2 h-3 w-20 rounded bg-white/[0.06]" />
          {Array.from({ length: rows }, (_, rowIndex) => (
            <div
              key={rowIndex}
              className="mb-1.5 flex items-center gap-2 rounded-lg px-2 py-1.5"
            >
              <div className="h-5 w-5 rounded-md bg-white/[0.05]" />
              <div
                className={`h-3 rounded bg-white/[0.05] ${
                  rowIndex % 2 === 0 ? "w-28" : "w-20"
                }`}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function WorkspaceLoadingState() {
  return (
    <div
      className="flex flex-1 items-center justify-center px-6"
      aria-live="polite"
      aria-label="Opening workspace"
    >
      <div className="flex flex-col items-center text-center">
        <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.04]">
          <div className="absolute inset-2 animate-ping rounded-xl bg-cyan-300/[0.08] motion-reduce:animate-none" />
          <LoaderCircle className="relative h-5 w-5 animate-spin text-cyan-300 motion-reduce:animate-none" />
        </div>
        <p className="mt-4 text-sm font-medium text-zinc-200">
          Opening your workspace
        </p>
        <p className="mt-1 text-xs text-zinc-600">
          Loading conversations and teammates…
        </p>
      </div>
    </div>
  );
}

function ConversationOpeningState({
  conversation,
}: {
  conversation: OpeningConversation;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6" aria-live="polite">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-cyan-300">
          <LoaderCircle className="h-5 w-5 animate-spin motion-reduce:animate-none" />
        </div>
        <h1 className="mt-4 text-base font-medium">
          Opening {conversation.label}
        </h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          {conversation.kind === "agent"
            ? "Preparing a private workspace for you and this agent."
            : "Preparing your direct conversation."}
        </p>
      </div>
    </div>
  );
}

const CHAT_COMPOSER_MAX_HEIGHT = 160;

function resizeChatComposer(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.style.height = "auto";
  const nextHeight = Math.min(
    Math.max(textarea.scrollHeight, 36),
    CHAT_COMPOSER_MAX_HEIGHT,
  );
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > CHAT_COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
}

function usesMobileComposerKeyboard(): boolean {
  return (
    window.matchMedia("(max-width: 767px)").matches ||
    window.matchMedia("(hover: none) and (pointer: coarse)").matches
  );
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function messageImageAttachments(
  metadata: Record<string, unknown> | null | undefined,
): MessageImageAttachment[] {
  if (!Array.isArray(metadata?.attachments)) return [];
  return metadata.attachments
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const value = raw as Record<string, unknown>;
      if (
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        typeof value.mimeType !== "string" ||
        typeof value.sizeBytes !== "number"
      ) {
        return null;
      }
      return {
        id: value.id,
        name: value.name,
        mimeType: value.mimeType,
        sizeBytes: value.sizeBytes,
      };
    })
    .filter((value): value is MessageImageAttachment => Boolean(value))
    .slice(0, MAX_INLINE_IMAGE_FILES);
}

export function TeamChatClient({ initialChannelId }: { initialChannelId?: string }) {
  const [workspaceName, setWorkspaceName] = useState("Workspace");
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [workspaceLoadError, setWorkspaceLoadError] = useState<string | null>(
    null,
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [collapsedSections, setCollapsedSections] = useState<
    Record<SidebarSection, boolean>
  >({
    channels: false,
    direct: false,
    people: false,
    agents: false,
  });
  const [channelComposerOpen, setChannelComposerOpen] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [channelMembers, setChannelMembers] = useState<ChannelMember[]>([]);
  const [skills, setSkills] = useState<ChannelSkillOption[]>([]);
  const [channelSkillAssignments, setChannelSkillAssignments] = useState<
    ChannelSkillAssignment[]
  >([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [workspaceRole, setWorkspaceRole] = useState<
    "admin" | "member" | "guest"
  >("member");
  const [activeId, setActiveId] = useState<string | null>(initialChannelId || null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(
    Boolean(initialChannelId),
  );
  const [draft, setDraft] = useState("");
  const [selectedImages, setSelectedImages] = useState<File[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [activeWork, setActiveWork] = useState<ActiveWork>({
    orchestrator: null,
    agents: [],
  });
  const [controlBusy, setControlBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);
  const [schedulePanelOpen, setSchedulePanelOpen] = useState(false);
  const [scheduledTasks, setScheduledTasks] = useState<ChannelScheduledTask[]>(
    [],
  );
  const [scheduledTasksLoading, setScheduledTasksLoading] = useState(false);
  const [scheduledTasksError, setScheduledTasksError] = useState<string | null>(
    null,
  );
  const [scheduleMigrationPending, setScheduleMigrationPending] =
    useState(false);
  const [scheduleBusyTaskId, setScheduleBusyTaskId] = useState<string | null>(
    null,
  );
  const [peopleInviteOpen, setPeopleInviteOpen] = useState(false);
  const [inviteContext, setInviteContext] = useState<{
    email: string;
    channelId: string;
    channelName: string;
  } | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionEnd, setMentionEnd] = useState<number | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [mentionBusyId, setMentionBusyId] = useState<string | null>(null);
  const [openingConversation, setOpeningConversation] =
    useState<OpeningConversation | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const sidebarSearchRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const settingsQueryHandledRef = useRef(false);
  const scheduledTasksChannelRef = useRef<string | null>(null);
  const scheduledTasksRequestRef = useRef<AbortController | null>(null);
  const channelReadRequestsRef = useRef<Map<string, AbortController>>(
    new Map(),
  );
  const schedulePanelTriggerRef = useRef<HTMLButtonElement>(null);
  const activeIdRef = useRef<string | null>(activeId);
  const currentUserIdRef = useRef(currentUserId);
  const activeWorkSnapshotRef = useRef<{
    channelId: string | null;
    work: ActiveWork;
  }>({
    channelId: activeId,
    work: { orchestrator: null, agents: [] },
  });
  const foregroundRefreshInFlightRef = useRef(false);
  activeIdRef.current = activeId;
  currentUserIdRef.current = currentUserId;

  const loadSidebar = useCallback(async () => {
    const [channelsRes, profilesRes] = await Promise.all([
      fetch("/api/chat/channels", { cache: "no-store" }),
      fetch("/api/harness/profiles", { cache: "no-store" }),
    ]);
    if (!channelsRes.ok) throw new Error("Could not load team chat.");
    const [channelsPayload, profilesPayload] = await Promise.all([
      channelsRes.json(),
      profilesRes.ok ? profilesRes.json() : Promise.resolve({ profiles: [] }),
    ]);
    const nextChannels = Array.isArray(channelsPayload.channels)
      ? channelsPayload.channels
      : [];
    setWorkspaceName(channelsPayload.workspace?.name || "Workspace");
    setChannels(nextChannels);
    setCurrentUserId(channelsPayload.workspace?.currentUserId || "");
    setWorkspaceRole(
      channelsPayload.workspace?.role === "admin" ||
        channelsPayload.workspace?.role === "guest"
        ? channelsPayload.workspace.role
        : "member",
    );
    setPeople(
      Array.isArray(channelsPayload.workspace?.members)
        ? channelsPayload.workspace.members
        : [],
    );
    setChannelMembers(
      Array.isArray(channelsPayload.members) ? channelsPayload.members : [],
    );
    const profileMap = new Map<string, Profile>();
    for (const profile of Array.isArray(profilesPayload.profiles)
      ? profilesPayload.profiles
      : []) {
      if (profile.workspace_id === channelsPayload.workspace?.id) {
        profileMap.set(profile.id, profile);
      }
    }
    for (const profile of Array.isArray(channelsPayload.profiles)
      ? channelsPayload.profiles
      : []) {
      profileMap.set(profile.id, profile);
    }
    setProfiles(Array.from(profileMap.values()));
    setAgents(Array.isArray(channelsPayload.agents) ? channelsPayload.agents : []);
    setSkills(
      Array.isArray(channelsPayload.skills) ? channelsPayload.skills : [],
    );
    setChannelSkillAssignments(
      Array.isArray(channelsPayload.skillAssignments)
        ? channelsPayload.skillAssignments
        : [],
    );
    setActiveId((current) => {
      if (current && nextChannels.some((channel: Channel) => channel.id === current)) {
        return current;
      }
      return nextChannels[0]?.id || null;
    });
  }, []);

  const markChannelRead = useCallback(async (channelId: string) => {
    setChannels((current) =>
      current.map((channel) =>
        channel.id === channelId
          ? { ...channel, unread_count: 0 }
          : channel,
      ),
    );
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker
        .getRegistration("/")
        .then((registration) => {
          const worker =
            navigator.serviceWorker.controller || registration?.active;
          worker?.postMessage({
            type: "groovy-channel-read",
            channelId,
          });
        })
        .catch(() => undefined);
    }
    channelReadRequestsRef.current.get(channelId)?.abort();
    const controller = new AbortController();
    channelReadRequestsRef.current.set(channelId, controller);
    try {
      const response = await fetch(`/api/chat/channels/${channelId}/read`, {
        method: "POST",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return;
      if (
        controller.signal.aborted ||
        channelReadRequestsRef.current.get(channelId) !== controller
      ) {
        return;
      }
      // A concurrent sidebar refresh may have landed before the read cursor.
      // Clear the optimistic badge again once persistence is confirmed.
      setChannels((current) =>
        current.map((channel) =>
          channel.id === channelId
            ? { ...channel, unread_count: 0 }
            : channel,
        ),
      );
    } catch (cause) {
      if (
        cause instanceof DOMException &&
        cause.name === "AbortError"
      ) {
        return;
      }
    } finally {
      if (channelReadRequestsRef.current.get(channelId) === controller) {
        channelReadRequestsRef.current.delete(channelId);
      }
    }
  }, []);

  const loadMessages = useCallback(async (channelId: string) => {
    if (activeIdRef.current === channelId) {
      setMessagesLoading(true);
    }
    try {
      const res = await fetch(`/api/chat/channels/${channelId}/messages`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Could not load channel messages.");
      const payload = await res.json();
      const authoritative = Array.isArray(payload.messages)
        ? (payload.messages as Message[])
        : [];
      if (activeIdRef.current === channelId) {
        setMessages((current) =>
          reconcileChatMessages(current, authoritative),
        );
      }
      return authoritative;
    } finally {
      if (activeIdRef.current === channelId) {
        setMessagesLoading(false);
      }
    }
  }, []);

  const loadActiveWork = useCallback(async (channelId: string) => {
    const res = await fetch(`/api/chat/channels/${channelId}/control`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Could not load active channel work.");
    const payload = await res.json();
    const next: ActiveWork = {
      orchestrator: payload.orchestrator || null,
      agents: Array.isArray(payload.agents) ? payload.agents : [],
    };
    if (activeIdRef.current === channelId) {
      const previous =
        activeWorkSnapshotRef.current.channelId === channelId
          ? activeWorkSnapshotRef.current.work
          : { orchestrator: null, agents: [] };
      const previouslyWorking =
        Boolean(previous.orchestrator) || previous.agents.length > 0;
      const stillWorking =
        Boolean(next.orchestrator) || next.agents.length > 0;
      activeWorkSnapshotRef.current = { channelId, work: next };
      setActiveWork(next);
      setThinking(Boolean(next.orchestrator));
      // Realtime sockets can be suspended or dropped while a phone sleeps.
      // When durable work reaches a terminal state, fetch the completion
      // message explicitly instead of depending on a realtime event.
      if (previouslyWorking && !stillWorking) {
        void loadMessages(channelId).catch(() => undefined);
      }
    }
    return next;
  }, [loadMessages]);

  const hydrateWorkspace = useCallback(async () => {
    setWorkspaceLoadError(null);
    setError(null);
    try {
      await loadSidebar();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Could not load chat.";
      setWorkspaceLoadError(message);
      setError(message);
    } finally {
      setWorkspaceReady(true);
    }
  }, [loadSidebar]);

  const loadScheduledTasks = useCallback(
    async (
      channelId: string,
      { background = false }: { background?: boolean } = {},
    ) => {
      if (scheduledTasksChannelRef.current !== channelId) return;
      // A background poll should never interrupt a user-requested refresh or
      // make the panel flash. A foreground refresh may replace an older poll.
      if (background && scheduledTasksRequestRef.current) return;
      scheduledTasksRequestRef.current?.abort();
      const controller = new AbortController();
      scheduledTasksRequestRef.current = controller;
      if (!background) {
        setScheduledTasksLoading(true);
        setScheduledTasksError(null);
      }
      try {
        const response = await fetch(
          `/api/chat/channels/${channelId}/scheduled-tasks`,
          { cache: "no-store", signal: controller.signal },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            payload.error || "Could not load this channel’s scheduled tasks.",
          );
        }
        if (
          controller.signal.aborted ||
          scheduledTasksRequestRef.current !== controller ||
          scheduledTasksChannelRef.current !== channelId
        ) {
          return;
        }
        setScheduledTasks(
          Array.isArray(payload.tasks)
            ? (payload.tasks as ChannelScheduledTask[])
            : [],
        );
        setScheduleMigrationPending(Boolean(payload.migrationPending));
        setScheduledTasksError(null);
      } catch (cause) {
        if (
          controller.signal.aborted ||
          scheduledTasksRequestRef.current !== controller ||
          scheduledTasksChannelRef.current !== channelId
        ) {
          return;
        }
        if (!background) {
          setScheduledTasksError(
            cause instanceof Error
              ? cause.message
              : "Could not load this channel’s scheduled tasks.",
          );
        }
      } finally {
        if (scheduledTasksRequestRef.current === controller) {
          scheduledTasksRequestRef.current = null;
          if (
            !background &&
            scheduledTasksChannelRef.current === channelId
          ) {
            setScheduledTasksLoading(false);
          }
        }
      }
    },
    [],
  );

  useEffect(() => {
    void hydrateWorkspace();
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker
        .getRegistration("/")
        .then((registration) => registration?.update())
        .catch(() => undefined);
    }
    const supabase = getSupabaseBrowserClient();
    const realtime = supabase
      .channel("team-chat-sidebar")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_channels",
        },
        () => {
          void loadSidebar().catch(() => undefined);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(realtime);
    };
  }, [hydrateWorkspace, loadSidebar]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    const realtime = supabase
      .channel("team-chat-unread")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
        },
        (payload) => {
          const message = payload.new as Message;
          const disposition = incomingUnreadDisposition({
            channelId: message.channel_id,
            authorType: message.author_type,
            authorUserId: message.author_user_id,
            currentUserId: currentUserIdRef.current,
            activeChannelId: activeIdRef.current,
            documentVisible: document.visibilityState === "visible",
          });
          if (disposition === "ignore") return;
          if (disposition === "read") {
            const channelId = message.channel_id;
            void markChannelRead(channelId);
            return;
          }
          const channelId = message.channel_id;
          setChannels((current) =>
            current.map((channel) =>
              channel.id === channelId
                ? {
                    ...channel,
                    unread_count: channelUnreadCount(channel) + 1,
                  }
                : channel,
            ),
          );
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(realtime);
    };
  }, [markChannelRead]);

  useEffect(
    () => () => {
      for (const controller of channelReadRequestsRef.current.values()) {
        controller.abort();
      }
      channelReadRequestsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    try {
      setSidebarCollapsed(
        window.localStorage.getItem("groovy-chat-sidebar-collapsed") === "1",
      );
      const savedSchedulePanel = window.localStorage.getItem(
        "groovy-chat-schedule-panel-open",
      );
      const desktopSchedulePanel = window.matchMedia(
        "(min-width: 1280px)",
      ).matches;
      setSchedulePanelOpen(
        desktopSchedulePanel &&
          (savedSchedulePanel === null || savedSchedulePanel === "1"),
      );
    } catch {
      // Storage can be unavailable in hardened/private browser contexts.
    }
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const previousOverflow = document.body.style.overflow;
    const mobileMedia = window.matchMedia("(max-width: 767px)");
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setMobileNavOpen(false);
      }
    };
    const syncBodyScroll = () => {
      document.body.style.overflow = mobileMedia.matches
        ? "hidden"
        : previousOverflow;
    };
    syncBodyScroll();
    mobileMedia.addEventListener("change", syncBodyScroll);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      mobileMedia.removeEventListener("change", syncBodyScroll);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    const hasActiveScheduleChannel = channels.some(
      (channel) =>
        channel.id === activeId && channel.kind === "channel",
    );
    if (!schedulePanelOpen || !hasActiveScheduleChannel) return;
    const previousOverflow = document.body.style.overflow;
    const drawerMedia = window.matchMedia("(max-width: 1279px)");
    const syncBodyScroll = () => {
      document.body.style.overflow = drawerMedia.matches
        ? "hidden"
        : previousOverflow;
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setSchedulePanelOpen(false);
        window.requestAnimationFrame(() => {
          schedulePanelTriggerRef.current?.focus();
        });
        try {
          if (window.matchMedia("(min-width: 1280px)").matches) {
            window.localStorage.setItem(
              "groovy-chat-schedule-panel-open",
              "0",
            );
          }
        } catch {
          // The panel still closes if browser storage is unavailable.
        }
      }
    };
    syncBodyScroll();
    drawerMedia.addEventListener("change", syncBodyScroll);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      drawerMedia.removeEventListener("change", syncBodyScroll);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [activeId, channels, schedulePanelOpen]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      setMessagesLoading(false);
      setActiveWork({ orchestrator: null, agents: [] });
      activeWorkSnapshotRef.current = {
        channelId: null,
        work: { orchestrator: null, agents: [] },
      };
      return;
    }
    setMessages([]);
    setMessagesLoading(true);
    if (document.visibilityState === "visible") {
      void markChannelRead(activeId);
    }
    void loadMessages(activeId).catch((cause) => {
      if (activeIdRef.current !== activeId) return;
      setMessagesLoading(false);
      setError(
        cause instanceof Error ? cause.message : "Could not load messages.",
      );
    });
    void loadActiveWork(activeId).catch(() => undefined);
    const activeWorkPoll = setInterval(() => {
      void loadActiveWork(activeId).catch(() => undefined);
    }, 2000);
    const supabase = getSupabaseBrowserClient();
    const realtime = supabase
      .channel(`team-chat:${activeId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_messages",
          filter: `channel_id=eq.${activeId}`,
        },
        (payload) => {
          if (activeIdRef.current !== activeId) return;
          if (payload.eventType === "DELETE") {
            const deletedId = (payload.old as { id?: unknown } | null)?.id;
            if (typeof deletedId === "string") {
              setMessages((current) =>
                current.filter((message) => message.id !== deletedId),
              );
            }
            return;
          }
          setMessages((current) =>
            mergeChatMessages(current, [payload.new as Message]),
          );
        },
      )
      .subscribe();
    return () => {
      clearInterval(activeWorkPoll);
      void supabase.removeChannel(realtime);
    };
  }, [activeId, loadActiveWork, loadMessages, markChannelRead]);

  useEffect(() => {
    let wasBackgrounded = document.visibilityState === "hidden";

    const reconcileForegroundState = async () => {
      if (
        document.visibilityState === "hidden" ||
        foregroundRefreshInFlightRef.current
      ) {
        return;
      }
      const channelId = activeIdRef.current;
      if (!channelId) return;

      foregroundRefreshInFlightRef.current = true;
      try {
        await Promise.allSettled([
          loadMessages(channelId),
          loadActiveWork(channelId),
          loadSidebar(),
        ]);
        if (activeIdRef.current === channelId) {
          await markChannelRead(channelId);
          // A suspended browser request is not authoritative. The refreshed
          // messages and durable run/task rows now own the visible state.
          setBusy(false);
        }
      } finally {
        foregroundRefreshInFlightRef.current = false;
        wasBackgrounded = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        wasBackgrounded = true;
        return;
      }
      if (wasBackgrounded) void reconcileForegroundState();
    };
    const handlePageHide = () => {
      wasBackgrounded = true;
    };
    const handlePageShow = () => {
      void reconcileForegroundState();
    };
    const handleFocus = () => {
      if (wasBackgrounded) void reconcileForegroundState();
    };
    const handleOnline = () => {
      void reconcileForegroundState();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, [loadActiveWork, loadMessages, loadSidebar, markChannelRead]);

  useLayoutEffect(() => {
    resizeChatComposer(draftRef.current);
  }, [activeId, draft]);

  const activeScheduleChannelId =
    channels.find(
      (candidate) =>
        candidate.id === activeId && candidate.kind === "channel",
    )?.id || null;

  useEffect(() => {
    if (!activeScheduleChannelId) {
      scheduledTasksRequestRef.current?.abort();
      scheduledTasksRequestRef.current = null;
      scheduledTasksChannelRef.current = null;
      setScheduledTasks([]);
      setScheduledTasksLoading(false);
      setScheduledTasksError(null);
      setScheduleMigrationPending(false);
      setScheduleBusyTaskId(null);
      return;
    }
    scheduledTasksRequestRef.current?.abort();
    scheduledTasksRequestRef.current = null;
    scheduledTasksChannelRef.current = activeScheduleChannelId;
    setScheduledTasks([]);
    setScheduledTasksLoading(false);
    setScheduledTasksError(null);
    setScheduleMigrationPending(false);
    setScheduleBusyTaskId(null);
    void loadScheduledTasks(activeScheduleChannelId);
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadScheduledTasks(activeScheduleChannelId, {
          background: true,
        });
      }
    }, 30_000);
    return () => {
      window.clearInterval(poll);
      scheduledTasksRequestRef.current?.abort();
      scheduledTasksRequestRef.current = null;
      if (
        scheduledTasksChannelRef.current === activeScheduleChannelId
      ) {
        scheduledTasksChannelRef.current = null;
      }
    };
  }, [activeScheduleChannelId, loadScheduledTasks]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, thinking]);

  const active = channels.find((channel) => channel.id === activeId) || null;
  const activeProfile =
    profiles.find((profile) => profile.id === active?.profile_id) || null;
  const profileById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile])),
    [profiles],
  );
  const workspaceChannels = useMemo(
    () => channels.filter((channel) => channel.kind === "channel"),
    [channels],
  );
  const directChannels = useMemo(
    () => channels.filter((channel) => channel.kind === "dm"),
    [channels],
  );
  const channelUnreadTotal = useMemo(
    () =>
      workspaceChannels.reduce(
        (total, channel) => total + channelUnreadCount(channel),
        0,
      ),
    [workspaceChannels],
  );
  const directUnreadTotal = useMemo(
    () =>
      directChannels.reduce(
        (total, channel) => total + channelUnreadCount(channel),
        0,
      ),
    [directChannels],
  );
  const totalUnreadCount = channelUnreadTotal + directUnreadTotal;
  const teammates = useMemo(
    () => people.filter((person) => person.user_id !== currentUserId),
    [currentUserId, people],
  );
  const normalizedSidebarQuery = sidebarQuery.trim().toLowerCase();
  const filteredWorkspaceChannels = useMemo(
    () =>
      workspaceChannels.filter((channel) =>
        channel.name.toLowerCase().includes(normalizedSidebarQuery),
      ),
    [normalizedSidebarQuery, workspaceChannels],
  );
  const filteredDirectChannels = useMemo(
    () =>
      directChannels.filter((channel) =>
        channel.name.toLowerCase().includes(normalizedSidebarQuery),
      ),
    [directChannels, normalizedSidebarQuery],
  );
  const filteredTeammates = useMemo(
    () =>
      teammates.filter((person) =>
        [person.email, person.role]
          .filter(Boolean)
          .some((value) =>
            String(value).toLowerCase().includes(normalizedSidebarQuery),
          ),
      ),
    [normalizedSidebarQuery, teammates],
  );
  const filteredAgents = useMemo(
    () =>
      agents.filter((agent) =>
        [agent.name, agent.harness, agent.model]
          .filter(Boolean)
          .some((value) =>
            String(value).toLowerCase().includes(normalizedSidebarQuery),
          ),
      ),
    [agents, normalizedSidebarQuery],
  );
  const sidebarResultCount =
    filteredWorkspaceChannels.length +
    filteredDirectChannels.length +
    (workspaceRole === "guest" ? 0 : filteredTeammates.length) +
    (workspaceRole === "guest" ? 0 : filteredAgents.length);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const canManageActive =
    Boolean(active) &&
    (workspaceRole === "admin" || active?.created_by === currentUserId);

  useEffect(() => {
    if (
      settingsQueryHandledRef.current ||
      !active ||
      active.kind !== "channel"
    ) {
      return;
    }
    settingsQueryHandledRef.current = true;
    if (
      new URLSearchParams(window.location.search).get("settings") === "1"
    ) {
      setChannelSettingsOpen(true);
    }
  }, [active]);
  const activeMembers = useMemo(
    () =>
      channelMembers.filter(
        (member) => member.channel_id === active?.id,
      ),
    [active?.id, channelMembers],
  );
  const activeHasOrchestrator = activeMembers.some(
    (member) => member.member_type === "orchestrator",
  );
  const canAttachImages =
    active?.kind === "channel" &&
    active.orchestrator_mode !== "off" &&
    activeHasOrchestrator;
  const selectedImagePreviews = useMemo(
    () =>
      selectedImages.map((file) => ({
        file,
        url: URL.createObjectURL(file),
      })),
    [selectedImages],
  );
  useEffect(
    () => () => {
      for (const preview of selectedImagePreviews) {
        URL.revokeObjectURL(preview.url);
      }
    },
    [selectedImagePreviews],
  );
  const mentionOptions = useMemo<ChatMentionOption[]>(() => {
    if (!active || active.kind !== "channel" || mentionQuery === null) {
      return [];
    }
    const query = mentionQuery.trim().toLowerCase();
    const mindName = activeProfile?.name || "Groovy";
    const mindHandle = teamChatMentionHandle(
      activeProfile?.slug || DEFAULT_TEAM_CHAT_MIND_HANDLE,
      DEFAULT_TEAM_CHAT_MIND_HANDLE,
    );
    const selectedAgents = selectedChannelAgents(agents, activeMembers);
    const selectedAgentIds = new Set(selectedAgents.map((agent) => agent.id));
    const mentionableAgents =
      workspaceRole === "admin" ? agents : selectedAgents;
    const options: ChatMentionOption[] = [
      {
        id: `mind:${activeProfile?.id || "default"}`,
        kind: "mind",
        handle: mindHandle,
        label: mindName,
        detail:
          active.orchestrator_mode === "off"
            ? "Mind replies are off in this channel"
            : "Channel Mind",
        included: true,
      },
      ...mentionableAgents.map((agent) => {
        const included = selectedAgentIds.has(agent.id);
        return {
          id: `agent:${agent.id}`,
          kind: "agent" as const,
          handle: teamChatMentionHandle(agent.name, "agent"),
          label: agent.name,
          detail: included
            ? `${agent.harness} · assigned to this channel`
            : `${agent.harness} · add to this channel`,
          included,
        };
      }),
      ...teammates.map((person) => {
        const included = activeMembers.some(
          (member) =>
            member.member_type === "user" &&
            member.user_id === person.user_id,
        );
        const email = person.email || "";
        return {
          id: `person:${person.user_id}`,
          kind: "person" as const,
          handle: teamChatMentionHandle(
            email.split("@")[0] || "teammate",
            "teammate",
          ),
          label: email || "Workspace member",
          detail: included
            ? "In this channel"
            : person.role === "guest"
              ? "Channel guest · add to this channel"
              : "Workspace member · add to this channel",
          included,
          email,
        };
      }),
    ];
    const filtered = options.filter((option) =>
      [option.handle, option.label, option.detail].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
    const emailCandidate = mentionQuery.trim().toLowerCase();
    const isExternalEmail =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCandidate) &&
      !people.some(
        (person) => person.email?.toLowerCase() === emailCandidate,
      );
    if (isExternalEmail && workspaceRole === "admin") {
      filtered.unshift({
        id: `invite:${emailCandidate}`,
        kind: "invite",
        handle: emailCandidate,
        label: `Invite ${emailCandidate}`,
        detail: `Invite as a channel guest to #${active.name}`,
        included: false,
        email: emailCandidate,
      });
    }
    return filtered;
  }, [
    active,
    activeMembers,
    activeProfile,
    agents,
    mentionQuery,
    people,
    teammates,
    workspaceRole,
  ]);

  useEffect(() => {
    setMentionActiveIndex(0);
  }, [mentionQuery]);

  const selectChannel = (id: string) => {
    if (activeIdRef.current !== id) {
      activeIdRef.current = id;
      setMessages([]);
      setMessagesLoading(true);
      setActiveWork({ orchestrator: null, agents: [] });
      setThinking(false);
    }
    setActiveId(id);
    setSelectedImages([]);
    setReplyTo(null);
    setMentionQuery(null);
    setMentionStart(null);
    setMentionEnd(null);
    setMobileNavOpen(false);
    // Room selection should not remount the entire chat workspace.
    window.history.replaceState(null, "", `/chat/${id}`);
  };

  const revealCreatedChannel = (
    channel: Channel,
    createdMembers: ChannelMember[] = [],
    createdSkillAssignments: ChannelSkillAssignment[] = [],
  ) => {
    setChannels((current) => {
      const existingIndex = current.findIndex(
        (candidate) => candidate.id === channel.id,
      );
      if (existingIndex < 0) return [...current, channel];
      return current.map((candidate, index) =>
        index === existingIndex ? channel : candidate,
      );
    });
    if (createdMembers.length > 0) {
      setChannelMembers((current) => [
        ...current.filter((member) => member.channel_id !== channel.id),
        ...createdMembers,
      ]);
    }
    if (createdSkillAssignments.length > 0) {
      setChannelSkillAssignments((current) => [
        ...current.filter(
          (assignment) => assignment.channel_id !== channel.id,
        ),
        ...createdSkillAssignments,
      ]);
    }
    selectChannel(channel.id);
    void loadSidebar().catch(() => undefined);
  };

  const setDesktopSidebarCollapsed = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    try {
      window.localStorage.setItem(
        "groovy-chat-sidebar-collapsed",
        collapsed ? "1" : "0",
      );
    } catch {
      // The in-memory preference still works for this session.
    }
  };

  const setSchedulePanelVisible = (open: boolean) => {
    setSchedulePanelOpen(open);
    if (!open) {
      window.requestAnimationFrame(() => {
        schedulePanelTriggerRef.current?.focus();
      });
    }
    try {
      if (window.matchMedia("(min-width: 1280px)").matches) {
        window.localStorage.setItem(
          "groovy-chat-schedule-panel-open",
          open ? "1" : "0",
        );
      }
    } catch {
      // The in-memory preference still works for this session.
    }
  };

  const toggleSidebarSection = (section: SidebarSection) => {
    setCollapsedSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  };

  const toggleSidebarSearch = () => {
    if (sidebarSearchOpen) {
      setSidebarSearchOpen(false);
      setSidebarQuery("");
      return;
    }
    setSidebarSearchOpen(true);
    window.requestAnimationFrame(() => sidebarSearchRef.current?.focus());
  };

  const openChannelComposer = () => {
    if (workspaceRole === "guest") return;
    setCollapsedSections((current) => ({ ...current, channels: false }));
    setSidebarSearchOpen(false);
    setSidebarQuery("");
    setChannelComposerOpen(true);
    if (window.matchMedia("(max-width: 767px)").matches) {
      setMobileNavOpen(true);
    } else {
      setDesktopSidebarCollapsed(false);
    }
  };

  const closeChannelComposer = () => {
    setChannelComposerOpen(false);
  };

  const createChannel = async (input: ChannelCreateInput) => {
    if (workspaceRole === "guest") {
      throw new Error("Channel guests cannot create channels.");
    }
    const res = await fetch("/api/chat/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || "Could not create channel.");
    }
    revealCreatedChannel(
      payload.channel as Channel,
      Array.isArray(payload.members) ? payload.members : [],
      Array.isArray(payload.skillAssignments) ? payload.skillAssignments : [],
    );
    setChannelComposerOpen(false);
  };

  const openAgentDm = async (agent: Agent) => {
    const existing = channels.find(
      (channel) => channel.kind === "dm" && channel.slug === `agent-${agent.id}`,
    );
    if (existing) {
      selectChannel(existing.id);
      return;
    }
    const openingId = `agent:${agent.id}`;
    if (openingConversation) return;
    setOpeningConversation({
      id: openingId,
      label: agent.name,
      kind: "agent",
    });
    setError(null);
    try {
      const res = await fetch("/api/chat/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "dm",
          name: agent.name,
          slug: `agent-${agent.id}`,
          agentIds: [agent.id],
          profileId: profiles.find((profile) => profile.is_default)?.id || null,
          orchestratorMode: "always",
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Could not open agent conversation.");
      }
      revealCreatedChannel(
        payload.channel as Channel,
        Array.isArray(payload.members) ? payload.members : [],
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not open agent conversation.",
      );
    } finally {
      setOpeningConversation((current) =>
        current?.id === openingId ? null : current,
      );
    }
  };

  const openPersonDm = async (person: Person) => {
    const existing = channels.find((channel) => {
      if (channel.kind !== "dm") return false;
      const members = channelMembers.filter(
        (member) => member.channel_id === channel.id,
      );
      const userIds = members
        .filter((member) => member.member_type === "user")
        .map((member) => member.user_id)
        .filter((id): id is string => Boolean(id));
      return (
        !members.some((member) => member.member_type === "agent") &&
        userIds.length === 2 &&
        userIds.includes(currentUserId) &&
        userIds.includes(person.user_id)
      );
    });
    if (existing) {
      selectChannel(existing.id);
      return;
    }

    const label = person.email?.split("@")[0] || "Teammate";
    const openingId = `person:${person.user_id}`;
    if (openingConversation) return;
    setOpeningConversation({
      id: openingId,
      label,
      kind: "person",
    });
    setError(null);
    try {
      const res = await fetch("/api/chat/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "dm",
          name: label,
          slug: `dm-${crypto.randomUUID()}`,
          userIds: [person.user_id],
          profileId: profiles.find((profile) => profile.is_default)?.id || null,
          orchestratorMode: "mention",
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Could not open teammate conversation.");
      }
      revealCreatedChannel(
        payload.channel as Channel,
        Array.isArray(payload.members) ? payload.members : [],
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not open teammate conversation.",
      );
    } finally {
      setOpeningConversation((current) =>
        current?.id === openingId ? null : current,
      );
    }
  };

  const updateMentionState = (value: string, cursor: number | null) => {
    if (!active || active.kind !== "channel" || cursor === null) {
      setMentionQuery(null);
      setMentionStart(null);
      setMentionEnd(null);
      return;
    }
    const prefix = value.slice(0, cursor);
    const match = prefix.match(/(?:^|\s)@([^\s]*)$/);
    if (!match) {
      setMentionQuery(null);
      setMentionStart(null);
      setMentionEnd(null);
      return;
    }
    const start = prefix.lastIndexOf("@");
    setMentionQuery(match[1] || "");
    setMentionStart(start);
    setMentionEnd(cursor);
  };

  const insertMention = (option: ChatMentionOption) => {
    if (mentionStart === null || mentionEnd === null) return;
    const before = draft.slice(0, mentionStart);
    const after = draft.slice(mentionEnd);
    const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
    const token = `@${option.handle}${needsTrailingSpace ? " " : ""}`;
    const nextDraft = `${before}${token}${after}`;
    const cursor = before.length + token.length;
    setDraft(nextDraft);
    setMentionQuery(null);
    setMentionStart(null);
    setMentionEnd(null);
    window.requestAnimationFrame(() => {
      draftRef.current?.focus();
      draftRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const selectMention = async (option: ChatMentionOption) => {
    if (!active || mentionBusyId) return;
    if (option.kind === "mind" && active.orchestrator_mode === "off") {
      setError(
        "The channel Mind is turned off. A workspace admin or the channel creator can enable @mention replies in room settings.",
      );
      setMentionQuery(null);
      setMentionStart(null);
      setMentionEnd(null);
      return;
    }
    if (option.kind === "invite") {
      setInviteContext({
        email: option.email || mentionQuery || "",
        channelId: active.id,
        channelName: active.name,
      });
      setPeopleInviteOpen(true);
      setMentionQuery(null);
      setMentionStart(null);
      setMentionEnd(null);
      return;
    }
    if (option.kind === "agent" && !option.included) {
      if (workspaceRole !== "admin") {
        setError("Only workspace admins can add agents to a channel.");
        setMentionQuery(null);
        setMentionStart(null);
        setMentionEnd(null);
        return;
      }
      setMentionBusyId(option.id);
      setError(null);
      try {
        const agentId = option.id.slice(option.id.indexOf(":") + 1);
        const res = await fetch(`/api/chat/channels/${active.id}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memberType: "agent", agentId }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 409) {
          throw new Error(payload.error || "Could not add this agent.");
        }
        await loadSidebar();
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Could not add this agent.",
        );
        setMentionBusyId(null);
        return;
      }
      setMentionBusyId(null);
      insertMention(option);
      return;
    }
    if (!option.included && option.kind !== "mind") {
      if (!canManageActive) {
        setError(
          "Only a workspace admin or this channel’s creator can add participants.",
        );
        setMentionQuery(null);
        return;
      }
      setMentionBusyId(option.id);
      setError(null);
      try {
        const memberType = "user";
        const memberId = option.id.slice(option.id.indexOf(":") + 1);
        const addsGuest =
          memberType === "user" &&
          people.some(
            (person) =>
              person.user_id === memberId && person.role === "guest",
          );
        const activeSkillCount = channelSkillAssignments.filter(
          (assignment) => assignment.channel_id === active.id,
        ).length;
        if (
          addsGuest &&
          activeSkillCount > 0 &&
          !window.confirm(
            `Add this channel guest? ${activeSkillCount} internal ${
              activeSkillCount === 1 ? "capability" : "capabilities"
            } will be paused while any guest participates.`,
          )
        ) {
          setMentionBusyId(null);
          return;
        }
        const res = await fetch(`/api/chat/channels/${active.id}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memberType, userId: memberId }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 409) {
          throw new Error(payload.error || "Could not add this participant.");
        }
        await loadSidebar();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not add this participant.",
        );
        setMentionBusyId(null);
        return;
      }
      setMentionBusyId(null);
    }
    insertMention(option);
  };

  const addImages = (files: File[]) => {
    const images = files.filter(isVisionImageFile);
    if (images.length !== files.length) {
      setError("Use a JPEG, PNG, WebP, or GIF image.");
    }
    if (images.length === 0) return;
    const remaining = MAX_INLINE_IMAGE_FILES - selectedImages.length;
    if (remaining <= 0) {
      setError(`Attach up to ${MAX_INLINE_IMAGE_FILES} images at a time.`);
      return;
    }
    setError(
      images.length > remaining
        ? `Attach up to ${MAX_INLINE_IMAGE_FILES} images at a time.`
        : null,
    );
    setSelectedImages((current) => [
      ...current,
      ...images.slice(0, remaining),
    ]);
  };

  const send = async () => {
    if (
      !active ||
      (!draft.trim() && selectedImages.length === 0) ||
      busy
    ) {
      return;
    }
    if (selectedImages.length > 0 && !canAttachImages) {
      setError(
        "Images can be shared in channels where the orchestrator is available.",
      );
      return;
    }
    const content = draft.trim();
    const images = selectedImages;
    const channelId = active.id;
    const replyTarget = replyTo;
    const clientMessageId = window.crypto.randomUUID();
    const optimisticMessageId = `optimistic:${clientMessageId}`;
    const optimisticMessage: Message = {
      id: optimisticMessageId,
      channel_id: channelId,
      author_type: "user",
      author_user_id: currentUserIdRef.current || null,
      author_agent_id: null,
      profile_id: null,
      content:
        content ||
        (images.length === 1
          ? "Shared an image"
          : `Shared ${images.length} images`),
      reply_to_message_id: replyTarget?.id || null,
      metadata: {
        client_message_id: clientMessageId,
        client_pending: true,
      },
      created_at: new Date().toISOString(),
    };
    const confirmationTimers: number[] = [];
    setBusy(true);
    setDraft("");
    setReplyTo(null);
    setSelectedImages([]);
    setMessages((current) =>
      mergeChatMessages(current, [optimisticMessage]),
    );
    setMentionQuery(null);
    setMentionStart(null);
    setMentionEnd(null);
    setError(null);
    try {
      const preparedImages =
        images.length > 0 ? await prepareInlineImageFiles(images) : [];
      confirmationTimers.push(
        ...[750, 2500].map((delay) =>
          window.setTimeout(() => {
            if (activeIdRef.current === channelId) {
              void loadMessages(channelId).catch(() => undefined);
            }
          }, delay),
        ),
      );
      const res = await fetch(`/api/chat/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          clientMessageId,
          replyToMessageId: replyTarget?.id || null,
          files: preparedImages.map((image) => ({
            mediaType: image.mediaType,
            base64: image.base64,
            filename: image.filename,
          })),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Could not send message.");
      }
      const received = [payload.message, payload.orchestrator].filter(Boolean);
      if (activeIdRef.current === channelId) {
        setMessages((current) =>
          mergeChatMessages(current, received as Message[]),
        );
        if (payload.error) setError(payload.error);
        const queuedTask =
          payload.agentTask &&
          typeof payload.agentTask === "object" &&
          typeof payload.agentTask.id === "string" &&
          typeof payload.agentTask.agentId === "string" &&
          typeof payload.agentTask.agentName === "string"
            ? (payload.agentTask as ActiveAgentTask)
            : null;
        if (queuedTask) {
          const current =
            activeWorkSnapshotRef.current.channelId === channelId
              ? activeWorkSnapshotRef.current.work
              : { orchestrator: null, agents: [] };
          const next = {
            ...current,
            agents: [
              ...current.agents.filter((task) => task.id !== queuedTask.id),
              queuedTask,
            ],
          };
          activeWorkSnapshotRef.current = { channelId, work: next };
          setActiveWork(next);
        }
        void loadActiveWork(channelId).catch(() => undefined);
      }
      if (
        active.kind === "channel" &&
        activeIdRef.current === channelId
      ) {
        void loadScheduledTasks(channelId);
      }
    } catch (cause) {
      if (activeIdRef.current === channelId) {
        const [messagesResult] = await Promise.allSettled([
          loadMessages(channelId),
          loadActiveWork(channelId),
        ]);
        const messageWasDelivered =
          messagesResult.status === "fulfilled" &&
          messagesResult.value.some(
            (message) =>
              chatClientMessageId(message) === clientMessageId,
          );
        if (!messageWasDelivered) {
          setMessages((current) =>
            current.filter(
              (message) => message.id !== optimisticMessageId,
            ),
          );
          setDraft((current) => (current.trim() ? current : content));
          setReplyTo((current) => current || replyTarget);
          setSelectedImages((current) =>
            [...images, ...current].slice(0, MAX_INLINE_IMAGE_FILES),
          );
        }
        setError(
          messageWasDelivered
            ? "Message delivered, but the response connection was interrupted."
            : cause instanceof Error
              ? cause.message
              : "Could not send message.",
        );
      }
    } finally {
      for (const timer of confirmationTimers) {
        window.clearTimeout(timer);
      }
      setBusy(false);
      if (activeIdRef.current === channelId) {
        void loadActiveWork(channelId).catch(() => undefined);
      }
    }
  };

  const manageScheduledTask = async (
    taskId: string,
    action: ChannelScheduleAction,
  ) => {
    if (!active || active.kind !== "channel" || scheduleBusyTaskId) return;
    const channelId = active.id;
    setScheduleBusyTaskId(taskId);
    setScheduledTasksError(null);
    try {
      const response = await fetch(
        `/api/chat/channels/${channelId}/scheduled-tasks`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: taskId, action }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          payload.error || "Could not update the scheduled task.",
        );
      }
      if (scheduledTasksChannelRef.current === channelId) {
        await loadScheduledTasks(channelId);
      }
    } catch (cause) {
      if (scheduledTasksChannelRef.current === channelId) {
        setScheduledTasksError(
          cause instanceof Error
            ? cause.message
            : "Could not update the scheduled task.",
        );
      }
    } finally {
      if (scheduledTasksChannelRef.current === channelId) {
        setScheduleBusyTaskId(null);
      }
    }
  };

  const startSchedulePrompt = () => {
    if (!active || active.kind !== "channel") return;
    if (active.orchestrator_mode === "off") {
      setSchedulePanelVisible(false);
      setError(
        "Enable this channel’s Mind before creating a scheduled task.",
      );
      setChannelSettingsOpen(true);
      return;
    }
    const handle = teamChatMentionHandle(
      activeProfile?.slug || DEFAULT_TEAM_CHAT_MIND_HANDLE,
      DEFAULT_TEAM_CHAT_MIND_HANDLE,
    );
    setDraft((current) =>
      current.trim() ? current : `@${handle} Schedule `,
    );
    setMentionQuery(null);
    setMentionStart(null);
    setMentionEnd(null);
    if (window.matchMedia("(max-width: 1279px)").matches) {
      setSchedulePanelVisible(false);
    }
    window.requestAnimationFrame(() => {
      draftRef.current?.focus();
      const length = draftRef.current?.value.length || 0;
      draftRef.current?.setSelectionRange(length, length);
    });
  };

  const controlWork = async (args: {
    action: "stop" | "redirect";
    target: "orchestrator" | "agent";
    taskId?: string;
    label: string;
  }) => {
    if (!active) return;
    let direction = "";
    if (args.action === "redirect") {
      direction =
        window.prompt(
          `Redirect ${args.label}\n\nGive the new direction. Current work will be stopped first.`,
        )?.trim() || "";
      if (!direction) return;
    } else if (
      !window.confirm(
        `Stop ${args.label}? The current model or connector run will be canceled. Actions already completed are not rolled back.`,
      )
    ) {
      return;
    }

    const busyKey = `${args.target}:${args.taskId || "orchestrator"}:${args.action}`;
    setControlBusy(busyKey);
    setError(null);
    try {
      const res = await fetch(`/api/chat/channels/${active.id}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: args.action,
          target: args.target,
          taskId: args.taskId,
          direction: direction || undefined,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || `Could not ${args.action} ${args.label}.`);
      }
      if (Array.isArray(payload.taskWarnings) && payload.taskWarnings.length > 0) {
        setError(
          `The orchestrator was controlled, but one delegated task could not be stopped: ${payload.taskWarnings[0]}`,
        );
      } else if (typeof payload.cancellationWarning === "string") {
        setError(
          `The task is canceled in Groovy, but local process termination was not confirmed: ${payload.cancellationWarning}`,
        );
      }
      await Promise.all([
        loadActiveWork(active.id),
        loadMessages(active.id),
      ]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `Could not ${args.action} ${args.label}.`,
      );
    } finally {
      setControlBusy(null);
    }
  };

  return (
    <div className="app-viewport-shell flex overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <WorkspaceSwitcher
        modalOnly
        fallbackName={workspaceName}
        switchDestination="/chat"
      />
      {/* Mobile: the sidebar becomes a slide-over so the conversation gets the
          full viewport. md+ keeps the fixed rail. */}
      {mobileNavOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close channels panel"
        />
      ) : null}
      <aside
        className={`${
          mobileNavOpen
            ? "visible translate-x-0"
            : "invisible pointer-events-none -translate-x-full md:visible md:pointer-events-auto"
        } fixed inset-y-0 left-0 z-40 flex w-80 max-w-[calc(100vw-1rem)] shrink-0 flex-col border-r border-[var(--glass-border)] bg-[var(--bg-secondary)] shadow-2xl shadow-black/50 transition-transform duration-200 ease-out max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] md:static md:z-auto md:w-64 md:max-w-none md:translate-x-0 md:bg-[var(--bg-secondary)]/70 md:shadow-none ${
          sidebarCollapsed ? "md:hidden" : "md:flex"
        }`}
        aria-label="Channels, people, and agents"
        aria-busy={!workspaceReady}
      >
        <div className="border-b border-[var(--glass-border)] px-4 py-4">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              {workspaceReady ? (
                <WorkspaceSwitcher
                  fallbackName={workspaceName}
                  switchDestination="/chat"
                  showPendingGate={false}
                />
              ) : (
                <span className="block h-4 w-28 animate-pulse rounded bg-white/[0.07] motion-reduce:animate-none" />
              )}
            </div>
            <button
              type="button"
              onClick={toggleSidebarSearch}
              disabled={!workspaceReady}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-white/5 hover:text-white ${
                sidebarSearchOpen ? "bg-white/[0.06] text-cyan-300" : ""
              } disabled:opacity-35`}
              aria-label={sidebarSearchOpen ? "Close sidebar search" : "Search sidebar"}
              aria-expanded={sidebarSearchOpen}
              aria-controls="chat-sidebar-search"
              title="Search"
            >
              <Search className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-white/5 hover:text-white md:hidden"
              aria-label="Close channels panel"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setDesktopSidebarCollapsed(true)}
              className="hidden rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-white/5 hover:text-white md:inline-flex"
              aria-label="Hide channels panel"
              title="Hide channels panel"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
                <path d="m15 9-3 3 3 3" />
              </svg>
            </button>
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            <AppNav compact />
          </div>
          {sidebarSearchOpen ? (
            <div
              id="chat-sidebar-search"
              className="relative mt-3"
            >
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
              <input
                ref={sidebarSearchRef}
                type="search"
                value={sidebarQuery}
                onChange={(event) => {
                  const nextQuery = event.target.value;
                  setSidebarQuery(nextQuery);
                  if (nextQuery.trim()) {
                    setCollapsedSections({
                      channels: false,
                      direct: false,
                      people: false,
                      agents: false,
                    });
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSidebarQuery("");
                    setSidebarSearchOpen(false);
                  }
                }}
                placeholder="Search channels and people"
                className="w-full rounded-xl border border-[var(--glass-border)] bg-black/25 py-2.5 pl-9 pr-8 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-400/35 focus:ring-2 focus:ring-cyan-400/10"
                aria-label="Search channels, people, and agents"
              />
              {sidebarQuery ? (
                <button
                  type="button"
                  onClick={() => {
                    setSidebarQuery("");
                    sidebarSearchRef.current?.focus();
                  }}
                  className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-zinc-500 hover:bg-white/5 hover:text-white"
                  aria-label="Clear sidebar search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div ref={sidebarScrollRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {!workspaceReady ? (
            <SidebarLoadingState />
          ) : (
            <>
          {normalizedSidebarQuery && sidebarResultCount === 0 ? (
            <div className="mx-2 mt-3 rounded-xl border border-dashed border-white/10 px-3 py-5 text-center">
              <p className="text-xs text-zinc-500">No matches for “{sidebarQuery.trim()}”.</p>
              <button
                type="button"
                onClick={() => {
                  setSidebarQuery("");
                  sidebarSearchRef.current?.focus();
                }}
                className="mt-2 text-xs text-cyan-400 hover:text-cyan-300"
              >
                Clear search
              </button>
            </div>
          ) : null}
          <SidebarSectionHeader
            label="Channels"
            count={filteredWorkspaceChannels.length}
            unreadCount={channelUnreadTotal}
            controls="chat-sidebar-channels"
            collapsed={collapsedSections.channels}
            onToggle={() => toggleSidebarSection("channels")}
            action={
              workspaceRole !== "guest" ? (
                <button
                  type="button"
                  onClick={openChannelComposer}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-base leading-none text-[var(--text-secondary)] hover:bg-white/5 hover:text-white"
                  aria-label="Create channel"
                  title="Create channel"
                >
                  +
                </button>
              ) : null
            }
          />
          <div id="chat-sidebar-channels">
            {!collapsedSections.channels
              ? filteredWorkspaceChannels.map((channel) => (
                  <SidebarRoomButton
                    key={channel.id}
                    channel={channel}
                    active={channel.id === activeId}
                    onSelect={selectChannel}
                  />
                ))
              : null}
          </div>
          <SidebarSectionHeader
            label="Direct"
            count={filteredDirectChannels.length}
            unreadCount={directUnreadTotal}
            controls="chat-sidebar-direct"
            collapsed={collapsedSections.direct}
            onToggle={() => toggleSidebarSection("direct")}
          />
          <div id="chat-sidebar-direct">
            {!collapsedSections.direct
              ? filteredDirectChannels.map((channel) => (
                  <SidebarRoomButton
                    key={channel.id}
                    channel={channel}
                    active={channel.id === activeId}
                    onSelect={selectChannel}
                  />
                ))
              : null}
          </div>
          <SidebarSectionHeader
            label="People"
            count={workspaceRole === "guest" ? 0 : filteredTeammates.length}
            controls="chat-sidebar-people"
            collapsed={collapsedSections.people}
            onToggle={() => toggleSidebarSection("people")}
            action={
              workspaceRole === "admin" ? (
                <button
                  type="button"
                  onClick={() => {
                    setInviteContext(null);
                    setPeopleInviteOpen(true);
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-base leading-none text-[var(--text-secondary)] hover:bg-white/5 hover:text-white"
                  aria-label="Invite people"
                  title="Invite people"
                >
                  +
                </button>
              ) : null
            }
          />
          <div id="chat-sidebar-people">
            {!collapsedSections.people && workspaceRole !== "guest"
              ? filteredTeammates.map((person) => (
                  <button
                    key={person.user_id}
                    onClick={() => void openPersonDm(person)}
                    disabled={Boolean(openingConversation)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-white disabled:cursor-wait disabled:opacity-55"
                  >
                    <span className="flex h-4 w-4 items-center justify-center text-[var(--accent-green)]">
                      {openingConversation?.id ===
                      `person:${person.user_id}` ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                      ) : (
                        "●"
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {person.email?.split("@")[0] || "Teammate"}
                    </span>
                    <span className="text-[9px] uppercase tracking-wider text-zinc-600">
                      {person.role === "guest" ? "guest" : person.role}
                    </span>
                  </button>
                ))
              : null}
            {!collapsedSections.people &&
            workspaceRole !== "guest" &&
            teammates.length === 0 &&
            !normalizedSidebarQuery ? (
              <p className="px-3 py-2 text-xs text-zinc-600">
                No teammates yet.
              </p>
            ) : null}
          </div>
          <SidebarSectionHeader
            label="Agents"
            count={workspaceRole === "guest" ? 0 : filteredAgents.length}
            controls="chat-sidebar-agents"
            collapsed={collapsedSections.agents}
            onToggle={() => toggleSidebarSection("agents")}
          />
          <div id="chat-sidebar-agents">
            {!collapsedSections.agents && workspaceRole !== "guest"
              ? filteredAgents.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => void openAgentDm(agent)}
                    disabled={Boolean(openingConversation)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-white disabled:cursor-wait disabled:opacity-55"
                  >
                    <span
                      className={
                        agent.deviceOnline
                          ? "text-emerald-400"
                          : "text-zinc-600"
                      }
                    >
                      {openingConversation?.id === `agent:${agent.id}` ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                      ) : (
                        "◆"
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate">{agent.name}</span>
                      <span className="block truncate text-[10px] opacity-60">
                        {agent.harness}
                        {agent.model ? ` · ${agent.model}` : ""}
                      </span>
                    </span>
                  </button>
                ))
              : null}
          </div>
            </>
          )}
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {sidebarCollapsed ? (
          <button
            type="button"
            onClick={() => setDesktopSidebarCollapsed(false)}
            className="absolute left-3 top-2.5 z-20 hidden rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] p-2 text-[var(--text-secondary)] shadow-lg hover:text-white md:inline-flex"
            aria-label={`Show channels panel${
              totalUnreadCount > 0
                ? `, ${totalUnreadCount} unread ${
                    totalUnreadCount === 1 ? "message" : "messages"
                  }`
                : ""
            }`}
            title={
              totalUnreadCount > 0
                ? `${totalUnreadCount} unread ${
                    totalUnreadCount === 1 ? "message" : "messages"
                  }`
                : "Show channels panel"
            }
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
              <path d="m13 9 3 3-3 3" />
            </svg>
            {totalUnreadCount > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-[var(--bg-primary)] bg-cyan-300 px-1 text-[8px] font-bold text-[#071014]">
                {totalUnreadCount > 99 ? "99+" : totalUnreadCount}
              </span>
            ) : null}
          </button>
        ) : null}
        {!workspaceReady ? (
          <WorkspaceLoadingState />
        ) : workspaceLoadError ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <div className="max-w-sm rounded-2xl border border-red-400/15 bg-red-400/[0.04] px-6 py-5">
              <h1 className="text-base font-medium">Couldn’t open Team Chat</h1>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {workspaceLoadError}
              </p>
              <button
                type="button"
                onClick={() => {
                  setWorkspaceReady(false);
                  void hydrateWorkspace();
                }}
                className="mt-4 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-zinc-200 transition hover:bg-white/[0.08]"
              >
                Try again
              </button>
            </div>
          </div>
        ) : active ? (
          <>
            <header
              className={`flex items-center gap-3 border-b border-[var(--glass-border)] bg-[var(--bg-secondary)]/40 px-4 py-3 sm:px-5 ${
                sidebarCollapsed ? "md:pl-16" : ""
              }`}
            >
              <button
                onClick={() => setMobileNavOpen(true)}
                className="relative -ml-1 shrink-0 rounded-lg p-2 text-[var(--text-secondary)] hover:text-white md:hidden"
                aria-label={`Open channels${
                  totalUnreadCount > 0
                    ? `, ${totalUnreadCount} unread ${
                        totalUnreadCount === 1 ? "message" : "messages"
                      }`
                    : ""
                }`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
                {totalUnreadCount > 0 ? (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-[var(--bg-primary)] bg-cyan-300 px-1 text-[8px] font-bold text-[#071014]">
                    {totalUnreadCount > 99 ? "99+" : totalUnreadCount}
                  </span>
                ) : null}
              </button>
              <div className="min-w-0 flex-1">
                <h1 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                  {active.kind === "channel" &&
                  active.visibility === "private" ? (
                    <Lock
                      className="h-3.5 w-3.5 shrink-0 text-zinc-400"
                      aria-label="Private channel"
                    />
                  ) : active.kind === "channel" ? (
                    <span className="shrink-0 text-zinc-500">#</span>
                  ) : null}
                  <span className="truncate">{active.name}</span>
                </h1>
                {active.topic ? (
                  <p className="truncate text-xs text-[var(--text-secondary)]">{active.topic}</p>
                ) : null}
              </div>
              <RoomNotificationMenu
                room={{
                  id: active.id,
                  kind: active.kind,
                  name: active.name,
                }}
              />
              {active.kind === "channel" ? (
                <>
                  <button
                    ref={schedulePanelTriggerRef}
                    type="button"
                    onClick={() =>
                      setSchedulePanelVisible(!schedulePanelOpen)
                    }
                    className={`relative flex h-9 shrink-0 items-center gap-2 rounded-lg border px-2.5 text-xs transition ${
                      schedulePanelOpen
                        ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
                        : "border-[var(--glass-border)] text-[var(--text-secondary)] hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
                    }`}
                    aria-label={`${
                      schedulePanelOpen ? "Hide" : "Show"
                    } scheduled tasks for ${active.name}`}
                    aria-expanded={schedulePanelOpen}
                    title="Scheduled tasks"
                  >
                    <CalendarClock className="h-4 w-4" />
                    <span className="hidden 2xl:inline">Scheduled</span>
                    {scheduledTasks.length > 0 ? (
                      <span className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full border border-[#0d0f13] bg-cyan-300 px-1 text-center text-[8px] font-semibold leading-4 text-[#071014]">
                        {Math.min(scheduledTasks.length, 99)}
                      </span>
                    ) : null}
                  </button>
                  <div className="hidden items-center gap-2 lg:flex">
                    <span className="max-w-40 truncate rounded-full border border-[var(--glass-border)] bg-black/15 px-2.5 py-1 text-[10px] text-zinc-500">
                      {activeProfile?.name || "Groovy default"}
                    </span>
                    <span className="rounded-full border border-[var(--glass-border)] bg-black/15 px-2.5 py-1 text-[10px] text-zinc-500">
                      {active.orchestrator_mode === "always"
                        ? "Always listening"
                        : active.orchestrator_mode === "off"
                          ? "Humans only"
                          : "@mention"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setChannelSettingsOpen(true)}
                    className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[var(--glass-border)] px-2.5 text-xs text-[var(--text-secondary)] transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
                    aria-label="Open channel settings"
                    title="Channel settings"
                  >
                    <Settings2 className="h-4 w-4" />
                    <span className="hidden sm:inline">Settings</span>
                  </button>
                </>
              ) : null}
            </header>

            <div className="relative flex min-h-0 flex-1">
              <section className="flex min-w-0 flex-1 flex-col">
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {messagesLoading && messages.length === 0 ? (
                <div
                  className="animate-pulse space-y-5 py-2 motion-reduce:animate-none"
                  aria-label="Loading conversation"
                >
                  {[56, 72, 44].map((width, index) => (
                    <div key={width} className="flex gap-3">
                      <div className="h-8 w-8 shrink-0 rounded-full bg-white/[0.06]" />
                      <div className="min-w-0 flex-1 pt-1">
                        <div className="h-3 w-20 rounded bg-white/[0.07]" />
                        <div
                          className="mt-3 h-3 rounded bg-white/[0.045]"
                          style={{ width: `${width}%` }}
                        />
                        {index === 1 ? (
                          <div className="mt-2 h-3 w-2/5 rounded bg-white/[0.035]" />
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {messages.map((message) => {
                const isPending = isPendingChatMessage(message);
                const quoted = message.reply_to_message_id
                  ? messageById.get(message.reply_to_message_id)
                  : null;
                const profile = message.profile_id
                  ? profileById.get(message.profile_id)
                  : activeProfile;
                const isTaskResult =
                  message.metadata?.kind === "agent_task_result";
                const agentName =
                  typeof message.metadata?.agent_name === "string"
                    ? message.metadata.agent_name
                    : "Agent";
                const imageAttachments = messageImageAttachments(
                  message.metadata,
                );
                const isImageOnly =
                  message.metadata?.image_only === true &&
                  imageAttachments.length > 0;
                const authorPerson =
                  message.author_user_id === currentUserId
                    ? "You"
                    : people
                        .find(
                          (person) =>
                            person.user_id === message.author_user_id,
                        )
                        ?.email?.split("@")[0] || "Teammate";
                const label =
                  message.author_type === "orchestrator"
                    ? profile?.name || "Groovy"
                    : message.author_type === "agent"
                      ? agentName
                      : message.author_type === "system"
                        ? "System"
                        : authorPerson;
                return (
                  <article
                    key={message.id}
                    className={`group mb-4 flex gap-3 ${
                      isPending ? "opacity-75" : ""
                    }`}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--glass-border)] bg-[var(--bg-tertiary)] text-xs">
                      {message.author_type === "orchestrator" ? "✦" : label.slice(0, 1)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span
                          className={
                            message.author_type === "orchestrator"
                              ? "font-medium text-[var(--accent-cyan)]"
                              : "font-medium"
                          }
                        >
                          {label}
                        </span>
                        <time className="text-[10px] text-[var(--text-secondary)]">
                          {isPending
                            ? "Sending…"
                            : displayTime(message.created_at)}
                        </time>
                        <button
                          onClick={() => setReplyTo(message)}
                          disabled={isPending}
                          className="px-1 py-1 text-[11px] text-[var(--text-secondary)] opacity-60 disabled:pointer-events-none disabled:opacity-0 sm:opacity-0 sm:group-hover:opacity-100"
                        >
                          Reply
                        </button>
                      </div>
                      {quoted ? (
                        <div className="my-1 border-l-2 border-[var(--glass-border)] pl-2 text-xs text-[var(--text-secondary)]">
                          {quoted.metadata?.image_only === true
                            ? "Image"
                            : quoted.content.slice(0, 180)}
                        </div>
                      ) : null}
                      {isTaskResult ? (
                        <div
                          className={`mt-1 rounded-xl border px-4 py-3 ${
                            message.metadata?.status === "done"
                              ? "border-emerald-400/30 bg-emerald-400/[0.06]"
                              : "border-red-400/30 bg-red-400/[0.06]"
                          }`}
                        >
                          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">
                            Worker task ·{" "}
                            {message.metadata?.status === "done"
                              ? "completed"
                              : "failed"}
                          </div>
                          <p className="whitespace-pre-wrap text-[14px] leading-relaxed">
                            {message.content}
                          </p>
                        </div>
                      ) : (
                        <>
                          {!isImageOnly ? (
                            <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
                              {message.content}
                            </p>
                          ) : null}
                          {imageAttachments.length > 0 ? (
                            <div
                              className={`mt-2 grid max-w-xl gap-2 ${
                                imageAttachments.length === 1
                                  ? "grid-cols-1"
                                  : "grid-cols-2"
                              }`}
                            >
                              {imageAttachments.map((attachment, index) => (
                                <a
                                  key={attachment.id}
                                  href={`/api/chat/channels/${message.channel_id}/attachments/${attachment.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={`group/image relative overflow-hidden rounded-xl border border-white/10 bg-black/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/50 ${
                                    imageAttachments.length === 3 && index === 0
                                      ? "col-span-2"
                                      : ""
                                  }`}
                                  aria-label={`Open ${attachment.name}`}
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={`/api/chat/channels/${message.channel_id}/attachments/${attachment.id}`}
                                    alt={attachment.name}
                                    loading="lazy"
                                    className={`w-full object-cover transition duration-200 group-hover/image:scale-[1.01] ${
                                      imageAttachments.length === 1
                                        ? "max-h-[28rem]"
                                        : "h-36 sm:h-44"
                                    }`}
                                  />
                                  <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/75 to-transparent px-3 pb-2 pt-8 text-[10px] text-white/75 opacity-0 transition group-hover/image:opacity-100 group-focus-visible/image:opacity-100">
                                    {attachment.name}
                                  </span>
                                </a>
                              ))}
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
              {thinking ? (
                <div className="animate-pulse text-sm text-[var(--accent-cyan)]">
                  {activeProfile?.name || "Groovy"} is working…
                </div>
              ) : null}
              {activeWork.orchestrator ? (
                <div className="mt-3 max-w-xl rounded-xl border border-cyan-400/30 bg-cyan-400/[0.06] p-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-cyan-400/30 text-cyan-300">
                      ✦
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        {activeProfile?.name || "Groovy"} is working
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
                        {activeWork.orchestrator.status === "stop_requested"
                          ? "Stopping current run…"
                          : activeWork.orchestrator.status === "redirect_requested"
                            ? "Applying a teammate’s redirect…"
                            : "Anyone in this room can stop or redirect this run."}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void controlWork({
                          action: "redirect",
                          target: "orchestrator",
                          label: activeProfile?.name || "the orchestrator",
                        })
                      }
                      disabled={
                        controlBusy !== null ||
                        activeWork.orchestrator.status !== "running"
                      }
                      className="rounded-lg border border-cyan-400/30 px-2.5 py-1.5 text-xs text-cyan-200 disabled:opacity-40"
                    >
                      Redirect
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void controlWork({
                          action: "stop",
                          target: "orchestrator",
                          label: activeProfile?.name || "the orchestrator",
                        })
                      }
                      disabled={
                        controlBusy !== null ||
                        activeWork.orchestrator.status !== "running"
                      }
                      className="rounded-lg border border-red-400/30 px-2.5 py-1.5 text-xs text-red-300 disabled:opacity-40"
                    >
                      Stop
                    </button>
                  </div>
                </div>
              ) : null}
              {activeWork.agents.map((task) => (
                <div
                  key={task.id}
                  className="mt-3 max-w-xl rounded-xl border border-violet-400/25 bg-violet-400/[0.05] p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-violet-400/30 text-violet-300">
                      ◆
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{task.title}</div>
                      <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
                        {task.agentName} ·{" "}
                        {task.status === "awaiting_approval"
                          ? "awaiting approval"
                          : task.status}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void controlWork({
                          action: "redirect",
                          target: "agent",
                          taskId: task.id,
                          label: task.agentName,
                        })
                      }
                      disabled={controlBusy !== null}
                      className="rounded-lg border border-violet-400/30 px-2.5 py-1.5 text-xs text-violet-200 disabled:opacity-40"
                    >
                      Redirect
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void controlWork({
                          action: "stop",
                          target: "agent",
                          taskId: task.id,
                          label: task.agentName,
                        })
                      }
                      disabled={controlBusy !== null}
                      className="rounded-lg border border-red-400/30 px-2.5 py-1.5 text-xs text-red-300 disabled:opacity-40"
                    >
                      Stop
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t border-[var(--glass-border)] bg-[var(--bg-secondary)]/40 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              {replyTo ? (
                <div className="mb-2 flex items-center justify-between rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                  <span className="truncate">Replying to: {replyTo.content}</span>
                  <button onClick={() => setReplyTo(null)}>×</button>
                </div>
              ) : null}
              <div className="relative rounded-xl border border-[var(--glass-border)] bg-[var(--bg-primary)] focus-within:border-cyan-400/30">
                {mentionQuery !== null ? (
                  <ChatMentionMenu
                    options={mentionOptions}
                    activeIndex={Math.min(
                      mentionActiveIndex,
                      Math.max(0, mentionOptions.length - 1),
                    )}
                    busyId={mentionBusyId}
                    onSelect={(option) => void selectMention(option)}
                  />
                ) : null}
                {selectedImagePreviews.length > 0 ? (
                  <div className="flex gap-2 overflow-x-auto px-3 pt-3">
                    {selectedImagePreviews.map(({ file, url }, index) => (
                      <div
                        key={`${file.name}-${file.lastModified}-${index}`}
                        className="group/preview relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-black/30"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={url}
                          alt={file.name}
                          className="h-full w-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedImages((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index),
                            )
                          }
                          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-black/75 text-white shadow-sm transition hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
                          aria-label={`Remove ${file.name}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                        <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/65 px-1.5 py-1 text-[9px] text-white/75">
                          {file.name}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="flex items-end gap-2 px-3 py-3 sm:gap-3">
                  {canAttachImages ? (
                    <>
                      <input
                        ref={imageInputRef}
                        type="file"
                        accept={VISION_IMAGE_ACCEPT}
                        multiple
                        className="sr-only"
                        onChange={(event) => {
                          addImages(Array.from(event.target.files || []));
                          event.target.value = "";
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => imageInputRef.current?.click()}
                        disabled={
                          busy ||
                          selectedImages.length >= MAX_INLINE_IMAGE_FILES
                        }
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40 disabled:opacity-35"
                        aria-label="Attach images"
                        title="Attach images"
                      >
                        <ImagePlus className="h-[18px] w-[18px]" />
                      </button>
                    </>
                  ) : null}
                  <textarea
                    ref={draftRef}
                    rows={1}
                    wrap="soft"
                    value={draft}
                    onPaste={(event) => {
                      if (!canAttachImages) return;
                      const pastedFiles = Array.from(
                        event.clipboardData.files || [],
                      ).filter(isVisionImageFile);
                      if (pastedFiles.length === 0) return;
                      event.preventDefault();
                      addImages(pastedFiles);
                    }}
                    onChange={(event) => {
                      resizeChatComposer(event.currentTarget);
                      setDraft(event.target.value);
                      updateMentionState(
                        event.target.value,
                        event.target.selectionStart,
                      );
                    }}
                    onKeyDown={(event) => {
                      const isComposing = event.nativeEvent.isComposing;
                      const mobileKeyboard = usesMobileComposerKeyboard();
                      if (
                        !isComposing &&
                        mentionQuery !== null &&
                        (event.key === "ArrowDown" || event.key === "ArrowUp")
                      ) {
                        event.preventDefault();
                        setMentionActiveIndex((current) => {
                          if (mentionOptions.length === 0) return 0;
                          const delta = event.key === "ArrowDown" ? 1 : -1;
                          return (
                            (current + delta + mentionOptions.length) %
                            mentionOptions.length
                          );
                        });
                        return;
                      }
                      if (
                        !isComposing &&
                        mentionQuery !== null &&
                        !event.shiftKey &&
                        (event.key === "Tab" ||
                          (event.key === "Enter" && !mobileKeyboard)) &&
                        mentionOptions.length > 0
                      ) {
                        event.preventDefault();
                        const option =
                          mentionOptions[
                            Math.min(
                              mentionActiveIndex,
                              mentionOptions.length - 1,
                            )
                          ];
                        if (option) void selectMention(option);
                        return;
                      }
                      if (
                        !isComposing &&
                        mentionQuery !== null &&
                        event.key === "Escape"
                      ) {
                        event.preventDefault();
                        setMentionQuery(null);
                        setMentionStart(null);
                        setMentionEnd(null);
                        return;
                      }
                      if (
                        !isComposing &&
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !mobileKeyboard
                      ) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    onClick={(event) =>
                      updateMentionState(
                        event.currentTarget.value,
                        event.currentTarget.selectionStart,
                      )
                    }
                    onBlur={() => {
                      window.setTimeout(() => {
                        if (document.activeElement !== draftRef.current) {
                          setMentionQuery(null);
                        }
                      }, 120);
                    }}
                    placeholder={`Message ${active.kind === "channel" ? "#" : ""}${active.name} — use @ to summon`}
                    className="max-h-40 min-h-9 min-w-0 flex-1 resize-none overflow-x-hidden whitespace-pre-wrap break-words bg-transparent py-2 text-sm leading-5 outline-none"
                    aria-haspopup="listbox"
                    aria-autocomplete="list"
                    aria-controls={
                      mentionQuery !== null ? "chat-mention-menu" : undefined
                    }
                  />
                  <button
                    onClick={() => void send()}
                    disabled={
                      busy || (!draft.trim() && selectedImages.length === 0)
                    }
                    className="mb-0.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-300 disabled:opacity-40"
                  >
                    {busy ? "Sending…" : "Send"}
                  </button>
                </div>
              </div>
              {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
            </div>
              </section>
              {active.kind === "channel" && schedulePanelOpen ? (
                <ChannelScheduledTasksPanel
                  channelName={active.name}
                  tasks={scheduledTasks}
                  loading={scheduledTasksLoading}
                  error={scheduledTasksError}
                  migrationPending={scheduleMigrationPending}
                  busyTaskId={scheduleBusyTaskId}
                  canCreate={workspaceRole !== "guest"}
                  onAction={manageScheduledTask}
                  onClose={() => setSchedulePanelVisible(false)}
                  onRefresh={() => void loadScheduledTasks(active.id)}
                  onCreatePrompt={startSchedulePrompt}
                />
              ) : null}
            </div>
          </>
        ) : openingConversation ? (
          <ConversationOpeningState conversation={openingConversation} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <button
              onClick={() => setMobileNavOpen(true)}
              className="relative mb-4 rounded-lg border border-[var(--glass-border)] px-3 py-2 text-xs text-[var(--text-secondary)] hover:text-white md:hidden"
            >
              ☰ Channels & agents
              {totalUnreadCount > 0 ? (
                <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-300 px-1 text-[8px] font-bold text-[#071014]">
                  {totalUnreadCount > 99 ? "99+" : totalUnreadCount}
                </span>
              ) : null}
            </button>
            <h1 className="text-xl font-semibold">Start a room where work happens</h1>
            <p className="mt-2 max-w-md text-sm text-[var(--text-secondary)]">
              Create a channel, bind a Mind, and invite the orchestrator or an agent with @mentions.
            </p>
            {workspaceRole !== "guest" ? (
              <button
                onClick={openChannelComposer}
                className="mt-5 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-300"
              >
                Create first channel
              </button>
            ) : null}
            {error ? <p className="mt-3 text-xs text-red-300">{error}</p> : null}
          </div>
        )}
      </main>
      {channelComposerOpen && workspaceRole !== "guest" ? (
        <ChannelCreateModal
          profiles={profiles}
          agents={agents}
          people={people}
          skills={skills}
          currentUserId={currentUserId}
          canAssignAgents={workspaceRole === "admin"}
          onClose={closeChannelComposer}
          onCreate={createChannel}
        />
      ) : null}
      {channelSettingsOpen && active && active.kind === "channel" ? (
        <ChannelSettingsModal
          channel={active}
          profiles={profiles}
          people={people}
          agents={agents}
          skills={skills}
          members={channelMembers.filter(
            (member) => member.channel_id === active.id,
          )}
          skillAssignments={channelSkillAssignments.filter(
            (assignment) => assignment.channel_id === active.id,
          )}
          canManage={canManageActive}
          canManageAgents={workspaceRole === "admin"}
          onInviteNew={() => {
            setChannelSettingsOpen(false);
            setInviteContext({
              email: "",
              channelId: active.id,
              channelName: active.name,
            });
            setPeopleInviteOpen(true);
          }}
          onClose={() => setChannelSettingsOpen(false)}
          onChanged={async () => {
            await loadSidebar();
          }}
        />
      ) : null}
      {peopleInviteOpen && workspaceRole === "admin" ? (
        <PeopleInviteModal
          channels={channels
            .filter((channel) => channel.kind === "channel")
            .map((channel) => ({
              id: channel.id,
              name: channel.name,
              visibility: channel.visibility,
            }))}
          initialEmail={inviteContext?.email || ""}
          initialChannelIds={
            inviteContext?.channelId ? [inviteContext.channelId] : []
          }
          initialRole={inviteContext?.channelId ? "guest" : "member"}
          reason={
            inviteContext?.channelId
              ? inviteContext.email
                ? `${inviteContext.email} is not in this workspace yet. Invite them as a guest with access to #${inviteContext.channelName}?`
                : `Invite someone with scoped access to #${inviteContext.channelName}.`
              : undefined
          }
          onClose={() => {
            setPeopleInviteOpen(false);
            setInviteContext(null);
          }}
        />
      ) : null}
    </div>
  );
}
