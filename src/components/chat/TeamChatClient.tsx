"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  AtSign,
  Bookmark,
  Bold,
  Braces,
  CalendarClock,
  Check,
  CheckSquare,
  Brain,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  FileText,
  Italic,
  Link2,
  List as ListIcon,
  ListOrdered,
  Lock,
  LoaderCircle,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  Quote,
  Search,
  Send,
  Smile,
  Settings2,
  Strikethrough,
  Terminal,
  Underline,
  Upload,
  Video,
  Webhook,
  X,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { webhookMessageLabel } from "@/lib/chat/incomingWebhook";
import {
  insertTextAtSelection,
  pasteTextPreservingStructure,
} from "@/lib/composer/pasteFormatting";
import { AppHeader } from "@/components/AppHeader";
import { useConnectorDevice } from "@/hooks/useConnectorDevice";
import dynamic from "next/dynamic";
import type {
  ChannelCreateInput,
  ChannelSkillOption,
} from "@/components/chat/ChannelCreateModal";
import type { DirectMessagePersonOption } from "@/components/chat/DirectMessageCreateModal";

// The large conditional panels/modals stay out of the boot bundle; each chunk
// loads on first open. Everything rendered during a cold paint of the
// timeline must remain statically imported.
const ChannelSettingsModal = dynamic(
  () =>
    import("@/components/chat/ChannelSettingsModal").then(
      (mod) => mod.ChannelSettingsModal,
    ),
  { ssr: false },
);
const ChannelCreateModal = dynamic(
  () =>
    import("@/components/chat/ChannelCreateModal").then(
      (mod) => mod.ChannelCreateModal,
    ),
  { ssr: false },
);
const DirectMessageCreateModal = dynamic(
  () =>
    import("@/components/chat/DirectMessageCreateModal").then(
      (mod) => mod.DirectMessageCreateModal,
    ),
  { ssr: false },
);
import {
  ChatMentionMenu,
  type ChatMentionOption,
} from "@/components/chat/ChatMentionMenu";
import type { ChannelThreadMessageView } from "@/components/chat/ChannelThreadPanel";
import {
  orchestratorToolLabel,
  type OrchestratorProgress,
} from "@/lib/chat/orchestratorProgress";

const PeopleInviteModal = dynamic(
  () =>
    import("@/components/chat/PeopleInviteModal").then(
      (mod) => mod.PeopleInviteModal,
    ),
  { ssr: false },
);
const ChannelScheduledTasksPanel = dynamic(
  () =>
    import("@/components/chat/ChannelScheduledTasksPanel").then(
      (mod) => mod.ChannelScheduledTasksPanel,
    ),
  { ssr: false },
);
const ChannelThreadPanel = dynamic(
  () =>
    import("@/components/chat/ChannelThreadPanel").then(
      (mod) => mod.ChannelThreadPanel,
    ),
  { ssr: false },
);
import { RoomNotificationMenu } from "@/components/notifications/RoomNotificationControl";
import { WorkspaceSwitcher } from "@/components/workspaces/WorkspaceSwitcher";
import { FormattedMessageContent } from "@/components/common/FormattedMessageContent";
import {
  type ChannelScheduleAction,
  type ChannelScheduledTask,
} from "@/lib/chat/channelSchedules";
import {
  CHAT_ATTACHMENT_ACCEPT,
  chatAttachmentOnlyMessage,
  isChatImageAttachment,
  isSupportedChatAttachmentFile,
  MAX_CHAT_ATTACHMENT_FILES,
  prepareChatAttachmentFiles,
} from "@/lib/chat/attachments.client";
import {
  chatMentionTrigger,
  DEFAULT_TEAM_CHAT_MIND_HANDLE,
  teamChatMentionHandle,
} from "@/lib/chat/mentions";
import {
  incomingUnreadDisposition,
  normalizeUnreadCount,
} from "@/lib/chat/unread";
import {
  readLastChatChannel,
  rememberLastChatChannel,
  resolveLastChatChannel,
} from "@/lib/chat/lastChannel";
import {
  clearChatWorkspaceCaches,
  readChatCacheUserId,
  readChatChannelMessages,
  readChatComposerDrafts,
  readChatWorkspaceCache,
  rememberChatCacheUserId,
  writeChatChannelMessages,
  writeChatComposerDraft,
  writeChatWorkspaceCache,
} from "@/lib/chat/workspaceCache";
import { APP_NAVIGATE_EVENT } from "@/lib/navigation/appNavigationEvent";
import {
  chatMessageDeliveryConfirmed,
  isPendingChatMessage,
  mergeChatMessages,
  reconcileChatMessagesAfterRequest,
  reconcileLatestChatMessageWindow,
} from "@/lib/chat/messageMerge";
import {
  chatMessageLengthError,
  MAX_CHAT_MESSAGE_CHARACTERS,
} from "@/lib/chat/messageLimits";
import {
  chatChannelDisplayName,
  isHumanDirectMessageForParticipants,
  isHumanDirectMessageForRecipient,
  selfDirectMessageSlug,
} from "@/lib/chat/directMessages";
import {
  channelAgentIds,
  isAgentDirectMessageForRecipient,
  selectedChannelAgents,
} from "@/lib/chat/channelAgentRoster";
import {
  threadRootId as resolveThreadRootId,
} from "@/lib/chat/threadBoundary";
import type { ChatMessagePageInfo } from "@/lib/chat/messagePagination";
import {
  activeCustomStatus,
  chatTypingIndicatorFromBroadcast,
  groupMessageReactions,
  memberDisplayName,
  mergeChatHuddleParticipant,
  mergeChatTypingIndicator,
  replaceChannelTypingIndicators,
  socialSchemaUnavailable,
  typingLabel,
  type ChatChannelPin,
  type ChatHuddle,
  type ChatHuddleParticipant,
  type ChatMemberPresence,
  type ChatMemberProfile,
  type ChatMessageReaction,
  type ChatTypingIndicator,
} from "@/lib/chat/social";
import { ChatMemberAvatar } from "@/components/chat/ChatMemberAvatar";
import { ChatSearchDialog } from "@/components/chat/ChatSearchDialog";

const ChatProfileModal = dynamic(
  () =>
    import("@/components/chat/ChatProfileModal").then(
      (mod) => mod.ChatProfileModal,
    ),
  { ssr: false },
);
import {
  ChatThreadsDialog,
  type ChatThreadInboxItem,
} from "@/components/chat/ChatThreadsDialog";
import { ChatMessageActions } from "@/components/chat/ChatMessageActions";
import { ChannelHuddle } from "@/components/chat/ChannelHuddle";
import { ChatNativeNudge } from "@/components/chat/ChatNativeNudge";
import { ChatVoiceRecorderButton } from "@/components/chat/ChatVoiceRecorderButton";
import { isDesktopShell } from "@/lib/desktop/shell";
import { ChatTextSnippetCard } from "@/components/chat/ChatTextSnippetCard";
import { ChatTextSnippetModal } from "@/components/chat/ChatTextSnippetModal";
import { ChatDateSeparator } from "@/components/chat/ChatDateSeparator";
import {
  applyChatComposerFormat,
  type ChatComposerFormat,
} from "@/lib/chat/composerFormatting";
import { shouldGroupChatMessage } from "@/lib/chat/messageGrouping";
import { isDifferentChatCalendarDate } from "@/lib/chat/messageDates";
import {
  messageTextSnippet,
  textSnippetMessage,
  type ChatTextSnippet,
} from "@/lib/chat/snippets";
import {
  formatVoiceNoteDuration,
  prepareChatVoiceNote,
  type PendingChatVoiceNote,
} from "@/lib/chat/voiceNotes.client";
import { CHAT_MESSAGE_RECEIVED_EVENT } from "@/lib/chat/events";
import { chatSearchRoomScopeLabel } from "@/lib/chat/searchScope";
import {
  chatWorkspaceActivationState,
  handoffPendingOrchestratorStart,
  keyedOperationPending,
  shouldFollowTimelineGrowth,
  updateKeyedValue,
  updatePendingCount,
} from "@/lib/chat/conversationState";
import type { TeamChatVisibleOrchestratorRunStatus } from "@/lib/chat/orchestratorRunState";
import { mergeChronologicalChatTimeline } from "@/lib/chat/timelineEntries";
import { latestPersistedChatMessageCursor } from "@/lib/chat/messageSync";
import { mindContinuationPending } from "@/lib/chat/mindContinuation";

type Channel = {
  id: string;
  kind: "channel" | "dm";
  name: string;
  display_name?: string | null;
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
  thread_root_message_id?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

type MainComposerState = {
  draft: string;
  selectedImages: File[];
  voiceNote: PendingChatVoiceNote | null;
  textSnippet: ChatTextSnippet | null;
  replyTo: Message | null;
  resendSource: Message | null;
};

const EMPTY_MAIN_COMPOSER_STATE: MainComposerState = {
  draft: "",
  selectedImages: [],
  voiceNote: null,
  textSnippet: null,
  replyTo: null,
  resendSource: null,
};

type MessageImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

type MessageFileAttachment = MessageImageAttachment;

type MessageVoiceAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  previewUrl?: string;
};

const EMPTY_MESSAGE_PAGE_INFO: ChatMessagePageInfo = {
  hasOlder: false,
  olderCursor: null,
  hasNewer: false,
  newerCursor: null,
};

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function messagePageInfo(value: unknown): ChatMessagePageInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_MESSAGE_PAGE_INFO;
  }
  const candidate = value as Record<string, unknown>;
  return {
    hasOlder: candidate.hasOlder === true,
    olderCursor:
      typeof candidate.olderCursor === "string"
        ? candidate.olderCursor
        : null,
    hasNewer: candidate.hasNewer === true,
    newerCursor:
      typeof candidate.newerCursor === "string"
        ? candidate.newerCursor
        : null,
  };
}

function numericThreadReplyCounts(value: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return counts;
  }
  for (const [rootId, count] of Object.entries(value)) {
    if (
      /^[0-9a-f-]{36}$/i.test(rootId) &&
      typeof count === "number" &&
      Number.isFinite(count)
    ) {
      counts.set(rootId, Math.max(0, Math.floor(count)));
    }
  }
  return counts;
}

type Profile = {
  id: string;
  name: string;
  slug: string;
  agent_roster?: string[] | null;
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

/* Shape of the /api/chat/channels payload, which is applied both from the
 * network and from the localStorage workspace cache on cold opens. */
type ChatSidebarChannelsPayload = {
  channels?: Channel[];
  workspace?: {
    id?: string;
    name?: string;
    currentUserId?: string;
    role?: string;
    members?: Person[];
  } | null;
  memberProfiles?: ChatMemberProfile[];
  presence?: ChatMemberPresence[];
  activeHuddles?: ChatHuddle[];
  huddleParticipants?: ChatHuddleParticipant[];
  socialMigrationPending?: boolean;
  members?: ChannelMember[];
  profiles?: Profile[];
  agents?: Agent[];
  skills?: ChannelSkillOption[];
  skillAssignments?: ChannelSkillAssignment[];
};

type ChatSidebarProfilesPayload = {
  profiles?: Profile[];
};

type ActiveOrchestratorRun = {
  id: string;
  trace_id: string;
  status: TeamChatVisibleOrchestratorRunStatus;
  profile_id: string | null;
  started_by: string | null;
  control_requested_by: string | null;
  started_at: string;
  control_requested_at: string | null;
  thread_root_message_id: string | null;
  progress: OrchestratorProgress;
};

type ActiveAgentTask = {
  id: string;
  status: "queued" | "running" | "awaiting_approval";
  title: string;
  agentId: string;
  agentName: string;
  canDecide?: boolean;
  traceId: string | null;
  startedAt?: string;
  threadRootMessageId?: string | null;
  liveText?: string;
  liveTextTruncated?: boolean;
  liveTools?: Array<{
    name: string;
    input: string;
  }>;
  liveEvents?: Array<
    | {
        seq: number;
        type: "assistant";
        content: string;
      }
    | {
        seq: number;
        type: "tool_use";
        name: string;
        input: string;
      }
  >;
  liveEventCount?: number;
  liveEventsTruncated?: boolean;
  progressUpdatedAt?: string | null;
};

type ActiveWork = {
  orchestrator: ActiveOrchestratorRun | null;
  agents: ActiveAgentTask[];
};

type ActiveTimelineWork =
  | {
      kind: "orchestrator";
      run: ActiveOrchestratorRun;
    }
  | {
      kind: "agent";
      task: ActiveAgentTask;
    };

function AgentTaskLiveActivity({ task }: { task: ActiveAgentTask }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const liveText =
    typeof task.liveText === "string" ? task.liveText.trimStart() : "";
  const liveTools = useMemo(
    () => (Array.isArray(task.liveTools) ? task.liveTools : []),
    [task.liveTools],
  );
  const orderedEvents = useMemo(() => {
    type DisplayEvent =
      | { key: string; type: "assistant"; content: string }
      | {
          key: string;
          type: "tool_use";
          name: string;
          input: string;
        };
    const events: DisplayEvent[] = [];
    if (!Array.isArray(task.liveEvents)) return events;

    for (const event of task.liveEvents) {
      if (event.type === "assistant" && event.content) {
        const previous = events[events.length - 1];
        if (previous?.type === "assistant") {
          previous.content += event.content;
          previous.key = `${previous.key}-${event.seq}`;
        } else {
          events.push({
            key: `assistant-${event.seq}`,
            type: "assistant",
            content: event.content,
          });
        }
      } else if (event.type === "tool_use" && event.name) {
        events.push({
          key: `tool-${event.seq}`,
          type: "tool_use",
          name: event.name,
          input: event.input || "",
        });
      }
    }
    return events;
  }, [task.liveEvents]);
  const hasOrderedEvents = orderedEvents.length > 0;

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [liveText, liveTools, orderedEvents, task.progressUpdatedAt]);

  if (task.status !== "running") return null;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-violet-300/10 bg-black/25">
      <div className="flex items-center gap-2 border-b border-white/[0.055] px-3 py-2">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-300 motion-reduce:animate-none" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-violet-200">
          Live activity
        </span>
        <span className="truncate text-[10px] text-zinc-600">
          Narrated progress from {task.agentName}
        </span>
        {typeof task.liveEventCount === "number" &&
        task.liveEventCount > 0 ? (
          <span className="ml-auto shrink-0 text-[9px] tabular-nums text-zinc-600">
            {task.liveEventCount}{" "}
            {task.liveEventCount === 1 ? "event" : "events"}
          </span>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className="max-h-52 space-y-3 overflow-y-auto px-3 py-2.5"
        aria-live="polite"
      >
        {task.liveTextTruncated || task.liveEventsTruncated ? (
          <p className="text-[10px] text-zinc-600">…earlier activity hidden…</p>
        ) : null}

        {hasOrderedEvents ? (
          <div className="space-y-2">
            {orderedEvents.map((event) => {
              if (event.type === "assistant") {
                return (
                  <FormattedMessageContent
                    key={event.key}
                    content={event.content}
                    className="space-y-2 text-xs leading-relaxed text-zinc-400"
                    textClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                  />
                );
              }
              const Icon =
                event.name === "Read"
                  ? FileText
                  : event.name === "Edit" || event.name === "Write"
                    ? Pencil
                    : event.name === "Task"
                      ? Brain
                      : event.name === "Grep" || event.name === "Glob"
                        ? Search
                        : Terminal;
              return (
                <div
                  key={event.key}
                  className="rounded-lg border border-white/[0.055] bg-white/[0.025] px-2.5 py-2"
                >
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <Icon className="h-3 w-3 shrink-0 text-violet-300/70" />
                    <span className="font-medium text-zinc-300">
                      {event.name}
                    </span>
                  </div>
                  {event.input ? (
                    <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-zinc-500 [overflow-wrap:anywhere]">
                      {event.input}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <>
            {liveTools.length > 0 ? (
              <div>
                <div className="mb-1.5 text-[9px] font-medium uppercase tracking-[0.14em] text-zinc-600">
                  Tool activity
                </div>
                <div className="space-y-1.5">
                  {liveTools.map((tool, index) => {
                    const Icon =
                      tool.name === "Read"
                        ? FileText
                        : tool.name === "Edit" || tool.name === "Write"
                          ? Pencil
                          : tool.name === "Task"
                            ? Brain
                            : tool.name === "Grep" || tool.name === "Glob"
                              ? Search
                              : Terminal;
                    return (
                      <div
                        key={`${tool.name}-${index}-${tool.input}`}
                        className="rounded-lg border border-white/[0.055] bg-white/[0.025] px-2.5 py-2"
                      >
                        <div className="flex items-center gap-1.5 text-[11px]">
                          <Icon className="h-3 w-3 shrink-0 text-violet-300/70" />
                          <span className="font-medium text-zinc-300">
                            {tool.name}
                          </span>
                        </div>
                        {tool.input ? (
                          <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-zinc-500 [overflow-wrap:anywhere]">
                            {tool.input}
                          </pre>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {liveText ? (
              <div>
                <div className="mb-1.5 text-[9px] font-medium uppercase tracking-[0.14em] text-zinc-600">
                  Thinking
                </div>
                <FormattedMessageContent
                  content={liveText}
                  className="space-y-2 text-xs leading-relaxed text-zinc-400"
                  textClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                />
              </div>
            ) : liveTools.length === 0 ? (
              <div className="flex items-center gap-2 py-1 text-xs text-zinc-500">
                <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                Starting delegated work…
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

type WorkControlArgs = {
  action: "stop" | "redirect";
  target: "orchestrator" | "agent";
  taskId?: string;
  label: string;
};

function OrchestratorStartingCard({
  profileName,
  phase = "starting",
}: {
  profileName: string;
  phase?: "starting" | "continuing";
}) {
  const continuing = phase === "continuing";
  return (
    <div
      className="mt-3 max-w-xl rounded-xl border border-cyan-400/25 bg-cyan-400/[0.05] p-4"
      role="status"
      aria-live="polite"
      aria-label={
        continuing
          ? `${profileName} is reviewing delegated work`
          : `${profileName} is starting`
      }
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-cyan-400/30 text-cyan-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {continuing
              ? `${profileName} is reviewing the Agent’s result`
              : `${profileName} is getting ready`}
          </div>
          <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
            {continuing
              ? "Preparing the next action or final response…"
              : "Starting the run and connecting live activity…"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-cyan-300/15 bg-cyan-300/[0.06] px-2 py-1 text-[10px] text-cyan-200">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300 motion-reduce:animate-none" />
          {continuing ? "Reviewing" : "Starting"}
        </div>
      </div>
      <div className="mt-3 overflow-hidden rounded-lg border border-cyan-300/10 bg-black/20">
        <div className="flex items-center gap-2 border-b border-white/[0.055] px-3 py-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-300 motion-reduce:animate-none" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan-200">
            {continuing
              ? "Mind continuation in progress"
              : "Preparing live activity"}
          </span>
        </div>
        <div
          className="space-y-2.5 px-3 py-3 motion-safe:animate-pulse"
          aria-hidden="true"
        >
          <div className="h-2 w-3/4 rounded-full bg-white/[0.08]" />
          <div className="h-2 w-1/2 rounded-full bg-white/[0.055]" />
        </div>
      </div>
    </div>
  );
}

function OrchestratorWorkCard({
  run,
  profileName,
  controlBusy,
  onControl,
}: {
  run: ActiveOrchestratorRun;
  profileName: string;
  controlBusy: string | null;
  onControl: (args: WorkControlArgs) => void;
}) {
  const scrollRef = useRef<HTMLOListElement | null>(null);
  const progressEvents = useMemo(
    () =>
      Array.isArray(run.progress?.events) ? run.progress.events : [],
    [run.progress],
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [progressEvents, run.progress?.updatedAt]);

  return (
    <div className="mt-3 max-w-xl rounded-xl border border-cyan-400/30 bg-cyan-400/[0.06] p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-cyan-400/30 text-cyan-300">
          ✦
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{profileName} is working</div>
          <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
            {run.status === "stop_requested"
              ? "Stopping current run…"
              : run.status === "redirect_requested"
                ? "Applying a teammate’s redirect…"
                : run.status === "finalizing"
                  ? "Finishing the response and delegated-work handoff…"
                  : "Anyone in this room can stop or redirect this run."}
          </div>
        </div>
        <button
          type="button"
          onClick={() =>
            onControl({
              action: "redirect",
              target: "orchestrator",
              label: profileName,
            })
          }
          disabled={controlBusy !== null || run.status !== "running"}
          className="rounded-lg border border-cyan-400/30 px-2.5 py-1.5 text-xs text-cyan-200 disabled:opacity-40"
        >
          Redirect
        </button>
        <button
          type="button"
          onClick={() =>
            onControl({
              action: "stop",
              target: "orchestrator",
              label: profileName,
            })
          }
          disabled={controlBusy !== null || run.status !== "running"}
          className="rounded-lg border border-red-400/30 px-2.5 py-1.5 text-xs text-red-300 disabled:opacity-40"
        >
          Stop
        </button>
      </div>
      <div className="mt-3 overflow-hidden rounded-lg border border-cyan-300/10 bg-black/20">
        <div className="flex items-center gap-2 border-b border-white/[0.055] px-3 py-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-300 motion-reduce:animate-none" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan-200">
            Live activity
          </span>
          <span className="text-[10px] text-zinc-600">
            Safe progress from {profileName}
          </span>
        </div>
        <ol
          ref={scrollRef}
          className="max-h-44 space-y-1.5 overflow-y-auto px-3 py-2.5"
          aria-live="polite"
        >
          {progressEvents.length > 0 ? (
            progressEvents.map((event) => (
              <li key={event.id} className="flex items-center gap-2 text-xs">
                {event.status === "running" ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-cyan-300 motion-reduce:animate-none" />
                ) : event.status === "failed" ? (
                  <X className="h-3 w-3 shrink-0 text-red-300" />
                ) : (
                  <Check className="h-3 w-3 shrink-0 text-emerald-300" />
                )}
                <span className={event.status === "running" ? "text-zinc-200" : "text-zinc-500"}>
                  {orchestratorToolLabel(event.toolName)}
                  {event.agent ? ` · ${event.agent}` : ""}
                </span>
              </li>
            ))
          ) : (
            <li className="flex items-center gap-2 text-xs text-zinc-500">
              Planning the next step…
            </li>
          )}
        </ol>
      </div>
    </div>
  );
}

function AgentWorkCard({
  task,
  controlBusy,
  onControl,
  onDecide,
}: {
  task: ActiveAgentTask;
  controlBusy: string | null;
  onControl: (args: WorkControlArgs) => void;
  onDecide: (
    task: ActiveAgentTask,
    action: "approve" | "reject",
  ) => void;
}) {
  return (
    <div
      className={`mt-3 max-w-xl rounded-xl border p-4 ${
        task.status === "awaiting_approval"
          ? "border-amber-400/40 bg-amber-400/[0.055]"
          : "border-violet-400/25 bg-violet-400/[0.05]"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
            task.status === "awaiting_approval"
              ? "border-amber-400/40 text-amber-300"
              : "border-violet-400/30 text-violet-300"
          }`}
        >
          ◆
        </div>
        <div className="min-w-0 flex-1">
          <div className="break-words text-sm font-medium">{task.title}</div>
          <div
            className={`mt-0.5 text-xs ${
              task.status === "awaiting_approval"
                ? "text-amber-200/80"
                : "text-[var(--text-secondary)]"
            }`}
          >
            {task.agentName} ·{" "}
            {task.status === "awaiting_approval"
              ? task.canDecide
                ? "needs your approval"
                : "waiting for workspace owner approval"
              : task.status}
          </div>
        </div>
        {task.status !== "awaiting_approval" ? (
          <>
            <button
              type="button"
              onClick={() =>
                onControl({
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
                onControl({
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
          </>
        ) : null}
      </div>
      {task.status === "awaiting_approval" && task.canDecide ? (
        <div className="mt-3 border-t border-amber-300/10 pt-3">
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            Approve to let {task.agentName} start this work, or reject to
            cancel it. You can decide here without leaving Chat.
          </p>
          <div
            className="mt-3 grid grid-cols-2 gap-2"
            role="group"
            aria-label={`Approval for ${task.title}`}
          >
            <button
              type="button"
              onClick={() => onDecide(task, "approve")}
              disabled={controlBusy !== null}
              className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-emerald-400/25 bg-emerald-400/15 px-3 text-sm font-medium text-emerald-300 transition hover:bg-emerald-400/25 disabled:cursor-wait disabled:opacity-45"
            >
              {controlBusy === `agent:${task.id}:approve` ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Approve &amp; run
            </button>
            <button
              type="button"
              onClick={() => onDecide(task, "reject")}
              disabled={controlBusy !== null}
              className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 text-sm font-medium text-red-300 transition hover:bg-red-400/20 disabled:cursor-wait disabled:opacity-45"
            >
              {controlBusy === `agent:${task.id}:reject` ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <X className="h-4 w-4" />
              )}
              Reject
            </button>
          </div>
        </div>
      ) : null}
      <AgentTaskLiveActivity task={task} />
    </div>
  );
}

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
  const hasUnread = unread > 0;
  const displayName = chatChannelDisplayName(channel);
  const unreadLabel = `${unread} unread ${
    unread === 1 ? "message" : "messages"
  }`;
  return (
    <button
      type="button"
      onClick={() => onSelect(channel.id)}
      aria-label={hasUnread ? `${displayName}, ${unreadLabel}` : displayName}
      aria-current={active ? "page" : undefined}
      title={`Open ${displayName}`}
      className={`group relative flex w-full cursor-pointer items-center rounded-xl border px-3 py-2 text-left text-sm transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40 ${
        active
          ? "border-cyan-300/25 bg-cyan-400/[0.12] font-medium text-white shadow-[inset_3px_0_0_rgba(34,211,238,0.85),0_4px_16px_rgba(0,0,0,0.16)]"
          : hasUnread
            ? "border-cyan-300/10 bg-cyan-400/[0.065] font-medium text-white shadow-[inset_3px_0_0_rgba(34,211,238,0.65)] hover:-translate-y-px hover:border-cyan-300/25 hover:bg-cyan-400/[0.11]"
            : "border-transparent text-[var(--text-secondary)] hover:-translate-y-px hover:border-white/10 hover:bg-white/[0.055] hover:text-white hover:shadow-sm"
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
      <span className="min-w-0 flex-1 truncate">{displayName}</span>
      {hasUnread ? (
        <UnreadBadge count={unread} />
      ) : (
        <ChevronRight
          className={`ml-2 h-3.5 w-3.5 shrink-0 transition ${
            active
              ? "text-cyan-300 opacity-100"
              : "translate-x-[-2px] text-zinc-600 opacity-0 group-hover:translate-x-0 group-hover:opacity-100"
          }`}
          aria-hidden="true"
        />
      )}
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
    Math.max(textarea.scrollHeight, 52),
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

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1_000) return `${sizeBytes} B`;
  if (sizeBytes < 1_000_000) return `${Math.ceil(sizeBytes / 1_000)} KB`;
  return `${(sizeBytes / 1_000_000).toFixed(1)} MB`;
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
        typeof value.sizeBytes !== "number" ||
        !value.mimeType.startsWith("image/")
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
    .slice(0, MAX_CHAT_ATTACHMENT_FILES);
}

function messageFileAttachments(
  metadata: Record<string, unknown> | null | undefined,
): MessageFileAttachment[] {
  if (!Array.isArray(metadata?.attachments)) return [];
  return metadata.attachments
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const value = raw as Record<string, unknown>;
      if (
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        typeof value.mimeType !== "string" ||
        typeof value.sizeBytes !== "number" ||
        value.mimeType.startsWith("image/") ||
        value.mimeType.startsWith("audio/")
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
    .filter((value): value is MessageFileAttachment => Boolean(value))
    .slice(0, MAX_CHAT_ATTACHMENT_FILES);
}

function messageVoiceAttachment(
  metadata: Record<string, unknown> | null | undefined,
): MessageVoiceAttachment | null {
  const raw = metadata?.voice_note;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.mimeType !== "string" ||
    !value.mimeType.startsWith("audio/") ||
    typeof value.sizeBytes !== "number" ||
    typeof value.durationMs !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    durationMs: value.durationMs,
    previewUrl:
      typeof value.previewUrl === "string" ? value.previewUrl : undefined,
  };
}

function scheduledTaskRunErrorMessage(error: string): string {
  switch (error) {
    case "device_not_online":
    case "no_connector_devices":
      return "No online connector could be reached. Reconnect it and try again.";
    case "scheduled_job_requires_assigned_connector":
      return "This task is tied to its original connector. Start that connector and try again.";
    case "scheduled_job_target_device_not_owned":
      return "This task cannot move to the selected shared connector. Start one of your own connectors and try again.";
    case "job_not_found":
      return "The connector has not synced this task yet. Refresh and try again.";
    case "scheduled_job_rebind_failed":
    case "scheduled_job_sync_failed":
      return "Could not synchronize this task to the online connector. Try again.";
    default:
      return "Could not start this scheduled task.";
  }
}

export function TeamChatClient({
  visible,
  initialChannelId,
  initialThreadRootId,
}: {
  visible: boolean;
  initialChannelId?: string;
  initialThreadRootId?: string;
}) {
  const headerDevice = useConnectorDevice();
  const [workspaceId, setWorkspaceId] = useState("");
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
  const [directComposerOpen, setDirectComposerOpen] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [memberProfiles, setMemberProfiles] = useState<ChatMemberProfile[]>([]);
  const [memberPresence, setMemberPresence] = useState<ChatMemberPresence[]>([]);
  const [activeHuddles, setActiveHuddles] = useState<ChatHuddle[]>([]);
  const [huddleParticipants, setHuddleParticipants] = useState<
    ChatHuddleParticipant[]
  >([]);
  const [socialMigrationPending, setSocialMigrationPending] = useState(false);
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
  const [messageContext, setMessageContext] = useState<Message[]>([]);
  const [messageReactions, setMessageReactions] = useState<
    ChatMessageReaction[]
  >([]);
  const [channelPins, setChannelPins] = useState<ChatChannelPin[]>([]);
  const [savedMessageIds, setSavedMessageIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [typingIndicators, setTypingIndicators] = useState<
    ChatTypingIndicator[]
  >([]);
  const [messagesLoading, setMessagesLoading] = useState(
    Boolean(initialChannelId),
  );
  const [timelinePageInfo, setTimelinePageInfo] =
    useState<ChatMessagePageInfo>(EMPTY_MESSAGE_PAGE_INFO);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [threadPageInfo, setThreadPageInfo] =
    useState<ChatMessagePageInfo>(EMPTY_MESSAGE_PAGE_INFO);
  const [threadInitialLoading, setThreadInitialLoading] = useState(false);
  const [threadHistoryLoading, setThreadHistoryLoading] = useState(false);
  const [serverThreadReplyCounts, setServerThreadReplyCounts] = useState<
    Map<string, number>
  >(() => new Map());
  const [snippetModalOpen, setSnippetModalOpen] = useState(false);
  const [snippetModalMode, setSnippetModalMode] = useState<
    "snippet" | "canvas"
  >("snippet");
  const [snippetModalTarget, setSnippetModalTarget] = useState<
    "main" | "thread"
  >("main");
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [threadDraft, setThreadDraft] = useState("");
  const [threadSelectedImages, setThreadSelectedImages] = useState<File[]>([]);
  const [threadVoiceNote, setThreadVoiceNote] =
    useState<PendingChatVoiceNote | null>(null);
  const [threadTextSnippet, setThreadTextSnippet] =
    useState<ChatTextSnippet | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [threadResendSource, setThreadResendSource] =
    useState<Message | null>(null);
  const [unreadThreadRoots, setUnreadThreadRoots] = useState<Set<string>>(
    () => new Set(),
  );
  const [threadMentionQuery, setThreadMentionQuery] = useState<string | null>(
    null,
  );
  const [threadMentionStart, setThreadMentionStart] = useState<number | null>(
    null,
  );
  const [threadMentionEnd, setThreadMentionEnd] = useState<number | null>(
    null,
  );
  const [threadMentionActiveIndex, setThreadMentionActiveIndex] = useState(0);
  const [mainComposerStates, setMainComposerStates] = useState<
    Map<string, MainComposerState>
  >(() => new Map());
  const [pendingMainSends, setPendingMainSends] = useState<
    Map<string, number>
  >(() => new Map());
  const [pendingThreadSends, setPendingThreadSends] = useState<
    Map<string, number>
  >(() => new Map());
  const [pendingOrchestratorStarts, setPendingOrchestratorStarts] = useState<
    Map<string, number>
  >(() => new Map());
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
  const [scheduleRunningTaskIds, setScheduleRunningTaskIds] = useState<
    Set<string>
  >(() => new Set());
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
  const [profileOpen, setProfileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInitialTab, setSearchInitialTab] = useState<
    "search" | "saved"
  >("search");
  const [searchInitialScope, setSearchInitialScope] = useState<
    "workspace" | "channel"
  >("workspace");
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [threadInbox, setThreadInbox] = useState<ChatThreadInboxItem[]>([]);
  const [threadInboxLoading, setThreadInboxLoading] = useState(false);
  const [threadInboxError, setThreadInboxError] = useState<string | null>(null);
  const [threadReadMigrationPending, setThreadReadMigrationPending] =
    useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<
    string | null
  >(null);
  const [socialBusyId, setSocialBusyId] = useState<string | null>(null);
  const [activeMessageActionsId, setActiveMessageActionsId] = useState<
    string | null
  >(null);
  const [composerEmojiOpen, setComposerEmojiOpen] = useState(false);
  const [composerAddOpen, setComposerAddOpen] = useState(false);
  const [composerRecentOpen, setComposerRecentOpen] = useState(false);
  const [composerRecentBusyId, setComposerRecentBusyId] = useState<
    string | null
  >(null);
  const [composerFormatOpen, setComposerFormatOpen] = useState(true);
  const [socialNotice, setSocialNotice] = useState<string | null>(null);
  const activeMainComposer =
    (activeId && mainComposerStates.get(activeId)) ||
    EMPTY_MAIN_COMPOSER_STATE;
  const {
    draft,
    selectedImages,
    voiceNote,
    textSnippet,
    replyTo,
    resendSource,
  } = activeMainComposer;
  const setMainComposerField = <Key extends keyof MainComposerState,>(
    field: Key,
    action: SetStateAction<MainComposerState[Key]>,
  ) => {
    if (!activeId) return;
    setMainComposerStates((current) =>
      updateKeyedValue(
        current,
        activeId,
        EMPTY_MAIN_COMPOSER_STATE,
        (composer) => ({
          ...composer,
          [field]:
            typeof action === "function"
              ? (
                  action as (
                    value: MainComposerState[Key],
                  ) => MainComposerState[Key]
                )(composer[field])
              : action,
        }),
      ),
    );
  };
  const setDraft = (action: SetStateAction<string>) =>
    setMainComposerField("draft", action);
  const setSelectedImages = (action: SetStateAction<File[]>) =>
    setMainComposerField("selectedImages", action);
  const setVoiceNote = (
    action: SetStateAction<PendingChatVoiceNote | null>,
  ) => setMainComposerField("voiceNote", action);
  const setTextSnippet = (action: SetStateAction<ChatTextSnippet | null>) =>
    setMainComposerField("textSnippet", action);
  const setReplyTo = (action: SetStateAction<Message | null>) =>
    setMainComposerField("replyTo", action);
  const setResendSource = (action: SetStateAction<Message | null>) =>
    setMainComposerField("resendSource", action);
  const busy = keyedOperationPending(pendingMainSends, activeId);
  const activeThreadSendKey =
    activeId && threadRootId ? `${activeId}:${threadRootId}` : null;
  const threadBusy = keyedOperationPending(
    pendingThreadSends,
    activeThreadSendKey,
  );
  const changeMainSendCount = useCallback(
    (channelId: string, delta: 1 | -1) => {
      setPendingMainSends((current) =>
        updatePendingCount(current, channelId, delta),
      );
    },
    [],
  );
  const changeThreadSendCount = useCallback(
    (key: string, delta: 1 | -1) => {
      setPendingThreadSends((current) =>
        updatePendingCount(current, key, delta),
      );
    },
    [],
  );
  const changeOrchestratorStartCount = useCallback(
    (key: string, delta: 1 | -1) => {
      setPendingOrchestratorStarts((current) =>
        updatePendingCount(current, key, delta),
      );
    },
    [],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineContentRef = useRef<HTMLDivElement>(null);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const sidebarSearchRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const composerAddMenuRef = useRef<HTMLDivElement>(null);
  const settingsQueryHandledRef = useRef(false);
  const scheduledTasksChannelRef = useRef<string | null>(null);
  const scheduledTasksRequestRef = useRef<AbortController | null>(null);
  const scheduleRunChannelsRef = useRef<Map<string, string>>(new Map());
  const scheduleRunBaselineRef = useRef<Map<string, string | null>>(new Map());
  const scheduleRunTimeoutsRef = useRef<Map<string, number>>(new Map());
  const channelReadRequestsRef = useRef<Map<string, AbortController>>(
    new Map(),
  );
  const schedulePanelTriggerRef = useRef<HTMLButtonElement>(null);
  const activeIdRef = useRef<string | null>(activeId);
  const chatVisibleRef = useRef(visible);
  const chatWorkspaceActivatedRef = useRef(false);
  const workspaceHydrationStartedRef = useRef(false);
  const initializedChannelEffectsRef = useRef<string | null>(null);
  const threadRootIdRef = useRef<string | null>(threadRootId);
  const currentUserIdRef = useRef(currentUserId);
  const activeWorkSnapshotRef = useRef<{
    channelId: string | null;
    work: ActiveWork;
  }>({
    channelId: activeId,
    work: { orchestrator: null, agents: [] },
  });
  const foregroundRefreshInFlightRef = useRef(false);
  const sidebarRequestSequenceRef = useRef(0);
  const activeWorkRequestSequenceRef = useRef(0);
  const activeWorkRequestRef = useRef<{
    channelId: string;
    sequence: number;
    promise: Promise<ActiveWork>;
  } | null>(null);
  const messagesRequestRef = useRef<AbortController | null>(null);
  const threadRequestRef = useRef<AbortController | null>(null);
  const threadInboxRequestRef = useRef<AbortController | null>(null);
  const timelinePageInfoRef =
    useRef<ChatMessagePageInfo>(EMPTY_MESSAGE_PAGE_INFO);
  const pendingSearchAnchorRef = useRef<{
    channelId: string;
    messageId: string;
  } | null>(null);
  const pendingThreadOpenRef = useRef<{
    channelId: string;
    rootMessageId: string;
  } | null>(
    initialChannelId && isUuid(initialThreadRootId)
      ? {
          channelId: initialChannelId,
          rootMessageId: initialThreadRootId,
        }
      : null,
  );
  const attemptedMessageAnchorRef = useRef<string | null>(null);
  const initialTimelineScrollRef = useRef(false);
  const pendingTimelineScrollRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const timelineSticksToBottomRef = useRef(true);
  const previousTimelineTailRef = useRef<string | null>(null);
  const messagesSnapshotRef = useRef<Message[]>(messages);
  const mainComposerStatesRef =
    useRef<Map<string, MainComposerState>>(mainComposerStates);
  const threadVoiceNoteRef =
    useRef<PendingChatVoiceNote | null>(threadVoiceNote);
  const mainTypingActive = draft.trim().length > 0;
  const threadTypingActive = threadDraft.trim().length > 0;
  activeIdRef.current = activeId;
  chatVisibleRef.current = visible;
  threadRootIdRef.current = threadRootId;
  currentUserIdRef.current = currentUserId;
  timelinePageInfoRef.current = timelinePageInfo;
  messagesSnapshotRef.current = messages;
  mainComposerStatesRef.current = mainComposerStates;
  threadVoiceNoteRef.current = threadVoiceNote;

  useEffect(() => {
    if (!initialChannelId || activeIdRef.current === initialChannelId) return;
    activeIdRef.current = initialChannelId;
    setActiveId(initialChannelId);
  }, [initialChannelId]);

  const applySidebarPayload = useCallback((
    channelsPayload: ChatSidebarChannelsPayload,
    profilesPayload: ChatSidebarProfilesPayload,
  ) => {
    const nextChannels = Array.isArray(channelsPayload.channels)
      ? channelsPayload.channels
      : [];
    const nextWorkspaceId = String(channelsPayload.workspace?.id || "");
    const nextCurrentUserId = String(
      channelsPayload.workspace?.currentUserId || "",
    );
    setWorkspaceId(nextWorkspaceId);
    setWorkspaceName(channelsPayload.workspace?.name || "Workspace");
    setChannels(nextChannels);
    setCurrentUserId(nextCurrentUserId);
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
    setMemberProfiles(
      Array.isArray(channelsPayload.memberProfiles)
        ? channelsPayload.memberProfiles
        : [],
    );
    setMemberPresence(
      Array.isArray(channelsPayload.presence)
        ? channelsPayload.presence
        : [],
    );
    setActiveHuddles(
      Array.isArray(channelsPayload.activeHuddles)
        ? channelsPayload.activeHuddles
        : [],
    );
    setHuddleParticipants(
      Array.isArray(channelsPayload.huddleParticipants)
        ? channelsPayload.huddleParticipants
        : [],
    );
    setSocialMigrationPending(Boolean(channelsPayload.socialMigrationPending));
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
    const rememberedChannelId = initialChannelId
      ? null
      : readLastChatChannel(
          window.localStorage,
          nextWorkspaceId,
          nextCurrentUserId,
        );
    setActiveId((current) =>
      resolveLastChatChannel(
        nextChannels.map((channel: Channel) => channel.id),
        current,
        rememberedChannelId,
      ),
    );
  }, [initialChannelId]);

  const loadSidebar = useCallback(async () => {
    const requestSequence = ++sidebarRequestSequenceRef.current;
    const [channelsRes, profilesRes] = await Promise.all([
      fetch("/api/chat/channels", { cache: "no-store" }),
      fetch("/api/harness/profiles", { cache: "no-store" }),
    ]);
    if (!channelsRes.ok) throw new Error("Could not load team chat.");
    const [channelsPayload, profilesPayload] = await Promise.all([
      channelsRes.json(),
      profilesRes.ok ? profilesRes.json() : Promise.resolve({ profiles: [] }),
    ]);
    if (requestSequence !== sidebarRequestSequenceRef.current) return;
    applySidebarPayload(channelsPayload, profilesPayload);
    const cacheUserId = String(channelsPayload.workspace?.currentUserId || "");
    if (cacheUserId) {
      // A different account on this browser must never read the previous
      // one's cached conversations.
      if (readChatCacheUserId() !== cacheUserId) clearChatWorkspaceCaches();
      rememberChatCacheUserId(cacheUserId);
      const cachedDrafts = readChatComposerDrafts(cacheUserId);
      setMainComposerStates((current) => {
        const next = new Map(current);
        for (const [channelId, draft] of Object.entries(cachedDrafts)) {
          const existing = next.get(channelId);
          if (!existing?.draft) {
            next.set(channelId, {
              ...EMPTY_MAIN_COMPOSER_STATE,
              ...existing,
              draft,
            });
          }
        }
        return next;
      });
      writeChatWorkspaceCache(cacheUserId, {
        channelsPayload,
        profilesPayload,
      });
    }
  }, [applySidebarPayload]);

  const refreshSidebarAfterHuddleChange = useCallback(() => {
    void loadSidebar().catch(() => undefined);
  }, [loadSidebar]);

  const loadThreadInbox = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      if (background && threadInboxRequestRef.current) return;
      threadInboxRequestRef.current?.abort();
      const controller = new AbortController();
      threadInboxRequestRef.current = controller;
      if (!background) setThreadInboxLoading(true);
      try {
        const response = await fetch("/api/chat/threads", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || "Could not load threads.");
        }
        if (controller.signal.aborted) return;
        const nextThreads = Array.isArray(payload.threads)
          ? (payload.threads as ChatThreadInboxItem[])
          : [];
        setThreadInbox(nextThreads);
        setThreadReadMigrationPending(Boolean(payload.migrationPending));
        setThreadInboxError(null);
        setUnreadThreadRoots(
          new Set(
            nextThreads
              .filter((thread) => thread.unread)
              .map((thread) => thread.thread_root_message_id),
          ),
        );
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        if (!background) {
          setThreadInboxError(
            cause instanceof Error ? cause.message : "Could not load threads.",
          );
        }
      } finally {
        if (threadInboxRequestRef.current === controller) {
          threadInboxRequestRef.current = null;
        }
        if (!controller.signal.aborted && !background) {
          setThreadInboxLoading(false);
        }
      }
    },
    [],
  );

  const markThreadRead = useCallback(async (rootMessageId: string) => {
    setThreadInbox((current) =>
      current.map((thread) =>
        thread.thread_root_message_id === rootMessageId
          ? { ...thread, unread: false, last_read_at: new Date().toISOString() }
          : thread,
      ),
    );
    setUnreadThreadRoots((current) => {
      if (!current.has(rootMessageId)) return current;
      const next = new Set(current);
      next.delete(rootMessageId);
      return next;
    });
    try {
      await fetch("/api/chat/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadRootMessageId: rootMessageId }),
        cache: "no-store",
      });
    } catch {
      // The optimistic read state remains useful for this browser session.
    }
  }, []);

  const markChannelRead = useCallback(async (channelId: string) => {
    setChannels((current) =>
      current.map((channel) =>
        channel.id === channelId
          ? { ...channel, unread_count: 0 }
          : channel,
        ),
    );
    window.dispatchEvent(
      new CustomEvent("groovy:channel-read", {
        detail: { channelId },
      }),
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
      window.dispatchEvent(
        new CustomEvent("groovy:channel-read", {
          detail: { channelId },
        }),
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

  const applyMessageSocialState = useCallback(
    (
      payload: Record<string, unknown>,
      { reset = false }: { reset?: boolean } = {},
    ) => {
      const incomingReactions = Array.isArray(payload.reactions)
        ? (payload.reactions as ChatMessageReaction[])
        : [];
      setMessageReactions((current) => {
        if (reset) return incomingReactions;
        const byId = new Map(
          current.map((reaction) => [reaction.id, reaction] as const),
        );
        for (const reaction of incomingReactions) {
          if (typeof reaction.id === "string") byId.set(reaction.id, reaction);
        }
        return Array.from(byId.values());
      });
      if (Array.isArray(payload.pins)) {
        setChannelPins(payload.pins as ChatChannelPin[]);
      }
      const incomingSavedIds = Array.isArray(payload.savedMessageIds)
        ? payload.savedMessageIds.filter(
            (value: unknown): value is string => typeof value === "string",
          )
        : [];
      setSavedMessageIds((current) => {
        if (reset) return new Set(incomingSavedIds);
        const next = new Set(current);
        for (const messageId of incomingSavedIds) next.add(messageId);
        return next;
      });
      setSocialMigrationPending(
        (current) => current || Boolean(payload.socialMigrationPending),
      );
      const incomingCounts = numericThreadReplyCounts(
        payload.threadReplyCounts,
      );
      setServerThreadReplyCounts((current) => {
        if (reset) return incomingCounts;
        const next = new Map(current);
        for (const [rootId, count] of incomingCounts) {
          next.set(rootId, count);
        }
        return next;
      });
    },
    [],
  );

  const pruneLoadedThreadState = useCallback(
    (pendingThreadRootId: string | null = null) => {
      const removedMessageIds = new Set(
        messagesSnapshotRef.current
          .filter(
            (message) =>
              Boolean(message.thread_root_message_id) &&
              !(
                message.thread_root_message_id === pendingThreadRootId &&
                isPendingChatMessage(message)
              ),
          )
          .map((message) => message.id),
      );
      setMessages((current) =>
        current.filter(
          (message) =>
            !message.thread_root_message_id ||
            (message.thread_root_message_id === pendingThreadRootId &&
              isPendingChatMessage(message)),
        ),
      );
      setMessageContext((current) =>
        current.filter((message) => !message.thread_root_message_id),
      );
      if (removedMessageIds.size === 0) return;
      setMessageReactions((current) =>
        current.filter(
          (reaction) => !removedMessageIds.has(reaction.message_id),
        ),
      );
      setSavedMessageIds((current) => {
        const next = new Set(current);
        for (const messageId of removedMessageIds) next.delete(messageId);
        return next;
      });
    },
    [],
  );

  const loadMessages = useCallback(
    async (
      channelId: string,
      {
        reset = false,
        before = null,
        around = null,
      }: {
        reset?: boolean;
        before?: string | null;
        around?: string | null;
      } = {},
    ) => {
      messagesRequestRef.current?.abort();
      const controller = new AbortController();
      messagesRequestRef.current = controller;
      const requestSnapshotIds = new Set(
        messagesSnapshotRef.current.map((message) => message.id),
      );
      const isHistoryRequest = Boolean(before);
      if (activeIdRef.current === channelId) {
        if (isHistoryRequest) {
          setHistoryLoading(true);
        } else if (reset) {
          setMessagesLoading(true);
        }
      }
      try {
        const url = new URL(
          `/api/chat/channels/${channelId}/messages`,
          window.location.origin,
        );
        url.searchParams.set("limit", "50");
        if (before) url.searchParams.set("before", before);
        if (around) url.searchParams.set("around", around);
        const res = await fetch(url.href, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        if (!res.ok) {
          throw new Error(
            typeof payload.error === "string"
              ? payload.error
              : "Could not load channel messages.",
          );
        }
        const authoritative = Array.isArray(payload.messages)
          ? (payload.messages as Message[])
          : [];
        const incomingContext = Array.isArray(payload.contextMessages)
          ? (payload.contextMessages as Message[])
          : [];
        if (
          !controller.signal.aborted &&
          activeIdRef.current === channelId
        ) {
          const preserveAnchoredWindow =
            !reset &&
            !before &&
            !around &&
            timelinePageInfoRef.current.hasNewer;
          if (!preserveAnchoredWindow) {
            setMessages((current) =>
              reset
                ? reconcileChatMessagesAfterRequest(
                    current,
                    authoritative,
                    requestSnapshotIds,
                  )
                : mergeChatMessages(current, authoritative),
            );
            setMessageContext((current) =>
              reset
                ? incomingContext
                : mergeChatMessages(current, incomingContext),
            );
          }
          applyMessageSocialState(payload, { reset });
          const cacheUserId =
            currentUserIdRef.current || readChatCacheUserId();
          if (!before && !around && cacheUserId) {
            writeChatChannelMessages(cacheUserId, channelId, authoritative);
          }
          const nextPageInfo = messagePageInfo(payload.pageInfo);
          const target =
            payload.target &&
            typeof payload.target === "object" &&
            !Array.isArray(payload.target)
              ? (payload.target as Record<string, unknown>)
              : null;
          const targetThreadRootId =
            around && typeof target?.threadRootId === "string"
              ? target.threadRootId
              : null;
          setTimelinePageInfo((current) => {
            if (reset) {
              return targetThreadRootId
                ? EMPTY_MESSAGE_PAGE_INFO
                : nextPageInfo;
            }
            if (before) {
              return {
                ...current,
                hasOlder: nextPageInfo.hasOlder,
                olderCursor: nextPageInfo.olderCursor,
              };
            }
            if (current.hasNewer) return current;
            return {
              ...current,
              hasOlder:
                current.olderCursor !== null
                  ? current.hasOlder
                  : nextPageInfo.hasOlder,
              olderCursor:
                current.olderCursor || nextPageInfo.olderCursor,
            };
          });
          if (targetThreadRootId) {
            threadRootIdRef.current = targetThreadRootId;
            setThreadRootId(targetThreadRootId);
            setThreadPageInfo(nextPageInfo);
            setThreadInitialLoading(false);
          }
        }
        return authoritative;
      } finally {
        if (messagesRequestRef.current === controller) {
          messagesRequestRef.current = null;
        }
        if (activeIdRef.current === channelId) {
          if (isHistoryRequest) {
            setHistoryLoading(false);
          } else if (reset) {
            setMessagesLoading(false);
          }
        }
      }
    },
    [applyMessageSocialState],
  );

  const loadThreadMessages = useCallback(
    async (
      channelId: string,
      rootId: string,
      {
        reset = false,
        before = null,
        around = null,
      }: {
        reset?: boolean;
        before?: string | null;
        around?: string | null;
      } = {},
    ) => {
      threadRequestRef.current?.abort();
      const controller = new AbortController();
      threadRequestRef.current = controller;
      const requestSnapshotIds = new Set(
        messagesSnapshotRef.current.map((message) => message.id),
      );
      if (activeIdRef.current === channelId) {
        if (before) setThreadHistoryLoading(true);
        else if (reset) setThreadInitialLoading(true);
      }
      try {
        const url = new URL(
          `/api/chat/channels/${channelId}/messages`,
          window.location.origin,
        );
        url.searchParams.set("limit", "50");
        url.searchParams.set("threadRootId", rootId);
        if (before) url.searchParams.set("before", before);
        if (around) url.searchParams.set("around", around);
        const response = await fetch(url.href, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        if (!response.ok) {
          throw new Error(
            typeof payload.error === "string"
              ? payload.error
              : "Could not load this thread.",
          );
        }
        const incoming = Array.isArray(payload.messages)
          ? (payload.messages as Message[])
          : [];
        const incomingContext = Array.isArray(payload.contextMessages)
          ? (payload.contextMessages as Message[])
          : [];
        if (
          !controller.signal.aborted &&
          activeIdRef.current === channelId &&
          threadRootIdRef.current === rootId
        ) {
          if (reset) pruneLoadedThreadState(rootId);
          setMessages((current) => {
            if (!reset) return mergeChatMessages(current, incoming);
            const withoutLoadedReplies = current.filter(
              (message) =>
                !message.thread_root_message_id ||
                (message.thread_root_message_id === rootId &&
                  (isPendingChatMessage(message) ||
                    !requestSnapshotIds.has(message.id))),
            );
            return mergeChatMessages(withoutLoadedReplies, incoming);
          });
          setMessageContext((current) =>
            mergeChatMessages(current, incomingContext),
          );
          applyMessageSocialState(payload);
          setThreadPageInfo((current) => {
            const next = messagePageInfo(payload.pageInfo);
            return before
              ? {
                  ...current,
                  hasOlder: next.hasOlder,
                  olderCursor: next.olderCursor,
                }
              : next;
          });
          if (typeof payload.replyCount === "number") {
            setServerThreadReplyCounts((current) => {
              const next = new Map(current);
              next.set(rootId, Math.max(0, Math.floor(payload.replyCount as number)));
              return next;
            });
          }
        }
        return incoming;
      } finally {
        if (threadRequestRef.current === controller) {
          threadRequestRef.current = null;
        }
        if (
          activeIdRef.current === channelId &&
          threadRootIdRef.current === rootId
        ) {
          if (before) setThreadHistoryLoading(false);
          else if (reset) setThreadInitialLoading(false);
        }
      }
    },
    [applyMessageSocialState, pruneLoadedThreadState],
  );

  const loadActiveWork = useCallback((channelId: string) => {
    const existingRequest = activeWorkRequestRef.current;
    if (existingRequest?.channelId === channelId) {
      return existingRequest.promise;
    }
    const requestSequence = ++activeWorkRequestSequenceRef.current;
    const request = (async () => {
      const url = new URL(
        `/api/chat/channels/${channelId}/control`,
        window.location.origin,
      );
      if (!timelinePageInfoRef.current.hasNewer) {
        url.searchParams.set("syncMessages", "1");
        const latestMessage = latestPersistedChatMessageCursor(
          messagesSnapshotRef.current,
        );
        if (latestMessage) {
          url.searchParams.set("latestMessageId", latestMessage.id);
          url.searchParams.set(
            "latestMessageCreatedAt",
            latestMessage.createdAt,
          );
        }
      }
      const res = await fetch(url.href, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Could not load active channel work.");
      const payload = await res.json();
      const next: ActiveWork = {
        orchestrator: payload.orchestrator || null,
        agents: Array.isArray(payload.agents) ? payload.agents : [],
      };
      if (
        activeIdRef.current === channelId &&
        activeWorkRequestSequenceRef.current === requestSequence
      ) {
        const rawMessageWindow =
          payload.messageWindow &&
          typeof payload.messageWindow === "object" &&
          !Array.isArray(payload.messageWindow)
            ? (payload.messageWindow as Record<string, unknown>)
            : null;
        const recoveredMessages = Array.isArray(rawMessageWindow?.messages)
          ? (rawMessageWindow.messages as Message[])
          : null;
        const recoveredWindowHasOlder =
          typeof rawMessageWindow?.hasOlder === "boolean"
            ? rawMessageWindow.hasOlder
            : null;
        const validRecoveredWindow =
          recoveredMessages &&
          recoveredWindowHasOlder !== null &&
          recoveredMessages.every(
            (message) =>
              message &&
              typeof message.id === "string" &&
              typeof message.created_at === "string" &&
              message.channel_id === channelId &&
              !message.thread_root_message_id,
          )
            ? recoveredMessages
            : null;
        if (validRecoveredWindow && recoveredWindowHasOlder !== null) {
          const currentIds = new Set(
            messagesSnapshotRef.current.map((message) => message.id),
          );
          const recoveredNewMessage = validRecoveredWindow.some(
            (message) => !currentIds.has(message.id),
          );
          setMessages((current) =>
            reconcileLatestChatMessageWindow(current, validRecoveredWindow, {
              hasOlder: recoveredWindowHasOlder,
            }),
          );
          if (
            recoveredNewMessage &&
            document.visibilityState === "visible"
          ) {
            void markChannelRead(channelId);
          }
        }
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
        // Realtime sockets can be suspended or dropped while a phone sleeps.
        // When durable work reaches a terminal state, fetch the completion
        // message explicitly instead of depending on a realtime event.
        if (previouslyWorking && !stillWorking) {
          const completedThreadRoot =
            previous.orchestrator?.thread_root_message_id ||
            previous.agents.find((task) => task.threadRootMessageId)
              ?.threadRootMessageId ||
            null;
          if (
            completedThreadRoot &&
            threadRootIdRef.current === completedThreadRoot
          ) {
            void loadThreadMessages(channelId, completedThreadRoot).catch(
              () => undefined,
            );
          } else {
            void loadMessages(channelId).catch(() => undefined);
          }
        }
      }
      return next;
    })();
    activeWorkRequestRef.current = {
      channelId,
      sequence: requestSequence,
      promise: request,
    };
    const clearRequest = () => {
      if (activeWorkRequestRef.current?.sequence === requestSequence) {
        activeWorkRequestRef.current = null;
      }
    };
    void request.then(clearRequest, clearRequest);
    return request;
  }, [loadMessages, loadThreadMessages, markChannelRead]);

  const hydrateWorkspace = useCallback(async () => {
    setWorkspaceLoadError(null);
    setError(null);
    // Paint the cached workspace before anything touches the network.
    // supabase.auth.getSession() refreshes tokens over the wire on most cold
    // opens, so resolving the account first would reintroduce the very wait
    // this cache removes; the id recorded on the last successful load is
    // enough, and the sidebar response below is still authoritative.
    let paintedFromCache = false;
    const cachedUserId = readChatCacheUserId();
    try {
      const cached = cachedUserId
        ? readChatWorkspaceCache(cachedUserId)
        : null;
      if (cached) {
        applySidebarPayload(
          cached.channelsPayload as ChatSidebarChannelsPayload,
          cached.profilesPayload as ChatSidebarProfilesPayload,
        );
        setWorkspaceReady(true);
        paintedFromCache = true;
      }
    } catch {
      // Cache hydration is best-effort; the live request is authoritative.
    }
    try {
      await loadSidebar();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Could not load chat.";
      // A painted cached workspace stays usable behind the non-blocking
      // error banner; the full-screen failure state is for empty boots only.
      if (!paintedFromCache) setWorkspaceLoadError(message);
      setError(message);
    } finally {
      setWorkspaceReady(true);
    }
  }, [applySidebarPayload, loadSidebar]);

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

  const clearRunningScheduledTask = useCallback((taskId: string) => {
    const timeout = scheduleRunTimeoutsRef.current.get(taskId);
    if (timeout) window.clearTimeout(timeout);
    scheduleRunTimeoutsRef.current.delete(taskId);
    scheduleRunChannelsRef.current.delete(taskId);
    scheduleRunBaselineRef.current.delete(taskId);
    setScheduleRunningTaskIds((current) => {
      if (!current.has(taskId)) return current;
      const next = new Set(current);
      next.delete(taskId);
      return next;
    });
  }, []);

  useEffect(() => {
    for (const taskId of scheduleRunningTaskIds) {
      if (!scheduleRunBaselineRef.current.has(taskId)) continue;
      const task = scheduledTasks.find((candidate) => candidate.id === taskId);
      if (!task?.lastRunAt) continue;
      const baseline = scheduleRunBaselineRef.current.get(taskId) || null;
      if (task.lastRunAt === baseline) continue;
      const channelId = scheduleRunChannelsRef.current.get(taskId) || null;
      clearRunningScheduledTask(taskId);
      if (channelId && scheduledTasksChannelRef.current === channelId) {
        void loadMessages(channelId).catch(() => undefined);
      }
    }
  }, [
    clearRunningScheduledTask,
    loadMessages,
    scheduleRunningTaskIds,
    scheduledTasks,
  ]);

  const subscribeToScheduleRelay = headerDevice.relay.subscribe;
  useEffect(() => {
    return subscribeToScheduleRelay((message) => {
      const relayMessage = message as Record<string, unknown>;
      const type = typeof relayMessage.type === "string" ? relayMessage.type : "";
      if (type !== "schedule_run_report") return;
      const taskId =
        typeof relayMessage.job_id === "string" ? relayMessage.job_id : "";
      if (!taskId || !scheduleRunChannelsRef.current.has(taskId)) return;
      const channelId = scheduleRunChannelsRef.current.get(taskId) || null;
      clearRunningScheduledTask(taskId);
      if (channelId && scheduledTasksChannelRef.current === channelId) {
        void loadScheduledTasks(channelId, { background: true });
      }
    });
  }, [
    clearRunningScheduledTask,
    loadScheduledTasks,
    subscribeToScheduleRelay,
  ]);

  useEffect(
    () => () => {
      for (const timeout of scheduleRunTimeoutsRef.current.values()) {
        window.clearTimeout(timeout);
      }
      scheduleRunTimeoutsRef.current.clear();
      scheduleRunChannelsRef.current.clear();
      scheduleRunBaselineRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!workspaceHydrationStartedRef.current) {
      workspaceHydrationStartedRef.current = true;
      void hydrateWorkspace();
      if ("serviceWorker" in navigator) {
        void navigator.serviceWorker
          .getRegistration("/")
          .then((registration) => registration?.update())
          .catch(() => undefined);
      }
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
    if (!workspaceReady || !currentUserId) return;
    void loadThreadInbox().catch(() => undefined);
  }, [currentUserId, loadThreadInbox, workspaceReady]);

  useEffect(() => {
    if (!currentUserId) return;
    let lastHeartbeatAt = 0;
    const sendPresence = (
      availability: ChatMemberPresence["availability"],
      force = false,
    ) => {
      const now = Date.now();
      if (!force && now - lastHeartbeatAt < 15_000) return;
      lastHeartbeatAt = now;
      void fetch("/api/chat/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ availability }),
        keepalive: true,
      }).catch(() => undefined);
    };
    const markActive = () => {
      if (document.visibilityState === "visible") sendPresence("online");
    };
    const onVisibility = () => {
      sendPresence(
        document.visibilityState === "visible" ? "online" : "away",
        true,
      );
    };
    sendPresence(
      document.visibilityState === "visible" ? "online" : "away",
      true,
    );
    const interval = window.setInterval(() => {
      sendPresence(
        document.visibilityState === "visible" ? "online" : "away",
        true,
      );
    }, 45_000);
    window.addEventListener("pointerdown", markActive, { passive: true });
    window.addEventListener("keydown", markActive);
    window.addEventListener("focus", markActive);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pointerdown", markActive);
      window.removeEventListener("keydown", markActive);
      window.removeEventListener("focus", markActive);
      document.removeEventListener("visibilitychange", onVisibility);
      void fetch("/api/chat/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ availability: "away" }),
        keepalive: true,
      }).catch(() => undefined);
    };
  }, [currentUserId]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (
        event.data?.type !== "groovy-channel-read" ||
        typeof event.data.channelId !== "string"
      ) {
        return;
      }
      const channelId = event.data.channelId;
      setChannels((current) =>
        current.map((channel) =>
          channel.id === channelId ? { ...channel, unread_count: 0 } : channel,
        ),
      );
      window.dispatchEvent(
        new CustomEvent("groovy:channel-read", {
          detail: { channelId },
        }),
      );
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const onUnreadState = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const entries = event.detail?.unreadCounts;
      if (!Array.isArray(entries)) return;
      const unreadByChannel = new Map<string, number>();
      for (const entry of entries) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string"
        ) {
          continue;
        }
        unreadByChannel.set(entry[0], normalizeUnreadCount(entry[1]));
      }
      if (unreadByChannel.size === 0) return;
      setChannels((current) =>
        current.map((channel) => {
          // Cross-device reads are authoritative and idempotent. Positive
          // counts remain owned by this client's message stream/sidebar load,
          // avoiding a race where the same Realtime INSERT is counted twice.
          if (unreadByChannel.get(channel.id) !== 0) return channel;
          return channelUnreadCount(channel) > 0
            ? { ...channel, unread_count: 0 }
            : channel;
        }),
      );
    };
    window.addEventListener("groovy:channel-unread-state", onUnreadState);
    return () =>
      window.removeEventListener("groovy:channel-unread-state", onUnreadState);
  }, []);

  useEffect(() => {
    if (!workspaceReady || !currentUserId) return;
    const supabase = getSupabaseBrowserClient();
    const realtime = supabase
      .channel(`team-chat-social:${currentUserId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_member_profiles",
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const deletedId = (payload.old as { user_id?: unknown }).user_id;
            if (typeof deletedId === "string") {
              setMemberProfiles((current) =>
                current.filter((profile) => profile.user_id !== deletedId),
              );
            }
            return;
          }
          const row = payload.new as Record<string, unknown>;
          if (typeof row.user_id !== "string") return;
          const profile: ChatMemberProfile = {
            user_id: row.user_id,
            display_name:
              typeof row.display_name === "string" ? row.display_name : null,
            has_avatar:
              typeof row.avatar_path === "string" && row.avatar_path.length > 0,
            status_emoji:
              typeof row.status_emoji === "string" ? row.status_emoji : null,
            status_text:
              typeof row.status_text === "string" ? row.status_text : null,
            status_expires_at:
              typeof row.status_expires_at === "string"
                ? row.status_expires_at
                : null,
            updated_at:
              typeof row.updated_at === "string" ? row.updated_at : null,
          };
          setMemberProfiles((current) => [
            ...current.filter((candidate) => candidate.user_id !== profile.user_id),
            profile,
          ]);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_member_presence",
        },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          const row = payload.new as ChatMemberPresence;
          if (typeof row.user_id !== "string") return;
          setMemberPresence((current) => [
            ...current.filter((candidate) => candidate.user_id !== row.user_id),
            row,
          ]);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_huddles" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const deleted = payload.old as Partial<ChatHuddle>;
            if (typeof deleted.id === "string") {
              setActiveHuddles((current) =>
                current.filter((huddle) => huddle.id !== deleted.id),
              );
            }
          } else {
            const incoming = payload.new as ChatHuddle;
            if (typeof incoming.id === "string") {
              setActiveHuddles((current) => {
                const withoutHuddle = current.filter(
                  (huddle) => huddle.id !== incoming.id,
                );
                return incoming.status === "active"
                  ? [...withoutHuddle, incoming]
                  : withoutHuddle;
              });
            }
          }
          void loadSidebar().catch(() => undefined);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_huddle_participants",
        },
        (payload) => {
          if (payload.eventType !== "DELETE") {
            const incoming = payload.new as ChatHuddleParticipant;
            if (
              typeof incoming.huddle_id === "string" &&
              typeof incoming.user_id === "string"
            ) {
              setHuddleParticipants((current) =>
                mergeChatHuddleParticipant(current, incoming),
              );
            }
          }
          void loadSidebar().catch(() => undefined);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(realtime);
    };
  }, [currentUserId, loadSidebar, workspaceReady]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    const realtime = supabase
      .channel("team-chat-unread")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_messages",
        },
        (payload) => {
          if (
            payload.eventType !== "INSERT" &&
            payload.eventType !== "UPDATE"
          ) {
            return;
          }
          const message = payload.new as Message;
          if (payload.eventType === "UPDATE") {
            const previous = payload.old as Message;
            const editedAt = message.metadata?.edited_at;
            const previousEditedAt = previous.metadata?.edited_at;
            if (
              typeof editedAt !== "string" ||
              editedAt === previousEditedAt
            ) {
              return;
            }
          }
          const threadIsOpen =
            Boolean(message.thread_root_message_id) &&
            message.thread_root_message_id === threadRootIdRef.current;
          if (message.thread_root_message_id) {
            void loadThreadInbox({ background: true });
          }
          const disposition = incomingUnreadDisposition({
            channelId: message.channel_id,
            authorType: message.author_type,
            authorUserId: message.author_user_id,
            currentUserId: currentUserIdRef.current,
            activeChannelId:
              message.thread_root_message_id && !threadIsOpen
                ? null
                : activeIdRef.current,
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
  }, [loadThreadInbox, markChannelRead]);

  useEffect(
    () => () => {
      messagesRequestRef.current?.abort();
      threadRequestRef.current?.abort();
      threadInboxRequestRef.current?.abort();
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
    if (
      !workspaceReady ||
      !workspaceId ||
      !currentUserId ||
      !activeId ||
      !channels.some((channel) => channel.id === activeId)
    ) {
      return;
    }
    rememberLastChatChannel(
      window.localStorage,
      workspaceId,
      currentUserId,
      activeId,
    );
    if (window.location.pathname !== `/chat/${activeId}`) {
      window.history.replaceState(
        window.history.state,
        "",
        `/chat/${activeId}`,
      );
    }
  }, [activeId, channels, currentUserId, workspaceId, workspaceReady]);

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
    if (!threadRootId) return;
    const previousOverflow = document.body.style.overflow;
    const drawerMedia = window.matchMedia("(max-width: 1279px)");
    const syncBodyScroll = () => {
      document.body.style.overflow = drawerMedia.matches
        ? "hidden"
        : previousOverflow;
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        threadRequestRef.current?.abort();
        threadRootIdRef.current = null;
        setThreadRootId(null);
        setThreadPageInfo(EMPTY_MESSAGE_PAGE_INFO);
        setThreadInitialLoading(false);
        setThreadHistoryLoading(false);
        setThreadDraft("");
        setThreadError(null);
        setThreadResendSource(null);
        setThreadMentionQuery(null);
        pruneLoadedThreadState();
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
  }, [pruneLoadedThreadState, threadRootId]);

  const reconcileActiveChatState = useCallback(async () => {
    if (
      !chatVisibleRef.current ||
      document.visibilityState === "hidden" ||
      foregroundRefreshInFlightRef.current
    ) {
      return;
    }
    const channelId = activeIdRef.current;
    if (!channelId) return;

    foregroundRefreshInFlightRef.current = true;
    const openThreadRootId = threadRootIdRef.current;
    try {
      const refreshResults = await Promise.allSettled([
        loadMessages(channelId),
        openThreadRootId
          ? loadThreadMessages(channelId, openThreadRootId)
          : Promise.resolve([]),
        loadActiveWork(channelId),
        loadSidebar(),
      ]);
      if (
        !chatVisibleRef.current ||
        activeIdRef.current !== channelId
      ) {
        return;
      }
      const threadRefreshSucceeded =
        !openThreadRootId || refreshResults[1]?.status === "fulfilled";
      await Promise.allSettled([
        markChannelRead(channelId),
        threadRefreshSucceeded &&
        openThreadRootId &&
        threadRootIdRef.current === openThreadRootId
          ? markThreadRead(openThreadRootId)
          : Promise.resolve(),
      ]);
    } finally {
      foregroundRefreshInFlightRef.current = false;
    }
  }, [
    loadActiveWork,
    loadMessages,
    loadSidebar,
    loadThreadMessages,
    markChannelRead,
    markThreadRead,
  ]);

  useEffect(() => {
    if (!visible) return;
    const resumingChannel =
      Boolean(activeId) && initializedChannelEffectsRef.current === activeId;
    if (!resumingChannel) {
      setThreadRootId(null);
      setThreadDraft("");
      setThreadError(null);
      setThreadResendSource(null);
      setThreadMentionQuery(null);
    }
    if (!activeId) {
      initializedChannelEffectsRef.current = null;
      messagesRequestRef.current?.abort();
      threadRequestRef.current?.abort();
      setMessages([]);
      setMessageContext([]);
      setMessageReactions([]);
      setChannelPins([]);
      setSavedMessageIds(new Set());
      setServerThreadReplyCounts(new Map());
      setTimelinePageInfo(EMPTY_MESSAGE_PAGE_INFO);
      setThreadPageInfo(EMPTY_MESSAGE_PAGE_INFO);
      setHistoryLoading(false);
      setThreadHistoryLoading(false);
      setThreadInitialLoading(false);
      setTypingIndicators([]);
      setMessagesLoading(false);
      setActiveWork({ orchestrator: null, agents: [] });
      activeWorkSnapshotRef.current = {
        channelId: null,
        work: { orchestrator: null, agents: [] },
      };
      return;
    }
    if (!resumingChannel) {
      setMessages([]);
      setMessageContext([]);
      setMessageReactions([]);
      setChannelPins([]);
      setSavedMessageIds(new Set());
      setServerThreadReplyCounts(new Map());
      setTimelinePageInfo(EMPTY_MESSAGE_PAGE_INFO);
      setThreadPageInfo(EMPTY_MESSAGE_PAGE_INFO);
      setHistoryLoading(false);
      setThreadHistoryLoading(false);
      setThreadInitialLoading(false);
      setTypingIndicators([]);
      setMessagesLoading(true);
    } else {
      setMessagesLoading(false);
    }
    const pendingThread =
      pendingThreadOpenRef.current?.channelId === activeId
        ? pendingThreadOpenRef.current
        : null;
    const pendingAnchor =
      pendingThread?.rootMessageId ||
      (pendingSearchAnchorRef.current?.channelId === activeId
        ? pendingSearchAnchorRef.current.messageId
        : null);
    if (!resumingChannel) {
      pendingSearchAnchorRef.current = null;
      timelineSticksToBottomRef.current = !pendingAnchor;
      previousTimelineTailRef.current = null;
      pendingTimelineScrollRestoreRef.current = null;
      initialTimelineScrollRef.current = !pendingAnchor;
      if (!pendingAnchor) {
        // On a /chat/<id> deep link this effect runs before the sidebar
        // response populates currentUserId, so fall back to the recorded id.
        const cachedMessages = readChatChannelMessages(
          currentUserIdRef.current || readChatCacheUserId(),
          activeId,
        ) as Message[] | null;
        if (cachedMessages?.length) {
          // Paint the cached conversation instantly; the reset fetch below
          // reconciles it against the authoritative window.
          setMessages(cachedMessages);
          messagesSnapshotRef.current = cachedMessages;
          setMessagesLoading(false);
        }
      }
    }
    if (visible && document.visibilityState === "visible") {
      void markChannelRead(activeId);
    }
    if (!resumingChannel) {
      void loadMessages(activeId, {
        reset: true,
        around: pendingAnchor,
      })
        .then(() => {
          if (
            !pendingThread ||
            activeIdRef.current !== activeId
          ) {
            return;
          }
          pendingThreadOpenRef.current = null;
          setSchedulePanelOpen(false);
          threadRootIdRef.current = pendingThread.rootMessageId;
          setThreadRootId(pendingThread.rootMessageId);
          setThreadPageInfo(EMPTY_MESSAGE_PAGE_INFO);
          setThreadInitialLoading(true);
          setThreadHistoryLoading(false);
          setThreadDraft("");
          setThreadError(null);
          setThreadResendSource(null);
          void markThreadRead(pendingThread.rootMessageId);
          void loadThreadMessages(activeId, pendingThread.rootMessageId, {
            reset: true,
          }).catch((cause) => {
            if (cause instanceof DOMException && cause.name === "AbortError") {
              return;
            }
            setThreadError(
              cause instanceof Error
                ? cause.message
                : "Could not load this thread.",
            );
          });
        })
        .catch((cause) => {
          if (activeIdRef.current !== activeId) return;
          if (cause instanceof DOMException && cause.name === "AbortError") {
            return;
          }
          setMessagesLoading(false);
          setError(
            cause instanceof Error ? cause.message : "Could not load messages.",
          );
        });
      void loadActiveWork(activeId).catch(() => undefined);
    }
    initializedChannelEffectsRef.current = activeId;
    const activeWorkPoll = setInterval(() => {
      if (document.visibilityState !== "visible") return;
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
            const deleted = payload.old as Partial<Message> | null;
            const deletedId = deleted?.id;
            if (typeof deletedId === "string") {
              setMessages((current) =>
                current.filter((message) => message.id !== deletedId),
              );
              setMessageContext((current) =>
                current.filter((message) => message.id !== deletedId),
              );
            }
            if (typeof deleted?.thread_root_message_id === "string") {
              setServerThreadReplyCounts((current) => {
                const next = new Map(current);
                next.set(
                  deleted.thread_root_message_id!,
                  Math.max(
                    0,
                    (next.get(deleted.thread_root_message_id!) || 1) - 1,
                  ),
                );
                return next;
              });
            }
            return;
          }
          const incoming = payload.new as Message;
          if (
            incoming.author_type === "orchestrator" &&
            incoming.metadata?.scheduled_tasks_changed === true &&
            scheduledTasksChannelRef.current === activeId
          ) {
            void loadScheduledTasks(activeId);
          }
          if (
            payload.eventType === "INSERT" &&
            incoming.thread_root_message_id
          ) {
            setServerThreadReplyCounts((current) => {
              const next = new Map(current);
              next.set(
                incoming.thread_root_message_id!,
                (next.get(incoming.thread_root_message_id!) || 0) + 1,
              );
              return next;
            });
            if (
              incoming.thread_root_message_id !== threadRootIdRef.current
            ) {
              return;
            }
          }
          if (
            payload.eventType === "UPDATE" &&
            incoming.thread_root_message_id &&
            incoming.thread_root_message_id !== threadRootIdRef.current
          ) {
            return;
          }
          if (
            payload.eventType === "INSERT" &&
            !incoming.thread_root_message_id &&
            timelinePageInfoRef.current.hasNewer
          ) {
            return;
          }
          setMessages((current) => {
            if (
              payload.eventType === "UPDATE" &&
              !current.some((message) => message.id === incoming.id)
            ) {
              return current;
            }
            return mergeChatMessages(current, [incoming]);
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_message_reactions",
          filter: `channel_id=eq.${activeId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const deletedId = (payload.old as { id?: unknown } | null)?.id;
            if (typeof deletedId === "string") {
              setMessageReactions((current) =>
                current.filter((reaction) => reaction.id !== deletedId),
              );
            } else {
              void loadMessages(activeId).catch(() => undefined);
            }
            return;
          }
          const reaction = payload.new as ChatMessageReaction;
          if (typeof reaction.id !== "string") return;
          setMessageReactions((current) => [
            ...current.filter((candidate) => candidate.id !== reaction.id),
            reaction,
          ]);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_channel_pins",
          filter: `channel_id=eq.${activeId}`,
        },
        () => {
          void loadMessages(activeId).catch(() => undefined);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_typing_indicators",
          filter: `channel_id=eq.${activeId}`,
        },
        (payload) => {
          const row =
            payload.eventType === "DELETE"
              ? (payload.old as ChatTypingIndicator)
              : (payload.new as ChatTypingIndicator);
          if (
            typeof row.user_id !== "string" ||
            typeof row.channel_id !== "string"
          ) {
            return;
          }
          if (payload.eventType === "DELETE") {
            setTypingIndicators((current) =>
              current.filter(
                (candidate) =>
                  !(
                    candidate.channel_id === row.channel_id &&
                    candidate.user_id === row.user_id &&
                    candidate.thread_root_message_id ===
                      row.thread_root_message_id
                  ),
              ),
            );
            return;
          }
          setTypingIndicators((current) =>
            mergeChatTypingIndicator(current, row),
          );
        },
      )
      .subscribe((status) => {
        if (
          status === "SUBSCRIBED" &&
          activeIdRef.current === activeId
        ) {
          // Close both the load-before-subscribe race and any rows missed while
          // Chat's Activity was hidden. The open thread is a separate paginated
          // query, so refreshing only the main timeline cannot recover replies.
          void reconcileActiveChatState();
        }
      });
    let typingPollInFlight = false;
    let typingPollingDisabled = false;
    let typingPollDisposed = false;
    const reconcileTypingIndicators = async () => {
      if (typingPollInFlight || typingPollingDisabled) return;
      typingPollInFlight = true;
      try {
        const { data, error } = await supabase
          .from("chat_typing_indicators")
          .select(
            "channel_id,user_id,thread_root_message_id,expires_at,updated_at",
          )
          .eq("channel_id", activeId)
          .gt("expires_at", new Date().toISOString());
        if (error) {
          if (socialSchemaUnavailable(error)) typingPollingDisabled = true;
          return;
        }
        if (
          typingPollDisposed ||
          activeIdRef.current !== activeId ||
          !Array.isArray(data)
        ) {
          return;
        }
        const activeRows = data
          .map((row) => chatTypingIndicatorFromBroadcast(row, activeId))
          .filter((row): row is ChatTypingIndicator => Boolean(row));
        setTypingIndicators((current) =>
          replaceChannelTypingIndicators(current, activeId, activeRows),
        );
      } finally {
        typingPollInFlight = false;
      }
    };
    void reconcileTypingIndicators();
    // Electron can keep the renderer alive across app switching and system
    // sleep while its Realtime socket is no longer healthy. A small REST
    // reconciliation while Chat is visible makes the ephemeral indicator
    // self-healing without adding browser traffic or reloading the timeline.
    const typingPoll = isDesktopShell()
      ? window.setInterval(() => void reconcileTypingIndicators(), 2_000)
      : null;
    return () => {
      typingPollDisposed = true;
      clearInterval(activeWorkPoll);
      if (typingPoll !== null) window.clearInterval(typingPoll);
      void supabase.removeChannel(realtime);
    };
  }, [
    activeId,
    loadActiveWork,
    loadMessages,
    reconcileActiveChatState,
    loadScheduledTasks,
    loadThreadMessages,
    markChannelRead,
    markThreadRead,
    visible,
  ]);

  useEffect(() => {
    const activation = chatWorkspaceActivationState({
      hasActivated: chatWorkspaceActivatedRef.current,
      visible,
    });
    chatWorkspaceActivatedRef.current = activation.hasActivated;
    if (activation.shouldReconcile) {
      void reconcileActiveChatState();
    }
  }, [reconcileActiveChatState, visible]);

  useEffect(() => {
    if (!activeId || !currentUserId) return;
    const supabase = getSupabaseBrowserClient();
    let disposed = false;
    let typingBroadcast: ReturnType<typeof supabase.channel> | null = null;

    void supabase.realtime
      .setAuth()
      .then(() => {
        if (disposed) return;
        typingBroadcast = supabase
          .channel(`chat-typing:${activeId}`, {
            config: { private: true },
          })
          .on("broadcast", { event: "typing" }, (event) => {
            const row = chatTypingIndicatorFromBroadcast(
              event.payload,
              activeId,
            );
            if (!row || activeIdRef.current !== activeId) return;
            setTypingIndicators((current) =>
              mergeChatTypingIndicator(current, row),
            );
          })
          .subscribe();
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      if (typingBroadcast) void supabase.removeChannel(typingBroadcast);
    };
  }, [activeId, currentUserId]);

  useEffect(() => {
    const receiveFromNotificationBridge = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const candidate = event.detail?.message as Message | undefined;
      if (
        !candidate ||
        typeof candidate.id !== "string" ||
        candidate.channel_id !== activeIdRef.current
      ) {
        return;
      }
      if (
        candidate.thread_root_message_id &&
        candidate.thread_root_message_id !== threadRootIdRef.current
      ) {
        return;
      }
      if (
        !candidate.thread_root_message_id &&
        timelinePageInfoRef.current.hasNewer
      ) {
        return;
      }
      setMessages((current) => mergeChatMessages(current, [candidate]));
      if (
        chatVisibleRef.current &&
        document.visibilityState === "visible"
      ) {
        void markChannelRead(candidate.channel_id);
      }
    };
    window.addEventListener(
      CHAT_MESSAGE_RECEIVED_EVENT,
      receiveFromNotificationBridge,
    );
    return () =>
      window.removeEventListener(
        CHAT_MESSAGE_RECEIVED_EVENT,
        receiveFromNotificationBridge,
      );
  }, [markChannelRead]);

  useEffect(() => {
    if (
      !activeId ||
      !currentUserId ||
      !mainTypingActive
    ) {
      return;
    }
    const send = () => {
      void fetch(`/api/chat/channels/${activeId}/typing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: true, threadRootMessageId: null }),
        keepalive: true,
      }).catch(() => undefined);
    };
    send();
    const interval = window.setInterval(send, 3_000);
    return () => {
      window.clearInterval(interval);
      void fetch(`/api/chat/channels/${activeId}/typing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false, threadRootMessageId: null }),
        keepalive: true,
      }).catch(() => undefined);
    };
  }, [
    activeId,
    currentUserId,
    mainTypingActive,
  ]);

  useEffect(() => {
    if (
      !activeId ||
      !currentUserId ||
      !threadRootId ||
      !threadTypingActive
    ) {
      return;
    }
    const send = () => {
      void fetch(`/api/chat/channels/${activeId}/typing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          active: true,
          threadRootMessageId: threadRootId,
        }),
        keepalive: true,
      }).catch(() => undefined);
    };
    send();
    const interval = window.setInterval(send, 3_000);
    return () => {
      window.clearInterval(interval);
      void fetch(`/api/chat/channels/${activeId}/typing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          active: false,
          threadRootMessageId: threadRootId,
        }),
        keepalive: true,
      }).catch(() => undefined);
    };
  }, [
    activeId,
    currentUserId,
    threadRootId,
    threadTypingActive,
  ]);

  useEffect(() => {
    if (typingIndicators.length === 0) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setTypingIndicators((current) =>
        current.filter(
          (indicator) => Date.parse(indicator.expires_at) > now,
        ),
      );
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [typingIndicators.length]);

  useEffect(() => {
    let wasBackgrounded = document.visibilityState === "hidden";

    const reconcileForegroundState = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        await reconcileActiveChatState();
      } finally {
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
  }, [reconcileActiveChatState]);

  useLayoutEffect(() => {
    resizeChatComposer(draftRef.current);
  }, [activeId, draft]);

  useEffect(() => {
    if (!activeId || !currentUserId) return;
    const timeout = window.setTimeout(() => {
      writeChatComposerDraft(currentUserId, activeId, draft);
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [activeId, currentUserId, draft]);

  useEffect(
    () => () => {
      const cacheUserId = currentUserIdRef.current || readChatCacheUserId();
      for (const [channelId, composer] of mainComposerStatesRef.current) {
        writeChatComposerDraft(cacheUserId, channelId, composer.draft);
      }
      const revoked = new Set<string>();
      for (const composer of mainComposerStatesRef.current.values()) {
        const previewUrl = composer.voiceNote?.previewUrl;
        if (previewUrl && !revoked.has(previewUrl)) {
          URL.revokeObjectURL(previewUrl);
          revoked.add(previewUrl);
        }
      }
      if (threadVoiceNoteRef.current?.previewUrl) {
        URL.revokeObjectURL(threadVoiceNoteRef.current.previewUrl);
      }
    },
    [],
  );

  useEffect(() => {
    setThreadSelectedImages([]);
    setThreadTextSnippet(null);
    setThreadVoiceNote((current) => {
      if (current?.previewUrl) URL.revokeObjectURL(current.previewUrl);
      return null;
    });
  }, [threadRootId]);

  useEffect(() => {
    if (!composerAddOpen) return;
    const close = (event: MouseEvent) => {
      if (!composerAddMenuRef.current?.contains(event.target as Node)) {
        setComposerAddOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setComposerAddOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [composerAddOpen]);

  useEffect(() => {
    const openCommandSearch = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        setSearchInitialTab("search");
        setSearchInitialScope("workspace");
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", openCommandSearch);
    if (new URLSearchParams(window.location.search).get("search") === "1") {
      setSearchInitialTab("search");
      setSearchInitialScope("workspace");
      setSearchOpen(true);
    }
    const hashMessage = window.location.hash.match(/^#message-(.+)$/)?.[1];
    if (hashMessage) setHighlightedMessageId(hashMessage);
    return () => document.removeEventListener("keydown", openCommandSearch);
  }, []);

  useEffect(() => {
    const requestedThreadRootId = new URLSearchParams(
      window.location.search,
    ).get("thread");
    const channelId = activeIdRef.current;
    if (!channelId || !isUuid(requestedThreadRootId)) return;

    pendingThreadOpenRef.current = null;
    setSchedulePanelOpen(false);
    threadRootIdRef.current = requestedThreadRootId;
    setThreadRootId(requestedThreadRootId);
    setThreadPageInfo(EMPTY_MESSAGE_PAGE_INFO);
    setThreadInitialLoading(true);
    setThreadHistoryLoading(false);
    setThreadDraft("");
    setThreadError(null);
    setThreadResendSource(null);
    void markThreadRead(requestedThreadRootId);
    void loadMessages(channelId, {
      reset: true,
      around: requestedThreadRootId,
    })
      .then(() =>
        loadThreadMessages(channelId, requestedThreadRootId, {
          reset: true,
        }),
      )
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setThreadError(
          cause instanceof Error
            ? cause.message
            : "Could not open this thread.",
        );
      });
  }, [loadMessages, loadThreadMessages, markThreadRead]);

  useEffect(() => {
    if (!socialNotice) return;
    const timer = window.setTimeout(() => setSocialNotice(null), 2_600);
    return () => window.clearTimeout(timer);
  }, [socialNotice]);

  useEffect(() => {
    if (!highlightedMessageId || messagesLoading) return;
    const frame = window.requestAnimationFrame(() => {
      const element = document.getElementById(
        `chat-message-${highlightedMessageId}`,
      );
      if (!element) {
        const target = messages.find(
          (message) => message.id === highlightedMessageId,
        );
        if (
          target?.thread_root_message_id &&
          threadRootId !== target.thread_root_message_id
        ) {
          threadRootIdRef.current = target.thread_root_message_id;
          setThreadRootId(target.thread_root_message_id);
          setThreadPageInfo(EMPTY_MESSAGE_PAGE_INFO);
          void loadThreadMessages(
            target.channel_id,
            target.thread_root_message_id,
            { reset: true, around: target.id },
          ).catch(() => undefined);
          return;
        }
        const anchorKey = activeId
          ? `${activeId}:${highlightedMessageId}`
          : null;
        if (
          activeId &&
          anchorKey &&
          attemptedMessageAnchorRef.current !== anchorKey
        ) {
          attemptedMessageAnchorRef.current = anchorKey;
          timelineSticksToBottomRef.current = false;
          initialTimelineScrollRef.current = false;
          void loadMessages(activeId, {
            reset: true,
            around: highlightedMessageId,
          }).catch((cause) => {
            if (cause instanceof DOMException && cause.name === "AbortError") {
              return;
            }
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not open this message.",
            );
          });
        }
        return;
      }
      const scroller = scrollRef.current;
      if (scroller) {
        const scrollerRect = scroller.getBoundingClientRect();
        const messageRect = element.getBoundingClientRect();
        const messageTop =
          scroller.scrollTop + messageRect.top - scrollerRect.top;
        const topInset =
          messageRect.height < scroller.clientHeight * 0.75
            ? (scroller.clientHeight - messageRect.height) / 2
            : 16;
        scroller.scrollTop = Math.max(
          0,
          Math.min(
            messageTop - topInset,
            scroller.scrollHeight - scroller.clientHeight,
          ),
        );
      } else {
        element.scrollIntoView({ behavior: "auto", block: "center" });
      }
      window.setTimeout(() => setHighlightedMessageId(null), 2_200);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeId,
    highlightedMessageId,
    loadMessages,
    loadThreadMessages,
    messages,
    messagesLoading,
    threadRootId,
  ]);

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
    if (!activeScheduleChannelId || scheduleRunningTaskIds.size === 0) return;
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadScheduledTasks(activeScheduleChannelId, {
          background: true,
        });
      }
    }, 3_000);
    return () => window.clearInterval(poll);
  }, [
    activeScheduleChannelId,
    loadScheduledTasks,
    scheduleRunningTaskIds.size,
  ]);

  const loadOlderHistory = useCallback(async () => {
    const channelId = activeIdRef.current;
    const page = timelinePageInfoRef.current;
    const scroller = scrollRef.current;
    if (
      !channelId ||
      !page.hasOlder ||
      !page.olderCursor ||
      messagesRequestRef.current ||
      !scroller
    ) {
      return;
    }
    pendingTimelineScrollRestoreRef.current = {
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
    };
    try {
      await loadMessages(channelId, { before: page.olderCursor });
    } catch (cause) {
      pendingTimelineScrollRestoreRef.current = null;
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return;
      }
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load earlier messages.",
      );
    }
  }, [loadMessages]);

  const jumpToLatestMessages = useCallback(() => {
    const channelId = activeIdRef.current;
    if (!channelId) return;
    setHighlightedMessageId(null);
    attemptedMessageAnchorRef.current = null;
    timelineSticksToBottomRef.current = true;
    initialTimelineScrollRef.current = true;
    pendingTimelineScrollRestoreRef.current = null;
    void loadMessages(channelId, { reset: true }).catch((cause) => {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return;
      }
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not return to the latest messages.",
      );
    });
  }, [loadMessages]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const main = messages.filter(
      (message) => !message.thread_root_message_id,
    );
    const nextTail = main[main.length - 1]?.id || null;
    const restore = pendingTimelineScrollRestoreRef.current;
    if (restore) {
      pendingTimelineScrollRestoreRef.current = null;
      scroller.scrollTop =
        scroller.scrollHeight - restore.scrollHeight + restore.scrollTop;
    } else if (
      initialTimelineScrollRef.current &&
      main.length > 0
    ) {
      initialTimelineScrollRef.current = false;
      scroller.scrollTop = scroller.scrollHeight;
    } else {
      const tailChanged =
        previousTimelineTailRef.current !== null &&
        previousTimelineTailRef.current !== nextTail;
      if (tailChanged && timelineSticksToBottomRef.current) {
        scroller.scrollTo({
          top: scroller.scrollHeight,
          behavior: "smooth",
        });
      }
    }
    previousTimelineTailRef.current = nextTail;
  }, [messages, pendingOrchestratorStarts]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = timelineContentRef.current;
    if (!scroller || !content || typeof ResizeObserver === "undefined") {
      return;
    }
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (
        !shouldFollowTimelineGrowth({
          sticksToBottom: timelineSticksToBottomRef.current,
          hasNewer: timelinePageInfoRef.current.hasNewer,
          restoringHistory: Boolean(
            pendingTimelineScrollRestoreRef.current,
          ),
        })
      ) {
        return;
      }
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (
          shouldFollowTimelineGrowth({
            sticksToBottom: timelineSticksToBottomRef.current,
            hasNewer: timelinePageInfoRef.current.hasNewer,
            restoringHistory: Boolean(
              pendingTimelineScrollRestoreRef.current,
            ),
          })
        ) {
          scroller.scrollTop = scroller.scrollHeight;
        }
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [activeId]);

  const active = channels.find((channel) => channel.id === activeId) || null;
  const activeDisplayName = active ? chatChannelDisplayName(active) : "";
  const activeSearchScopeLabel = active
    ? chatSearchRoomScopeLabel({ ...active, name: activeDisplayName })
    : "this conversation";
  const memberProfileByUserId = useMemo(
    () =>
      new Map(
        memberProfiles.map((profile) => [profile.user_id, profile] as const),
      ),
    [memberProfiles],
  );
  const memberPresenceByUserId = useMemo(
    () =>
      new Map(
        memberPresence.map((presence) => [presence.user_id, presence] as const),
      ),
    [memberPresence],
  );
  const personByUserId = useMemo(
    () => new Map(people.map((person) => [person.user_id, person] as const)),
    [people],
  );
  const memberNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const person of people) {
      names.set(
        person.user_id,
        memberDisplayName({
          email: person.email,
          profile: memberProfileByUserId.get(person.user_id),
        }),
      );
    }
    return names;
  }, [memberProfileByUserId, people]);
  const currentMemberProfile = useMemo<ChatMemberProfile>(
    () =>
      memberProfileByUserId.get(currentUserId) || {
        user_id: currentUserId,
        display_name:
          people.find((person) => person.user_id === currentUserId)?.email?.split(
            "@",
          )[0] || "You",
        has_avatar: false,
        status_emoji: null,
        status_text: null,
        status_expires_at: null,
        updated_at: null,
      },
    [currentUserId, memberProfileByUserId, people],
  );
  const activeHuddle = useMemo(
    () =>
      activeHuddles.find((huddle) => huddle.channel_id === activeId) || null,
    [activeHuddles, activeId],
  );
  const activeHuddleParticipants = useMemo(
    () =>
      activeHuddle
        ? huddleParticipants.filter(
            (participant) =>
              participant.huddle_id === activeHuddle.id &&
              !participant.left_at,
          )
        : [],
    [activeHuddle, huddleParticipants],
  );
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
  const displayChannels = useMemo(
    () =>
      channels.map((channel) => ({
        ...channel,
        name: chatChannelDisplayName(channel),
      })),
    [channels],
  );
  const displayChannelNameById = useMemo(
    () =>
      new Map(
        displayChannels.map((channel) => [channel.id, channel.name] as const),
      ),
    [displayChannels],
  );
  const displayThreadInbox = useMemo(
    () =>
      threadInbox.map((thread) => ({
        ...thread,
        channel: {
          ...thread.channel,
          name:
            displayChannelNameById.get(thread.channel.id) ||
            thread.channel.name,
        },
      })),
    [displayChannelNameById, threadInbox],
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
  const unreadThreadCount = useMemo(
    () => threadInbox.filter((thread) => thread.unread).length,
    [threadInbox],
  );
  const teammates = useMemo(
    () => people.filter((person) => person.user_id !== currentUserId),
    [currentUserId, people],
  );
  const directMessagePeople = useMemo<DirectMessagePersonOption[]>(
    () =>
      teammates
        .map((person) => ({
          userId: person.user_id,
          label:
            memberNames.get(person.user_id) ||
            person.email?.split("@")[0] ||
            "Teammate",
          email: person.email,
          role: person.role,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [memberNames, teammates],
  );
  const chatPeople = useMemo(
    () =>
      [...people].sort((left, right) => {
        if (left.user_id === currentUserId) return -1;
        if (right.user_id === currentUserId) return 1;
        return (
          memberNames.get(left.user_id) || left.email || ""
        ).localeCompare(memberNames.get(right.user_id) || right.email || "");
      }),
    [currentUserId, memberNames, people],
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
        chatChannelDisplayName(channel)
          .toLowerCase()
          .includes(normalizedSidebarQuery),
      ),
    [directChannels, normalizedSidebarQuery],
  );
  const filteredChatPeople = useMemo(
    () =>
      chatPeople.filter((person) =>
        [
          person.email,
          person.role,
          memberNames.get(person.user_id),
          person.user_id === currentUserId ? "notes to self you" : null,
        ]
          .filter(Boolean)
          .some((value) =>
            String(value).toLowerCase().includes(normalizedSidebarQuery),
          ),
      ),
    [chatPeople, currentUserId, memberNames, normalizedSidebarQuery],
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
    (workspaceRole === "guest" ? 0 : filteredChatPeople.length) +
    (workspaceRole === "guest" ? 0 : filteredAgents.length);
  const messageById = useMemo(
    () =>
      new Map(
        [...messageContext, ...messages].map(
          (message) => [message.id, message] as const,
        ),
      ),
    [messageContext, messages],
  );
  const reactionsByMessageId = useMemo(() => {
    const grouped = new Map<string, ChatMessageReaction[]>();
    for (const reaction of messageReactions) {
      const current = grouped.get(reaction.message_id) || [];
      current.push(reaction);
      grouped.set(reaction.message_id, current);
    }
    return grouped;
  }, [messageReactions]);
  const pinnedMessageIds = useMemo(
    () => new Set(channelPins.map((pin) => pin.message_id)),
    [channelPins],
  );
  const activeTypingNames = useMemo(() => {
    const now = Date.now();
    return typingIndicators
      .filter(
        (indicator) =>
          indicator.channel_id === activeId &&
          indicator.user_id !== currentUserId &&
          indicator.thread_root_message_id === null &&
          Date.parse(indicator.expires_at) > now,
      )
      .map(
        (indicator) =>
          memberNames.get(indicator.user_id) || "A teammate",
      );
  }, [activeId, currentUserId, memberNames, typingIndicators]);
  const activeTypingLabel = typingLabel(activeTypingNames);
  const activeThreadTypingLabel = typingLabel(
    typingIndicators
      .filter(
        (indicator) =>
          indicator.channel_id === activeId &&
          indicator.user_id !== currentUserId &&
          indicator.thread_root_message_id === threadRootId &&
          Date.parse(indicator.expires_at) > Date.now(),
      )
      .map(
        (indicator) =>
          memberNames.get(indicator.user_id) || "A teammate",
      ),
  );
  const mainMessages = useMemo(
    () => messages.filter((message) => !message.thread_root_message_id),
    [messages],
  );
  const mainMindContinuationPending = useMemo(
    () => mindContinuationPending(mainMessages),
    [mainMessages],
  );
  const mainTimelineEntries = useMemo(() => {
    const fallbackStartedAt =
      mainMessages[mainMessages.length - 1]?.created_at ||
      new Date(0).toISOString();
    const workItems: Array<{
      key: string;
      startedAt: string;
      anchorMessageId?: string | null;
      value: ActiveTimelineWork;
    }> = [];
    const delegatingMessageByTraceId = new Map<string, string>();
    for (const message of mainMessages) {
      if (message.author_type !== "orchestrator") continue;
      const traceId =
        typeof message.metadata?.trace_id === "string"
          ? message.metadata.trace_id.trim()
          : "";
      if (traceId) delegatingMessageByTraceId.set(traceId, message.id);
    }
    if (activeWork.orchestrator) {
      workItems.push({
        key: `orchestrator:${activeWork.orchestrator.id}`,
        startedAt: activeWork.orchestrator.started_at,
        value: {
          kind: "orchestrator",
          run: activeWork.orchestrator,
        },
      });
    }
    for (const task of activeWork.agents) {
      workItems.push({
        key: `agent:${task.id}`,
        startedAt: task.startedAt || fallbackStartedAt,
        anchorMessageId: task.traceId
          ? delegatingMessageByTraceId.get(task.traceId) || null
          : null,
        value: { kind: "agent", task },
      });
    }
    return mergeChronologicalChatTimeline(mainMessages, workItems);
  }, [activeWork, mainMessages]);
  const recentImageAttachments = useMemo(() => {
    const seen = new Set<string>();
    const recent: Array<MessageImageAttachment & { channelId: string }> = [];
    for (const message of [...messages].reverse()) {
      for (const attachment of messageImageAttachments(message.metadata)) {
        if (seen.has(attachment.id)) continue;
        seen.add(attachment.id);
        recent.push({ ...attachment, channelId: message.channel_id });
        if (recent.length >= 6) return recent;
      }
    }
    return recent;
  }, [messages]);
  const threadReplyCountByRoot = useMemo(() => {
    const counts = new Map(serverThreadReplyCounts);
    const loadedCounts = new Map<string, number>();
    for (const message of messages) {
      if (!message.thread_root_message_id) continue;
      loadedCounts.set(
        message.thread_root_message_id,
        (loadedCounts.get(message.thread_root_message_id) || 0) + 1,
      );
    }
    for (const [rootId, count] of loadedCounts) {
      counts.set(rootId, Math.max(counts.get(rootId) || 0, count));
    }
    return counts;
  }, [messages, serverThreadReplyCounts]);
  const activeThreadRoot = threadRootId
    ? messageById.get(threadRootId) || null
    : null;
  const activeThreadReplies = useMemo(
    () =>
      threadRootId
        ? messages.filter(
            (message) => message.thread_root_message_id === threadRootId,
          )
        : [],
    [messages, threadRootId],
  );
  const threadMindContinuationPending = useMemo(
    () => mindContinuationPending(activeThreadReplies),
    [activeThreadReplies],
  );
  const messageAuthorLabel = useCallback(
    (message: Message) => {
      const profile = message.profile_id
        ? profileById.get(message.profile_id)
        : activeProfile;
      if (message.author_type === "orchestrator") {
        return profile?.name || "Groovy";
      }
      if (message.author_type === "agent") {
        return typeof message.metadata?.agent_name === "string"
          ? message.metadata.agent_name
          : "Agent";
      }
      if (message.author_type === "system") {
        return webhookMessageLabel(message) || "System";
      }
      if (message.author_user_id === currentUserId) {
        return `${memberNames.get(currentUserId) || "You"} (you)`;
      }
      return message.author_user_id
        ? memberNames.get(message.author_user_id) || "Teammate"
        : "Teammate";
    },
    [activeProfile, currentUserId, memberNames, profileById],
  );
  const toThreadMessageView = useCallback(
    (message: Message): ChannelThreadMessageView => {
      const imageAttachments = messageImageAttachments(message.metadata);
      const fileAttachments = messageFileAttachments(message.metadata);
      const attachments = [...imageAttachments, ...fileAttachments];
      const voice = messageVoiceAttachment(message.metadata);
      const snippet = messageTextSnippet(message.metadata);
      return {
        id: message.id,
        label: messageAuthorLabel(message),
        authorType: message.author_type,
        content: message.content,
        createdAt: message.created_at,
        pending: isPendingChatMessage(message),
        ownMessage:
          message.author_type === "user" &&
          message.author_user_id === currentUserId,
        imageOnly:
          message.metadata?.image_only === true &&
          imageAttachments.length > 0,
        fileOnly:
          message.metadata?.file_only === true && fileAttachments.length > 0,
        voiceOnly: message.metadata?.voice_only === true && Boolean(voice),
        snippetOnly:
          message.metadata?.snippet_only === true && Boolean(snippet),
        attachments: attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })),
        voiceNote: voice
          ? {
              id: voice.id,
              name: voice.name,
              durationMs: voice.durationMs,
            }
          : null,
        snippet,
        taskResult: message.metadata?.kind === "agent_task_result",
        taskStatus: message.metadata?.status,
        deleted: typeof message.metadata?.deleted_at === "string",
        edited: typeof message.metadata?.edited_at === "string",
      };
    },
    [currentUserId, messageAuthorLabel],
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
  const activeHumanIds = useMemo(
    () =>
      activeMembers
        .filter(
          (member) =>
            member.member_type === "user" && Boolean(member.user_id),
        )
        .map((member) => member.user_id as string),
    [activeMembers],
  );
  const activeIsHumanDm =
    active?.kind === "dm" &&
    !activeMembers.some((member) => member.member_type === "agent");
  const canAttachImages = Boolean(active);
  const selectedImagePreviews = useMemo(
    () =>
      selectedImages
        .map((file, index) => ({ file, index }))
        .filter(({ file }) => isChatImageAttachment(file))
        .map(({ file, index }) => ({
          file,
          index,
          url: URL.createObjectURL(file),
        })),
    [selectedImages],
  );
  const selectedFilePreviews = useMemo(
    () =>
      selectedImages
        .map((file, index) => ({ file, index }))
        .filter(({ file }) => !isChatImageAttachment(file)),
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
  const mentionOptionsFor = useCallback((queryValue: string | null) => {
    if (!active || queryValue === null) {
      return [];
    }
    const query = queryValue.trim().toLowerCase();
    const roomLabel =
      active.kind === "channel" ? "this channel" : "this conversation";
    const mindName = activeProfile?.name || "Groovy";
    const mindHandle = teamChatMentionHandle(
      activeProfile?.slug || DEFAULT_TEAM_CHAT_MIND_HANDLE,
      DEFAULT_TEAM_CHAT_MIND_HANDLE,
    );
    const selectedAgents = selectedChannelAgents(agents, activeMembers);
    const selectedAgentIds = new Set(selectedAgents.map((agent) => agent.id));
    const mentionableAgents =
      active.kind === "dm" || workspaceRole === "admin"
        ? agents
        : selectedAgents;
    const options: ChatMentionOption[] = [
      {
        id: `mind:${activeProfile?.id || "default"}`,
        kind: "mind",
        handle: mindHandle,
        label: mindName,
        detail:
          active.orchestrator_mode === "off"
            ? `Mind replies are off in ${roomLabel}`
            : active.kind === "channel"
              ? "Channel Mind"
              : "Conversation Mind",
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
            ? `${agent.harness} · assigned to ${roomLabel}`
            : `${agent.harness} · add to ${roomLabel}`,
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
            ? `In ${roomLabel}`
            : person.role === "guest"
              ? `Workspace guest · add to ${roomLabel}`
              : `Workspace member · add to ${roomLabel}`,
          included,
          email,
        };
      }),
    ];
    const filtered = options
      .filter((option) =>
        [option.handle, option.label].some((value) =>
          value.toLowerCase().includes(query),
        ),
      )
      .sort((left, right) => {
        const relevance = (option: ChatMentionOption) => {
          const handle = option.handle.toLowerCase();
          const label = option.label.toLowerCase();
          return (
            (option.included ? 0 : 10) +
            (handle.startsWith(query)
              ? 0
              : label.startsWith(query)
                ? 1
                : 2)
          );
        };
        return relevance(left) - relevance(right);
      });
    const emailCandidate = queryValue.trim().toLowerCase();
    const isExternalEmail =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCandidate) &&
      !people.some(
        (person) => person.email?.toLowerCase() === emailCandidate,
      );
    if (
      active.kind === "channel" &&
      isExternalEmail &&
      workspaceRole === "admin"
    ) {
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
    people,
    teammates,
    workspaceRole,
  ]);
  const mentionOptions = useMemo<ChatMentionOption[]>(
    () => mentionOptionsFor(mentionQuery),
    [mentionOptionsFor, mentionQuery],
  );
  const threadMentionOptions = useMemo<ChatMentionOption[]>(
    () => mentionOptionsFor(threadMentionQuery),
    [mentionOptionsFor, threadMentionQuery],
  );

  useEffect(() => {
    setMentionActiveIndex(0);
  }, [mentionQuery]);
  useEffect(() => {
    setThreadMentionActiveIndex(0);
  }, [threadMentionQuery]);

  const selectChannel = (id: string) => {
    if (activeIdRef.current !== id) {
      messagesRequestRef.current?.abort();
      threadRequestRef.current?.abort();
      activeIdRef.current = id;
      setMessages([]);
      setMessageContext([]);
      setMessagesLoading(true);
      setTimelinePageInfo(EMPTY_MESSAGE_PAGE_INFO);
      timelinePageInfoRef.current = EMPTY_MESSAGE_PAGE_INFO;
      setThreadPageInfo(EMPTY_MESSAGE_PAGE_INFO);
      setServerThreadReplyCounts(new Map());
      setActiveWork({ orchestrator: null, agents: [] });
    }
    setActiveId(id);
    setThreadRootId(null);
    setThreadDraft("");
    setThreadError(null);
    setThreadResendSource(null);
    setThreadMentionQuery(null);
    setMentionQuery(null);
    setMentionStart(null);
    setMentionEnd(null);
    setError(null);
    setControlBusy(null);
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
    window.dispatchEvent(
      new Event("groovy:notification-preferences-changed"),
    );
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
    if (open) {
      setThreadRootId(null);
      setThreadDraft("");
      setThreadError(null);
      setThreadResendSource(null);
      setThreadMentionQuery(null);
    }
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

  const openThread = (message: Message) => {
    if (isPendingChatMessage(message)) return;
    const rootId = resolveThreadRootId(message);
    if (!messageById.has(rootId)) return;
    const hasOtherUnreadThreads = Array.from(unreadThreadRoots).some(
      (candidate) =>
        candidate !== rootId && messageById.has(candidate),
    );
    setSchedulePanelOpen(false);
    threadRootIdRef.current = rootId;
    setThreadRootId(rootId);
    setThreadPageInfo(EMPTY_MESSAGE_PAGE_INFO);
    setThreadInitialLoading(true);
    setThreadHistoryLoading(false);
    setThreadDraft("");
    setThreadError(null);
    setThreadResendSource(null);
    dismissThreadMention();
    setUnreadThreadRoots((current) => {
      if (!current.has(rootId)) return current;
      const next = new Set(current);
      next.delete(rootId);
      return next;
    });
    void markThreadRead(rootId);
    if (activeIdRef.current && !hasOtherUnreadThreads) {
      void markChannelRead(activeIdRef.current);
    }
    if (activeIdRef.current) {
      void loadThreadMessages(activeIdRef.current, rootId, {
        reset: true,
      }).catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setThreadError(
          cause instanceof Error ? cause.message : "Could not load this thread.",
        );
      });
    }
  };

  const closeThread = () => {
    threadRequestRef.current?.abort();
    threadRootIdRef.current = null;
    setThreadRootId(null);
    setThreadPageInfo(EMPTY_MESSAGE_PAGE_INFO);
    setThreadInitialLoading(false);
    setThreadHistoryLoading(false);
    setThreadDraft("");
    setThreadError(null);
    setThreadResendSource(null);
    dismissThreadMention();
    pruneLoadedThreadState();
    if (activeIdRef.current) {
      window.history.replaceState(
        null,
        "",
        `/chat/${activeIdRef.current}`,
      );
    }
  };

  const loadOlderThreadReplies = useCallback(async () => {
    const channelId = activeIdRef.current;
    const rootId = threadRootIdRef.current;
    if (
      !channelId ||
      !rootId ||
      !threadPageInfo.hasOlder ||
      !threadPageInfo.olderCursor ||
      threadHistoryLoading ||
      threadRequestRef.current
    ) {
      return;
    }
    try {
      await loadThreadMessages(channelId, rootId, {
        before: threadPageInfo.olderCursor,
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return;
      }
      setThreadError(
        cause instanceof Error
          ? cause.message
          : "Could not load earlier replies.",
      );
    }
  }, [
    loadThreadMessages,
    threadHistoryLoading,
    threadPageInfo.hasOlder,
    threadPageInfo.olderCursor,
  ]);

  const jumpThreadToLatest = useCallback(() => {
    const channelId = activeIdRef.current;
    const rootId = threadRootIdRef.current;
    if (!channelId || !rootId) return;
    void loadThreadMessages(channelId, rootId, { reset: true }).catch(
      (cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setThreadError(
          cause instanceof Error
            ? cause.message
            : "Could not return to the latest replies.",
        );
      },
    );
  }, [loadThreadMessages]);

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

  const openDirectComposer = () => {
    if (workspaceRole === "guest") return;
    setCollapsedSections((current) => ({ ...current, direct: false }));
    setSidebarSearchOpen(false);
    setSidebarQuery("");
    setDirectComposerOpen(true);
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

  const createDirectMessage = async (participantUserIds: string[]) => {
    if (workspaceRole === "guest") {
      throw new Error("Channel guests cannot create direct messages.");
    }
    const userIds = Array.from(
      new Set(
        participantUserIds.filter(
          (userId) => userId && userId !== currentUserId,
        ),
      ),
    );
    if (userIds.length === 0) {
      throw new Error("Choose at least one person.");
    }
    const existing = channels.find((channel) => {
      if (channel.kind !== "dm") return false;
      const members = channelMembers.filter(
        (member) => member.channel_id === channel.id,
      );
      return isHumanDirectMessageForParticipants({
        currentUserId,
        participantUserIds: userIds,
        memberUserIds: members
          .filter((member) => member.member_type === "user")
          .map((member) => member.user_id),
        hasAgent: members.some((member) => member.member_type === "agent"),
      });
    });
    if (existing) {
      setDirectComposerOpen(false);
      selectChannel(existing.id);
      return;
    }

    const name =
      userIds
        .map(
          (userId) =>
            memberNames.get(userId) ||
            people.find((person) => person.user_id === userId)?.email?.split(
              "@",
            )[0] ||
            "Teammate",
        )
        .join(", ")
        .slice(0, 100) || "Group conversation";
    const response = await fetch("/api/chat/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "dm",
        name,
        slug: `dm-${crypto.randomUUID()}`,
        userIds,
        profileId: null,
        orchestratorMode: "off",
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Could not start this conversation.");
    }
    revealCreatedChannel(
      payload.channel as Channel,
      Array.isArray(payload.members) ? payload.members : [],
    );
    setDirectComposerOpen(false);
  };

  const openAgentDm = async (agent: Agent) => {
    const existing = channels.find((channel) =>
      isAgentDirectMessageForRecipient({
        kind: channel.kind,
        agentId: agent.id,
        members: channelMembers.filter(
          (member) => member.channel_id === channel.id,
        ),
      }),
    );
    if (existing) {
      selectChannel(existing.id);
      if (
        existing.profile_id !== null ||
        existing.orchestrator_mode !== "off"
      ) {
        // Membership already guarantees direct worker dispatch. Normalize the
        // legacy presentation metadata in the background when this viewer is
        // allowed to edit the room, without blocking the conversation.
        void fetch(`/api/chat/channels/${existing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profileId: null,
            orchestratorMode: "off",
          }),
        })
          .then((response) => {
            if (response.ok) void loadSidebar();
          })
          .catch(() => undefined);
      }
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
      // Older builds created Agent-looking DMs with a Mind attached. Repair a
      // legacy room only when it has no Agent roster at all; never retarget a
      // conversation that already belongs to a different Agent.
      const legacy = channels.find(
        (channel) =>
          channel.kind === "dm" && channel.slug === `agent-${agent.id}`,
      );
      if (legacy) {
        const legacyMembers = channelMembers.filter(
          (member) => member.channel_id === legacy.id,
        );
        if (channelAgentIds(legacyMembers).length > 0) {
          throw new Error(
            "This conversation is linked to a different Agent. Ask a workspace admin to repair its participants.",
          );
        }
        if (
          !isAgentDirectMessageForRecipient({
            kind: legacy.kind,
            agentId: agent.id,
            members: [
              ...legacyMembers,
              { member_type: "agent", user_id: null, agent_id: agent.id },
            ],
          })
        ) {
          throw new Error(
            "This legacy conversation is not one-to-one, so it cannot be converted into an Agent direct message.",
          );
        }
        const memberResponse = await fetch(
          `/api/chat/channels/${legacy.id}/members`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ memberType: "agent", agentId: agent.id }),
          },
        );
        const memberPayload = await memberResponse.json().catch(() => ({}));
        if (!memberResponse.ok && memberResponse.status !== 409) {
          throw new Error(
            memberPayload.error || "Could not repair this Agent conversation.",
          );
        }
        await fetch(`/api/chat/channels/${legacy.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profileId: null,
            orchestratorMode: "off",
          }),
        });
        // The Agent membership is the security/routing boundary, so a viewer
        // who cannot edit room settings can still use the repaired direct DM.
        // Normalize stale Mind metadata when permissions allow it.
        await loadSidebar();
        selectChannel(legacy.id);
        return;
      }
      const res = await fetch("/api/chat/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "dm",
          name: agent.name,
          slug: `agent-${agent.id}`,
          agentIds: [agent.id],
          profileId: null,
          orchestratorMode: "off",
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
    const isSelf = person.user_id === currentUserId;
    const existing = channels.find((channel) => {
      if (channel.kind !== "dm") return false;
      const members = channelMembers.filter(
        (member) => member.channel_id === channel.id,
      );
      return isHumanDirectMessageForRecipient({
        currentUserId,
        recipientUserId: person.user_id,
        memberUserIds: members
          .filter((member) => member.member_type === "user")
          .map((member) => member.user_id),
        hasAgent: members.some((member) => member.member_type === "agent"),
      });
    });
    if (existing) {
      selectChannel(existing.id);
      return;
    }

    const label = isSelf
      ? "Notes to self"
      : memberNames.get(person.user_id) ||
        person.email?.split("@")[0] ||
        "Teammate";
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
          slug: isSelf
            ? selfDirectMessageSlug(currentUserId)
            : `dm-${crypto.randomUUID()}`,
          userIds: [person.user_id],
          profileId: null,
          orchestratorMode: "off",
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          payload.error ||
            (isSelf
              ? "Could not open your notes."
              : "Could not open teammate conversation."),
        );
      }
      revealCreatedChannel(
        payload.channel as Channel,
        Array.isArray(payload.members) ? payload.members : [],
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : isSelf
            ? "Could not open your notes."
            : "Could not open teammate conversation.",
      );
    } finally {
      setOpeningConversation((current) =>
        current?.id === openingId ? null : current,
      );
    }
  };

  const updateMentionState = (value: string, cursor: number | null) => {
    if (!active) {
      setMentionQuery(null);
      setMentionStart(null);
      setMentionEnd(null);
      return;
    }
    const trigger = chatMentionTrigger(value, cursor);
    if (!trigger) {
      setMentionQuery(null);
      setMentionStart(null);
      setMentionEnd(null);
      return;
    }
    setMentionQuery(trigger.query);
    setMentionStart(trigger.start);
    setMentionEnd(trigger.end);
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

  const dismissThreadMention = () => {
    setThreadMentionQuery(null);
    setThreadMentionStart(null);
    setThreadMentionEnd(null);
  };

  const updateThreadMentionState = (
    value: string,
    cursor: number | null,
  ) => {
    if (!active) {
      dismissThreadMention();
      return;
    }
    const trigger = chatMentionTrigger(value, cursor);
    if (!trigger) {
      dismissThreadMention();
      return;
    }
    setThreadMentionQuery(trigger.query);
    setThreadMentionStart(trigger.start);
    setThreadMentionEnd(trigger.end);
  };

  const insertThreadMention = (option: ChatMentionOption) => {
    if (threadMentionStart === null || threadMentionEnd === null) return;
    const before = threadDraft.slice(0, threadMentionStart);
    const after = threadDraft.slice(threadMentionEnd);
    const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
    const token = `@${option.handle}${needsTrailingSpace ? " " : ""}`;
    setThreadDraft(`${before}${token}${after}`);
    dismissThreadMention();
  };

  const selectMention = async (
    option: ChatMentionOption,
    target: "main" | "thread" = "main",
  ) => {
    if (!active || mentionBusyId) return;
    const activeQuery =
      target === "thread" ? threadMentionQuery : mentionQuery;
    const dismiss =
      target === "thread"
        ? dismissThreadMention
        : () => {
            setMentionQuery(null);
            setMentionStart(null);
            setMentionEnd(null);
          };
    const insert =
      target === "thread" ? insertThreadMention : insertMention;
    if (option.kind === "mind" && active.orchestrator_mode === "off") {
      setError(
        "The channel Mind is turned off. A workspace admin or the channel creator can enable @mention replies in room settings.",
      );
      dismiss();
      return;
    }
    if (option.kind === "invite") {
      setInviteContext({
        email: option.email || activeQuery || "",
        channelId: active.id,
        channelName: activeDisplayName,
      });
      setPeopleInviteOpen(true);
      dismiss();
      return;
    }
    if (option.kind === "agent" && !option.included) {
      if (active.kind === "channel" && workspaceRole !== "admin") {
        setError("Only workspace admins can add agents to a channel.");
        dismiss();
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
      insert(option);
      return;
    }
    if (!option.included && option.kind !== "mind") {
      if (!canManageActive) {
        setError(
          "Only a workspace admin or this channel’s creator can add participants.",
        );
        dismiss();
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
            `Add this channel guest? ${activeSkillCount} assigned ${
              activeSkillCount === 1 ? "capability" : "capabilities"
            } will remain available to the Mind in replies this guest can see. Only continue if the assigned content is approved for guest-facing use.`,
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
    insert(option);
  };

  const addImages = (files: File[]) => {
    if (voiceNote || textSnippet) {
      setError(
        "Remove the voice note or text snippet before attaching files.",
      );
      return;
    }
    const supportedFiles = files.filter(isSupportedChatAttachmentFile);
    if (supportedFiles.length !== files.length) {
      setError(
        "Upload an image, PDF, Office document, text file, CSV, Markdown, JSON, RTF, or ZIP file.",
      );
    }
    if (supportedFiles.length === 0) return;
    const remaining = MAX_CHAT_ATTACHMENT_FILES - selectedImages.length;
    if (remaining <= 0) {
      setError(`Attach up to ${MAX_CHAT_ATTACHMENT_FILES} files at a time.`);
      return;
    }
    setError(
      supportedFiles.length > remaining
        ? `Attach up to ${MAX_CHAT_ATTACHMENT_FILES} files at a time.`
        : null,
    );
    setSelectedImages((current) => [
      ...current,
      ...supportedFiles.slice(0, remaining),
    ]);
  };

  const addThreadImages = (files: File[]) => {
    if (threadVoiceNote || threadTextSnippet) {
      setThreadError(
        "Remove the voice note or text snippet before attaching files.",
      );
      return;
    }
    const supportedFiles = files.filter(isSupportedChatAttachmentFile);
    if (supportedFiles.length !== files.length) {
      setThreadError(
        "Upload an image, PDF, Office document, text file, CSV, Markdown, JSON, RTF, or ZIP file.",
      );
    }
    if (supportedFiles.length === 0) return;
    const remaining =
      MAX_CHAT_ATTACHMENT_FILES - threadSelectedImages.length;
    if (remaining <= 0) {
      setThreadError(
        `Attach up to ${MAX_CHAT_ATTACHMENT_FILES} files at a time.`,
      );
      return;
    }
    setThreadError(
      supportedFiles.length > remaining
        ? `Attach up to ${MAX_CHAT_ATTACHMENT_FILES} files at a time.`
        : null,
    );
    setThreadSelectedImages((current) => [
      ...current,
      ...supportedFiles.slice(0, remaining),
    ]);
  };

  const reuseRecentImage = async (
    attachment: MessageImageAttachment & { channelId: string },
    target: "main" | "thread" = "main",
  ) => {
    if (composerRecentBusyId) return;
    setComposerRecentBusyId(attachment.id);
    setError(null);
    try {
      const response = await fetch(
        `/api/chat/channels/${attachment.channelId}/attachments/${attachment.id}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error("That recent image is no longer available.");
      }
      const blob = await response.blob();
      const file = new File([blob], attachment.name, {
        type: blob.type || attachment.mimeType,
      });
      if (target === "thread") addThreadImages([file]);
      else addImages([file]);
      setComposerRecentOpen(false);
      setComposerAddOpen(false);
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Could not reuse that recent image.";
      if (target === "thread") setThreadError(message);
      else setError(message);
    } finally {
      setComposerRecentBusyId(null);
    }
  };

  const clearVoiceNote = () => {
    setVoiceNote((current) => {
      if (current?.previewUrl) URL.revokeObjectURL(current.previewUrl);
      return null;
    });
  };

  const clearThreadVoiceNote = () => {
    setThreadVoiceNote((current) => {
      if (current?.previewUrl) URL.revokeObjectURL(current.previewUrl);
      return null;
    });
  };

  const applyDraftFormat = (format: ChatComposerFormat) => {
    const textarea = draftRef.current;
    const selectionStart = textarea?.selectionStart ?? draft.length;
    const selectionEnd = textarea?.selectionEnd ?? draft.length;
    let href: string | undefined;
    if (format === "link") {
      const entered = window.prompt("Link URL", "https://");
      if (entered === null) return;
      try {
        const parsed = new URL(entered);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("unsupported");
        }
        href = parsed.href;
      } catch {
        setError("Links must use a valid http:// or https:// URL.");
        return;
      }
    }
    const result = applyChatComposerFormat(
      { value: draft, selectionStart, selectionEnd },
      format,
      { href },
    );
    setDraft(result.value);
    setError(null);
    window.requestAnimationFrame(() => {
      resizeChatComposer(draftRef.current);
      draftRef.current?.focus();
      draftRef.current?.setSelectionRange(
        result.selectionStart,
        result.selectionEnd,
      );
    });
  };

  const insertComposerMention = () => {
    const textarea = draftRef.current;
    const selectionStart = textarea?.selectionStart ?? draft.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const needsLeadingSpace =
      selectionStart > 0 && !/\s/.test(draft[selectionStart - 1] || "");
    const insertion = `${needsLeadingSpace ? " " : ""}@`;
    const next =
      draft.slice(0, selectionStart) +
      insertion +
      draft.slice(selectionEnd);
    const cursor = selectionStart + insertion.length;
    setDraft(next);
    updateMentionState(next, cursor);
    window.requestAnimationFrame(() => {
      draftRef.current?.focus();
      draftRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const beginEditAndResend = (message: Message) => {
    if (
      isPendingChatMessage(message) ||
      message.author_type !== "user" ||
      message.author_user_id !== currentUserIdRef.current
    ) {
      return;
    }
    if (message.thread_root_message_id) {
      openThread(message);
      setThreadDraft(message.content);
      setThreadSelectedImages([]);
      clearThreadVoiceNote();
      setThreadTextSnippet(null);
      setThreadResendSource(message);
      setThreadError(null);
      dismissThreadMention();
      return;
    }
    const channelId = message.channel_id;
    const currentVoicePreview =
      mainComposerStatesRef.current.get(channelId)?.voiceNote?.previewUrl;
    if (currentVoicePreview) URL.revokeObjectURL(currentVoicePreview);
    setMainComposerStates((current) =>
      updateKeyedValue(
        current,
        channelId,
        EMPTY_MAIN_COMPOSER_STATE,
        (composer) => ({
          ...composer,
          draft: message.content,
          selectedImages: [],
          voiceNote: null,
          textSnippet: null,
          replyTo: message.reply_to_message_id
            ? messageById.get(message.reply_to_message_id) || null
            : null,
          resendSource: message,
        }),
      ),
    );
    setMentionQuery(null);
    setMentionStart(null);
    setMentionEnd(null);
    setError(null);
    window.requestAnimationFrame(() => {
      resizeChatComposer(draftRef.current);
      draftRef.current?.focus();
      const length = draftRef.current?.value.length || 0;
      draftRef.current?.setSelectionRange(length, length);
    });
  };

  const interactWithMessage = async (
    message: Message,
    action: "reaction" | "save" | "pin",
    emoji?: string,
  ) => {
    if (
      isPendingChatMessage(message) ||
      socialMigrationPending ||
      socialBusyId
    ) {
      if (socialMigrationPending) {
        setSocialNotice("Chat extras are being activated. Try again shortly.");
      }
      return;
    }
    const busyId = `${message.id}:${action}:${emoji || ""}`;
    setSocialBusyId(busyId);
    setError(null);
    try {
      const response = await fetch(
        `/api/chat/channels/${message.channel_id}/messages/${message.id}/interactions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, emoji }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not update this message.");
      }
      if (action === "reaction" && emoji) {
        setMessageReactions((current) => {
          const withoutMine = current.filter(
            (reaction) =>
              !(
                reaction.message_id === message.id &&
                reaction.user_id === currentUserIdRef.current &&
                reaction.emoji === emoji
              ),
          );
          return payload.active && payload.reaction
            ? [...withoutMine, payload.reaction as ChatMessageReaction]
            : withoutMine;
        });
      } else if (action === "save") {
        setSavedMessageIds((current) => {
          const next = new Set(current);
          if (payload.active) next.add(message.id);
          else next.delete(message.id);
          return next;
        });
        setSocialNotice(
          payload.active ? "Saved for later" : "Removed from Later",
        );
      } else if (action === "pin") {
        setChannelPins((current) =>
          payload.active
            ? [
                ...current.filter((pin) => pin.message_id !== message.id),
                {
                  channel_id: message.channel_id,
                  message_id: message.id,
                  pinned_by: currentUserIdRef.current,
                  created_at: new Date().toISOString(),
                },
              ]
            : current.filter((pin) => pin.message_id !== message.id),
        );
        setSocialNotice(
          payload.active ? "Pinned to this room" : "Removed from pins",
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update this message.",
      );
    } finally {
      setSocialBusyId(null);
    }
  };

  const deleteMessage = async (message: Message) => {
    if (
      isPendingChatMessage(message) ||
      message.author_type !== "user" ||
      message.author_user_id !== currentUserIdRef.current
    ) {
      return;
    }
    if (
      !window.confirm(
        message.thread_root_message_id
          ? "Delete this thread reply? This cannot be undone."
          : "Delete this message? Replies will keep a deleted-message placeholder.",
      )
    ) {
      return;
    }
    setSocialBusyId(`${message.id}:delete`);
    setError(null);
    try {
      const response = await fetch(
        `/api/chat/channels/${message.channel_id}/messages/${message.id}`,
        { method: "DELETE" },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not delete this message.");
      }
      if (payload.message) {
        setMessages((current) =>
          mergeChatMessages(current, [payload.message as Message]),
        );
      }
      setMessageReactions((current) =>
        current.filter((reaction) => reaction.message_id !== message.id),
      );
      setSavedMessageIds((current) => {
        const next = new Set(current);
        next.delete(message.id);
        return next;
      });
      setChannelPins((current) =>
        current.filter((pin) => pin.message_id !== message.id),
      );
      setSocialNotice("Message deleted");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not delete this message.",
      );
    } finally {
      setSocialBusyId(null);
    }
  };

  const copyMessageLink = async (message: Message) => {
    const url = new URL(`/chat/${message.channel_id}`, window.location.origin);
    url.hash = `message-${message.id}`;
    try {
      await navigator.clipboard.writeText(url.href);
      setSocialNotice("Message link copied");
    } catch {
      setSocialNotice(url.href);
    }
  };

  const openSearchResult = (channelId: string, messageId: string) => {
    attemptedMessageAnchorRef.current = `${channelId}:${messageId}`;
    timelineSticksToBottomRef.current = false;
    initialTimelineScrollRef.current = false;
    setHighlightedMessageId(messageId);
    if (activeIdRef.current === channelId) {
      void loadMessages(channelId, {
        reset: true,
        around: messageId,
      }).catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not open this search result.",
        );
      });
      return;
    }
    pendingSearchAnchorRef.current = { channelId, messageId };
    selectChannel(channelId);
  };

  const openThreadInboxResult = (
    channelId: string,
    rootMessageId: string,
  ) => {
    setThreadsOpen(false);
    setMobileNavOpen(false);
    pendingThreadOpenRef.current = { channelId, rootMessageId };
    attemptedMessageAnchorRef.current = `${channelId}:${rootMessageId}`;
    timelineSticksToBottomRef.current = false;
    initialTimelineScrollRef.current = false;
    setHighlightedMessageId(rootMessageId);
    if (activeIdRef.current !== channelId) {
      selectChannel(channelId);
      window.history.replaceState(
        null,
        "",
        `/chat/${channelId}?thread=${encodeURIComponent(
          rootMessageId,
        )}#message-${encodeURIComponent(rootMessageId)}`,
      );
      return;
    }

    pendingThreadOpenRef.current = null;
    setSchedulePanelOpen(false);
    threadRootIdRef.current = rootMessageId;
    setThreadRootId(rootMessageId);
    setThreadPageInfo(EMPTY_MESSAGE_PAGE_INFO);
    setThreadInitialLoading(true);
    setThreadHistoryLoading(false);
    setThreadDraft("");
    setThreadError(null);
    setThreadResendSource(null);
    dismissThreadMention();
    void markThreadRead(rootMessageId);
    window.history.replaceState(
      null,
      "",
      `/chat/${channelId}?thread=${encodeURIComponent(
        rootMessageId,
      )}#message-${encodeURIComponent(rootMessageId)}`,
    );
    void loadMessages(channelId, {
      reset: true,
      around: rootMessageId,
    })
      .then(() =>
        loadThreadMessages(channelId, rootMessageId, {
          reset: true,
        }),
      )
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setThreadError(
          cause instanceof Error ? cause.message : "Could not open this thread.",
        );
      });
  };

  // Notification taps arrive as a soft navigation (no reload, no remount), so
  // channel/thread intent in the URL must be applied imperatively here.
  const applyChatNavigationRef = useRef<(url: string) => void>(() => {});
  applyChatNavigationRef.current = (url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url, window.location.origin);
    } catch {
      return;
    }
    const match = parsed.pathname.match(/^\/chat\/([^/]+)\/?$/);
    if (!match) return;
    const channelId = decodeURIComponent(match[1]);
    if (!isUuid(channelId)) return;
    const threadRoot = parsed.searchParams.get("thread") || "";
    if (isUuid(threadRoot)) {
      openThreadInboxResult(channelId, threadRoot);
      return;
    }
    if (activeIdRef.current !== channelId) {
      selectChannel(channelId);
    }
  };

  useEffect(() => {
    const onAppNavigate = (event: Event) => {
      const url =
        event instanceof CustomEvent
          ? (event.detail as { url?: unknown } | null)?.url
          : null;
      if (typeof url !== "string") return;
      applyChatNavigationRef.current(url);
    };
    window.addEventListener(APP_NAVIGATE_EVENT, onAppNavigate);
    return () =>
      window.removeEventListener(APP_NAVIGATE_EVENT, onAppNavigate);
  }, []);

  const send = async () => {
    if (
      !active ||
      (!draft.trim() &&
        selectedImages.length === 0 &&
        !voiceNote &&
        !textSnippet)
    ) {
      return;
    }
    if (selectedImages.length > 0 && !canAttachImages) {
      setError("Files cannot be shared in this conversation right now.");
      return;
    }
    const lengthError = chatMessageLengthError(draft);
    if (lengthError) {
      setError(lengthError);
      draftRef.current?.focus();
      return;
    }
    const selectedAttachmentKinds =
      (selectedImages.length > 0 ? 1 : 0) +
      (voiceNote ? 1 : 0) +
      (textSnippet ? 1 : 0);
    if (selectedAttachmentKinds > 1) {
      setError("Send files, one voice note, or one text snippet at a time.");
      return;
    }
    const content = draft.trim();
    const images = selectedImages;
    const recordedVoiceNote = voiceNote;
    const snippetTarget = textSnippet;
    const channelId = active.id;
    const replyTarget = replyTo;
    const resendTarget = resendSource;
    const clientMessageId = window.crypto.randomUUID();
    const optimisticMessageId =
      resendTarget?.id || `optimistic:${clientMessageId}`;
    const optimisticMessage: Message = {
      id: optimisticMessageId,
      channel_id: channelId,
      author_type: "user",
      author_user_id: currentUserIdRef.current || null,
      author_agent_id: null,
      profile_id: null,
      content:
        content ||
        (images.length > 0
          ? chatAttachmentOnlyMessage(images)
          : recordedVoiceNote
              ? "Shared a voice note"
              : textSnippetMessage(snippetTarget!)),
      reply_to_message_id:
        resendTarget?.reply_to_message_id || replyTarget?.id || null,
      thread_root_message_id:
        resendTarget?.thread_root_message_id || null,
      metadata: {
        ...(resendTarget?.metadata || {}),
        client_message_id: clientMessageId,
        client_pending: true,
        ...(resendTarget
          ? { edited_at: new Date().toISOString(), image_only: false }
          : {}),
        ...(recordedVoiceNote
          ? {
              voice_note: {
                id: `optimistic:${clientMessageId}`,
                name: recordedVoiceNote.filename,
                mimeType: recordedVoiceNote.mediaType,
                sizeBytes: recordedVoiceNote.blob.size,
                durationMs: recordedVoiceNote.durationMs,
                previewUrl: recordedVoiceNote.previewUrl,
              },
              voice_only: !content,
            }
          : {}),
        ...(snippetTarget
          ? {
              snippet: snippetTarget,
              snippet_only: !content,
            }
          : {}),
      },
      created_at: resendTarget?.created_at || new Date().toISOString(),
    };
    const confirmationTimers: number[] = [];
    let pendingOrchestratorStart = false;
    changeMainSendCount(channelId, 1);
    setDraft("");
    setReplyTo(null);
    setResendSource(null);
    setSelectedImages([]);
    setVoiceNote(null);
    setTextSnippet(null);
    setMessages((current) =>
      mergeChatMessages(current, [optimisticMessage]),
    );
    setMentionQuery(null);
    setMentionStart(null);
    setMentionEnd(null);
    setError(null);
    try {
      if (resendTarget) {
        const response = await fetch(
          `/api/chat/channels/${channelId}/messages/${resendTarget.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || "Could not edit message.");
        }
        if (activeIdRef.current === channelId && payload.message) {
          setMessages((current) =>
            mergeChatMessages(current, [payload.message as Message]),
          );
        }
        return;
      }
      const shouldDiscoverWorkImmediately =
        active.kind === "channel" &&
        active.orchestrator_mode !== "off" &&
        (active.orchestrator_mode === "always" ||
          content
            .toLowerCase()
            .includes(
              `@${teamChatMentionHandle(
                activeProfile?.slug || DEFAULT_TEAM_CHAT_MIND_HANDLE,
                DEFAULT_TEAM_CHAT_MIND_HANDLE,
              ).toLowerCase()}`,
            ));
      if (shouldDiscoverWorkImmediately) {
        pendingOrchestratorStart = true;
        changeOrchestratorStartCount(channelId, 1);
        confirmationTimers.push(
          ...[150, 500, 1000].map((delay) =>
            window.setTimeout(() => {
              if (activeIdRef.current === channelId) {
                void loadActiveWork(channelId).catch(() => undefined);
              }
            }, delay),
          ),
        );
      }
      const [preparedImages, preparedVoiceNote] = await Promise.all([
        images.length > 0 ? prepareChatAttachmentFiles(images) : [],
        recordedVoiceNote
          ? prepareChatVoiceNote(recordedVoiceNote)
          : Promise.resolve(null),
      ]);
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
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          replyToMessageId: replyTarget?.id || null,
          files: preparedImages.map((image) => ({
            mediaType: image.mediaType,
            base64: image.base64,
            filename: image.filename,
          })),
          voiceNote: preparedVoiceNote
            ? {
                mediaType: preparedVoiceNote.mediaType,
                base64: preparedVoiceNote.base64,
                filename: preparedVoiceNote.filename,
                durationMs: preparedVoiceNote.durationMs,
              }
            : null,
          snippet: snippetTarget,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Could not send message.");
      }
      if (recordedVoiceNote?.previewUrl) {
        URL.revokeObjectURL(recordedVoiceNote.previewUrl);
      }
      if (active.kind === "dm") {
        window.dispatchEvent(
          new Event("groovy:notification-preferences-changed"),
        );
      }
      const received = [payload.message, payload.orchestrator].filter(Boolean);
      if (activeIdRef.current === channelId) {
        setMessages((current) =>
          mergeChatMessages(current, received as Message[]),
        );
        if (payload.error) setError(payload.error);
        if (typeof payload.notice === "string") {
          setSocialNotice(payload.notice);
        }
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
        payload.scheduledTasksChanged === true &&
        active.kind === "channel" &&
        activeIdRef.current === channelId
      ) {
        await loadScheduledTasks(channelId);
      }
    } catch (cause) {
      let confirmedMessages: Message[] = [];
      try {
        const confirmationUrl = new URL(
          `/api/chat/channels/${channelId}/messages`,
          window.location.origin,
        );
        confirmationUrl.searchParams.set("limit", "50");
        const confirmationResponse = await fetch(confirmationUrl.href, {
          cache: "no-store",
        });
        const confirmationPayload = await confirmationResponse
          .json()
          .catch(() => ({}));
        if (
          confirmationResponse.ok &&
          Array.isArray(confirmationPayload.messages)
        ) {
          confirmedMessages = confirmationPayload.messages as Message[];
        }
      } catch {
        // The original draft is restored below when delivery cannot be proven.
      }
      const messageWasDelivered = chatMessageDeliveryConfirmed(
        confirmedMessages,
        {
          clientMessageId,
          resendMessageId: resendTarget?.id,
          content,
        },
      );
      if (!messageWasDelivered) {
        if (activeIdRef.current === channelId) {
          setMessages((current) => {
            const withoutOptimistic = current.filter(
              (message) => message.id !== optimisticMessageId,
            );
            return resendTarget
              ? mergeChatMessages(withoutOptimistic, [resendTarget])
              : withoutOptimistic;
          });
        }
        setDraft((current) => (current.trim() ? current : content));
        setReplyTo((current) => current || replyTarget);
        setResendSource((current) => current || resendTarget);
        setSelectedImages((current) =>
          [...images, ...current].slice(0, MAX_CHAT_ATTACHMENT_FILES),
        );
        if (recordedVoiceNote) {
          setVoiceNote((current) =>
            current || {
              ...recordedVoiceNote,
              previewUrl:
                recordedVoiceNote.previewUrl ||
                URL.createObjectURL(recordedVoiceNote.blob),
            },
          );
        }
        setTextSnippet((current) => current || snippetTarget);
      } else if (recordedVoiceNote?.previewUrl) {
        URL.revokeObjectURL(recordedVoiceNote.previewUrl);
      }
      if (activeIdRef.current === channelId) {
        await Promise.allSettled([
          loadMessages(channelId),
          loadActiveWork(channelId),
        ]);
        setError(
          messageWasDelivered
            ? null
            : cause instanceof Error
              ? cause.message
              : "Could not send message.",
        );
      }
    } finally {
      for (const timer of confirmationTimers) {
        window.clearTimeout(timer);
      }
      if (pendingOrchestratorStart) {
        if (activeIdRef.current === channelId) {
          await handoffPendingOrchestratorStart({
            refreshActiveWork: () => loadActiveWork(channelId),
            releasePending: () =>
              changeOrchestratorStartCount(channelId, -1),
          });
        } else {
          changeOrchestratorStartCount(channelId, -1);
        }
      }
      changeMainSendCount(channelId, -1);
      if (!pendingOrchestratorStart && activeIdRef.current === channelId) {
        void loadActiveWork(channelId).catch(() => undefined);
      }
    }
  };

  const sendThreadReply = async () => {
    if (
      !active ||
      !activeThreadRoot ||
      (!threadDraft.trim() &&
        threadSelectedImages.length === 0 &&
        !threadVoiceNote &&
        !threadTextSnippet)
    ) {
      return;
    }
    const lengthError = chatMessageLengthError(threadDraft);
    if (lengthError) {
      setThreadError(lengthError);
      return;
    }
    const selectedAttachmentKinds =
      (threadSelectedImages.length > 0 ? 1 : 0) +
      (threadVoiceNote ? 1 : 0) +
      (threadTextSnippet ? 1 : 0);
    if (selectedAttachmentKinds > 1) {
      setThreadError(
        "Send files, one voice note, or one text snippet at a time.",
      );
      return;
    }
    const content = threadDraft.trim();
    const images = threadSelectedImages;
    const recordedVoiceNote = threadVoiceNote;
    const snippetTarget = threadTextSnippet;
    const channelId = active.id;
    const rootId = activeThreadRoot.id;
    const threadSendKey = `${channelId}:${rootId}`;
    const resendTarget = threadResendSource;
    const clientMessageId = window.crypto.randomUUID();
    const optimisticMessageId =
      resendTarget?.id || `optimistic:${clientMessageId}`;
    const optimisticMessage: Message = {
      id: optimisticMessageId,
      channel_id: channelId,
      author_type: "user",
      author_user_id: currentUserIdRef.current || null,
      author_agent_id: null,
      profile_id: null,
      content:
        content ||
        (images.length > 0
          ? chatAttachmentOnlyMessage(images)
          : recordedVoiceNote
              ? "Shared a voice note"
              : textSnippetMessage(snippetTarget!)),
      reply_to_message_id:
        resendTarget?.reply_to_message_id || rootId,
      thread_root_message_id:
        resendTarget?.thread_root_message_id || rootId,
      metadata: {
        ...(resendTarget?.metadata || {}),
        client_message_id: clientMessageId,
        client_pending: true,
        ...(resendTarget
          ? { edited_at: new Date().toISOString(), image_only: false }
          : {}),
        ...(recordedVoiceNote
          ? {
              voice_note: {
                id: `optimistic:${clientMessageId}`,
                name: recordedVoiceNote.filename,
                mimeType: recordedVoiceNote.mediaType,
                sizeBytes: recordedVoiceNote.blob.size,
                durationMs: recordedVoiceNote.durationMs,
                previewUrl: recordedVoiceNote.previewUrl,
              },
              voice_only: !content,
            }
          : {}),
        ...(snippetTarget
          ? {
              snippet: snippetTarget,
              snippet_only: !content,
            }
          : {}),
      },
      created_at: resendTarget?.created_at || new Date().toISOString(),
    };
    const confirmationTimers: number[] = [];
    let pendingOrchestratorStart = false;
    changeThreadSendCount(threadSendKey, 1);
    setThreadDraft("");
    setThreadSelectedImages([]);
    setThreadVoiceNote(null);
    setThreadTextSnippet(null);
    setThreadResendSource(null);
    dismissThreadMention();
    setThreadError(null);
    setMessages((current) =>
      mergeChatMessages(current, [optimisticMessage]),
    );
    try {
      if (resendTarget) {
        const response = await fetch(
          `/api/chat/channels/${channelId}/messages/${resendTarget.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || "Could not edit this reply.");
        }
        if (
          activeIdRef.current === channelId &&
          threadRootIdRef.current === rootId &&
          payload.message
        ) {
          setMessages((current) =>
            mergeChatMessages(current, [payload.message as Message]),
          );
        }
        return;
      }
      const shouldDiscoverWorkImmediately =
        active.kind === "channel" &&
        active.orchestrator_mode !== "off" &&
        (active.orchestrator_mode === "always" ||
          content
            .toLowerCase()
            .includes(
              `@${teamChatMentionHandle(
                activeProfile?.slug || DEFAULT_TEAM_CHAT_MIND_HANDLE,
                DEFAULT_TEAM_CHAT_MIND_HANDLE,
              ).toLowerCase()}`,
            ));
      if (shouldDiscoverWorkImmediately) {
        pendingOrchestratorStart = true;
        changeOrchestratorStartCount(threadSendKey, 1);
        confirmationTimers.push(
          ...[150, 500, 1000].map((delay) =>
            window.setTimeout(() => {
              if (activeIdRef.current === channelId) {
                void loadActiveWork(channelId).catch(() => undefined);
              }
            }, delay),
          ),
        );
      }
      confirmationTimers.push(
        ...[750, 2500].map((delay) =>
          window.setTimeout(() => {
            if (
              activeIdRef.current === channelId &&
              threadRootIdRef.current === rootId
            ) {
              void loadThreadMessages(channelId, rootId).catch(
                () => undefined,
              );
            }
          }, delay),
        ),
      );
      const [preparedImages, preparedVoiceNote] = await Promise.all([
        images.length > 0 ? prepareChatAttachmentFiles(images) : [],
        recordedVoiceNote
          ? prepareChatVoiceNote(recordedVoiceNote)
          : Promise.resolve(null),
      ]);
      const response = await fetch(
        `/api/chat/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            clientMessageId,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            replyToMessageId: rootId,
            threadRootMessageId: rootId,
            files: preparedImages.map((image) => ({
              mediaType: image.mediaType,
              base64: image.base64,
              filename: image.filename,
            })),
            voiceNote: preparedVoiceNote
              ? {
                  mediaType: preparedVoiceNote.mediaType,
                  base64: preparedVoiceNote.base64,
                  filename: preparedVoiceNote.filename,
                  durationMs: preparedVoiceNote.durationMs,
                }
              : null,
            snippet: snippetTarget,
          }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not send the thread reply.");
      }
      if (recordedVoiceNote?.previewUrl) {
        URL.revokeObjectURL(recordedVoiceNote.previewUrl);
      }
      if (active.kind === "dm") {
        window.dispatchEvent(
          new Event("groovy:notification-preferences-changed"),
        );
      }
      const received = [payload.message, payload.orchestrator].filter(Boolean);
      if (
        activeIdRef.current === channelId &&
        threadRootIdRef.current === rootId
      ) {
        setMessages((current) =>
          mergeChatMessages(current, received as Message[]),
        );
        if (payload.error) setThreadError(payload.error);
        if (typeof payload.notice === "string") {
          setSocialNotice(payload.notice);
        }
        void loadActiveWork(channelId).catch(() => undefined);
      }
      if (
        payload.scheduledTasksChanged === true &&
        active.kind === "channel" &&
        activeIdRef.current === channelId
      ) {
        await loadScheduledTasks(channelId);
      }
    } catch (cause) {
      if (
        activeIdRef.current === channelId &&
        threadRootIdRef.current === rootId
      ) {
        const messagesResult = await loadThreadMessages(channelId, rootId)
          .then((value) => ({ ok: true as const, value }))
          .catch(() => ({ ok: false as const, value: [] as Message[] }));
        const messageWasDelivered =
          messagesResult.ok &&
          chatMessageDeliveryConfirmed(messagesResult.value, {
            clientMessageId,
            resendMessageId: resendTarget?.id,
            content,
          });
        if (!messageWasDelivered) {
          setMessages((current) => {
            const withoutOptimistic = current.filter(
              (message) => message.id !== optimisticMessageId,
            );
            return resendTarget
              ? mergeChatMessages(withoutOptimistic, [resendTarget])
              : withoutOptimistic;
          });
          setThreadDraft((current) => (current.trim() ? current : content));
          setThreadResendSource((current) => current || resendTarget);
          setThreadSelectedImages((current) =>
            [...images, ...current].slice(0, MAX_CHAT_ATTACHMENT_FILES),
          );
          if (recordedVoiceNote) {
            setThreadVoiceNote(
              (current) =>
                current || {
                  ...recordedVoiceNote,
                  previewUrl:
                    recordedVoiceNote.previewUrl ||
                    URL.createObjectURL(recordedVoiceNote.blob),
                },
            );
          }
          setThreadTextSnippet((current) => current || snippetTarget);
        } else if (recordedVoiceNote?.previewUrl) {
          URL.revokeObjectURL(recordedVoiceNote.previewUrl);
        }
        setThreadError(
          messageWasDelivered
            ? null
            : cause instanceof Error
              ? cause.message
              : "Could not send the thread reply.",
        );
      }
    } finally {
      for (const timer of confirmationTimers) {
        window.clearTimeout(timer);
      }
      if (pendingOrchestratorStart) {
        if (activeIdRef.current === channelId) {
          await handoffPendingOrchestratorStart({
            refreshActiveWork: () => loadActiveWork(channelId),
            releasePending: () =>
              changeOrchestratorStartCount(threadSendKey, -1),
          });
        } else {
          changeOrchestratorStartCount(threadSendKey, -1);
        }
      }
      changeThreadSendCount(threadSendKey, -1);
      if (!pendingOrchestratorStart && activeIdRef.current === channelId) {
        void loadActiveWork(channelId).catch(() => undefined);
      }
    }
  };

  const runScheduledTask = async (taskId: string) => {
    if (!active || active.kind !== "channel") return;
    const channelId = active.id;
    const task = scheduledTasks.find((candidate) => candidate.id === taskId);
    if (
      !task?.canRun ||
      scheduleRunChannelsRef.current.has(taskId)
    ) {
      return;
    }

    scheduleRunChannelsRef.current.set(taskId, channelId);
    scheduleRunBaselineRef.current.set(taskId, task.lastRunAt);
    setScheduleRunningTaskIds((current) => new Set(current).add(taskId));
    setScheduledTasksError(null);
    scheduleRunTimeoutsRef.current.set(
      taskId,
      window.setTimeout(() => {
        const pendingChannelId =
          scheduleRunChannelsRef.current.get(taskId) || null;
        clearRunningScheduledTask(taskId);
        if (scheduledTasksChannelRef.current === pendingChannelId) {
          setScheduledTasksError(
            "This task is taking longer than expected. Refresh to check its latest status.",
          );
        }
      }, 30 * 60 * 1000),
    );

    try {
      const response = await fetch(
        `/api/chat/channels/${channelId}/scheduled-tasks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: taskId }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.accepted !== true) {
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : "scheduled_task_start_failed",
        );
      }
    } catch (cause) {
      clearRunningScheduledTask(taskId);
      if (scheduledTasksChannelRef.current === channelId) {
        setScheduledTasksError(
          scheduledTaskRunErrorMessage(
            cause instanceof Error ? cause.message : "",
          ),
        );
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

  const decideAgentTask = async (
    task: ActiveAgentTask,
    action: "approve" | "reject",
  ) => {
    if (!active || task.status !== "awaiting_approval" || !task.canDecide) {
      return;
    }
    const channelId = active.id;
    const busyKey = `agent:${task.id}:${action}`;
    setControlBusy(busyKey);
    setError(null);
    try {
      const res = await fetch(`/api/chat/channels/${channelId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          target: "agent",
          taskId: task.id,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          await loadActiveWork(channelId).catch(() => undefined);
          throw new Error(
            "This approval was already handled. Chat has been refreshed.",
          );
        }
        throw new Error(
          payload.error ||
            `Could not ${action === "approve" ? "approve" : "reject"} this task.`,
        );
      }

      if (activeIdRef.current === channelId) {
        const current =
          activeWorkSnapshotRef.current.channelId === channelId
            ? activeWorkSnapshotRef.current.work
            : { orchestrator: null, agents: [] };
        const next: ActiveWork = {
          ...current,
          agents:
            action === "approve"
              ? current.agents.map((candidate) =>
                  candidate.id === task.id
                    ? { ...candidate, status: "queued" }
                    : candidate,
                )
              : current.agents.filter((candidate) => candidate.id !== task.id),
        };
        activeWorkSnapshotRef.current = { channelId, work: next };
        setActiveWork(next);
        setSocialNotice(
          action === "approve"
            ? `${task.title} approved — ${task.agentName} is starting`
            : `${task.title} rejected`,
        );
      }

      await Promise.allSettled([
        loadActiveWork(channelId),
        loadMessages(channelId),
      ]);
    } catch (cause) {
      if (activeIdRef.current === channelId) {
        setError(
          cause instanceof Error
            ? cause.message
            : `Could not ${action === "approve" ? "approve" : "reject"} this task.`,
        );
      }
    } finally {
      if (activeIdRef.current === channelId) setControlBusy(null);
    }
  };

  const controlWork = async (args: WorkControlArgs) => {
    if (!active) return;
    const channelId = active.id;
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
      const res = await fetch(`/api/chat/channels/${channelId}/control`, {
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
      if (
        activeIdRef.current === channelId &&
        Array.isArray(payload.taskWarnings) &&
        payload.taskWarnings.length > 0
      ) {
        setError(
          `The orchestrator was controlled, but one delegated task could not be stopped: ${payload.taskWarnings[0]}`,
        );
      } else if (
        activeIdRef.current === channelId &&
        typeof payload.cancellationWarning === "string"
      ) {
        setError(
          `The task is canceled in Groovy, but local process termination was not confirmed: ${payload.cancellationWarning}`,
        );
      }
      await Promise.all([
        loadActiveWork(channelId),
        loadMessages(channelId),
      ]);
    } catch (cause) {
      if (activeIdRef.current === channelId) {
        setError(
          cause instanceof Error
            ? cause.message
            : `Could not ${args.action} ${args.label}.`,
        );
      }
    } finally {
      if (activeIdRef.current === channelId) setControlBusy(null);
    }
  };

  return (
    <div className="app-viewport-shell flex flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <WorkspaceSwitcher
        modalOnly
        fallbackName={workspaceName}
        switchDestination="/chat"
      />
      <AppHeader
        device={headerDevice}
        workspaceName={workspaceName}
        switchDestination="/chat"
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* Mobile: the sidebar becomes a slide-over so the conversation gets the
          full viewport. md+ keeps the fixed rail. */}
      {mobileNavOpen ? (
        <button
          type="button"
          className="fixed inset-x-0 bottom-0 top-[var(--app-header-offset)] z-30 bg-black/60 md:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close channels panel"
        />
      ) : null}
      <aside
        className={`${
          mobileNavOpen
            ? "visible translate-x-0"
            : "invisible pointer-events-none -translate-x-full md:visible md:pointer-events-auto"
        } fixed bottom-0 left-0 top-[var(--app-header-offset)] z-40 flex w-80 max-w-[calc(100vw-1rem)] shrink-0 flex-col border-r border-[var(--glass-border)] bg-[var(--bg-secondary)] shadow-2xl shadow-black/50 transition-transform duration-200 ease-out max-md:pb-[env(safe-area-inset-bottom)] md:static md:z-auto md:w-64 md:max-w-none md:translate-x-0 md:bg-[var(--bg-secondary)]/70 md:shadow-none ${
          sidebarCollapsed ? "md:hidden" : "md:flex"
        }`}
        aria-label="Channels, people, and agents"
        aria-busy={!workspaceReady}
      >
        <div className="border-b border-[var(--glass-border)] px-4 py-4">
          <div className="flex items-center gap-2">
            {workspaceReady && currentUserId ? (
              <button
                type="button"
                onClick={() => setProfileOpen(true)}
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/50"
                aria-label="Open your chat profile"
                title="Your profile and status"
              >
                <ChatMemberAvatar
                  userId={currentUserId}
                  name={memberNames.get(currentUserId) || "You"}
                  profile={currentMemberProfile}
                  presence={memberPresenceByUserId.get(currentUserId)}
                  size={36}
                />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              {workspaceReady ? (
                <>
                  <p className="text-sm font-semibold text-white">Chat</p>
                  <p className="truncate text-xs text-zinc-500">{workspaceName}</p>
                </>
              ) : (
                <span className="block h-8 w-28 animate-pulse rounded bg-white/[0.07] motion-reduce:animate-none" />
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
        {workspaceReady ? (
          <div className="grid grid-cols-2 gap-1.5 border-b border-[var(--glass-border)] p-2">
            <button
              type="button"
              onClick={() => {
                setThreadsOpen(true);
                setMobileNavOpen(false);
                void loadThreadInbox();
              }}
              className={`col-span-2 flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition ${
                unreadThreadCount > 0
                  ? "bg-cyan-400/[0.065] font-medium text-zinc-100 hover:bg-cyan-400/[0.1]"
                  : "text-zinc-400 hover:bg-white/[0.05] hover:text-white"
              }`}
            >
              <MessageSquareText
                className={`h-3.5 w-3.5 ${
                  unreadThreadCount > 0 ? "text-cyan-300" : ""
                }`}
              />
              <span className="min-w-0 flex-1 truncate">Threads</span>
              {unreadThreadCount > 0 ? (
                <span className="rounded-full bg-cyan-300 px-1.5 py-0.5 text-[10px] font-bold leading-none text-[#071014]">
                  {unreadThreadCount > 99 ? "99+" : unreadThreadCount}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => {
                setSearchInitialTab("search");
                setSearchInitialScope("workspace");
                setSearchOpen(true);
                setMobileNavOpen(false);
              }}
              className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs text-zinc-400 transition hover:bg-white/[0.05] hover:text-white"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="min-w-0 flex-1 truncate">Search</span>
              <span className="hidden text-[9px] text-zinc-700 xl:inline">⌘K</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSearchInitialTab("saved");
                setSearchInitialScope("workspace");
                setSearchOpen(true);
                setMobileNavOpen(false);
              }}
              className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs text-zinc-400 transition hover:bg-white/[0.05] hover:text-white"
            >
              <Bookmark className="h-3.5 w-3.5" />
              <span className="truncate">Later</span>
            </button>
          </div>
        ) : null}
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
            action={
              workspaceRole !== "guest" ? (
                <button
                  type="button"
                  onClick={openDirectComposer}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-base leading-none text-[var(--text-secondary)] transition hover:bg-white/5 hover:text-white"
                  aria-label="New direct message"
                  title="New direct message"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              ) : null
            }
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
            count={workspaceRole === "guest" ? 0 : filteredChatPeople.length}
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
              ? filteredChatPeople.map((person) => {
                  const isActive =
                    activeIsHumanDm &&
                    isHumanDirectMessageForRecipient({
                      currentUserId,
                      recipientUserId: person.user_id,
                      memberUserIds: activeMembers
                        .filter((member) => member.member_type === "user")
                        .map((member) => member.user_id),
                      hasAgent: false,
                    });
                  return (
                    <button
                      key={person.user_id}
                      type="button"
                      onClick={() => void openPersonDm(person)}
                      disabled={Boolean(openingConversation)}
                      aria-current={isActive ? "page" : undefined}
                      title={`Message ${
                        person.user_id === currentUserId
                          ? "yourself"
                          : memberNames.get(person.user_id) || "this teammate"
                      }`}
                      className={`group flex w-full cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40 disabled:cursor-wait disabled:opacity-55 ${
                        isActive
                          ? "border-cyan-300/25 bg-cyan-400/[0.12] font-medium text-white shadow-[inset_3px_0_0_rgba(34,211,238,0.85)]"
                          : "border-transparent text-[var(--text-secondary)] hover:-translate-y-px hover:border-white/10 hover:bg-white/[0.055] hover:text-white hover:shadow-sm"
                      }`}
                    >
                      {openingConversation?.id ===
                      `person:${person.user_id}` ? (
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                        </span>
                      ) : (
                        <ChatMemberAvatar
                          userId={person.user_id}
                          name={
                            person.user_id === currentUserId
                              ? "Notes to self"
                              : memberNames.get(person.user_id) || "Teammate"
                          }
                          profile={memberProfileByUserId.get(person.user_id)}
                          presence={memberPresenceByUserId.get(person.user_id)}
                          size={28}
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {person.user_id === currentUserId
                            ? "Notes to self"
                            : memberNames.get(person.user_id) || "Teammate"}
                        </span>
                        {person.user_id === currentUserId ? (
                          <span className="block truncate text-[10px] text-zinc-600">
                            Private notes only you can see
                          </span>
                        ) : activeCustomStatus(
                          memberProfileByUserId.get(person.user_id),
                        ) ? (
                          <span className="block truncate text-[10px] text-zinc-600">
                            {
                              activeCustomStatus(
                                memberProfileByUserId.get(person.user_id),
                              )?.status_emoji
                            }{" "}
                            {
                              activeCustomStatus(
                                memberProfileByUserId.get(person.user_id),
                              )?.status_text
                            }
                          </span>
                        ) : null}
                      </span>
                      <span className="text-[9px] uppercase tracking-wider text-zinc-600">
                        {person.user_id === currentUserId
                          ? "you"
                          : person.role === "guest"
                            ? "guest"
                            : person.role}
                      </span>
                      <ChevronRight
                        className={`h-3.5 w-3.5 shrink-0 transition ${
                          isActive
                            ? "text-cyan-300 opacity-100"
                            : "translate-x-[-2px] text-zinc-600 opacity-0 group-hover:translate-x-0 group-hover:opacity-100"
                        }`}
                        aria-hidden="true"
                      />
                    </button>
                  );
                })
              : null}
            {!collapsedSections.people &&
            workspaceRole !== "guest" &&
            chatPeople.length === 0 &&
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
              ? filteredAgents.map((agent) => {
                  const isActive =
                    Boolean(active) &&
                    isAgentDirectMessageForRecipient({
                      kind: active?.kind,
                      agentId: agent.id,
                      members: channelMembers.filter(
                        (member) => member.channel_id === active?.id,
                      ),
                    });
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => void openAgentDm(agent)}
                      disabled={Boolean(openingConversation)}
                      aria-current={isActive ? "page" : undefined}
                      title={`Message ${agent.name}`}
                      className={`group flex w-full cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40 disabled:cursor-wait disabled:opacity-55 ${
                        isActive
                          ? "border-cyan-300/25 bg-cyan-400/[0.12] font-medium text-white shadow-[inset_3px_0_0_rgba(34,211,238,0.85)]"
                          : "border-transparent text-[var(--text-secondary)] hover:-translate-y-px hover:border-white/10 hover:bg-white/[0.055] hover:text-white hover:shadow-sm"
                      }`}
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
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{agent.name}</span>
                        <span className="block truncate text-[10px] opacity-60">
                          {agent.harness}
                          {agent.model ? ` · ${agent.model}` : ""}
                        </span>
                      </span>
                      <ChevronRight
                        className={`h-3.5 w-3.5 shrink-0 transition ${
                          isActive
                            ? "text-cyan-300 opacity-100"
                            : "translate-x-[-2px] text-zinc-600 opacity-0 group-hover:translate-x-0 group-hover:opacity-100"
                        }`}
                        aria-hidden="true"
                      />
                    </button>
                  );
                })
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
                <div className="flex min-w-0 items-center gap-1.5">
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
                    <span className="truncate">{activeDisplayName}</span>
                  </h1>
                  {active.kind === "channel" && canManageActive ? (
                    <button
                      type="button"
                      onClick={() => setChannelSettingsOpen(true)}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-600 transition hover:bg-white/[0.06] hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40"
                      aria-label={`Rename ${activeDisplayName}`}
                      title="Rename channel"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
                {active.topic ? (
                  <p className="truncate text-xs text-[var(--text-secondary)]">{active.topic}</p>
                ) : null}
              </div>
              {activeHumanIds.length > 0 ? (
                <div
                  className="hidden items-center -space-x-2 lg:flex"
                  title={`${activeHumanIds.length} ${
                    activeHumanIds.length === 1 ? "person" : "people"
                  } in this room`}
                >
                  {activeHumanIds.slice(0, 3).map((userId) => (
                    <ChatMemberAvatar
                      key={userId}
                      userId={userId}
                      name={memberNames.get(userId) || "Teammate"}
                      profile={memberProfileByUserId.get(userId)}
                      presence={memberPresenceByUserId.get(userId)}
                      size={28}
                      className="rounded-full ring-2 ring-[var(--bg-secondary)]"
                    />
                  ))}
                  {activeHumanIds.length > 3 ? (
                    <span className="relative flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-[#181a1f] text-[9px] text-zinc-400 ring-2 ring-[var(--bg-secondary)]">
                      +{activeHumanIds.length - 3}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setSearchInitialTab("search");
                  setSearchInitialScope("channel");
                  setSearchOpen(true);
                }}
                className="group flex h-9 w-9 shrink-0 items-center justify-center gap-2 overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.025] px-0 text-zinc-500 transition hover:border-cyan-300/20 hover:bg-white/[0.06] hover:text-white xl:w-52 xl:justify-start xl:px-3 2xl:w-64"
                aria-label={`Search ${activeSearchScopeLabel}`}
                title={`Search ${activeSearchScopeLabel}`}
              >
                <Search className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden min-w-0 items-center gap-1.5 text-xs xl:flex">
                  <span className="max-w-24 truncate rounded-md bg-cyan-300/[0.09] px-1.5 py-0.5 font-medium text-cyan-300 2xl:max-w-36">
                    {activeSearchScopeLabel}
                  </span>
                  <span className="shrink-0 text-zinc-600">— Search</span>
                </span>
              </button>
              {!socialMigrationPending && currentUserId ? (
                <ChannelHuddle
                  channelId={active.id}
                  channelName={activeDisplayName}
                  currentUserId={currentUserId}
                  huddle={activeHuddle}
                  initialParticipants={activeHuddleParticipants}
                  memberNames={memberNames}
                  memberProfiles={memberProfileByUserId}
                  memberPresence={memberPresenceByUserId}
                  onChanged={refreshSidebarAfterHuddleChange}
                />
              ) : null}
              <RoomNotificationMenu
                room={{
                  id: active.id,
                  kind: active.kind,
                  name: activeDisplayName,
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
              ) : activeIsHumanDm ? (
                <button
                  type="button"
                  onClick={() => setChannelSettingsOpen(true)}
                  className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[var(--glass-border)] px-2.5 text-xs text-[var(--text-secondary)] transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
                  aria-label="Open conversation Mind settings"
                  title="Conversation Mind settings"
                >
                  <Settings2 className="h-4 w-4" />
                  <span className="hidden sm:inline">
                    {active.profile_id ? "Mind" : "Add Mind"}
                  </span>
                </button>
              ) : null}
            </header>
            <ChatNativeNudge
              room={{
                id: active.id,
                kind: active.kind,
                name: activeDisplayName,
              }}
            />

            <div className="relative flex min-h-0 flex-1">
              <section className="flex min-w-0 flex-1 flex-col">
            <div
              ref={scrollRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                timelineSticksToBottomRef.current =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  120;
                if (element.scrollTop < 180) {
                  void loadOlderHistory();
                }
              }}
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4"
              data-chat-message-timeline
            >
              <div ref={timelineContentRef} className="min-h-full">
              {timelinePageInfo.hasNewer ? (
                <div className="sticky top-0 z-30 mb-3 flex justify-center">
                  <button
                    type="button"
                    onClick={jumpToLatestMessages}
                    className="inline-flex items-center gap-1.5 rounded-full border border-cyan-300/20 bg-[#15191e]/95 px-3 py-1.5 text-[11px] font-medium text-cyan-200 shadow-xl backdrop-blur transition hover:border-cyan-300/35 hover:bg-[#1a2026]"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                    Back to latest
                  </button>
                </div>
              ) : null}
              {historyLoading ? (
                <div
                  className="flex items-center justify-center gap-2 py-3 text-[11px] text-zinc-500"
                  role="status"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading earlier messages…
                </div>
              ) : !messagesLoading &&
                mainMessages.length > 0 &&
                !timelinePageInfo.hasOlder ? (
                <div className="flex items-center gap-3 pb-3 text-[9px] font-medium uppercase tracking-[0.16em] text-zinc-700">
                  <span className="h-px flex-1 bg-white/[0.055]" />
                  Beginning of conversation
                  <span className="h-px flex-1 bg-white/[0.055]" />
                </div>
              ) : null}
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
              {mainTimelineEntries.map((entry, timelineIndex) => {
                if (entry.kind === "work") {
                  return entry.work.kind === "orchestrator" ? (
                    <OrchestratorWorkCard
                      key={entry.key}
                      run={entry.work.run}
                      profileName={activeProfile?.name || "Groovy"}
                      controlBusy={controlBusy}
                      onControl={(args) => void controlWork(args)}
                    />
                  ) : (
                    <AgentWorkCard
                      key={entry.key}
                      task={entry.work.task}
                      controlBusy={controlBusy}
                      onControl={(args) => void controlWork(args)}
                      onDecide={(task, action) =>
                        void decideAgentTask(task, action)
                      }
                    />
                  );
                }
                const message = entry.message;
                const messageIndex = entry.sourceIndex;
                const isPending = isPendingChatMessage(message);
                const showDateSeparator = isDifferentChatCalendarDate(
                  mainMessages[messageIndex - 1]?.created_at,
                  message.created_at,
                );
                const previousTimelineEntry =
                  mainTimelineEntries[timelineIndex - 1];
                const groupedWithPrevious =
                  previousTimelineEntry?.kind === "message" &&
                  shouldGroupChatMessage(
                    previousTimelineEntry.message,
                    message,
                  );
                const threadReplyCount =
                  threadReplyCountByRoot.get(message.id) || 0;
                const hasUnreadThreadReply =
                  unreadThreadRoots.has(message.id);
                const quoted = message.reply_to_message_id
                  ? messageById.get(message.reply_to_message_id)
                  : null;
                const profile = message.profile_id
                  ? profileById.get(message.profile_id)
                  : activeProfile;
                const isTaskResult =
                  message.metadata?.kind === "agent_task_result";
                const isScheduledTaskResult =
                  message.metadata?.kind === "scheduled_task_result";
                const scheduledTaskName =
                  typeof message.metadata?.scheduled_task_name === "string" &&
                  message.metadata.scheduled_task_name.trim()
                    ? message.metadata.scheduled_task_name.trim()
                    : "Scheduled task";
                const agentName =
                  typeof message.metadata?.agent_name === "string"
                    ? message.metadata.agent_name
                    : "Agent";
                const imageAttachments = messageImageAttachments(
                  message.metadata,
                );
                const fileAttachments = messageFileAttachments(
                  message.metadata,
                );
                const voiceAttachment = messageVoiceAttachment(
                  message.metadata,
                );
                const snippetAttachment = messageTextSnippet(message.metadata);
                const isImageOnly =
                  message.metadata?.image_only === true &&
                  imageAttachments.length > 0;
                const isFileOnly =
                  message.metadata?.file_only === true &&
                  fileAttachments.length > 0;
                const isVoiceOnly =
                  message.metadata?.voice_only === true &&
                  Boolean(voiceAttachment);
                const isSnippetOnly =
                  message.metadata?.snippet_only === true &&
                  Boolean(snippetAttachment);
                const authorIsCurrent =
                  message.author_user_id === currentUserId;
                const authorProfile = message.author_user_id
                  ? memberProfileByUserId.get(message.author_user_id)
                  : null;
                const authorPerson = message.author_user_id
                  ? memberNames.get(message.author_user_id) || "Teammate"
                  : "Teammate";
                const label =
                  message.author_type === "orchestrator"
                    ? profile?.name || "Groovy"
                    : message.author_type === "agent"
                      ? agentName
                      : message.author_type === "system"
                        ? webhookMessageLabel(message) || "System"
                        : authorPerson;
                const deleted =
                  typeof message.metadata?.deleted_at === "string";
                const edited =
                  !deleted &&
                  typeof message.metadata?.edited_at === "string";
                const reactionGroups = groupMessageReactions(
                  reactionsByMessageId.get(message.id) || [],
                  currentUserId,
                );
                const messagePinned = pinnedMessageIds.has(message.id);
                const messageSaved = savedMessageIds.has(message.id);
                const canEditMessage =
                  !deleted &&
                  message.author_type === "user" &&
                  authorIsCurrent &&
                  !isImageOnly &&
                  !isVoiceOnly &&
                  !isSnippetOnly &&
                  Boolean(message.content.trim());
                return (
                  <Fragment key={message.id}>
                    {showDateSeparator ? (
                      <ChatDateSeparator timestamp={message.created_at} />
                    ) : null}
                  <article
                    id={`chat-message-${message.id}`}
                    className={`group relative -mx-2 flex gap-3 rounded-xl px-2 transition-colors ${
                      groupedWithPrevious ? "mb-0 py-1" : "mb-1 py-2"
                    } ${
                      isPending ? "opacity-75" : ""
                    } ${
                      highlightedMessageId === message.id
                        ? "bg-cyan-300/[0.09] ring-1 ring-cyan-300/20"
                        : "hover:bg-white/[0.025]"
                    }`}
                  >
                    {groupedWithPrevious ? (
                      <div className="flex h-6 w-9 shrink-0 items-center justify-end pt-1">
                        <time className="hidden text-[8px] text-zinc-700 opacity-0 transition group-hover:opacity-100 sm:block">
                          {isPending ? "" : displayTime(message.created_at)}
                        </time>
                      </div>
                    ) : message.author_type === "user" &&
                      message.author_user_id ? (
                      <ChatMemberAvatar
                        userId={message.author_user_id}
                        name={authorPerson}
                        profile={authorProfile}
                        presence={memberPresenceByUserId.get(
                          message.author_user_id,
                        )}
                        size={36}
                      />
                    ) : (
                      <div
                        className={`flex h-9 w-9 shrink-0 items-center justify-center border text-xs ${
                          message.author_type === "orchestrator"
                            ? "rounded-full border-cyan-300/25 bg-cyan-300/[0.07] text-cyan-200"
                            : message.author_type === "agent"
                              ? "rounded-xl border-violet-300/20 bg-violet-300/[0.07] text-violet-200"
                              : "rounded-full border-[var(--glass-border)] bg-[var(--bg-tertiary)] text-zinc-500"
                        }`}
                      >
                        {message.author_type === "orchestrator"
                          ? "✦"
                          : message.author_type === "agent"
                            ? "◆"
                            : webhookMessageLabel(message) ? (
                              <Webhook className="h-4 w-4" />
                            ) : "·"}
                      </div>
                    )}
                    <div className="min-w-0 flex-1 pr-10 sm:pr-0">
                      {!groupedWithPrevious ? (
                        <div className="flex min-h-5 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span
                          className={
                            message.author_type === "orchestrator"
                              ? "font-medium text-[var(--accent-cyan)]"
                              : "font-medium"
                          }
                        >
                          {label}
                        </span>
                        {webhookMessageLabel(message) ? (
                          <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">
                            Webhook
                          </span>
                        ) : null}
                        {authorIsCurrent ? (
                          <span className="text-[9px] font-medium uppercase tracking-wider text-zinc-600">
                            you
                          </span>
                        ) : null}
                        <time className="text-[10px] text-[var(--text-secondary)]">
                          {isPending
                            ? "Sending…"
                            : displayTime(message.created_at)}
                        </time>
                        {edited ? (
                          <span
                            className="text-[10px] text-zinc-600"
                            title={`Edited ${new Date(
                              String(message.metadata.edited_at),
                            ).toLocaleString()}`}
                          >
                            edited
                          </span>
                        ) : null}
                        {messagePinned ? (
                          <span className="text-[10px] text-amber-300/70">
                            pinned
                          </span>
                        ) : null}
                        </div>
                      ) : edited || messagePinned ? (
                        <div className="flex min-h-3 items-center gap-2 text-[9px] text-zinc-700">
                          {edited ? <span>edited</span> : null}
                          {messagePinned ? (
                            <span className="text-amber-300/60">pinned</span>
                          ) : null}
                        </div>
                      ) : null}
                      {!deleted ? (
                        <div
                          className={`absolute right-2 top-[-9px] opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 ${
                            activeMessageActionsId === message.id
                              ? "z-50"
                              : "z-20"
                          }`}
                        >
                          <ChatMessageActions
                            canEdit={canEditMessage}
                            canDelete={
                              message.author_type === "user" &&
                              authorIsCurrent
                            }
                            saved={messageSaved}
                            pinned={messagePinned}
                            messageDisabled={isPending}
                            socialDisabled={
                              isPending ||
                              Boolean(socialBusyId) ||
                              socialMigrationPending
                            }
                            onThread={() => openThread(message)}
                            onReply={() => setReplyTo(message)}
                            onEdit={() => beginEditAndResend(message)}
                            onDelete={() => void deleteMessage(message)}
                            onSave={() =>
                              void interactWithMessage(message, "save")
                            }
                            onPin={() =>
                              void interactWithMessage(message, "pin")
                            }
                            onCopyLink={() => void copyMessageLink(message)}
                            onReaction={(emoji) =>
                              void interactWithMessage(
                                message,
                                "reaction",
                                emoji,
                              )
                            }
                            onOpenChange={(open) =>
                              setActiveMessageActionsId((current) =>
                                open
                                  ? message.id
                                  : current === message.id
                                    ? null
                                    : current,
                              )
                            }
                          />
                        </div>
                      ) : null}
                      {quoted ? (
                        <div className="my-1 border-l-2 border-[var(--glass-border)] pl-2 text-xs text-[var(--text-secondary)]">
                          {typeof quoted.metadata?.deleted_at === "string"
                            ? "Message deleted"
                            : quoted.metadata?.image_only === true
                              ? "Image"
                              : quoted.metadata?.file_only === true
                                ? "File"
                              : quoted.metadata?.voice_only === true
                                ? "Voice note"
                                : quoted.metadata?.snippet_only === true
                                  ? "Text snippet"
                                  : quoted.content.slice(0, 180)}
                        </div>
                      ) : null}
                      {deleted ? (
                        <p className="mt-0.5 text-[14px] italic text-zinc-600">
                          This message was deleted.
                        </p>
                      ) : isScheduledTaskResult ? (
                        <div className="mt-1 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.045] px-4 py-3">
                          <div className="mb-1.5 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-cyan-200/75">
                            <CalendarClock className="h-3 w-3" aria-hidden="true" />
                            <span>{scheduledTaskName} · scheduled run</span>
                          </div>
                          <FormattedMessageContent
                            content={message.content}
                            className="space-y-2 text-[14px] leading-relaxed"
                            textClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                          />
                        </div>
                      ) : isTaskResult ? (
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
                          <FormattedMessageContent
                            content={message.content}
                            className="space-y-2 text-[14px] leading-relaxed"
                            textClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                          />
                        </div>
                      ) : (
                        <>
                          {!isImageOnly &&
                          !isFileOnly &&
                          !isVoiceOnly &&
                          !isSnippetOnly ? (
                            <FormattedMessageContent
                              content={message.content}
                              className="mt-0.5 space-y-2 text-[15px] leading-relaxed text-zinc-200/95"
                              textClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                            />
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
                                <div
                                  key={attachment.id}
                                  className={`group/image relative overflow-hidden rounded-xl border border-white/10 bg-black/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/50 ${
                                    imageAttachments.length === 3 && index === 0
                                      ? "col-span-2"
                                      : ""
                                  }`}
                                >
                                  <a
                                    href={`/api/chat/channels/${message.channel_id}/attachments/${attachment.id}`}
                                    target="_blank"
                                    rel="noreferrer"
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
                                  </a>
                                  <a
                                    href={`/api/chat/channels/${message.channel_id}/attachments/${attachment.id}?download=1`}
                                    className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-black/75 text-white opacity-100 shadow-lg backdrop-blur transition hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 sm:opacity-0 sm:group-hover/image:opacity-100 sm:focus-visible:opacity-100"
                                    aria-label={`Download ${attachment.name}`}
                                    title="Download image"
                                  >
                                    <Download className="h-4 w-4" />
                                  </a>
                                  <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/75 to-transparent px-3 pb-2 pt-8 text-[10px] text-white/75 opacity-0 transition group-hover/image:opacity-100 group-focus-visible/image:opacity-100">
                                    {attachment.name}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          {fileAttachments.length > 0 ? (
                            <div className="mt-2 flex max-w-xl flex-col gap-2">
                              {fileAttachments.map((attachment) => (
                                <a
                                  key={attachment.id}
                                  href={`/api/chat/channels/${message.channel_id}/attachments/${attachment.id}?download=1`}
                                  className="flex min-w-0 items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 transition hover:border-cyan-300/25 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/50"
                                  aria-label={`Download ${attachment.name}`}
                                >
                                  <FileText className="h-5 w-5 shrink-0 text-cyan-300/75" />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs text-zinc-200">
                                      {attachment.name}
                                    </span>
                                    <span className="mt-0.5 block text-[10px] text-zinc-600">
                                      {formatAttachmentSize(
                                        attachment.sizeBytes,
                                      )}
                                    </span>
                                  </span>
                                  <Download className="h-4 w-4 shrink-0 text-zinc-500" />
                                </a>
                              ))}
                            </div>
                          ) : null}
                          {voiceAttachment ? (
                            <div className="mt-2 max-w-xl rounded-xl border border-white/10 bg-black/20 p-3">
                              <div className="mb-2 flex items-center justify-between gap-3 text-[10px] text-zinc-500">
                                <span>
                                  Voice note ·{" "}
                                  {formatVoiceNoteDuration(
                                    voiceAttachment.durationMs,
                                  )}
                                </span>
                                {!isPending ? (
                                  <a
                                    href={`/api/chat/channels/${message.channel_id}/attachments/${voiceAttachment.id}?download=1`}
                                    className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 transition hover:bg-white/[0.05] hover:text-white"
                                  >
                                    <Download className="h-3.5 w-3.5" />
                                    Download
                                  </a>
                                ) : null}
                              </div>
                              <audio
                                controls
                                preload="metadata"
                                src={
                                  voiceAttachment.previewUrl ||
                                  `/api/chat/channels/${message.channel_id}/attachments/${voiceAttachment.id}`
                                }
                                className="h-10 w-full"
                              />
                            </div>
                          ) : null}
                          {snippetAttachment ? (
                            <ChatTextSnippetCard snippet={snippetAttachment} />
                          ) : null}
                        </>
                      )}
                      {!deleted && reactionGroups.length > 0 ? (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {reactionGroups.map((reaction) => (
                            <button
                              key={reaction.emoji}
                              type="button"
                              onClick={() =>
                                void interactWithMessage(
                                  message,
                                  "reaction",
                                  reaction.emoji,
                                )
                              }
                              disabled={
                                Boolean(socialBusyId) || socialMigrationPending
                              }
                              className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2 text-xs transition disabled:opacity-50 ${
                                reaction.reacted
                                  ? "border-cyan-300/30 bg-cyan-300/[0.09] text-cyan-100"
                                  : "border-white/[0.08] bg-white/[0.025] text-zinc-400 hover:bg-white/[0.06] hover:text-white"
                              }`}
                              aria-label={`${reaction.reacted ? "Remove" : "Add"} ${reaction.emoji} reaction`}
                            >
                              <span>{reaction.emoji}</span>
                              <span className="tabular-nums">
                                {reaction.count}
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {threadReplyCount > 0 || hasUnreadThreadReply ? (
                        <button
                          type="button"
                          onClick={() => openThread(message)}
                          disabled={isPending}
                          className={`mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] transition disabled:opacity-40 ${
                            hasUnreadThreadReply
                              ? "bg-cyan-400/[0.08] text-cyan-200"
                              : "text-cyan-300/80 hover:bg-cyan-300/[0.06] hover:text-cyan-200"
                          }`}
                        >
                          <MessageSquareText className="h-3 w-3" />
                          {threadReplyCount}{" "}
                          {threadReplyCount === 1 ? "reply" : "replies"}
                          {hasUnreadThreadReply ? (
                            <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,.8)]" />
                          ) : null}
                        </button>
                      ) : null}
                    </div>
                  </article>
                  </Fragment>
                );
              })}
              {keyedOperationPending(
                pendingOrchestratorStarts,
                activeId,
              ) && !activeWork.orchestrator ? (
                <OrchestratorStartingCard
                  profileName={activeProfile?.name || "Groovy"}
                />
              ) : mainMindContinuationPending &&
                !activeWork.orchestrator &&
                activeWork.agents.length === 0 ? (
                <OrchestratorStartingCard
                  profileName={activeProfile?.name || "Groovy"}
                  phase="continuing"
                />
              ) : null}
              </div>
            </div>

            <div className="border-t border-[var(--glass-border)] bg-[var(--bg-secondary)]/40 p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] sm:p-4 sm:pb-[calc(1rem+env(safe-area-inset-bottom))]">
              {resendSource ? (
                <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.06] px-3 py-2 text-xs">
                  <span className="min-w-0 truncate text-cyan-100">
                    Editing this message. Saving updates the text without
                    rerunning Groovy.
                  </span>
                  <button
                    type="button"
                    onClick={() => setResendSource(null)}
                    className="shrink-0 text-[var(--text-secondary)] transition hover:text-white"
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
              {replyTo ? (
                <div className="mb-2 flex items-center justify-between rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                  <span className="truncate">Replying to: {replyTo.content}</span>
                  <button onClick={() => setReplyTo(null)}>×</button>
                </div>
              ) : null}
              <div
                className="relative rounded-xl border border-white/10 bg-black/20 shadow-[0_10px_28px_rgba(0,0,0,.16)] transition focus-within:border-cyan-400/30"
                onDragOver={(event) => {
                  if (!canAttachImages) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(event) => {
                  if (!canAttachImages) return;
                  const files = Array.from(event.dataTransfer.files || []);
                  if (files.length === 0) return;
                  event.preventDefault();
                  addImages(files);
                }}
              >
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
                <input
                  ref={imageInputRef}
                  type="file"
                  accept={CHAT_ATTACHMENT_ACCEPT}
                  multiple
                  className="sr-only"
                  onChange={(event) => {
                    addImages(Array.from(event.target.files || []));
                    event.target.value = "";
                  }}
                />
                {composerFormatOpen ? (
                  <div
                    className="flex items-center gap-0.5 overflow-x-auto border-b border-white/[0.07] px-2.5 py-2"
                    role="toolbar"
                    aria-label="Message formatting"
                  >
                    {[
                      {
                        format: "bold" as const,
                        label: "Bold",
                        Icon: Bold,
                      },
                      {
                        format: "italic" as const,
                        label: "Italic",
                        Icon: Italic,
                      },
                      {
                        format: "underline" as const,
                        label: "Underline",
                        Icon: Underline,
                      },
                      {
                        format: "strike" as const,
                        label: "Strikethrough",
                        Icon: Strikethrough,
                      },
                    ].map(({ format, label, Icon }) => (
                      <button
                        key={format}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => applyDraftFormat(format)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                        aria-label={label}
                        title={label}
                      >
                        <Icon className="h-4 w-4" />
                      </button>
                    ))}
                    <span className="mx-1 h-5 w-px shrink-0 bg-white/[0.08]" />
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applyDraftFormat("link")}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                      aria-label="Add link"
                      title="Add link"
                    >
                      <Link2 className="h-4 w-4" />
                    </button>
                    {[
                      {
                        format: "ordered-list" as const,
                        label: "Numbered list",
                        Icon: ListOrdered,
                      },
                      {
                        format: "bullet-list" as const,
                        label: "Bulleted list",
                        Icon: ListIcon,
                      },
                      {
                        format: "quote" as const,
                        label: "Block quote",
                        Icon: Quote,
                      },
                    ].map(({ format, label, Icon }) => (
                      <button
                        key={format}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => applyDraftFormat(format)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                        aria-label={label}
                        title={label}
                      >
                        <Icon className="h-4 w-4" />
                      </button>
                    ))}
                    <span className="mx-1 h-5 w-px shrink-0 bg-white/[0.08]" />
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applyDraftFormat("inline-code")}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                      aria-label="Inline code"
                      title="Inline code"
                    >
                      <Code2 className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applyDraftFormat("code-block")}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                      aria-label="Code block"
                      title="Code block"
                    >
                      <Braces className="h-4 w-4" />
                    </button>
                  </div>
                ) : null}
                {selectedImagePreviews.length > 0 ? (
                  <div className="flex gap-2 overflow-x-auto px-3 pt-3">
                    {selectedImagePreviews.map(({ file, url, index }) => (
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
                {selectedFilePreviews.length > 0 ? (
                  <div className="flex flex-wrap gap-2 px-3 pt-3">
                    {selectedFilePreviews.map(({ file, index }) => (
                      <div
                        key={`${file.name}-${file.lastModified}-${index}`}
                        className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs"
                      >
                        <FileText className="h-4 w-4 shrink-0 text-cyan-300/70" />
                        <span className="min-w-0 truncate text-zinc-300">
                          {file.name}
                        </span>
                        <span className="shrink-0 text-[10px] text-zinc-600">
                          {formatAttachmentSize(file.size)}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedImages((current) =>
                              current.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
                            )
                          }
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:bg-white/[0.06] hover:text-white"
                          aria-label={`Remove ${file.name}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {voiceNote ? (
                  <div className="px-3 pt-3">
                    <div className="flex items-center gap-3 rounded-xl border border-rose-300/15 bg-rose-300/[0.035] p-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                          <span>
                            Voice note ·{" "}
                            {formatVoiceNoteDuration(voiceNote.durationMs)}
                          </span>
                          <span>{(voiceNote.blob.size / 1_000_000).toFixed(1)} MB</span>
                        </div>
                        <audio
                          controls
                          preload="metadata"
                          src={voiceNote.previewUrl}
                          className="h-9 w-full"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={clearVoiceNote}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-white"
                        aria-label="Remove voice note"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ) : null}
                {textSnippet ? (
                  <div className="relative px-3 pt-1">
                    <ChatTextSnippetCard snippet={textSnippet} compact />
                    <button
                      type="button"
                      onClick={() => setTextSnippet(null)}
                      className="absolute right-5 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-black/75 text-zinc-400 transition hover:text-white"
                      aria-label="Remove text snippet"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
                <div className="px-3 pb-1 pt-2">
                  <textarea
                    ref={draftRef}
                    rows={1}
                    wrap="soft"
                    value={draft}
                    onPaste={(event) => {
                      if (canAttachImages) {
                        const pastedFiles = Array.from(
                          event.clipboardData.files || [],
                        ).filter(isSupportedChatAttachmentFile);
                        if (pastedFiles.length > 0) {
                          event.preventDefault();
                          addImages(pastedFiles);
                          return;
                        }
                      }
                      const clipboardText =
                        event.clipboardData.getData("text/plain");
                      const insertion = pasteTextPreservingStructure({
                        html: event.clipboardData.getData("text/html"),
                        text: clipboardText,
                      });
                      if (insertion === clipboardText) return;
                      event.preventDefault();
                      const textarea = event.currentTarget;
                      const inserted = insertTextAtSelection({
                        value: textarea.value,
                        insertion,
                        selectionStart: textarea.selectionStart,
                        selectionEnd: textarea.selectionEnd,
                      });
                      setDraft(inserted.value);
                      updateMentionState(inserted.value, inserted.caret);
                      window.requestAnimationFrame(() => {
                        resizeChatComposer(draftRef.current);
                        draftRef.current?.focus();
                        draftRef.current?.setSelectionRange(
                          inserted.caret,
                          inserted.caret,
                        );
                      });
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
                    placeholder={`Message ${active.kind === "channel" ? "#" : ""}${activeDisplayName}`}
                    className="max-h-40 min-h-[52px] w-full resize-none overflow-x-hidden whitespace-pre-wrap break-words bg-transparent py-2 text-sm leading-5 outline-none placeholder:text-zinc-600"
                    aria-haspopup="listbox"
                    aria-autocomplete="list"
                    aria-controls={
                      mentionQuery !== null ? "chat-mention-menu" : undefined
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-white/[0.055] px-2 py-2">
                  <div className="flex min-w-0 items-center gap-0.5">
                    <div
                      ref={composerAddMenuRef}
                      className="relative shrink-0"
                    >
                    <button
                      type="button"
                      onClick={() => {
                        setComposerAddOpen((current) => !current);
                        setComposerEmojiOpen(false);
                      }}
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40 ${
                        composerAddOpen
                          ? "bg-white/[0.1] text-white"
                          : "bg-white/[0.05] text-[var(--text-secondary)] hover:bg-white/[0.09] hover:text-white"
                      }`}
                      aria-label="Add to message"
                      aria-expanded={composerAddOpen}
                      title="Add to message"
                    >
                      <Plus
                        className={`h-4 w-4 transition ${
                          composerAddOpen ? "rotate-45" : ""
                        }`}
                      />
                    </button>
                    {composerAddOpen ? (
                      <div className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-60 max-w-[calc(100vw-2rem)] rounded-xl border border-white/10 bg-[#17191e] p-1.5 shadow-2xl">
                        <button
                          type="button"
                          disabled={
                            selectedImages.length > 0 ||
                            Boolean(voiceNote) ||
                            Boolean(textSnippet)
                          }
                          onClick={() => {
                            setComposerAddOpen(false);
                            setSnippetModalTarget("main");
                            setSnippetModalMode("canvas");
                            setSnippetModalOpen(true);
                          }}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs text-zinc-300 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-35"
                        >
                          <FileText className="h-4 w-4 text-violet-300/75" />
                          Canvas
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setComposerAddOpen(false);
                            applyDraftFormat("checklist");
                          }}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs text-zinc-300 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-35"
                        >
                          <CheckSquare className="h-4 w-4 text-zinc-500" />
                          List
                        </button>
                        <div>
                          <button
                            type="button"
                            disabled={
                              !canAttachImages ||
                              Boolean(voiceNote) ||
                              Boolean(textSnippet) ||
                              selectedImages.length >= MAX_CHAT_ATTACHMENT_FILES
                            }
                            onClick={() => {
                              if (recentImageAttachments.length === 0) {
                                setComposerAddOpen(false);
                                setError(
                                  "No recent images are available in this conversation yet.",
                                );
                                return;
                              }
                              setComposerRecentOpen((current) => !current);
                            }}
                            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs text-zinc-300 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-35"
                          >
                            <Bookmark className="h-4 w-4 text-zinc-500" />
                            Recent file
                          </button>
                          {composerRecentOpen ? (
                            <div className="mx-2 mb-1 max-h-36 overflow-y-auto rounded-lg border border-white/[0.07] bg-black/20 p-1">
                              {recentImageAttachments.map((attachment) => (
                                <button
                                  key={attachment.id}
                                  type="button"
                                  disabled={Boolean(composerRecentBusyId)}
                                  onClick={() =>
                                    void reuseRecentImage(attachment)
                                  }
                                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[10px] text-zinc-400 transition hover:bg-white/[0.05] hover:text-white disabled:opacity-40"
                                >
                                  {composerRecentBusyId === attachment.id ? (
                                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                                  ) : (
                                    <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                                  )}
                                  <span className="truncate">
                                    {attachment.name}
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          disabled={
                            selectedImages.length > 0 ||
                            Boolean(voiceNote) ||
                            Boolean(textSnippet)
                          }
                          onClick={() => {
                            setComposerAddOpen(false);
                            setSnippetModalTarget("main");
                            setSnippetModalMode("snippet");
                            setSnippetModalOpen(true);
                          }}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs text-zinc-300 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-35"
                        >
                          <FileText className="h-4 w-4 text-cyan-300/70" />
                          <span>
                            Text snippet
                            <span className="mt-0.5 block text-[9px] text-zinc-600">
                              Share long text or code
                            </span>
                          </span>
                        </button>
                        {active.kind === "channel" ? (
                          <button
                            type="button"
                            onClick={() => {
                              setComposerAddOpen(false);
                              setSchedulePanelOpen(true);
                            }}
                            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
                          >
                            <CalendarClock className="h-4 w-4 text-zinc-500" />
                            Scheduled workflow
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={
                            !canAttachImages ||
                            Boolean(voiceNote) ||
                            Boolean(textSnippet) ||
                            selectedImages.length >= MAX_CHAT_ATTACHMENT_FILES
                          }
                          onClick={() => {
                            setComposerAddOpen(false);
                            imageInputRef.current?.click();
                          }}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs text-zinc-300 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-35"
                        >
                          <Upload className="h-4 w-4 text-zinc-500" />
                          Upload files
                        </button>
                      </div>
                    ) : null}
                    </div>
                  <button
                    type="button"
                    onClick={() =>
                      setComposerFormatOpen((current) => !current)
                    }
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-medium underline decoration-current underline-offset-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40 ${
                      composerFormatOpen
                        ? "bg-white/[0.06] text-zinc-200"
                        : "text-[var(--text-secondary)] hover:bg-white/[0.06] hover:text-white"
                    }`}
                    aria-label="Toggle formatting"
                    aria-pressed={composerFormatOpen}
                    title="Formatting"
                  >
                    Aa
                  </button>
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        setComposerEmojiOpen((current) => !current)
                      }
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40"
                      aria-label="Add emoji"
                      aria-expanded={composerEmojiOpen}
                    >
                      <Smile className="h-4 w-4" />
                    </button>
                    {composerEmojiOpen ? (
                      <div
                        className="absolute bottom-[calc(100%+8px)] left-0 z-50 grid w-56 max-w-[calc(100vw-1.5rem)] grid-cols-6 gap-1 rounded-xl border border-white/10 bg-[#17191e] p-2 shadow-2xl"
                        role="group"
                        aria-label="Choose an emoji"
                      >
                        {[
                          "😀",
                          "😂",
                          "😍",
                          "🤔",
                          "😅",
                          "🥳",
                          "👍",
                          "👏",
                          "🙏",
                          "💪",
                          "👀",
                          "✅",
                          "❤️",
                          "🔥",
                          "🎉",
                          "🚀",
                          "💡",
                          "✨",
                        ].map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => {
                              setDraft((current) => `${current}${emoji}`);
                              setComposerEmojiOpen(false);
                              window.requestAnimationFrame(() =>
                                draftRef.current?.focus(),
                              );
                            }}
                            className="flex h-8 w-8 min-w-0 items-center justify-center justify-self-center rounded-lg text-base leading-none transition hover:scale-110 hover:bg-white/[0.08] active:scale-95"
                            aria-label={`Insert ${emoji}`}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={insertComposerMention}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40"
                    aria-label="Mention someone"
                    title="Mention someone"
                  >
                    <AtSign className="h-4 w-4" />
                  </button>
                  {!socialMigrationPending && currentUserId ? (
                    <button
                      type="button"
                      onClick={() => {
                        const trigger = document.getElementById(
                          `chat-huddle-trigger-${active.id}`,
                        ) as HTMLButtonElement | null;
                        if (trigger) trigger.click();
                        else setError("Huddles are still being activated.");
                      }}
                      className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40 sm:flex"
                      aria-label="Start or join a video huddle"
                      title="Video huddle"
                    >
                      <Video className="h-4 w-4" />
                    </button>
                  ) : null}
                  <ChatVoiceRecorderButton
                    disabled={
                      Boolean(resendSource) ||
                      selectedImages.length > 0 ||
                      Boolean(textSnippet)
                    }
                    hasVoiceNote={Boolean(voiceNote)}
                    onRecorded={(note) => {
                      setVoiceNote(note);
                      setError(null);
                    }}
                    onError={setError}
                  />
                  </div>
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={
                      (!draft.trim() &&
                        selectedImages.length === 0 &&
                        !voiceNote &&
                        !textSnippet)
                    }
                    className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] text-cyan-300 transition hover:bg-cyan-400/[0.12] disabled:opacity-35"
                    aria-label={
                      resendSource ? "Save edited message" : "Send message"
                    }
                  >
                    {resendSource ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
              <div className="mt-1.5 flex min-h-4 items-center justify-between px-1">
                <p
                  className={`text-[11px] transition ${
                    activeTypingLabel ? "text-zinc-500" : "text-transparent"
                  }`}
                  aria-live="polite"
                >
                  {activeTypingLabel ? `${activeTypingLabel}…` : "No one typing"}
                </p>
                <p
                  className={`hidden text-[10px] sm:block ${
                    draft.trim().length > MAX_CHAT_MESSAGE_CHARACTERS
                      ? "text-red-300"
                      : "text-zinc-700"
                  }`}
                >
                  {draft.trim().length > MAX_CHAT_MESSAGE_CHARACTERS * 0.9
                    ? `${draft.trim().length.toLocaleString()} / ${MAX_CHAT_MESSAGE_CHARACTERS.toLocaleString()} characters`
                    : busy
                      ? "Sending previous message… · Enter sends another"
                      : "Enter to send · Shift+Enter for a new line"}
                </p>
              </div>
              {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
            </div>
              </section>
              {activeThreadRoot ? (
                <ChannelThreadPanel
                  channelId={active.id}
                  channelName={
                    active.kind === "channel"
                      ? `#${activeDisplayName}`
                      : activeDisplayName
                  }
                  root={toThreadMessageView(activeThreadRoot)}
                  replies={activeThreadReplies.map(toThreadMessageView)}
                  replyCount={
                    threadReplyCountByRoot.get(activeThreadRoot.id) || 0
                  }
                  draft={threadDraft}
                  busy={threadBusy}
                  initialLoading={threadInitialLoading}
                  historyLoading={threadHistoryLoading}
                  hasOlder={threadPageInfo.hasOlder}
                  hasNewer={threadPageInfo.hasNewer}
                  working={
                    activeWork.orchestrator?.thread_root_message_id ===
                      activeThreadRoot.id ||
                    activeWork.agents.some(
                      (task) =>
                        task.threadRootMessageId === activeThreadRoot.id,
                    ) ||
                    keyedOperationPending(
                      pendingOrchestratorStarts,
                      activeThreadSendKey,
                    ) ||
                    threadMindContinuationPending
                  }
                  error={threadError}
                  typingLabel={activeThreadTypingLabel}
                  resendSourceLabel={
                    threadResendSource
                      ? `"${threadResendSource.content.slice(0, 48)}${
                          threadResendSource.content.length > 48 ? "…" : ""
                        }"`
                      : null
                  }
                  mentionQuery={threadMentionQuery}
                  mentionOptions={threadMentionOptions}
                  mentionActiveIndex={threadMentionActiveIndex}
                  mentionBusyId={mentionBusyId}
                  selectedImages={threadSelectedImages}
                  voiceNote={threadVoiceNote}
                  snippet={threadTextSnippet}
                  recentImages={recentImageAttachments.map((image) => ({
                    id: image.id,
                    name: image.name,
                  }))}
                  recentBusyId={composerRecentBusyId}
                  canSchedule={active.kind === "channel"}
                  canStartHuddle={
                    !socialMigrationPending && Boolean(currentUserId)
                  }
                  onDraftChange={(value, cursor) => {
                    setThreadDraft(value);
                    updateThreadMentionState(value, cursor);
                  }}
                  onMentionActiveIndexChange={
                    setThreadMentionActiveIndex
                  }
                  onMentionSelect={(option) =>
                    void selectMention(option, "thread")
                  }
                  onMentionDismiss={dismissThreadMention}
                  onImagesSelected={addThreadImages}
                  onRemoveImage={(index) =>
                    setThreadSelectedImages((current) =>
                      current.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    )
                  }
                  onVoiceRecorded={(note) => {
                    setThreadVoiceNote(note);
                    setThreadError(null);
                  }}
                  onClearVoice={clearThreadVoiceNote}
                  onOpenSnippet={(mode) => {
                    setSnippetModalTarget("thread");
                    setSnippetModalMode(mode);
                    setSnippetModalOpen(true);
                  }}
                  onClearSnippet={() => setThreadTextSnippet(null)}
                  onReuseRecentImage={(imageId) => {
                    const image = recentImageAttachments.find(
                      (candidate) => candidate.id === imageId,
                    );
                    if (image) void reuseRecentImage(image, "thread");
                  }}
                  onOpenSchedule={() => setSchedulePanelVisible(true)}
                  onStartHuddle={() => {
                    const trigger = document.getElementById(
                      `chat-huddle-trigger-${active.id}`,
                    ) as HTMLButtonElement | null;
                    if (trigger) trigger.click();
                    else {
                      setThreadError(
                        "Huddles are still being activated.",
                      );
                    }
                  }}
                  onComposerError={setThreadError}
                  onSend={() => void sendThreadReply()}
                  onEdit={(messageId) => {
                    const message = messageById.get(messageId);
                    if (message) beginEditAndResend(message);
                  }}
                  onDelete={(messageId) => {
                    const message = messageById.get(messageId);
                    if (message) void deleteMessage(message);
                  }}
                  onCancelResend={() => setThreadResendSource(null)}
                  onLoadOlder={loadOlderThreadReplies}
                  onJumpLatest={jumpThreadToLatest}
                  onClose={closeThread}
                />
              ) : null}
              {active.kind === "channel" && schedulePanelOpen ? (
                <ChannelScheduledTasksPanel
                  channelName={active.name}
                  tasks={scheduledTasks}
                  loading={scheduledTasksLoading}
                  error={scheduledTasksError}
                  migrationPending={scheduleMigrationPending}
                  busyTaskId={scheduleBusyTaskId}
                  runningTaskIds={scheduleRunningTaskIds}
                  canCreate={workspaceRole !== "guest"}
                  onAction={manageScheduledTask}
                  onRun={runScheduledTask}
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
      </div>
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
      {directComposerOpen && workspaceRole !== "guest" ? (
        <DirectMessageCreateModal
          people={directMessagePeople}
          onClose={() => setDirectComposerOpen(false)}
          onStart={createDirectMessage}
        />
      ) : null}
      {channelSettingsOpen &&
      active &&
      (active.kind === "channel" || activeIsHumanDm) ? (
        <ChannelSettingsModal
          channel={active}
          displayName={activeDisplayName}
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
      {profileOpen && currentUserId ? (
        <ChatProfileModal
          open
          profile={currentMemberProfile}
          presence={memberPresenceByUserId.get(currentUserId)}
          email={
            personByUserId.get(currentUserId)?.email ||
            people.find((person) => person.user_id === currentUserId)?.email ||
            null
          }
          onClose={() => setProfileOpen(false)}
          onChanged={(profile) => {
            setMemberProfiles((current) => [
              ...current.filter(
                (candidate) => candidate.user_id !== profile.user_id,
              ),
              profile,
            ]);
          }}
        />
      ) : null}
      <ChatSearchDialog
        open={searchOpen}
        initialTab={searchInitialTab}
        initialScope={searchInitialScope}
        activeChannelId={activeId}
        channels={displayChannels}
        profiles={memberProfileByUserId}
        people={people}
        presence={memberPresenceByUserId}
        agentNames={
          new Map(agents.map((agent) => [agent.id, agent.name] as const))
        }
        profileNames={
          new Map(profiles.map((profile) => [profile.id, profile.name] as const))
        }
        onClose={() => setSearchOpen(false)}
        onOpenResult={openSearchResult}
      />
      <ChatThreadsDialog
        open={threadsOpen}
        threads={displayThreadInbox}
        loading={threadInboxLoading}
        error={threadInboxError}
        migrationPending={threadReadMigrationPending}
        profiles={memberProfileByUserId}
        people={people}
        presence={memberPresenceByUserId}
        agentNames={
          new Map(agents.map((agent) => [agent.id, agent.name] as const))
        }
        profileNames={
          new Map(profiles.map((profile) => [profile.id, profile.name] as const))
        }
        onClose={() => setThreadsOpen(false)}
        onRefresh={() => {
          void loadThreadInbox();
        }}
        onOpenThread={openThreadInboxResult}
      />
      <ChatTextSnippetModal
        open={snippetModalOpen}
        mode={snippetModalMode}
        onClose={() => setSnippetModalOpen(false)}
        onAdd={(snippet) => {
          if (snippetModalTarget === "thread") {
            if (threadSelectedImages.length > 0 || threadVoiceNote) {
              setThreadError(
                "Remove the current attachment before adding a text snippet.",
              );
              return;
            }
            setThreadTextSnippet(snippet);
            setThreadError(null);
            return;
          }
          if (selectedImages.length > 0 || voiceNote) {
            setError(
              "Remove the current attachment before adding a text snippet.",
            );
            return;
          }
          setTextSnippet(snippet);
          setError(null);
        }}
      />
      {socialNotice ? (
        <div
          className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-[110] -translate-x-1/2 rounded-full border border-white/10 bg-[#1b1e23]/95 px-4 py-2 text-xs text-zinc-100 shadow-2xl backdrop-blur"
          role="status"
        >
          {socialNotice}
        </div>
      ) : null}
    </div>
  );
}
