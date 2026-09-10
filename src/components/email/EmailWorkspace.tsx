"use client";

import {
  Archive,
  ArrowLeft,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  CircleAlert,
  ChevronDown,
  ChevronUp,
  Command,
  CornerUpLeft,
  Download,
  ExternalLink,
  FileText,
  Forward as ForwardIcon,
  Eye,
  ImagePlus,
  Inbox,
  Keyboard,
  LoaderCircle,
  Mail,
  MailOpen,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  UsersRound,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import {
  animate,
  motion,
  useMotionValue,
  useTransform,
} from "framer-motion";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppHeader } from "@/components/AppHeader";
import { useEmailCacheScope } from "@/components/email/EmailCacheScope";
import { EMAIL_BACKGROUND_SYNC_EVENT } from "@/components/email/EmailBackgroundSyncBridge";
import {
  applyEmailWorkspaceCorrectionToFeed,
  applyEmailWorkspaceCorrectionsToFeed,
  EMAIL_WORKSPACE_CORRECTION_EVENT,
  emailTrackingCompletedSendIdentity,
  emailWorkspaceCorrectionFromRow,
  emailWorkspacePlacementAppliesToThread,
  emailWorkspaceReadStateAppliesToThread,
  emailWorkspaceOperationForTargetView,
  recentEmailWorkspaceCorrections,
  type EmailWorkspaceCorrection,
} from "@/lib/email/workspaceSync";
import {
  mergeEmailNavigationStats,
  navigationStatsFromCachedFeeds,
} from "@/lib/email/navigationStats";
import { WorkspaceSwitcher } from "@/components/workspaces/WorkspaceSwitcher";
import { useConnectorDevice } from "@/hooks/useConnectorDevice";
import { connectDatagranInSystemBrowser } from "@/lib/datagran/desktopConnect";
import {
  insertTextAtSelection,
  pasteTextPreservingStructure,
} from "@/lib/composer/pasteFormatting";
import {
  getDesktopApi,
  isDesktopShell,
  type DesktopNativeComposerShortcut,
  type DesktopNativeEmailShortcut,
} from "@/lib/desktop/shell";
import {
  FOCUS_ZERO_PALETTES,
  focusZeroFallback,
  type FocusZeroScene,
} from "@/lib/email/focusZero";
import { readEmailBackgroundFocusSnapshot } from "@/lib/email/backgroundFeedCache";
import { shouldCoalesceEmailFeedRequest } from "@/lib/email/backgroundSync";
import {
  emailThreadDetailContainsMessage,
  readEmailBackgroundThreadSnapshot,
} from "@/lib/email/backgroundThreadCache";
import {
  applyOptimisticEmailNavigationStats,
  applyOptimisticEmailOperation,
  canHydrateEmailFeedFromCache,
  emailFeedAutoLoadThreshold,
  emailFeedPageSize,
  emailFeedNavigationAction,
  emailFeedResumeAction,
  isCurrentEmailFeedRequest,
  keepSentConversationInFeed,
  localEmailReadAppliesToThread,
  mergeEmailFocusNotificationSnapshot,
  mergeEmailFeedPage,
  mergeEmailMailboxHealth,
  mergeConfirmedSentThread,
  needsReviewNavigationCount,
  nextAutoLoadedEmailFeedDepth,
  preserveStableEmailThreadReferences,
  preserveLocallyReadEmailThreads,
  preserveTransientMailboxFailures,
  removeEmailConversationsClaimedByFeed,
  setEmailConversationUnread,
  shouldAutoLoadEmailFeed,
  shouldLoadMoreEmailNearScrollEnd,
  supportsProgressiveEmailSnapshot,
} from "@/lib/email/feedOptimistic";
import {
  runEmailActionWithRetry,
  retryableEmailActionError,
  SerialEmailActionQueue,
  type EmailActionQueuePhase,
} from "@/lib/email/actionQueue";
import { emailWorkspaceOverrideForOperation } from "@/lib/email/actionState";
import {
  nextEmailFeedCacheRevision,
  readEmailFeedCache,
  readEmailFeedCaches,
  writeEmailFeedCache,
  type EmailFeedCacheEntry,
} from "@/lib/email/feedCache";
import {
  readEmailNavigationFeed,
  readEmailNavigationLocation,
  rememberEmailNavigationFeed,
} from "@/lib/email/navigationFeed";
import {
  GROOVY_AI_EMAIL_DISCLOSURE,
  stripGroovyAiEmailDisclosure,
} from "@/lib/email/disclosure";
import {
  acceptEmailCompletion,
  canShowEmailCompletion,
  classifyEmailCompletionResponse,
  emailCompletionSuffix,
  isEmailCompletionCaretAtEnd,
  shouldRequestEmailCompletion,
  shouldScheduleEmailCompletion,
} from "@/lib/email/completion";
import {
  canOpenEmailAttachmentInline,
  emailAttachmentUrl,
  resolvedEmailAttachmentMimeType,
  safeEmailAttachmentFilename,
} from "@/lib/email/attachment";
import {
  canInlineEmailDraftMimeType,
  emailDraftContentId,
  EMAIL_DRAFT_ATTACHMENT_BUCKET,
  EMAIL_DRAFT_ATTACHMENT_MAX_COUNT,
  EMAIL_DRAFT_ATTACHMENT_MAX_FILE_BYTES,
  EMAIL_DRAFT_ATTACHMENT_MAX_TOTAL_BYTES,
  plainTextWithInlineImageLabels,
  plainTextWithInlineImages,
  safeEmailDraftFilename,
  safeEmailDraftMimeType,
} from "@/lib/email/draftAttachments";
import {
  splitEmailBodyHistory,
  tokenizeEmailBody,
} from "@/lib/email/bodyFormatting";
import { buildEmailReaderDocument } from "@/lib/email/readerDocument";
import {
  appendRecipientAddresses,
  recipientAddress,
  recipientAddresses,
  removeRecipientAddress,
  sanitizeAutomaticRecipientFields,
} from "@/lib/email/recipients";
import {
  canMarkEmailDone,
  getEmailSwipeActions,
  type EmailWorkspaceOperation,
} from "@/lib/email/interactions";
import { actionableEmailCalendarInvite } from "@/lib/email/calendarInvite";
import {
  canRunEmailWorkspaceShortcut,
  isPlainEmailShortcut,
} from "@/lib/email/shortcuts";
import {
  emailRecipientMailboxAddressKey,
  emailRecipientSuggestionCacheKey,
  filterEmailContactSuggestions,
  normalizeEmailSearchQuery,
  rankEmailSearchSummaries,
  suggestEmailContacts,
} from "@/lib/email/search";
import { defaultComposerMailbox } from "@/lib/email/composerMailbox";
import {
  emailComposerDraftHasContent,
  mergeEmailComposerDraftSnapshots,
  normalizeEmailComposerDraftSnapshot,
  persistEmailComposerDraft,
  readEmailComposerDraftState,
  removeEmailComposerDraft,
  setActiveEmailComposerDraft,
  type EmailComposerDraftSnapshot,
} from "@/lib/email/composerDrafts";
import {
  boundedEmailAssistPayload,
  boundedEmailDraftPayload,
} from "@/lib/email/payloadLimits";
import { APP_NAVIGATE_EVENT } from "@/lib/navigation/appNavigationEvent";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  EMAIL_SEND_COMPLETED_EVENT,
  EMAIL_SEND_FAILED_EVENT,
  emailSendCanUseKeepalive,
  readPendingEmailSends,
  recentCompletedEmailSends,
  recentFailedEmailSends,
  sendEmailDraftDurably,
  type CompletedEmailSend,
  type FailedEmailSend,
} from "@/lib/email/sendQueue";
import {
  EMAIL_FEED_SCHEMA_VERSION,
  type EmailDraft,
  type EmailDraftAttachment,
  type EmailContactSuggestion,
  type EmailCalendarInvite,
  type EmailCalendarResponseStatus,
  type EmailFeedResponse,
  type EmailMailbox,
  type EmailMessage,
  type EmailOpenStatus,
  type EmailSearchMatchField,
  type EmailSearchResponse,
  type EmailSearchResult,
  type EmailSnippet,
  type EmailThreadDetail,
  type EmailThreadSummary,
  type EmailView,
} from "@/lib/email/types";

type WorkspaceView = EmailView | "drafts" | "snippets";
type ComposerState = {
  localId: string;
  actionId: string | null;
  draftId: string | null;
  connectionId: string;
  threadId: string | null;
  sourceMessageId: string | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  bodyHtml: string | null;
  attachments: EmailDraftAttachment[];
  inReplyTo: string | null;
  references: string | null;
  aiGenerated: boolean;
  untouched: boolean;
  gmailSyncPending: boolean;
};
type ThreadComposeMode = "reply" | "reply_all" | "forward";
type ThreadComposeIntent = {
  messageId: string;
  mode: ThreadComposeMode;
};
type DetailCacheEntry = {
  detail: EmailThreadDetail;
  expiresAt: number;
};
type WorkspaceFeedCacheEntry = EmailFeedCacheEntry & {
  connectionId: string | null;
};
type EmailNavigationSnapshot = {
  threadKey: string;
  scrollTop: number;
  rowOffset: number | null;
};
type EmailActionUiState = {
  phase: EmailActionQueuePhase;
  operation: EmailWorkspaceOperation;
  attempt: number;
  error?: string;
};
type CalendarRsvpStatus = Exclude<
  EmailCalendarResponseStatus,
  "needsAction"
>;
type CalendarRsvpUiState = {
  phase: "queued" | "processing" | "retrying" | "failed";
  responseStatus: CalendarRsvpStatus;
  error?: string;
  code?: string;
  requiredCalendarEmail?: string;
  openInGmailUrl?: string;
};
type EmailSearchState = {
  query: string;
  connectionId: string | null;
  results: EmailSearchResult[];
  loading: boolean;
  resolved: boolean;
  error: string | null;
  warnings: string[];
  searchedMailboxCount: number;
  totalMailboxCount: number;
};
type IndexedEmailSearchState = {
  query: string;
  connectionId: string | null;
  results: EmailSearchResult[];
};

const EMPTY_FEED: EmailFeedResponse = {
  schemaVersion: EMAIL_FEED_SCHEMA_VERSION,
  view: "focus",
  mailboxes: [],
  threads: [],
  nextCursor: null,
  warnings: [],
  stats: {
    focus: 0,
    processed: 0,
    draftsReady: 0,
    needsReview: 0,
    noiseCaught: 0,
  },
};

const EMPTY_SEARCH: EmailSearchState = {
  query: "",
  connectionId: null,
  results: [],
  loading: false,
  resolved: false,
  error: null,
  warnings: [],
  searchedMailboxCount: 0,
  totalMailboxCount: 0,
};
const EMPTY_INDEXED_SEARCH: IndexedEmailSearchState = {
  query: "",
  connectionId: null,
  results: [],
};

function calendarRsvpLabel(status: EmailCalendarResponseStatus): string {
  if (status === "accepted") return "Accepted";
  if (status === "tentative") return "Maybe";
  if (status === "declined") return "Declined";
  return "Calendar invitation";
}

function applyCalendarRsvpToFeed(
  feed: EmailFeedResponse,
  thread: EmailThreadSummary,
  invite: EmailCalendarInvite,
): EmailFeedResponse {
  const matches = (item: EmailThreadSummary) =>
    item.connectionId === thread.connectionId &&
    item.threadId === thread.threadId;
  const containsThread = feed.threads.some(matches);
  if (!containsThread) return feed;
  const leavesWorkQueue =
    invite.responseStatus !== "needsAction" &&
    (feed.view === "focus" ||
      feed.view === "inbox" ||
      feed.view === "noise");
  const stats = { ...feed.stats };
  if (leavesWorkQueue) {
    if (feed.view === "focus") {
      stats.focus = Math.max(0, stats.focus - 1);
    } else if (feed.view === "inbox") {
      stats.needsReview = Math.max(0, stats.needsReview - 1);
    } else if (feed.view === "noise") {
      stats.noiseCaught = Math.max(0, stats.noiseCaught - 1);
    }
    stats.processed += 1;
  }
  return {
    ...feed,
    threads: leavesWorkQueue
      ? feed.threads.filter((item) => !matches(item))
      : feed.threads.map((item) =>
          matches(item) ? { ...item, calendarInvite: invite } : item,
        ),
    stats: leavesWorkQueue ? stats : feed.stats,
  };
}

const VIEW_ITEMS: Array<{
  id: WorkspaceView;
  label: string;
  description: string;
  icon: typeof Inbox;
}> = [
  {
    id: "focus",
    label: "Focus Stack",
    description: "What deserves you now",
    icon: Zap,
  },
  {
    id: "inbox",
    label: "Needs Review",
    description: "Unclassified or needs your judgment",
    icon: CircleAlert,
  },
  {
    id: "noise",
    label: "Noise",
    description: "Caught before it distracts",
    icon: ShieldCheck,
  },
  {
    id: "handled",
    label: "Handled",
    description: "Done and out of the way",
    icon: CheckCircle2,
  },
  {
    id: "all",
    label: "All Mail",
    description: "Every message, newest first",
    icon: Inbox,
  },
  {
    id: "sent",
    label: "Sent",
    description: "What left your desk",
    icon: Send,
  },
  {
    id: "drafts",
    label: "Drafts",
    description: "Continue unfinished messages",
    icon: FileText,
  },
  {
    id: "snippets",
    label: "Snippets",
    description: "Reusable messages",
    icon: FileText,
  },
];

function isEmailView(view: WorkspaceView): view is EmailView {
  return view !== "drafts" && view !== "snippets";
}

function browserEmailDraftStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function composerDraftRequestPayload(draft: ComposerState) {
  const payload: Partial<ComposerState> = { ...draft };
  delete payload.gmailSyncPending;
  return boundedEmailDraftPayload(
    payload as Omit<ComposerState, "gmailSyncPending">,
  );
}

const SHORTCUTS = [
  ["⌘ 1", "Open Command Center"],
  ["⌘ 2", "Open Chat"],
  ["⌘ 3", "Open Email"],
  ["J / K or ↓ / ↑", "Move through the stack"],
  ["Enter", "Open and reply all"],
  ["F", "Forward selected email"],
  ["Esc", "Return to the list"],
  ["C", "Compose"],
  ["D", "Mark Done"],
  ["E", "Archive"],
  ["S", "Star or unstar"],
  ["U", "Mark unread"],
  ["/", "Search"],
  ["Tab", "Accept AI continuation"],
  ["⌘ J", "Tell AI how to rewrite"],
  ["⌘ Enter", "Send"],
  ["⌘ K", "Open shortcuts"],
  ["?", "Open shortcuts"],
] as const;

const EMAIL_TRIAGE_INTERVAL_MS = 5 * 60_000;
const EMAIL_MAILBOX_HEALTH_INTERVAL_MS = 15 * 60_000;
const EMAIL_MAILBOX_HEALTH_INITIAL_DELAY_MS = 500;
const EMAIL_FOCUS_REFRESH_COOLDOWN_MS = 30_000;
const EMAIL_REALTIME_REFRESH_DEBOUNCE_MS = 1_500;
const EMAIL_REALTIME_RETRY_MS = 2_500;
const EMAIL_REALTIME_SELF_ECHO_WINDOW_MS = 5_000;
const EMAIL_LOCAL_WORKSPACE_CORRECTION_TTL_MS = 2 * 60_000;
const EMAIL_FOCUS_DELTA_RECONCILE_WINDOW_MS = 48 * 60 * 60_000;
const EMAIL_FOCUS_DELTA_RECONCILE_COOLDOWN_MS = 2_000;
const EMAIL_PREFETCH_THREAD_COUNT = 6;
const EMAIL_PREFETCH_START_DELAY_MS = 600;
const EMAIL_PREFETCH_CONCURRENCY = 2;
const EMAIL_INITIAL_FEED_LIMIT = 24;
const EMAIL_MAX_FEED_LIMIT = 96;
const EMAIL_DETAIL_CACHE_TTL_MS = 5 * 60_000;
const EMAIL_SEARCH_DEBOUNCE_MS = 180;
const EMAIL_SEARCH_RESULT_LIMIT = 30;
const EMAIL_RECIPIENT_SEARCH_DEBOUNCE_MS = 180;
const EMAIL_RECIPIENT_CACHE_TTL_MS = 5 * 60_000;
const emailRecipientSuggestionCache = new Map<
  string,
  { expiresAt: number; suggestions: EmailContactSuggestion[] }
>();

function cachedRecipientSuggestions(
  query: string,
): EmailContactSuggestion[] | null {
  const cached = emailRecipientSuggestionCache.get(query);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    emailRecipientSuggestionCache.delete(query);
    return null;
  }
  return cached.suggestions;
}

function cacheRecipientSuggestions(
  query: string,
  suggestions: EmailContactSuggestion[],
) {
  emailRecipientSuggestionCache.delete(query);
  emailRecipientSuggestionCache.set(query, {
    expiresAt: Date.now() + EMAIL_RECIPIENT_CACHE_TTL_MS,
    suggestions,
  });
  while (emailRecipientSuggestionCache.size > 50) {
    const oldest = emailRecipientSuggestionCache.keys().next().value;
    if (typeof oldest !== "string") break;
    emailRecipientSuggestionCache.delete(oldest);
  }
}

function emailConversationIdentity(
  thread: Pick<EmailThreadSummary, "connectionId" | "threadId">,
): string {
  return `${thread.connectionId}:${thread.threadId}`;
}

function setSearchConversationUnread(
  results: EmailSearchResult[],
  thread: Pick<EmailThreadSummary, "connectionId" | "threadId">,
  unread: boolean,
  correction?: EmailWorkspaceCorrection,
): EmailSearchResult[] {
  return results.map((result) =>
    result.connectionId === thread.connectionId &&
    result.threadId === thread.threadId &&
    (!correction ||
      emailWorkspaceReadStateAppliesToThread(correction, result)) &&
    result.unread !== unread
      ? { ...result, unread }
      : result,
  );
}

function searchFieldLabel(field: EmailSearchMatchField): string {
  if (field === "sender") return "Sender";
  if (field === "recipient") return "Recipient";
  if (field === "subject") return "Subject";
  if (field === "mailbox") return "Mailbox";
  return "Message text";
}

function emailFeedCacheKey(view: EmailView, connectionId: string | null) {
  return `${view}:${connectionId || "all"}`;
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function emailActionIsBusy(state: EmailActionUiState | undefined): boolean {
  return (
    state?.phase === "queued" ||
    state?.phase === "processing" ||
    state?.phase === "retrying"
  );
}

function errorMessage(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return fallback;
}

function EmailAttachmentChip({
  attachment,
  connectionId,
  messageId,
  threadId,
  activeDownloadKey,
  onDownload,
}: {
  attachment: EmailMessage["attachments"][number];
  connectionId: string;
  messageId: string;
  threadId: string;
  activeDownloadKey: string | null;
  onDownload: (args: {
    key: string;
    url: string;
    filename: string;
  }) => Promise<void>;
}) {
  const attachmentKey = `${messageId}:${attachment.id}:${attachment.filename}`;
  const mimeType = resolvedEmailAttachmentMimeType({
    mimeType: attachment.mimeType,
    filename: attachment.filename,
  });
  const canPreview = canOpenEmailAttachmentInline(mimeType);
  const attachmentUrl = (download: boolean) =>
    emailAttachmentUrl({
      connectionId,
      messageId,
      attachmentId: attachment.id,
      threadId,
      partId: attachment.partId,
      filename: attachment.filename,
      mimeType,
      open: !download,
      download,
    });
  const downloading = activeDownloadKey === attachmentKey;
  const detail = attachment.size > 0 ? formatAttachmentSize(attachment.size) : "";
  const content = (
    <>
      <Paperclip className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{attachment.filename}</span>
      {detail ? (
        <span className="shrink-0 text-[9px] text-zinc-600">{detail}</span>
      ) : null}
    </>
  );

  return (
    <span className="inline-flex max-w-full min-w-0 overflow-hidden rounded-lg border border-white/[0.08] bg-black/20 text-[10px] text-zinc-500 transition hover:border-cyan-300/20 hover:bg-cyan-300/[0.04] hover:text-cyan-200 focus-within:border-cyan-300/20">
      {canPreview ? (
        <a
          href={attachmentUrl(false)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-w-0 items-center gap-1.5 px-2.5 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300/40"
          aria-label={`Open attachment ${attachment.filename}`}
          title={`Open ${attachment.filename}`}
        >
          {content}
          <Eye className="h-3 w-3 shrink-0" />
        </a>
      ) : (
        <button
          type="button"
          onClick={() =>
            void onDownload({
              key: attachmentKey,
              url: attachmentUrl(true),
              filename: attachment.filename,
            })
          }
          disabled={activeDownloadKey !== null}
          className="inline-flex min-w-0 items-center gap-1.5 px-2.5 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300/40 disabled:cursor-wait disabled:opacity-60"
          aria-label={`Download attachment ${attachment.filename}`}
          title={`Download ${attachment.filename}`}
        >
          {content}
          {downloading ? (
            <LoaderCircle className="h-3 w-3 shrink-0 animate-spin opacity-70" />
          ) : (
            <Download className="h-3 w-3 shrink-0 opacity-60" />
          )}
        </button>
      )}
      {canPreview ? (
        <button
          type="button"
          onClick={() =>
            void onDownload({
              key: attachmentKey,
              url: attachmentUrl(true),
              filename: attachment.filename,
            })
          }
          disabled={activeDownloadKey !== null}
          className="border-l border-white/[0.08] px-2.5 text-zinc-600 transition hover:bg-white/[0.05] hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300/40 disabled:cursor-wait disabled:opacity-60"
          aria-label={`Download attachment ${attachment.filename}`}
          title={`Download ${attachment.filename}`}
        >
          {downloading ? (
            <LoaderCircle className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
        </button>
      ) : null}
    </span>
  );
}

function PlainEmailBody({ body }: { body: string }) {
  const sections = useMemo(() => splitEmailBodyHistory(body), [body]);
  const visibleTokens = useMemo(
    () => tokenizeEmailBody(sections.visible),
    [sections.visible],
  );
  const quotedTokens = useMemo(
    () => (sections.quoted ? tokenizeEmailBody(sections.quoted) : []),
    [sections.quoted],
  );
  const [showQuoted, setShowQuoted] = useState(false);

  const renderTokens = (
    tokens: ReturnType<typeof tokenizeEmailBody>,
    prefix: string,
  ) =>
    tokens.map((token, index) => {
      if (token.type === "text") {
        return <span key={`${prefix}-text-${index}`}>{token.value}</span>;
      }
      const external = /^https?:\/\//i.test(token.href);
      return (
        <a
          key={`${prefix}-link-${index}`}
          href={token.href}
          target={external ? "_blank" : undefined}
          rel={external ? "noopener noreferrer" : undefined}
          title={token.href}
          className="font-medium text-cyan-300 underline decoration-cyan-300/30 underline-offset-2 transition-colors hover:text-cyan-200 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40"
        >
          {token.label}
        </a>
      );
    });

  return (
    <div className="mt-4 max-w-full whitespace-pre-wrap break-words text-[13px] leading-6 text-zinc-400 [overflow-wrap:anywhere]">
      {renderTokens(visibleTokens, "visible")}
      {sections.quoted ? (
        <div className="mt-4 border-t border-white/[0.055] pt-3">
          <button
            type="button"
            onClick={() => setShowQuoted((current) => !current)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5 text-[10px] font-medium text-zinc-500 transition hover:border-white/[0.12] hover:text-zinc-300"
            aria-expanded={showQuoted}
          >
            {showQuoted ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            {showQuoted ? "Hide quoted text" : "Show quoted text"}
          </button>
          {showQuoted ? (
            <div className="mt-3 border-l border-white/[0.08] pl-3 text-zinc-600">
              {renderTokens(quotedTokens, "quoted")}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function EmailBody({
  body,
  htmlBody,
}: {
  body: string;
  htmlBody: string | null;
}) {
  if (!htmlBody) return <PlainEmailBody body={body} />;
  return <HtmlEmailBody htmlBody={htmlBody} />;
}

function HtmlEmailBody({ htmlBody }: { htmlBody: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [frameHeight, setFrameHeight] = useState(160);
  const srcDoc = useMemo(
    () => buildEmailReaderDocument(htmlBody),
    [htmlBody],
  );

  const resizeFrame = useCallback(() => {
    const document = frameRef.current?.contentDocument;
    if (!document) return;
    const nextHeight = Math.max(
      160,
      Math.ceil(
        Math.max(
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0,
        ),
      ),
    );
    setFrameHeight((current) =>
      Math.abs(current - nextHeight) > 1 ? nextHeight : current,
    );
  }, []);

  const handleFrameLoad = useCallback(() => {
    resizeObserverRef.current?.disconnect();
    const document = frameRef.current?.contentDocument;
    if (!document) return;
    resizeFrame();
    const observer = new ResizeObserver(resizeFrame);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    resizeObserverRef.current = observer;
  }, [resizeFrame]);

  useEffect(
    () => () => {
      resizeObserverRef.current?.disconnect();
    },
    [],
  );

  return (
    <div
      className="mt-4 max-w-full overflow-hidden rounded-xl border border-white/[0.1] bg-white shadow-[0_12px_32px_rgba(0,0,0,0.2)]"
      data-email-html-body
    >
      <iframe
        ref={frameRef}
        title="Email message content"
        srcDoc={srcDoc}
        sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
        referrerPolicy="no-referrer"
        onLoad={handleFrameLoad}
        className="block w-full border-0 bg-white"
        style={{ height: `${frameHeight}px` }}
      />
    </div>
  );
}

async function jsonRequest<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  const responseText = await response.text();
  let payload: T;
  try {
    payload = JSON.parse(responseText) as T;
  } catch {
    payload = {} as T;
  }
  if (!response.ok) {
    const payloadTooLarge =
      response.status === 413 ||
      /FUNCTION_PAYLOAD_TOO_LARGE|Request Entity Too Large/i.test(responseText);
    const error = new Error(
      payloadTooLarge
        ? "This email is too large for one in-app request. Shorten the draft or open the original in Gmail, then try again."
        : errorMessage(payload, "Request failed."),
    );
    Object.assign(error, { status: response.status, payload });
    throw error;
  }
  return payload;
}

function formatWhen(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (today.getFullYear() === date.getFullYear()) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}

function formatMessageDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatUpdatedAt(value: Date | null): string {
  if (!value) return "";
  return value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clipboardImageFiles(clipboard: DataTransfer): File[] {
  return Array.from(clipboard.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(
      (file): file is File =>
        Boolean(file) && canInlineEmailDraftMimeType(file?.type),
    );
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?"
  );
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined
    ? null
    : `${Math.round(value * 100)}%`;
}

function composerFromDetail(
  detail: EmailThreadDetail,
  ownedAddresses: readonly string[] = [],
): ComposerState {
  const draft = detail.draft;
  const draftAttachments = draft?.attachments || [];
  const automaticRecipients =
    draft?.aiGenerated === true
      ? sanitizeAutomaticRecipientFields({
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          ownedAddresses,
        })
      : null;
  return {
    localId: globalThis.crypto.randomUUID(),
    actionId: draft?.actionId || detail.summary.action?.id || null,
    draftId: draft?.draftId || null,
    connectionId: detail.summary.connectionId,
    threadId: detail.summary.threadId,
    sourceMessageId: detail.summary.messageId,
    to: (
      automaticRecipients
        ? automaticRecipients.to.length > 0
          ? automaticRecipients.to
          : detail.replyAll.to
        : draft?.to || detail.replyAll.to
    ).join(", "),
    cc: (automaticRecipients?.cc || draft?.cc || detail.replyAll.cc).join(
      ", ",
    ),
    bcc: (automaticRecipients?.bcc || draft?.bcc || []).join(", "),
    subject: draft?.subject || detail.replyAll.subject,
    body: stripGroovyAiEmailDisclosure(draft?.body || ""),
    bodyHtml: draftAttachments.some(
      (attachment) => attachment.disposition === "inline",
    )
      ? draft?.bodyHtml || null
      : null,
    attachments: draftAttachments,
    inReplyTo: detail.replyAll.inReplyTo,
    references: detail.replyAll.references,
    aiGenerated: draft?.aiGenerated === true,
    untouched: draft?.untouched === true,
    gmailSyncPending: false,
  };
}

function composerFromMessage(
  detail: EmailThreadDetail,
  message: EmailMessage,
  mode: ThreadComposeMode,
): ComposerState {
  if (mode === "forward") {
    const subject = /^fwd:/i.test(message.subject)
      ? message.subject
      : `Fwd: ${message.subject}`;
    const copied = [
      "---------- Forwarded message ----------",
      `From: ${message.from}`,
      `Date: ${formatMessageDate(message.sentAt)}`,
      `Subject: ${message.subject}`,
      `To: ${message.to.join(", ")}`,
      ...(message.cc.length ? [`Cc: ${message.cc.join(", ")}`] : []),
      "",
      message.body,
    ].join("\n");
    return {
      localId: globalThis.crypto.randomUUID(),
      actionId: null,
      draftId: null,
      connectionId: detail.summary.connectionId,
      threadId: null,
      sourceMessageId: message.id,
      to: "",
      cc: "",
      bcc: "",
      subject,
      body: `\n\n${copied}`,
      bodyHtml: null,
      attachments: [],
      inReplyTo: null,
      references: null,
      aiGenerated: false,
      untouched: false,
      gmailSyncPending: false,
    };
  }

  const target = mode === "reply" ? message.reply : message.replyAll;
  return {
    localId: globalThis.crypto.randomUUID(),
    actionId: null,
    draftId: null,
    connectionId: detail.summary.connectionId,
    threadId: detail.summary.threadId,
    sourceMessageId: message.id,
    to: target.to.join(", "),
    cc: target.cc.join(", "),
    bcc: "",
    subject: target.subject,
    body: "",
    bodyHtml: null,
    attachments: [],
    inReplyTo: target.inReplyTo,
    references: target.references,
    aiGenerated: false,
    untouched: false,
    gmailSyncPending: false,
  };
}

function emptyComposer(mailbox?: EmailMailbox): ComposerState {
  return {
    localId: globalThis.crypto.randomUUID(),
    actionId: null,
    draftId: null,
    connectionId: mailbox?.connectionId || "",
    threadId: null,
    sourceMessageId: null,
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    body: "",
    bodyHtml: null,
    attachments: [],
    inReplyTo: null,
    references: null,
    aiGenerated: false,
    untouched: false,
    gmailSyncPending: false,
  };
}

function composerFromDraftSnapshot(
  snapshot: EmailComposerDraftSnapshot,
): ComposerState {
  const draft: Partial<EmailComposerDraftSnapshot> = { ...snapshot };
  delete draft.updatedAt;
  return {
    ...(draft as Omit<EmailComposerDraftSnapshot, "updatedAt">),
    // The browser copy can be newer than Gmail when a refresh interrupted the
    // normal debounce. Force one reconciliation after recovery.
    gmailSyncPending: true,
  };
}

function MailboxBadge({
  mailbox,
  compact = false,
}: {
  mailbox: EmailMailbox;
  compact?: boolean;
}) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.035] px-2 py-0.5 text-[10px] text-zinc-400"
      title={`${mailbox.displayName} · ${mailbox.address}`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: mailbox.color }}
      />
      {!compact ? (
        <span className="max-w-28 truncate">{mailbox.displayName}</span>
      ) : null}
    </span>
  );
}

function useMobileSwipeEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const sync = () => setEnabled(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return enabled;
}

function seededUnit(seed: number, index: number) {
  const value = Math.sin(seed * 0.0137 + index * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function FocusZeroArtwork({ scene }: { scene: FocusZeroScene }) {
  const colors = FOCUS_ZERO_PALETTES[scene.palette];
  const id = `focus-zero-${scene.motif}-${scene.seed}`;
  const stars = Array.from({ length: 18 }, (_, index) => ({
    x: 18 + seededUnit(scene.seed, index) * 324,
    y: 16 + seededUnit(scene.seed + 7, index) * 118,
    radius: 0.8 + seededUnit(scene.seed + 13, index) * 1.6,
  }));
  const constellation = Array.from({ length: 7 }, (_, index) => ({
    x: 55 + index * 42 + seededUnit(scene.seed + 31, index) * 18,
    y: 50 + seededUnit(scene.seed + 37, index) * 92,
  }));
  const city = Array.from({ length: 10 }, (_, index) => {
    const width = 20 + seededUnit(scene.seed + 41, index) * 18;
    const height = 36 + seededUnit(scene.seed + 43, index) * 72;
    return { x: index * 38 - 8, width, height };
  });
  const flowers = Array.from({ length: 8 }, (_, index) => ({
    x: 34 + index * 42 + seededUnit(scene.seed + 47, index) * 14,
    height: 35 + seededUnit(scene.seed + 53, index) * 62,
    lean: -10 + seededUnit(scene.seed + 59, index) * 20,
  }));

  return (
    <svg
      viewBox="0 0 360 220"
      className="h-auto w-full"
      role="img"
      aria-label={scene.title}
    >
      <defs>
        <radialGradient id={`${id}-glow`} cx="50%" cy="42%" r="75%">
          <stop offset="0%" stopColor={colors[0]} stopOpacity="0.18" />
          <stop offset="52%" stopColor={colors[1]} stopOpacity="0.06" />
          <stop offset="100%" stopColor={colors[3]} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-line`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={colors[0]} />
          <stop offset="55%" stopColor={colors[1]} />
          <stop offset="100%" stopColor={colors[2]} />
        </linearGradient>
      </defs>
      <rect width="360" height="220" rx="20" fill={colors[3]} />
      <rect
        width="360"
        height="220"
        rx="20"
        fill={`url(#${id}-glow)`}
      />
      {stars.map((star, index) => (
        <circle
          key={index}
          cx={star.x}
          cy={star.y}
          r={star.radius}
          fill={colors[index % 3]}
          opacity={0.18 + seededUnit(scene.seed + 17, index) * 0.42}
        />
      ))}

      {scene.motif === "orbit" ? (
        <g
          fill="none"
          stroke={`url(#${id}-line)`}
          strokeLinecap="round"
        >
          {[0, 1, 2].map((ring) => (
            <ellipse
              key={ring}
              cx="180"
              cy="112"
              rx={66 + ring * 35}
              ry={27 + ring * 17}
              transform={`rotate(${-14 + ring * 13} 180 112)`}
              strokeWidth={ring === 0 ? 1.8 : 1.1}
              opacity={0.78 - ring * 0.16}
            />
          ))}
          <circle cx="180" cy="112" r="8" fill={colors[0]} stroke="none" />
          <circle cx="278" cy="94" r="4.5" fill={colors[2]} stroke="none" />
        </g>
      ) : null}

      {scene.motif === "mountains" ? (
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path
            d="M10 190 L77 105 L112 145 L164 69 L217 137 L257 92 L350 190"
            stroke={`url(#${id}-line)`}
            strokeWidth="2.4"
          />
          <path
            d="M50 190 L119 132 L152 161 L215 111 L294 190"
            stroke={colors[1]}
            strokeWidth="1.2"
            opacity="0.45"
          />
          <path
            d="M148 89 L164 69 L180 91"
            stroke={colors[2]}
            strokeWidth="1.8"
          />
        </g>
      ) : null}

      {scene.motif === "ocean" ? (
        <g fill="none" strokeLinecap="round">
          {[0, 1, 2, 3].map((wave) => (
            <path
              key={wave}
              d={`M12 ${126 + wave * 20} C68 ${102 + wave * 20}, 111 ${
                151 + wave * 13
              }, 170 ${126 + wave * 20} S284 ${151 + wave * 13}, 348 ${
                126 + wave * 20
              }`}
              stroke={colors[wave % 3]}
              strokeWidth={wave === 0 ? 2.2 : 1.2}
              opacity={0.76 - wave * 0.12}
            />
          ))}
          <circle
            cx={80 + seededUnit(scene.seed, 82) * 200}
            cy="66"
            r="20"
            stroke={colors[2]}
            strokeWidth="1.5"
            opacity="0.75"
          />
        </g>
      ) : null}

      {scene.motif === "constellation" ? (
        <g>
          <polyline
            points={constellation.map((point) => `${point.x},${point.y}`).join(" ")}
            fill="none"
            stroke={`url(#${id}-line)`}
            strokeWidth="1.4"
            opacity="0.72"
          />
          {constellation.map((point, index) => (
            <g key={index}>
              <circle
                cx={point.x}
                cy={point.y}
                r={index % 3 === 0 ? 4 : 2.5}
                fill={colors[index % 3]}
              />
              <circle
                cx={point.x}
                cy={point.y}
                r={index % 3 === 0 ? 9 : 6}
                fill="none"
                stroke={colors[index % 3]}
                strokeWidth="0.7"
                opacity="0.3"
              />
            </g>
          ))}
        </g>
      ) : null}

      {scene.motif === "city" ? (
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          {city.map((building, index) => (
            <path
              key={index}
              d={`M${building.x} 194 V${194 - building.height} H${
                building.x + building.width
              } V194`}
              stroke={colors[index % 3]}
              strokeWidth={index % 4 === 0 ? 2 : 1.2}
              opacity={0.42 + (index % 3) * 0.16}
            />
          ))}
          <path
            d="M0 194 H360"
            stroke={colors[0]}
            strokeWidth="1.5"
            opacity="0.8"
          />
        </g>
      ) : null}

      {scene.motif === "garden" ? (
        <g fill="none" strokeLinecap="round">
          {flowers.map((flower, index) => {
            const top = 194 - flower.height;
            return (
              <g key={index}>
                <path
                  d={`M${flower.x} 200 Q${flower.x + flower.lean} ${
                    top + flower.height / 2
                  } ${flower.x + flower.lean / 2} ${top}`}
                  stroke={colors[index % 3]}
                  strokeWidth={index % 3 === 0 ? 2 : 1.2}
                  opacity="0.72"
                />
                <circle
                  cx={flower.x + flower.lean / 2}
                  cy={top}
                  r={3.5 + (index % 3)}
                  stroke={colors[(index + 1) % 3]}
                  strokeWidth="1.3"
                />
              </g>
            );
          })}
          <path
            d="M10 200 Q88 185 180 200 T350 198"
            stroke={colors[1]}
            strokeWidth="1.4"
            opacity="0.56"
          />
        </g>
      ) : null}
    </svg>
  );
}

function FocusZeroCard({ onOpenInbox }: { onOpenInbox(): void }) {
  const [scene, setScene] = useState<FocusZeroScene>(() =>
    focusZeroFallback(new Date().getDate() + new Date().getMonth() * 31),
  );
  const [generating, setGenerating] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void jsonRequest<{ ok: true; scene: FocusZeroScene }>(
      "/api/email/focus-zero",
    )
      .then((payload) => {
        if (!cancelled) setScene(payload.scene);
      })
      .catch(() => {
        // The local scene is already a complete offline-safe fallback.
      })
      .finally(() => {
        if (!cancelled) setGenerating(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="p-4 sm:p-5">
      <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025] shadow-2xl shadow-black/20">
        <FocusZeroArtwork scene={scene} />
        <div className="p-4 text-left">
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-emerald-300/15 bg-emerald-300/[0.07] px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.14em] text-emerald-200">
              Focus Zero
            </span>
            <span className="text-[9px] text-zinc-700">
              {generating ? "Creating today’s surprise…" : "Made for this clear"}
            </span>
          </div>
          <p className="mt-3 text-base font-medium tracking-tight text-zinc-100">
            {scene.title}
          </p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">{scene.note}</p>
          <button
            type="button"
            onClick={onOpenInbox}
            className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-medium text-cyan-300 transition hover:text-cyan-200"
          >
            Check Needs Review
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function OpenStatusBadge({
  status,
  compact = false,
}: {
  status: EmailOpenStatus | null;
  compact?: boolean;
}) {
  const opened = Boolean(status?.openedAt);
  const groupRecipients = status?.recipients || [];
  const exactOpeners =
    status?.recipientStatuses
      ?.filter((item) => item.openCount > 0)
      .map((item) => item.recipient) || [];
  const groupIdentity =
    groupRecipients.length > 0
      ? `one of ${groupRecipients.slice(0, 2).join(", ")}${
          groupRecipients.length > 2
            ? ` +${groupRecipients.length - 2}`
            : ""
        }`
      : "a recipient";
  const identity =
    status?.attribution === "single_recipient"
      ? status.recipients[0] || "recipient"
      : status?.attribution === "recipient_specific"
        ? exactOpeners.length > 0
          ? `${exactOpeners.slice(0, 2).join(", ")}${
              exactOpeners.length > 2 ? ` +${exactOpeners.length - 2}` : ""
            }`
          : "recipient"
      : groupIdentity;
  const label = !status
    ? "Not tracked"
    : opened
      ? compact
        ? `Likely opened · ${identity}`
        : `Likely opened by ${identity}`
      : "Not opened yet";
  return (
    <span
      className={classNames(
        "inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
        opened
          ? "border-emerald-400/15 bg-emerald-400/[0.07] text-emerald-200"
          : status
            ? "border-white/[0.08] bg-white/[0.025] text-zinc-500"
            : "border-white/[0.06] text-zinc-700",
      )}
      title={
        status
          ? status.attribution === "single_recipient"
            ? "This message had one recipient, so the likely opener can be named. Mail privacy relays and security scanners can affect the estimate."
            : status.attribution === "recipient_specific"
              ? opened
                ? `Likely opened by ${exactOpeners.join(", ")}. Each recipient received a private tracker. Mail privacy relays and security scanners can still affect the estimate.`
                : `Recipient-specific tracking is active for ${status.recipients.join(", ")}.`
              : `This shared message was sent to ${status.recipients.join(", ") || "multiple recipients"}. One of them likely opened it, but a shared tracking image cannot identify which one.`
          : "Open tracking starts when a message is sent from Groovy."
      }
    >
      <Eye className="h-2.5 w-2.5 shrink-0" />
      <span className={classNames(compact && "max-w-40 truncate")}>
        {label}
      </span>
    </span>
  );
}

const ThreadRow = memo(function ThreadRow({
  thread,
  selected,
  view,
  searchMatch,
  searchMode,
  swipeEnabled,
  actionState,
  calendarRsvpState,
  onOpen,
  onSelect,
  onPrefetch,
  onAction,
  onCalendarRsvp,
  onSwipeActivity,
}: {
  thread: EmailThreadSummary;
  selected: boolean;
  view: EmailView;
  searchMatch?: EmailSearchResult;
  searchMode?: boolean;
  swipeEnabled: boolean;
  actionState?: EmailActionUiState;
  calendarRsvpState?: CalendarRsvpUiState;
  onOpen(thread: EmailThreadSummary): void;
  onSelect(thread: EmailThreadSummary): void;
  onPrefetch(thread: EmailThreadSummary): void;
  onAction(
    thread: EmailThreadSummary,
    operation: EmailWorkspaceOperation,
  ): void;
  onCalendarRsvp(
    thread: EmailThreadSummary,
    responseStatus: CalendarRsvpStatus,
  ): void;
  onSwipeActivity(active: boolean): void;
}) {
  const lane = thread.action?.lane;
  const actionBusy = emailActionIsBusy(actionState);
  const calendarRsvpBusy =
    calendarRsvpState?.phase === "queued" ||
    calendarRsvpState?.phase === "processing" ||
    calendarRsvpState?.phase === "retrying";
  const calendarAccountMissing =
    calendarRsvpState?.code === "calendar_account_not_connected";
  const rowBusy = actionBusy || calendarRsvpBusy;
  const calendarInvite = actionableEmailCalendarInvite({
    subject: thread.subject,
    body: thread.snippet,
    invite: thread.calendarInvite,
  });
  const calendarRsvpFailureLabel =
    calendarRsvpState?.code === "calendar_account_not_connected"
      ? `Connect Calendar for ${
          calendarRsvpState.requiredCalendarEmail || thread.mailbox.address
        }`
      : calendarRsvpState?.code === "calendar_invitation_not_available"
        ? "Not available in Calendar"
        : "Could not respond";
  const showCalendarRsvp =
    thread.direction === "incoming" &&
    calendarInvite?.responseStatus === "needsAction";
  const doneRetry =
    actionState?.phase === "failed" &&
    (actionState.operation === "move_handled" ||
      actionState.operation === "archive");
  const actionStatusLabel =
    actionState?.phase === "queued"
      ? "Queued"
      : actionState?.phase === "processing"
        ? "Processing…"
        : actionState?.phase === "retrying"
          ? "Waiting to retry…"
          : actionState?.phase === "failed"
            ? "Not updated · retry"
            : null;
  const canMarkDone = !searchMode && canMarkEmailDone(view);
  const showNeedsReviewRouting = !searchMode && view === "inbox";
  const recoverToFocus = Boolean(
    thread.draft ||
      (thread.action &&
        thread.action.type !== "mark_spam" &&
        thread.action.type !== "unsubscribe" &&
        thread.action.type !== "archive"),
  );
  const swipeActions = getEmailSwipeActions(view, { recoverToFocus });
  const x = useMotionValue(0);
  const rightOpacity = useTransform(x, [0, 18, 84, 124], [0, 0.18, 1, 1]);
  const leftOpacity = useTransform(x, [-124, -84, -18, 0], [1, 1, 0.18, 0]);
  const rightScale = useTransform(x, [0, 84], [0.86, 1]);
  const leftScale = useTransform(x, [-84, 0], [1, 0.86]);
  const [swipeStage, setSwipeStage] = useState<
    "idle" | "left" | "left-ready" | "right" | "right-ready"
  >("idle");
  const swipeStageRef = useRef(swipeStage);
  const dragging = useRef(false);
  const prefetchTimerRef = useRef<number | null>(null);
  const threshold = 84;
  const swipingRight = swipeStage === "right" || swipeStage === "right-ready";
  const swipingLeft = swipeStage === "left" || swipeStage === "left-ready";
  const revealed =
    swipingRight ? swipeActions.right : swipeActions.left;
  const releaseReady =
    swipeStage === "right-ready" || swipeStage === "left-ready";

  const schedulePrefetch = useCallback(() => {
    if (prefetchTimerRef.current !== null) {
      window.clearTimeout(prefetchTimerRef.current);
    }
    prefetchTimerRef.current = window.setTimeout(() => {
      prefetchTimerRef.current = null;
      onPrefetch(thread);
    }, 450);
  }, [onPrefetch, thread]);

  const cancelPrefetch = useCallback(() => {
    if (prefetchTimerRef.current === null) return;
    window.clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = null;
  }, []);

  useEffect(() => cancelPrefetch, [cancelPrefetch]);

  const updateSwipeStage = useCallback((offset: number) => {
    const next =
      offset >= threshold
        ? "right-ready"
        : offset > 0
          ? "right"
          : offset <= -threshold
            ? "left-ready"
            : offset < 0
              ? "left"
              : "idle";
    if (next === swipeStageRef.current) return;
    swipeStageRef.current = next;
    setSwipeStage(next);
  }, []);

  const finishSwipe = useCallback(
    (offset: number) => {
      const commits = Math.abs(offset) >= threshold;
      if (commits) {
        onAction(
          thread,
          offset > 0
            ? swipeActions.right.operation
            : swipeActions.left.operation,
        );
      } else {
        void animate(x, 0, { type: "spring", stiffness: 520, damping: 38 });
      }
      onSwipeActivity(false);
      swipeStageRef.current = "idle";
      setSwipeStage("idle");
      window.setTimeout(() => {
        dragging.current = false;
      }, 180);
    },
    [
      onAction,
      onSwipeActivity,
      swipeActions.left.operation,
      swipeActions.right.operation,
      thread,
      x,
    ],
  );

  return (
    <div
      className="relative overflow-hidden border-b border-white/[0.055]"
      data-email-thread-row
      data-email-thread-key={thread.key}
      data-email-action-state={actionState?.phase}
      data-swipe-right={swipeActions.right.label}
      data-swipe-left={swipeActions.left.label}
      onMouseEnter={() => {
        onSelect(thread);
        schedulePrefetch();
      }}
      onMouseLeave={cancelPrefetch}
    >
      <motion.div
        className="pointer-events-none absolute inset-0 flex items-center justify-start bg-gradient-to-r from-emerald-500/15 via-emerald-500/8 to-transparent px-5 md:hidden"
        style={{ opacity: rightOpacity }}
        aria-hidden="true"
      >
        <motion.span
          className="flex items-center gap-2 text-xs font-semibold text-emerald-100"
          style={{ scale: rightScale }}
        >
          {swipeActions.right.label === "Needs Review" ? (
            <Inbox className="h-4 w-4" />
          ) : swipeActions.right.label === "Focus" ? (
            <Zap className="h-4 w-4" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {swipingRight && releaseReady
            ? `Release for ${swipeActions.right.label}`
            : swipeActions.right.label}
        </motion.span>
      </motion.div>
      <motion.div
        className="pointer-events-none absolute inset-0 flex items-center justify-end bg-gradient-to-l from-violet-500/15 via-violet-500/10 to-transparent px-5 md:hidden"
        style={{ opacity: leftOpacity }}
        aria-hidden="true"
      >
        <motion.span
          className="flex items-center gap-2 text-xs font-semibold text-violet-100"
          style={{ scale: leftScale }}
        >
          {swipeActions.left.label === "Done" ? (
            <Check className="h-4 w-4" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
          {swipingLeft && releaseReady
            ? `Release for ${swipeActions.left.label}`
            : swipeActions.left.label}
        </motion.span>
      </motion.div>
      <motion.div
        drag={swipeEnabled && !rowBusy ? "x" : false}
        dragConstraints={{ left: -124, right: 124 }}
        dragElastic={0.12}
        dragMomentum={false}
        style={{ x, touchAction: "pan-y", willChange: "transform" }}
        onDragStart={() => {
          dragging.current = true;
          onSwipeActivity(true);
        }}
        onDrag={(_, info) => updateSwipeStage(info.offset.x)}
        onDragEnd={(_, info) => finishSwipe(info.offset.x)}
        className={classNames(
          "group relative bg-[var(--bg-primary)] transition-colors",
          selected
            ? "bg-white/[0.075]"
            : "hover:bg-white/[0.04] focus-within:bg-white/[0.04]",
        )}
      >
        <button
          type="button"
          onFocus={() => {
            onSelect(thread);
            schedulePrefetch();
          }}
          onClick={() => {
            cancelPrefetch();
            if (!dragging.current) onOpen(thread);
          }}
          className="relative w-full px-4 py-3.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-cyan-300/40"
          aria-label={`Open ${thread.subject}`}
        >
          <span
            className="absolute inset-y-3 left-0 w-0.5 rounded-full"
            style={{ backgroundColor: thread.mailbox.color }}
          />
          <span className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
          style={{
            background: `linear-gradient(145deg, ${thread.mailbox.color}55, ${thread.mailbox.color}18)`,
            border: `1px solid ${thread.mailbox.color}55`,
          }}
        >
          {initials(thread.senderName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            {thread.unread ? (
              <span
                className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_9px_rgba(52,211,153,0.65)]"
                title="Unread"
                aria-label="Unread"
              />
            ) : null}
            <span
              className={classNames(
                "min-w-0 flex-1 truncate text-[13px]",
                thread.unread ? "font-semibold text-white" : "text-zinc-300",
              )}
            >
              {thread.direction === "outgoing" ? (
                <>
                  <span className="text-zinc-600">To </span>
                  {thread.senderName}
                </>
              ) : (
                thread.senderName
              )}
            </span>
            <span className="shrink-0 text-[10px] text-zinc-600">
              {formatWhen(thread.receivedAt)}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-300">
              {thread.subject}
            </span>
            {thread.starred ? (
              <Star className="h-3 w-3 shrink-0 fill-amber-300 text-amber-300" />
            ) : null}
          </span>
          <span className="mt-1 line-clamp-2 text-[11px] leading-4 text-zinc-500">
            {thread.snippet || thread.action?.summary}
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            <MailboxBadge mailbox={thread.mailbox} />
            {calendarInvite ? (
              <span
                className={classNames(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
                  calendarInvite.responseStatus === "accepted"
                    ? "border-emerald-400/15 bg-emerald-400/[0.07] text-emerald-300"
                    : calendarInvite.responseStatus === "declined"
                      ? "border-red-400/15 bg-red-400/[0.07] text-red-300"
                      : "border-amber-400/15 bg-amber-400/[0.07] text-amber-300",
                )}
              >
                <CalendarDays className="h-2.5 w-2.5" />
                {calendarRsvpLabel(calendarInvite.responseStatus)}
              </span>
            ) : null}
            {actionStatusLabel ? (
              <span
                className={classNames(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
                  actionState?.phase === "failed"
                    ? "border-red-400/15 bg-red-400/[0.07] text-red-300"
                    : "border-cyan-400/15 bg-cyan-400/[0.07] text-cyan-200",
                )}
                title={actionState?.error}
                aria-live="polite"
              >
                {actionBusy ? (
                  <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <CircleAlert className="h-2.5 w-2.5" />
                )}
                {actionStatusLabel}
              </span>
            ) : null}
            {searchMatch?.matchedFields.slice(0, 2).map((field) => (
              <span
                key={field}
                className="rounded-full border border-cyan-300/10 bg-cyan-300/[0.045] px-2 py-0.5 text-[9px] text-cyan-200/70"
              >
                {searchFieldLabel(field)}
              </span>
            ))}
            {thread.direction === "outgoing" ? (
              <OpenStatusBadge status={thread.openStatus} compact />
            ) : thread.draft ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/15 bg-cyan-400/[0.08] px-2 py-0.5 text-[10px] text-cyan-300">
                <Sparkles className="h-2.5 w-2.5" />
                Draft ready
              </span>
            ) : !calendarInvite && lane === "decide" ? (
              <span className="rounded-full border border-amber-400/15 bg-amber-400/[0.07] px-2 py-0.5 text-[10px] text-amber-300">
                Needs you
              </span>
            ) : !calendarInvite && lane === "noise" ? (
              <span className="rounded-full border border-violet-400/15 bg-violet-400/[0.07] px-2 py-0.5 text-[10px] text-violet-300">
                Noise
              </span>
            ) : null}
            {thread.hasAttachments ? (
              <Paperclip className="ml-auto h-3 w-3 text-zinc-600" />
            ) : null}
          </span>
        </span>
          </span>
        </button>
        {showCalendarRsvp ? (
          <div
            className="flex flex-wrap items-center justify-end gap-1.5 px-4 pb-3 md:absolute md:bottom-3 md:right-3 md:rounded-xl md:bg-gradient-to-l md:from-[var(--bg-primary)] md:via-[var(--bg-primary)] md:to-transparent md:py-1 md:pl-8 md:pr-1 md:backdrop-blur-sm"
            aria-live="polite"
          >
            {calendarRsvpState?.phase === "failed" ? (
              <>
                <span
                  className="mr-1 inline-flex items-center gap-1 text-[10px] text-red-300"
                  title={calendarRsvpState.error}
                >
                  <CircleAlert className="h-3 w-3" />
                  {calendarRsvpFailureLabel}
                </span>
                {calendarAccountMissing ? (
                  <a
                    href="/settings/integrations"
                    onClick={(event) => event.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-lg border border-cyan-300/20 bg-cyan-300/[0.08] px-2 py-1.5 text-[10px] font-medium text-cyan-200 transition hover:bg-cyan-300/[0.14]"
                  >
                    <CalendarDays className="h-3 w-3" />
                    Connect Calendar
                  </a>
                ) : null}
                {calendarRsvpState.openInGmailUrl ? (
                  <a
                    href={calendarRsvpState.openInGmailUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[10px] font-medium text-zinc-300 transition hover:bg-white/[0.08]"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Open in Gmail
                  </a>
                ) : null}
              </>
            ) : null}
            {(
              [
                {
                  status: "accepted",
                  label: "Accept",
                  className:
                    "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-200 hover:bg-emerald-300/[0.14]",
                },
                {
                  status: "tentative",
                  label: "Maybe",
                  className:
                    "border-amber-300/20 bg-amber-300/[0.08] text-amber-200 hover:bg-amber-300/[0.14]",
                },
                {
                  status: "declined",
                  label: "Decline",
                  className:
                    "border-red-300/20 bg-red-300/[0.07] text-red-200 hover:bg-red-300/[0.13]",
                },
              ] as const
            ).map((option) => {
              const processing =
                calendarRsvpBusy &&
                calendarRsvpState?.responseStatus === option.status;
              const retrying =
                processing && calendarRsvpState?.phase === "retrying";
              return (
                <button
                  key={option.status}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCalendarRsvp(thread, option.status);
                  }}
                  disabled={rowBusy || calendarAccountMissing}
                  className={classNames(
                    "inline-flex min-w-[58px] items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[10px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
                    option.className,
                  )}
                  title={
                    calendarAccountMissing
                      ? "Connect the Calendar account that received this invitation first"
                      : `${option.label} this calendar invitation`
                  }
                >
                  {processing ? (
                    <LoaderCircle className="h-3 w-3 animate-spin" />
                  ) : null}
                  {processing
                    ? retrying
                      ? "Retrying…"
                      : "Saving…"
                    : option.label}
                </button>
              );
            })}
          </div>
        ) : showNeedsReviewRouting ? (
          <>
            <div className="flex items-center justify-end gap-1.5 px-4 pb-3 md:absolute md:bottom-3 md:right-3 md:rounded-xl md:bg-gradient-to-l md:from-[var(--bg-primary)] md:via-[var(--bg-primary)] md:to-transparent md:py-1 md:pl-8 md:pr-1 md:opacity-0 md:backdrop-blur-sm md:transition md:group-hover:opacity-100 md:group-focus-within:opacity-100">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAction(thread, "move_focus");
                }}
                disabled={actionBusy}
                className="inline-flex items-center gap-1 rounded-lg border border-cyan-300/15 bg-cyan-300/[0.07] px-2 py-1.5 text-[10px] font-medium text-cyan-200 transition hover:bg-cyan-300/[0.12] disabled:opacity-40"
                title="Move to Focus"
                aria-label="Move to Focus"
              >
                <Zap className="h-3 w-3" />
                Focus
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAction(thread, "move_noise");
                }}
                disabled={actionBusy}
                className="inline-flex items-center gap-1 rounded-lg border border-violet-300/15 bg-violet-300/[0.07] px-2 py-1.5 text-[10px] font-medium text-violet-200 transition hover:bg-violet-300/[0.12] disabled:opacity-40"
                title="Move to Noise"
                aria-label="Move to Noise"
              >
                <ShieldCheck className="h-3 w-3" />
                Noise
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAction(thread, "move_handled");
                }}
                disabled={actionBusy}
                className="inline-flex items-center gap-1 rounded-lg border border-emerald-300/15 bg-emerald-300/[0.07] px-2 py-1.5 text-[10px] font-medium text-emerald-200 transition hover:bg-emerald-300/[0.12] disabled:opacity-40"
                title="Mark Done"
                aria-label="Mark Done"
              >
                {actionBusy ? (
                  <LoaderCircle className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                {doneRetry ? "Retry Done" : "Done"}
              </button>
            </div>
          </>
        ) : canMarkDone ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onAction(thread, "move_handled");
            }}
            disabled={actionBusy}
            className="absolute bottom-3 right-3 hidden items-center gap-1.5 rounded-lg border border-emerald-300/15 bg-[var(--bg-primary)]/95 px-2.5 py-1.5 text-[10px] font-medium text-emerald-200 opacity-0 shadow-[-14px_0_20px_var(--bg-primary)] backdrop-blur-sm transition hover:bg-emerald-300/[0.12] focus-visible:opacity-100 disabled:opacity-40 group-hover:opacity-100 md:inline-flex"
            title={
              thread.draft
                ? "Move to Handled and keep the draft attached"
                : "Mark this email Done"
            }
          >
            {actionBusy ? (
              <LoaderCircle className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {doneRetry ? "Retry Done" : "Done"}
          </button>
        ) : null}
        {actionBusy &&
        !canMarkDone &&
        !showNeedsReviewRouting &&
        !showCalendarRsvp ? (
          <span className="pointer-events-none absolute bottom-4 right-4 text-zinc-500">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          </span>
        ) : null}
      </motion.div>
      <span className="sr-only" aria-live="polite">
        {swipeStage === "idle"
          ? ""
          : `${releaseReady ? "Release" : "Keep swiping"} to ${revealed.description}`}
      </span>
    </div>
  );
});

function ShortcutsOverlay({ onClose }: { onClose(): void }) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 bg-[#111216] shadow-2xl shadow-black/60">
        <div className="flex items-center gap-3 border-b border-white/[0.07] px-5 py-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-400/[0.08] text-cyan-300">
            <Keyboard className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold text-white">Move at thought speed</p>
            <p className="text-xs text-zinc-500">Shortcuts work when you are not typing.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white"
            aria-label="Close shortcuts"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid gap-x-8 gap-y-1 p-4 sm:grid-cols-2">
          {SHORTCUTS.map(([key, description]) => (
            <div
              key={key}
              className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 hover:bg-white/[0.035]"
            >
              <span className="text-xs text-zinc-400">{description}</span>
              <kbd className="shrink-0 rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-[10px] text-zinc-300">
                {key}
              </kbd>
            </div>
          ))}
        </div>
        <div className="border-t border-white/[0.07] px-5 py-4 md:hidden">
          <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-600">
            Touch gestures
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-emerald-300/10 bg-emerald-300/[0.045] p-3">
              <p className="text-[10px] font-medium text-emerald-200">
                Swipe right
              </p>
              <p className="mt-1 text-[9px] leading-4 text-zinc-600">
                Done, or recover it to Focus or Needs Review.
              </p>
            </div>
            <div className="rounded-xl border border-violet-300/10 bg-violet-300/[0.045] p-3">
              <p className="text-[10px] font-medium text-violet-200">
                Swipe left
              </p>
              <p className="mt-1 text-[9px] leading-4 text-zinc-600">
                Move to Noise, or finish from Noise.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MailboxSettings({
  mailboxes,
  onClose,
  onSaved,
}: {
  mailboxes: EmailMailbox[];
  onClose(): void;
  onSaved(mailboxes: EmailMailbox[]): void;
}) {
  const [drafts, setDrafts] = useState(mailboxes);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const palette = [
    "#22d3ee",
    "#a78bfa",
    "#34d399",
    "#f59e0b",
    "#fb7185",
    "#60a5fa",
    "#c084fc",
    "#2dd4bf",
  ];
  const save = async (mailbox: EmailMailbox) => {
    setBusy(mailbox.connectionId);
    setError(null);
    try {
      const payload = await jsonRequest<{
        ok: true;
        mailboxes: EmailMailbox[];
      }>("/api/email/mailboxes", {
        method: "PATCH",
        body: JSON.stringify(mailbox),
      });
      setDrafts(payload.mailboxes);
      onSaved(payload.mailboxes);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-2xl border border-white/10 bg-[#111216] shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center border-b border-white/[0.07] bg-[#111216]/95 px-5 py-4 backdrop-blur">
          <div>
            <p className="text-sm font-semibold text-white">Mailbox identities</p>
            <p className="text-xs text-zinc-500">
              One workspace, visually distinct accounts.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white"
            aria-label="Close mailbox settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          {drafts.map((mailbox, mailboxIndex) => (
            <div
              key={mailbox.connectionId}
              className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4"
            >
              <div className="flex items-center gap-3">
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-xl text-xs font-semibold"
                  style={{
                    color: mailbox.color,
                    backgroundColor: `${mailbox.color}16`,
                    border: `1px solid ${mailbox.color}40`,
                  }}
                >
                  {mailbox.monogram}
                </span>
                <div className="min-w-0 flex-1">
                  <input
                    value={mailbox.displayName}
                    onChange={(event) =>
                      setDrafts((current) =>
                        current.map((item, index) =>
                          index === mailboxIndex
                            ? { ...item, displayName: event.target.value }
                            : item,
                        ),
                      )
                    }
                    className="w-full bg-transparent text-sm font-medium text-white outline-none"
                    aria-label="Mailbox name"
                  />
                  <p className="truncate text-xs text-zinc-500">{mailbox.address}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void save(mailbox)}
                  disabled={busy === mailbox.connectionId}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.05] disabled:opacity-50"
                >
                  {busy === mailbox.connectionId ? "Saving…" : "Save"}
                </button>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {palette.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() =>
                      setDrafts((current) =>
                        current.map((item, index) =>
                          index === mailboxIndex ? { ...item, color } : item,
                        ),
                      )
                    }
                    className={classNames(
                      "flex h-7 w-7 items-center justify-center rounded-full transition",
                      mailbox.color === color
                        ? "ring-2 ring-white/70 ring-offset-2 ring-offset-[#111216]"
                        : "opacity-70 hover:opacity-100",
                    )}
                    style={{ backgroundColor: color }}
                    aria-label={`Use ${color}`}
                  >
                    {mailbox.color === color ? (
                      <Check className="h-3.5 w-3.5 text-black/70" />
                    ) : null}
                  </button>
                ))}
                <label className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={mailbox.includedInUnified}
                    onChange={(event) =>
                      setDrafts((current) =>
                        current.map((item, index) =>
                          index === mailboxIndex
                            ? {
                                ...item,
                                includedInUnified: event.target.checked,
                              }
                            : item,
                        ),
                      )
                    }
                    className="accent-cyan-400"
                  />
                  Include in unified view
                </label>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  <input
                    type="radio"
                    name="default-sender"
                    checked={mailbox.isDefaultSender}
                    onChange={() =>
                      setDrafts((current) =>
                        current.map((item, index) => ({
                          ...item,
                          isDefaultSender: index === mailboxIndex,
                        })),
                      )
                    }
                    className="accent-cyan-400"
                  />
                  Default sender
                </label>
                {mailbox.status !== "connected" ? (
                  <span className="ml-auto text-[10px] text-amber-300">
                    {mailbox.status === "reauth_required"
                      ? "Reconnect required"
                      : "Connection issue"}
                  </span>
                ) : null}
              </div>
              <textarea
                value={mailbox.aiInstructions}
                onChange={(event) =>
                  setDrafts((current) =>
                    current.map((item, index) =>
                      index === mailboxIndex
                        ? { ...item, aiInstructions: event.target.value }
                        : item,
                    ),
                  )
                }
                placeholder="Optional: how AI should sound from this account…"
                className="mt-3 min-h-16 w-full resize-none rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2 text-xs text-zinc-300 outline-none placeholder:text-zinc-600 focus:border-cyan-400/30"
              />
            </div>
          ))}
          <div className="flex items-start gap-2.5 rounded-xl border border-emerald-300/10 bg-emerald-300/[0.035] p-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300/70" />
            <div>
              <p className="text-xs font-medium text-zinc-300">
                Your mailbox is private by default
              </p>
              <p className="mt-1 text-[10px] leading-4 text-zinc-600">
                Only your signed-in account can open these messages and drafts.
                Adding someone to a workspace does not share your email.
              </p>
            </div>
          </div>
          {error ? <p className="text-xs text-red-300">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}

function SnippetEditor({
  snippet,
  mailboxes,
  onSaved,
  onDeleted,
}: {
  snippet: EmailSnippet | null;
  mailboxes: EmailMailbox[];
  onSaved(snippet: EmailSnippet): void;
  onDeleted(id: string): void;
}) {
  const [form, setForm] = useState(() => ({
    id: snippet?.id || "",
    name: snippet?.name || "",
    shortcut: snippet?.shortcut || "",
    mailboxConnectionIds: snippet?.mailboxConnectionIds || [],
    to: snippet?.to.join(", ") || "",
    cc: snippet?.cc.join(", ") || "",
    bcc: snippet?.bcc.join(", ") || "",
    subject: snippet?.subject || "",
    body: snippet?.body || "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setForm({
      id: snippet?.id || "",
      name: snippet?.name || "",
      shortcut: snippet?.shortcut || "",
      mailboxConnectionIds: snippet?.mailboxConnectionIds || [],
      to: snippet?.to.join(", ") || "",
      cc: snippet?.cc.join(", ") || "",
      bcc: snippet?.bcc.join(", ") || "",
      subject: snippet?.subject || "",
      body: snippet?.body || "",
    });
    setError(null);
  }, [snippet]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = await jsonRequest<{ ok: true; snippet: EmailSnippet }>(
        "/api/email/snippets",
        {
          method: form.id ? "PATCH" : "POST",
          body: JSON.stringify(form),
        },
      );
      onSaved(payload.snippet);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!form.id) return;
    setBusy(true);
    try {
      await jsonRequest(`/api/email/snippets?id=${encodeURIComponent(form.id)}`, {
        method: "DELETE",
      });
      onDeleted(form.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-white/[0.07] px-6 py-5">
        <div className="flex items-center gap-3">
          <div>
            <p className="text-base font-semibold text-white">
              {form.id ? "Edit snippet" : "New snippet"}
            </p>
            <p className="text-xs text-zinc-500">
              Tokens: {"{{first_name}}"}, {"{{company}}"}, {"{{today}}"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !form.name.trim()}
            className="ml-auto rounded-xl bg-white px-4 py-2 text-xs font-semibold text-black hover:bg-zinc-200 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save snippet"}
          </button>
          {form.id ? (
            <button
              type="button"
              onClick={() => void remove()}
              className="rounded-xl p-2 text-zinc-500 hover:bg-red-400/[0.08] hover:text-red-300"
              aria-label="Delete snippet"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
            <label className="space-y-1.5 text-xs text-zinc-500">
              Name
              <input
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="Intro after a demo"
                className="h-10 w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 text-sm text-white outline-none focus:border-cyan-400/30"
              />
            </label>
            <label className="space-y-1.5 text-xs text-zinc-500">
              Shortcut
              <span className="flex h-10 items-center rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 text-sm">
                <span className="text-zinc-600">/</span>
                <input
                  value={form.shortcut}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      shortcut: event.target.value.replace(/^\//, ""),
                    }))
                  }
                  placeholder="demo"
                  className="min-w-0 flex-1 bg-transparent text-white outline-none"
                />
              </span>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {mailboxes.map((mailbox) => {
              const active =
                form.mailboxConnectionIds.length === 0 ||
                form.mailboxConnectionIds.includes(mailbox.connectionId);
              return (
                <button
                  key={mailbox.connectionId}
                  type="button"
                  onClick={() =>
                    setForm((current) => {
                      const existing = current.mailboxConnectionIds;
                      const normalized =
                        existing.length === 0
                          ? mailboxes.map((item) => item.connectionId)
                          : existing;
                      const next = normalized.includes(mailbox.connectionId)
                        ? normalized.filter((id) => id !== mailbox.connectionId)
                        : [...normalized, mailbox.connectionId];
                      return {
                        ...current,
                        mailboxConnectionIds:
                          next.length === mailboxes.length ? [] : next,
                      };
                    })
                  }
                  className={classNames(
                    "rounded-full border px-2.5 py-1 text-[10px] transition",
                    active
                      ? "border-white/15 bg-white/[0.06] text-zinc-200"
                      : "border-white/[0.06] text-zinc-600",
                  )}
                >
                  <span
                    className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: mailbox.color }}
                  />
                  {mailbox.displayName}
                </button>
              );
            })}
          </div>
          {(["to", "cc", "bcc"] as const).map((field) => (
            <label
              key={field}
              className="grid grid-cols-[52px_1fr] items-center border-b border-white/[0.07] py-2 text-xs"
            >
              <span className="uppercase text-zinc-600">{field}</span>
              <input
                value={form[field]}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    [field]: event.target.value,
                  }))
                }
                placeholder={
                  field === "to"
                    ? "Optional recipients"
                    : `Optional ${field.toUpperCase()}`
                }
                className="bg-transparent text-zinc-300 outline-none placeholder:text-zinc-700"
              />
            </label>
          ))}
          <input
            value={form.subject}
            onChange={(event) =>
              setForm((current) => ({ ...current, subject: event.target.value }))
            }
            placeholder="Subject"
            className="h-11 w-full border-b border-white/[0.07] bg-transparent text-sm font-medium text-white outline-none placeholder:text-zinc-600"
          />
          <textarea
            value={form.body}
            onChange={(event) =>
              setForm((current) => ({ ...current, body: event.target.value }))
            }
            placeholder="Write the reusable message…"
            className="min-h-72 w-full resize-none bg-transparent text-sm leading-7 text-zinc-300 outline-none placeholder:text-zinc-600"
          />
          {error ? <p className="text-xs text-red-300">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}

type RecipientSuggestion = EmailContactSuggestion & {
  source: "recent" | "mailbox";
};

function RecipientField({
  field,
  value,
  disabled,
  mailboxes,
  contactThreads,
  excludeEmails = [],
  primary = false,
  trailing,
  onChange,
}: {
  field: "to" | "cc" | "bcc";
  value: string;
  disabled: boolean;
  mailboxes: EmailMailbox[];
  contactThreads: EmailThreadSummary[];
  excludeEmails?: readonly string[];
  primary?: boolean;
  trailing?: ReactNode;
  onChange(value: string): void;
}) {
  const emailCacheScope = useEmailCacheScope();
  const inputRef = useRef<HTMLInputElement>(null);
  const remoteRequestRef = useRef(0);
  const blurTimerRef = useRef<number | null>(null);
  const [query, setQuery] = useState("");
  const [remoteSuggestions, setRemoteSuggestions] = useState<
    EmailContactSuggestion[]
  >([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [entryError, setEntryError] = useState<string | null>(null);
  const mailboxAddressKey = useMemo(
    () =>
      emailRecipientMailboxAddressKey(
        mailboxes.map((mailbox) => mailbox.address),
      ),
    [mailboxes],
  );
  const mailboxAddresses = useMemo(
    () => (mailboxAddressKey ? mailboxAddressKey.split("|") : []),
    [mailboxAddressKey],
  );
  const committed = useMemo(() => recipientAddresses(value), [value]);
  const excluded = useMemo(
    () => [
      ...mailboxAddresses,
      ...excludeEmails,
      ...committed,
    ],
    [committed, excludeEmails, mailboxAddresses],
  );
  const localSuggestions = useMemo(
    () =>
      suggestEmailContacts(query, contactThreads, {
        excludeEmails: excluded,
        limit: 8,
      }).map(
        (suggestion): RecipientSuggestion => ({
          ...suggestion,
          lastContactAt: suggestion.receivedAt,
          mailboxAddress: "",
          mailboxDisplayName: "",
          source: "recent",
        }),
      ),
    [contactThreads, excluded, query],
  );

  useEffect(() => {
    const normalized = normalizeEmailSearchQuery(query);
    const requestId = remoteRequestRef.current + 1;
    remoteRequestRef.current = requestId;
    if (normalized.length < 2) return;
    const cacheKey = emailRecipientSuggestionCacheKey({
      scope: emailCacheScope,
      mailboxAddresses,
      query: normalized,
    });
    const cached = cachedRecipientSuggestions(cacheKey);
    if (cached) {
      const cachedTimer = window.setTimeout(() => {
        if (remoteRequestRef.current !== requestId) return;
        setRemoteSuggestions(cached);
        setLoading(false);
      }, 0);
      return () => window.clearTimeout(cachedTimer);
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (remoteRequestRef.current !== requestId) return;
      setLoading(true);
      const params = new URLSearchParams({
        query: normalized,
        limit: "10",
      });
      for (const address of mailboxAddresses) {
        params.append("ownedAddress", address);
      }
      void jsonRequest<{
        ok: true;
        query: string;
        suggestions: EmailContactSuggestion[];
      }>(`/api/email/contacts?${params.toString()}`, {
        signal: controller.signal,
      })
        .then((payload) => {
          if (
            controller.signal.aborted ||
            remoteRequestRef.current !== requestId ||
            normalizeEmailSearchQuery(payload.query) !== normalized
          ) {
            return;
          }
          cacheRecipientSuggestions(cacheKey, payload.suggestions);
          setRemoteSuggestions(payload.suggestions);
        })
        .catch((reason) => {
          if (
            controller.signal.aborted ||
            (reason instanceof Error && reason.name === "AbortError") ||
            remoteRequestRef.current !== requestId
          ) return;
          // Keep matching local/cached results visible on a transient failure.
        })
        .finally(() => {
          if (
            !controller.signal.aborted &&
            remoteRequestRef.current === requestId
          ) {
            setLoading(false);
          }
        });
    }, EMAIL_RECIPIENT_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [emailCacheScope, mailboxAddresses, query]);

  useEffect(
    () => () => {
      if (blurTimerRef.current !== null) {
        window.clearTimeout(blurTimerRef.current);
      }
    },
    [],
  );

  const visibleRemoteSuggestions = useMemo(
    () =>
      filterEmailContactSuggestions(query, remoteSuggestions, {
        excludeEmails: excluded,
        limit: 10,
      }),
    [excluded, query, remoteSuggestions],
  );

  const suggestions = useMemo(() => {
    const excludedSet = new Set(excluded.map((email) => email.toLowerCase()));
    const merged = new Map<string, RecipientSuggestion>();
    for (const suggestion of localSuggestions) {
      merged.set(suggestion.email.toLowerCase(), suggestion);
    }
    for (const suggestion of visibleRemoteSuggestions) {
      const email = suggestion.email.toLowerCase();
      if (excludedSet.has(email)) continue;
      merged.set(email, { ...suggestion, source: "mailbox" });
    }
    return [...merged.values()].slice(0, 10);
  }, [excluded, localSuggestions, visibleRemoteSuggestions]);

  const setTypedQuery = useCallback((next: string) => {
    setQuery(next);
    setLoading(false);
    setSelectedIndex(0);
    setEntryError(null);
    setOpen(true);
  }, []);

  const commit = useCallback(
    (raw: string) => {
      const email = recipientAddress(raw);
      if (!email) {
        if (raw.trim()) setEntryError("Enter a complete email address.");
        return false;
      }
      onChange(appendRecipientAddresses(value, [email]));
      setTypedQuery("");
      setOpen(true);
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return true;
    },
    [onChange, setTypedQuery, value],
  );

  const listId = `email-${field}-recipient-suggestions`;
  const activeIndex =
    suggestions.length === 0
      ? 0
      : Math.min(selectedIndex, suggestions.length - 1);

  return (
    <div className="relative border-b border-white/[0.06] py-2 text-xs">
      <div className="flex min-w-0 items-start gap-3">
        <span className="w-7 shrink-0 pt-1.5 text-zinc-600">
          {field === "to" ? "To" : field === "cc" ? "Cc" : "Bcc"}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {committed.map((email) => (
            <span
              key={email}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-cyan-300/15 bg-cyan-300/[0.07] py-1 pl-2.5 pr-1 text-[11px] text-cyan-100"
            >
              <span className="max-w-52 truncate">{email}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(removeRecipientAddress(value, email))}
                className="rounded-full p-0.5 text-cyan-200/50 transition hover:bg-white/10 hover:text-cyan-100"
                aria-label={`Remove ${email}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            data-email-recipient-field
            {...(primary ? { "data-email-recipient-input": true } : {})}
            value={query}
            onFocus={() => {
              if (blurTimerRef.current !== null) {
                window.clearTimeout(blurTimerRef.current);
                blurTimerRef.current = null;
              }
              setOpen(true);
            }}
            onBlur={() => {
              if (blurTimerRef.current !== null) {
                window.clearTimeout(blurTimerRef.current);
              }
              blurTimerRef.current = window.setTimeout(() => {
                setOpen(false);
                blurTimerRef.current = null;
              }, 160);
            }}
            onChange={(event) => {
              const next = event.target.value;
              const delimiter = Math.max(
                next.lastIndexOf(","),
                next.lastIndexOf(";"),
              );
              if (delimiter >= 0) {
                const additions = recipientAddresses(
                  next.slice(0, delimiter + 1),
                );
                if (additions.length > 0) {
                  onChange(appendRecipientAddresses(value, additions));
                  setTypedQuery(next.slice(delimiter + 1).trimStart());
                  return;
                }
              }
              setTypedQuery(next);
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              const additions = recipientAddresses(pasted);
              if (
                additions.length > 0 &&
                (additions.length > 1 || /[,;]/.test(pasted))
              ) {
                event.preventDefault();
                onChange(appendRecipientAddresses(value, additions));
                setTypedQuery("");
              }
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                query.trim()
              ) {
                event.preventDefault();
                event.stopPropagation();
                commit(query);
                return;
              }
              if (event.key === "ArrowDown" && suggestions.length > 0) {
                event.preventDefault();
                setOpen(true);
                setSelectedIndex(
                  (activeIndex + 1) % suggestions.length,
                );
                return;
              }
              if (event.key === "ArrowUp" && suggestions.length > 0) {
                event.preventDefault();
                setOpen(true);
                setSelectedIndex(
                  (activeIndex - 1 + suggestions.length) %
                    suggestions.length,
                );
                return;
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setOpen(false);
                return;
              }
              if (
                (event.key === "Enter" ||
                  (event.key === "Tab" && query.trim())) &&
                !event.metaKey &&
                !event.ctrlKey
              ) {
                event.preventDefault();
                event.stopPropagation();
                const suggestion =
                  open && suggestions.length > 0
                    ? suggestions[activeIndex]
                    : null;
                commit(suggestion?.email || query);
                return;
              }
              if (
                event.key === "Backspace" &&
                !query &&
                committed.length > 0
              ) {
                event.preventDefault();
                onChange(
                  removeRecipientAddress(
                    value,
                    committed[committed.length - 1],
                  ),
                );
              }
            }}
            disabled={disabled}
            className="min-w-40 flex-1 bg-transparent py-1 text-zinc-300 outline-none placeholder:text-zinc-700"
            placeholder={
              committed.length === 0
                ? field === "to"
                  ? "Type a name or email"
                  : "Add recipient"
                : "Add another"
            }
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open && suggestions.length > 0}
            aria-controls={listId}
            aria-activedescendant={
              open && suggestions.length > 0
                ? `${listId}-${activeIndex}`
                : undefined
            }
          />
          {loading ? (
            <LoaderCircle className="h-3 w-3 animate-spin text-zinc-600" />
          ) : null}
        </div>
        {trailing}
      </div>
      {entryError ? (
        <p className="ml-10 mt-1 text-[10px] text-amber-300/80">
          {entryError}
        </p>
      ) : null}
      {open && query.trim() && suggestions.length > 0 ? (
        <div
          id={listId}
          role="listbox"
          className="absolute left-10 right-0 top-full z-40 mt-1 overflow-hidden rounded-xl border border-white/[0.1] bg-[#15171b] p-1 shadow-2xl shadow-black/50"
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.email}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => commit(suggestion.email)}
              className={classNames(
                "flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left transition",
                index === activeIndex
                  ? "bg-cyan-300/[0.08] text-white"
                  : "text-zinc-300 hover:bg-white/[0.05]",
              )}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.05] text-[9px] font-semibold text-zinc-500">
                {initials(suggestion.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium">
                  {suggestion.name}
                </span>
                <span className="block truncate text-[10px] text-zinc-600">
                  {suggestion.email}
                </span>
              </span>
              <span className="shrink-0 text-[9px] text-zinc-700">
                {suggestion.source === "mailbox"
                  ? suggestion.mailboxDisplayName || "Mail history"
                  : "Recent"}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function escapeComposerHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function serializeRichComposerBody(
  root: HTMLElement,
  attachments: EmailDraftAttachment[],
): {
  body: string;
  bodyHtml: string;
  inlineAttachmentIds: string[];
} {
  const byId = new Map(
    attachments.map((attachment) => [attachment.id, attachment]),
  );
  const inlineAttachmentIds = new Set<string>();
  const visit = (
    node: Node,
  ): { text: string; html: string; block: boolean } => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent || "";
      return { text: value, html: escapeComposerHtml(value), block: false };
    }
    if (!(node instanceof HTMLElement)) {
      return { text: "", html: "", block: false };
    }
    if (node.tagName === "IMG") {
      const attachment = byId.get(node.dataset.emailInlineId || "");
      if (!attachment?.contentId) {
        return { text: "", html: "", block: false };
      }
      inlineAttachmentIds.add(attachment.id);
      return {
        text: `[Inline image: ${attachment.filename}]`,
        html:
          `<img src="cid:${escapeComposerHtml(attachment.contentId)}" ` +
          `alt="${escapeComposerHtml(attachment.filename)}" ` +
          'style="display:block;max-width:100%;height:auto;margin:10px 0">',
        block: false,
      };
    }
    if (node.tagName === "BR") {
      return { text: "\n", html: "<br>", block: false };
    }
    if (node.dataset.emailUploadAnchor) {
      return { text: "", html: "", block: false };
    }
    const children = Array.from(node.childNodes).map(visit);
    let textValue = "";
    let htmlValue = "";
    for (const child of children) {
      if (
        child.block &&
        textValue &&
        !textValue.endsWith("\n") &&
        !child.text.startsWith("\n")
      ) {
        textValue += "\n";
      }
      textValue += child.text;
      htmlValue += child.html;
      if (child.block && textValue && !textValue.endsWith("\n")) {
        textValue += "\n";
      }
    }
    const block =
      node !== root && (node.tagName === "DIV" || node.tagName === "P");
    if (block) {
      const tag = node.tagName.toLowerCase();
      htmlValue = `<${tag}>${htmlValue}</${tag}>`;
    }
    return { text: textValue, html: htmlValue, block };
  };
  const result = visit(root);
  return {
    body: result.text.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n"),
    bodyHtml: result.html,
    inlineAttachmentIds: Array.from(inlineAttachmentIds),
  };
}

function hydrateRichComposerHtml(args: {
  bodyHtml: string;
  attachments: EmailDraftAttachment[];
  previewUrls: Record<string, string>;
}): string {
  if (typeof document === "undefined") return args.bodyHtml;
  const template = document.createElement("template");
  template.innerHTML = args.bodyHtml;
  const byContentId = new Map(
    args.attachments
      .filter((attachment) => attachment.contentId)
      .map((attachment) => [attachment.contentId, attachment]),
  );
  for (const image of Array.from(
    template.content.querySelectorAll<HTMLImageElement>('img[src^="cid:"]'),
  )) {
    const contentId = image.getAttribute("src")?.slice(4) || "";
    const attachment = byContentId.get(contentId);
    if (!attachment) {
      image.remove();
      continue;
    }
    image.dataset.emailInlineId = attachment.id;
    image.src = args.previewUrls[attachment.id] || "";
    image.alt = attachment.filename;
    image.className =
      "my-2 block max-h-[28rem] max-w-full rounded-lg border border-white/10 object-contain";
  }
  return template.innerHTML;
}

function Composer({
  value,
  mailboxes,
  snippets,
  contactThreads,
  threadContext,
  snippetVariables,
  onChange,
  onSaved,
  onSent,
  onDiscarded,
  onEnableRecipientTracking,
}: {
  value: ComposerState;
  mailboxes: EmailMailbox[];
  snippets: EmailSnippet[];
  contactThreads: EmailThreadSummary[];
  threadContext: string;
  snippetVariables?: Record<string, string>;
  onChange(value: ComposerState): void;
  onSaved(value: ComposerState): void;
  onSent(
    sentThread: EmailThreadSummary | null,
    outcome: { actionHandled: boolean; warning: string | null },
  ): void;
  onDiscarded(): void;
  onEnableRecipientTracking(mailbox: EmailMailbox): Promise<boolean>;
}) {
  const emailCacheScope = useEmailCacheScope();
  const composerRootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const richBodyRef = useRef<HTMLDivElement>(null);
  const ghostContentRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const inlineImageInputRef = useRef<HTMLInputElement>(null);
  const uploadSessionIdRef = useRef(crypto.randomUUID());
  const lastRichBodyHtmlRef = useRef("");
  const focusAfterInlineIdRef = useRef<string | null>(null);
  const pendingInlineBodyOffsetRef = useRef<number | null>(null);
  const pendingInlineRangeRef = useRef<Range | null>(null);
  const [showDetails, setShowDetails] = useState(
    Boolean(value.cc || value.bcc),
  );
  const [ghost, setGhost] = useState("");
  const [completionStatus, setCompletionStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [bodyFocused, setBodyFocused] = useState(false);
  const [steerOpen, setSteerOpen] = useState(false);
  const [steer, setSteer] = useState("");
  const [busy, setBusy] = useState<
    "saving" | "sending" | "discarding" | "uploading" | "ai" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [trackingPermissionOpen, setTrackingPermissionOpen] =
    useState(false);
  const [trackingPermissionBusy, setTrackingPermissionBusy] =
    useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const previewUrlsRef = useRef(previewUrls);
  const completionVersion = useRef(0);
  const completionAbort = useRef<AbortController | null>(null);
  const lastSavedFingerprint = useRef("");
  const saveInFlightRef = useRef<Promise<ComposerState | null> | null>(null);
  const sendRequestIdRef = useRef<string | null>(null);
  const skipUnmountSaveRef = useRef(false);
  const onSentRef = useRef(onSent);
  const latestValue = useRef(value);
  const sending = useRef(false);
  const lastComposerShortcutRef = useRef<{
    shortcut: DesktopNativeComposerShortcut;
    at: number;
  } | null>(null);
  const mounted = useRef(true);
  latestValue.current = value;
  onSentRef.current = onSent;
  previewUrlsRef.current = previewUrls;

  useEffect(() => {
    mounted.current = true;
    const finishSend = (completion: CompletedEmailSend) => {
      if (sendRequestIdRef.current !== completion.requestId) return;
      sendRequestIdRef.current = null;
      sending.current = false;
      setSendStatus(null);
      setBusy(null);
      setConfirmOpen(false);
      skipUnmountSaveRef.current = true;
      onSentRef.current(completion.result.sentThread || null, {
        actionHandled: completion.result.actionHandled !== false,
        warning: completion.result.warning?.trim() || null,
      });
    };
    const onSendCompleted = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      finishSend(event.detail as CompletedEmailSend);
    };
    const onSendFailed = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const failure = event.detail as FailedEmailSend;
      if (sendRequestIdRef.current !== failure.requestId) return;
      if (failure.retrying) {
        sending.current = true;
        setBusy("sending");
        setError(null);
        setSendStatus("Queued · sending safely in the background…");
        return;
      }
      sendRequestIdRef.current = null;
      sending.current = false;
      setBusy(null);
      setSendStatus(null);
      setError(failure.error);
    };
    window.addEventListener(EMAIL_SEND_COMPLETED_EVENT, onSendCompleted);
    window.addEventListener(EMAIL_SEND_FAILED_EVENT, onSendFailed);
    try {
      const currentDraft = latestValue.current;
      const pending = readPendingEmailSends(
        window.localStorage,
        emailCacheScope,
      ).find(
        (candidate) =>
          candidate.connectionId === currentDraft.connectionId &&
          candidate.draftId === currentDraft.draftId,
      );
      if (pending) {
        sendRequestIdRef.current = pending.requestId;
        sending.current = true;
        setBusy("sending");
        setSendStatus("Queued · sending safely in the background…");
      }
      const pendingRequestId = sendRequestIdRef.current;
      const completion = pendingRequestId
        ? recentCompletedEmailSends(emailCacheScope).find(
            (candidate) => candidate.requestId === pendingRequestId,
          )
        : null;
      if (completion) {
        finishSend(completion);
      } else if (pendingRequestId && !pending) {
        const failure = recentFailedEmailSends(emailCacheScope).find(
          (candidate) => candidate.requestId === pendingRequestId,
        );
        if (failure) {
          onSendFailed(new CustomEvent(EMAIL_SEND_FAILED_EVENT, {
            detail: failure,
          }));
        }
      }
    } catch {
      // Live events still settle the composer when storage is blocked.
    }
    return () => {
      mounted.current = false;
      window.removeEventListener(
        EMAIL_SEND_COMPLETED_EVENT,
        onSendCompleted,
      );
      window.removeEventListener(EMAIL_SEND_FAILED_EVENT, onSendFailed);
      for (const url of Object.values(previewUrlsRef.current)) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      }
    };
  }, [emailCacheScope]);

  useEffect(() => {
    const missing = value.attachments.filter(
      (attachment) =>
        attachment.disposition === "inline" &&
        !previewUrlsRef.current[attachment.id],
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (attachment) => {
        const signed = await getSupabaseBrowserClient().storage
          .from(EMAIL_DRAFT_ATTACHMENT_BUCKET)
          .createSignedUrl(attachment.storagePath, 60 * 60);
        return [
          attachment.id,
          signed.data?.signedUrl || "",
        ] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setPreviewUrls((current) => ({
        ...current,
        ...Object.fromEntries(entries.filter((entry) => entry[1])),
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [value.attachments]);

  useLayoutEffect(() => {
    const root = richBodyRef.current;
    if (!root || value.bodyHtml === null) return;
    if (lastRichBodyHtmlRef.current !== value.bodyHtml) {
      root.innerHTML = hydrateRichComposerHtml({
        bodyHtml: value.bodyHtml,
        attachments: value.attachments,
        previewUrls,
      });
      lastRichBodyHtmlRef.current = value.bodyHtml;
    } else {
      for (const image of Array.from(
        root.querySelectorAll<HTMLImageElement>("img[data-email-inline-id]"),
      )) {
        const url = previewUrls[image.dataset.emailInlineId || ""];
        if (url && image.src !== url) image.src = url;
      }
    }
    const focusAfterId = focusAfterInlineIdRef.current;
    if (focusAfterId) {
      const image = root.querySelector<HTMLImageElement>(
        `img[data-email-inline-id="${focusAfterId}"]`,
      );
      if (image) {
        const range = document.createRange();
        range.setStartAfter(image.nextSibling || image);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        root.focus();
        focusAfterInlineIdRef.current = null;
      }
    }
  }, [previewUrls, value.attachments, value.bodyHtml]);

  useEffect(() => {
    setShowDetails(Boolean(value.cc || value.bcc));
  }, [value.bcc, value.cc]);

  useEffect(() => {
    setGhost("");
    setCompletionStatus("idle");
    window.requestAnimationFrame(() => {
      if (bodyRef.current) {
        bodyRef.current.scrollTop = 0;
        bodyRef.current.scrollLeft = 0;
      }
      if (ghostContentRef.current) {
        ghostContentRef.current.style.transform = "translate(0px, 0px)";
      }
    });
  }, [value.sourceMessageId, value.threadId]);

  const fingerprint = useCallback(
    (draft: ComposerState) =>
      JSON.stringify([
        draft.connectionId,
        draft.to,
        draft.cc,
        draft.bcc,
        draft.subject,
        draft.body,
        draft.bodyHtml,
        draft.attachments,
      ]),
    [],
  );

  useEffect(() => {
    lastSavedFingerprint.current = latestValue.current.gmailSyncPending
      ? ""
      : fingerprint(latestValue.current);
    // Treat a newly opened conversation as clean until the user changes it.
  }, [
    fingerprint,
    value.actionId,
    value.localId,
    value.sourceMessageId,
    value.threadId,
  ]);

  useEffect(
    () => () => {
      const draft = latestValue.current;
      if (
        skipUnmountSaveRef.current ||
        saveInFlightRef.current ||
        !draft.connectionId ||
        !emailComposerDraftHasContent(draft) ||
        fingerprint(draft) === lastSavedFingerprint.current
      ) {
        return;
      }
      const requestBody = JSON.stringify(composerDraftRequestPayload(draft));
      void fetch("/api/email/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        keepalive: emailSendCanUseKeepalive(requestBody),
      }).catch(() => undefined);
    },
    [fingerprint],
  );

  const update = useCallback(
    (patch: Partial<ComposerState>) => {
      if (sending.current) return;
      const current = latestValue.current;
      const changesMessage = Object.keys(patch).some((key) =>
        [
          "connectionId",
          "to",
          "cc",
          "bcc",
          "subject",
          "body",
          "bodyHtml",
          "attachments",
        ].includes(key),
      );
      const next = {
        ...current,
        ...patch,
        ...(changesMessage
          ? { untouched: false, gmailSyncPending: true }
          : {}),
      };
      if (changesMessage) sendRequestIdRef.current = null;
      latestValue.current = next;
      onChange(next);
    },
    [onChange],
  );

  const changeSenderMailbox = useCallback(
    async (connectionId: string) => {
      if (
        sending.current ||
        busy ||
        !connectionId ||
        connectionId === latestValue.current.connectionId
      ) {
        return;
      }
      const pendingSave = saveInFlightRef.current;
      if (pendingSave) await pendingSave;

      const current = latestValue.current;
      sendRequestIdRef.current = null;
      setBusy("saving");
      setError(null);
      try {
        const nextBase: ComposerState = {
          ...current,
          connectionId,
          actionId: null,
          draftId: null,
          threadId: null,
          sourceMessageId: null,
          gmailSyncPending: true,
        };
        let next = nextBase;
        let oldDraftCleanupFailed = false;
        if (current.draftId) {
          const payload = await jsonRequest<{
            ok: true;
            draft: EmailDraft;
          }>("/api/email/draft", {
            method: "POST",
            body: JSON.stringify(composerDraftRequestPayload(nextBase)),
          });
          next = {
            ...nextBase,
            actionId: payload.draft.actionId,
            draftId: payload.draft.draftId,
            to: payload.draft.to.join(", "),
            cc: payload.draft.cc.join(", "),
            bcc: payload.draft.bcc.join(", "),
            subject: payload.draft.subject,
            body: stripGroovyAiEmailDisclosure(payload.draft.body),
            bodyHtml: payload.draft.bodyHtml,
            attachments: payload.draft.attachments,
            aiGenerated: payload.draft.aiGenerated,
            untouched: payload.draft.untouched,
            gmailSyncPending: false,
          };
          try {
            await jsonRequest("/api/email/draft", {
              method: "DELETE",
              body: JSON.stringify({
                connectionId: current.connectionId,
                actionId: current.actionId,
                draftId: current.draftId,
                preserveAttachments: true,
              }),
            });
          } catch {
            oldDraftCleanupFailed = true;
          }
        }
        latestValue.current = next;
        lastSavedFingerprint.current = next.draftId ? fingerprint(next) : "";
        if (next.draftId) onSaved(next);
        else onChange(next);
        if (oldDraftCleanupFailed) {
          setError(
            "Sender changed. The previous mailbox may still contain an extra draft.",
          );
        }
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not change the sender mailbox.",
        );
      } finally {
        setBusy((currentBusy) =>
          currentBusy === "saving" ? null : currentBusy,
        );
      }
    },
    [busy, fingerprint, onChange, onSaved],
  );

  const save = useCallback(
    async (forSend = false): Promise<ComposerState | null> => {
      const pending = saveInFlightRef.current;
      if (pending) {
        const existing = await pending;
        if (
          !forSend ||
          fingerprint(latestValue.current) === lastSavedFingerprint.current
        ) {
          return existing;
        }
      }

      const snapshot = latestValue.current;
      if (!snapshot.connectionId) {
        setError("Choose a sender mailbox.");
        return null;
      }
      if (!emailComposerDraftHasContent(snapshot)) {
        setError("Start writing before saving this draft.");
        return null;
      }
      const requestDraft = composerDraftRequestPayload(snapshot);
      if (!forSend) setBusy("saving");
      setError(null);
      const request = (async (): Promise<ComposerState | null> => {
        try {
          let payload: {
            ok: true;
            draft: EmailDraft;
            warning?: string;
          } | null = null;
          await runEmailActionWithRetry({
            execute: async () => {
              const body = JSON.stringify(requestDraft);
              payload = await jsonRequest<{
                ok: true;
                draft: EmailDraft;
                warning?: string;
              }>("/api/email/draft", {
                method: "POST",
                body,
                keepalive: emailSendCanUseKeepalive(body),
              });
            },
            onState: forSend
              ? (state) => {
                  setSendStatus(
                    state.phase === "retrying"
                      ? `Gmail is busy · retrying the draft in ${Math.max(
                          1,
                          Math.ceil((state.delayMs || 0) / 1_000),
                        )}s`
                      : state.attempt > 1
                        ? "Retrying the draft…"
                        : "Saving the draft…",
                  );
                }
              : undefined,
          });
          const savedPayload = payload as {
            ok: true;
            draft: EmailDraft;
            warning?: string;
          } | null;
          if (!savedPayload) {
            throw new Error("Gmail did not return the draft.");
          }
          const saved: ComposerState = {
            ...snapshot,
            actionId: savedPayload.draft.actionId,
            draftId: savedPayload.draft.draftId,
            to: savedPayload.draft.to.join(", "),
            cc: savedPayload.draft.cc.join(", "),
            bcc: savedPayload.draft.bcc.join(", "),
            subject: savedPayload.draft.subject,
            // The editable DOM owns these two fields while the composer is
            // open. Replacing them with Gmail's round-tripped HTML during an
            // autosave destroys the live selection and can collapse a newly
            // inserted block back into the preceding line.
            body: requestDraft.body,
            bodyHtml: requestDraft.bodyHtml,
            attachments: savedPayload.draft.attachments,
            aiGenerated: savedPayload.draft.aiGenerated,
            untouched: savedPayload.draft.untouched,
            gmailSyncPending: false,
          };
          if (mounted.current) {
            const current = latestValue.current;
            const sameConversation =
              current.connectionId === snapshot.connectionId &&
              current.actionId === snapshot.actionId &&
              current.threadId === snapshot.threadId &&
              current.sourceMessageId === snapshot.sourceMessageId;
            if (!sameConversation) return saved;
            lastSavedFingerprint.current = fingerprint(saved);
            const next =
              fingerprint(current) === fingerprint(snapshot)
                ? saved
                : {
                    ...current,
                    actionId: saved.actionId,
                    draftId: saved.draftId,
                    gmailSyncPending: true,
                  };
            latestValue.current = next;
            onSaved(next);
            if (savedPayload.warning) setError(savedPayload.warning);
          }
          return saved;
        } catch (reason) {
          setError(
            reason instanceof Error ? reason.message : "Could not save.",
          );
          return null;
        }
      })();
      saveInFlightRef.current = request;
      try {
        return await request;
      } finally {
        if (saveInFlightRef.current === request) {
          saveInFlightRef.current = null;
        }
        if (!forSend) {
          setBusy((current) => (current === "saving" ? null : current));
        }
      }
    },
    [fingerprint, onSaved],
  );

  useEffect(() => {
    if (
      busy ||
      !value.connectionId ||
      !emailComposerDraftHasContent(value)
    ) {
      return;
    }
    const currentFingerprint = fingerprint(value);
    if (currentFingerprint === lastSavedFingerprint.current) return;
    const timer = window.setTimeout(() => void save(), 1_600);
    return () => window.clearTimeout(timer);
  }, [busy, fingerprint, save, value]);

  const send = useCallback(
    async (
      confirmAiDraft = false,
      allowSharedGroupTracking = false,
    ) => {
      if (sending.current || (busy && busy !== "saving")) return;
      if (!latestValue.current.to.trim()) {
        setError("Add at least one recipient before sending.");
        return;
      }
      sending.current = true;
      setBusy("sending");
      setSendStatus("Preparing to send…");
      let requestId =
        sendRequestIdRef.current || globalThis.crypto.randomUUID();
      sendRequestIdRef.current = requestId;
      let saved = latestValue.current;
      let queuedInBackground = false;
      if (
        !saved.draftId ||
        fingerprint(saved) !== lastSavedFingerprint.current
      ) {
        const result = await save(true);
        if (!result) {
          sending.current = false;
          if (mounted.current) {
            setSendStatus(null);
            setBusy(null);
          }
          return;
        }
        saved = result;
      }
      if (mounted.current) setError(null);
      const sendSavedDraft = async (
        draft: ComposerState,
      ): Promise<{
        sentThread: EmailThreadSummary | null;
        actionHandled: boolean;
        warning: string | null;
      }> => {
        if (!draft.draftId) {
          throw new Error("Save this Gmail draft before sending it.");
        }
        const payload = await sendEmailDraftDurably(
          {
            version: 1,
            userId: emailCacheScope,
            requestId,
            connectionId: draft.connectionId,
            draftId: draft.draftId,
            actionId: draft.actionId,
            threadId: draft.threadId,
            bodyHtml: draft.bodyHtml,
            attachments: draft.attachments,
            confirmAiDraft,
            allowSharedGroupTracking,
            queuedAt: Date.now(),
          },
          {
            onState: (state) => {
              if (!mounted.current) return;
              setSendStatus(
                state.phase === "retrying"
                  ? `Gmail is busy · retrying safely in ${Math.max(
                      1,
                      Math.ceil((state.delayMs || 0) / 1_000),
                    )}s`
                  : state.attempt > 1
                    ? "Retrying send safely…"
                    : "Sending…",
              );
            },
          },
        );
        return {
          sentThread: payload.sentThread || null,
          actionHandled: payload.actionHandled !== false,
          warning: payload.warning?.trim() || null,
        };
      };
      try {
        const outcome = await sendSavedDraft(saved);
        if (
          mounted.current &&
          sendRequestIdRef.current === requestId
        ) {
          sendRequestIdRef.current = null;
          setConfirmOpen(false);
          skipUnmountSaveRef.current = true;
          onSent(outcome.sentThread, outcome);
        }
      } catch (reason) {
        const withPayload = reason as Error & {
          status?: number;
          payload?: {
            needsConfirmation?: boolean;
            needsGmailTrackingPermission?: boolean;
          };
        };
        if (
          (withPayload.status === 404 ||
            /draft not found|requested entity (?:was )?not found/i.test(
              withPayload.message,
            )) &&
          saved.draftId
        ) {
          // Another Gmail client may have deleted a draft that is still open
          // in Groovy. The save endpoint recreates and relinks it; retry the
          // send once with that fresh ID.
          requestId = globalThis.crypto.randomUUID();
          sendRequestIdRef.current = requestId;
          const recreated = await save(true);
          if (recreated?.draftId && recreated.draftId !== saved.draftId) {
            try {
              const outcome = await sendSavedDraft(recreated);
              if (
                mounted.current &&
                sendRequestIdRef.current === requestId
              ) {
                sendRequestIdRef.current = null;
                setConfirmOpen(false);
                skipUnmountSaveRef.current = true;
                onSent(outcome.sentThread, outcome);
              }
              return;
            } catch (retryReason) {
              if (mounted.current) {
                queuedInBackground = retryableEmailActionError(retryReason);
                if (queuedInBackground) {
                  setError(null);
                  setSendStatus(
                    "Queued · sending safely in the background…",
                  );
                } else {
                  setError(
                    retryReason instanceof Error
                      ? retryReason.message
                      : "Could not send.",
                  );
                }
              }
              return;
            }
          }
        }
        if (!mounted.current) return;
        if (
          withPayload.status === 409 &&
          withPayload.payload?.needsConfirmation
        ) {
          setConfirmOpen(true);
        } else if (
          withPayload.status === 409 &&
          withPayload.payload?.needsGmailTrackingPermission
        ) {
          setError(null);
          setTrackingPermissionOpen(true);
        } else {
          queuedInBackground = retryableEmailActionError(reason);
          if (queuedInBackground) {
            setError(null);
            setSendStatus("Queued · sending safely in the background…");
          } else {
            setError(
              reason instanceof Error ? reason.message : "Could not send.",
            );
          }
        }
      } finally {
        if (!queuedInBackground) sending.current = false;
        if (mounted.current && !queuedInBackground) {
          setSendStatus(null);
          setBusy(null);
        }
      }
    },
    [busy, emailCacheScope, fingerprint, onSent, save],
  );

  const runComposerShortcut = useCallback(
    (shortcut: DesktopNativeComposerShortcut) => {
      const now = Date.now();
      const previous = lastComposerShortcutRef.current;
      if (
        previous?.shortcut === shortcut &&
        now - previous.at < 300
      ) {
        return;
      }
      lastComposerShortcutRef.current = { shortcut, at: now };
      if (shortcut === "mod-enter") {
        void send(confirmOpen);
      } else {
        setSteerOpen(true);
      }
    },
    [confirmOpen, send],
  );

  useEffect(() => {
    if (!isDesktopShell()) return;

    const hasComposerFocus = () => {
      const active = document.activeElement;
      return Boolean(
        composerRootRef.current &&
          active &&
          composerRootRef.current.contains(active),
      );
    };
    const hasUncommittedRecipient = () => {
      const active = document.activeElement;
      return (
        active instanceof HTMLInputElement &&
        active.hasAttribute("data-email-recipient-field") &&
        Boolean(active.value.trim())
      );
    };
    const hasRecipientFieldFocus = () =>
      document.activeElement instanceof HTMLInputElement &&
      document.activeElement.hasAttribute("data-email-recipient-field");
    const handleNativeShortcut = (
      shortcut: DesktopNativeComposerShortcut,
    ) => {
      if (
        !hasComposerFocus() ||
        (shortcut === "mod-enter" && hasRecipientFieldFocus())
      ) {
        return;
      }
      runComposerShortcut(shortcut);
    };
    const handleKeyDownCapture = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.isComposing ||
        (!event.metaKey && !event.ctrlKey) ||
        !hasComposerFocus() ||
        hasUncommittedRecipient()
      ) {
        return;
      }
      const normalizedKey = event.key.toLowerCase();
      const normalizedCode = event.code.toLowerCase();
      const shortcut =
        normalizedKey === "enter" ||
        normalizedKey === "return" ||
        normalizedCode === "enter" ||
        normalizedCode === "numpadenter"
          ? "mod-enter"
          : normalizedKey === "j"
            ? "mod-j"
            : null;
      if (!shortcut) return;
      event.preventDefault();
      event.stopPropagation();
      runComposerShortcut(shortcut);
    };

    window.addEventListener("keydown", handleKeyDownCapture, true);
    const unsubscribe =
      getDesktopApi().onNativeComposerShortcut(handleNativeShortcut);
    return () => {
      window.removeEventListener("keydown", handleKeyDownCapture, true);
      unsubscribe();
    };
  }, [runComposerShortcut]);

  const discard = useCallback(async () => {
    const draft = latestValue.current;
    if (busy || !draft.connectionId) return;
    sending.current = true;
    setBusy("discarding");
    setError(null);
    try {
      if (draft.draftId) {
        await jsonRequest("/api/email/draft", {
          method: "DELETE",
          body: JSON.stringify({
            connectionId: draft.connectionId,
            actionId: draft.actionId,
            draftId: draft.draftId,
            attachments: draft.attachments,
          }),
        });
      } else if (draft.attachments.length > 0) {
        const removed = await getSupabaseBrowserClient().storage
          .from(EMAIL_DRAFT_ATTACHMENT_BUCKET)
          .remove(
            draft.attachments.map((attachment) => attachment.storagePath),
          );
        if (removed.error) throw new Error(removed.error.message);
      }
      setDiscardConfirmOpen(false);
      skipUnmountSaveRef.current = true;
      onDiscarded();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not discard draft.",
      );
    } finally {
      sending.current = false;
      setBusy(null);
    }
  }, [busy, onDiscarded]);

  const insertRichUploadAnchor = useCallback(
    (
      anchorId: string,
      point?: { x: number; y: number },
      preferredRange?: Range | null,
    ) => {
      const root = richBodyRef.current;
      if (!root) return;
      const anchor = document.createElement("span");
      anchor.dataset.emailUploadAnchor = anchorId;
      anchor.className =
        "inline-flex rounded bg-cyan-300/10 px-1 text-[10px] text-cyan-300";
      anchor.textContent = "Uploading image…";
      let range: Range | null =
        preferredRange && root.contains(preferredRange.startContainer)
          ? preferredRange.cloneRange()
          : null;
      if (point) {
        const documentWithCaret = document as Document & {
          caretRangeFromPoint?: (x: number, y: number) => Range | null;
        };
        range =
          documentWithCaret.caretRangeFromPoint?.(point.x, point.y) || null;
        if (range && !root.contains(range.startContainer)) range = null;
      }
      if (!range) {
        const selection = window.getSelection();
        const selectedRange =
          selection && selection.rangeCount > 0
            ? selection.getRangeAt(0)
            : null;
        range =
          selectedRange && root.contains(selectedRange.startContainer)
            ? selectedRange.cloneRange()
            : null;
      }
      if (range) {
        range.deleteContents();
        range.insertNode(anchor);
      } else {
        root.append(anchor);
      }
    },
    [],
  );

  const uploadFiles = useCallback(
    async (
      filesValue: FileList | File[],
      options?: {
        inlineImages?: boolean;
        bodyOffset?: number;
        anchorId?: string;
      },
    ) => {
      const clearUploadAnchor = () => {
        if (!options?.anchorId) return;
        richBodyRef.current
          ?.querySelector(
            `[data-email-upload-anchor="${options.anchorId}"]`,
          )
          ?.remove();
      };
      if (busy && busy !== "saving") {
        clearUploadAnchor();
        return;
      }
      if (busy === "saving") {
        await saveInFlightRef.current;
      }
      const files = Array.from(filesValue).filter((file) => file.size > 0);
      if (files.length === 0) {
        clearUploadAnchor();
        return;
      }
      const current = latestValue.current;
      if (
        current.attachments.length + files.length >
        EMAIL_DRAFT_ATTACHMENT_MAX_COUNT
      ) {
        setError(
          `Add no more than ${EMAIL_DRAFT_ATTACHMENT_MAX_COUNT} files to one email.`,
        );
        clearUploadAnchor();
        return;
      }
      const oversized = files.find(
        (file) => file.size > EMAIL_DRAFT_ATTACHMENT_MAX_FILE_BYTES,
      );
      if (oversized) {
        setError(`"${oversized.name}" is larger than 16 MB.`);
        clearUploadAnchor();
        return;
      }
      const totalBytes =
        current.attachments.reduce(
          (total, attachment) => total + attachment.size,
          0,
        ) + files.reduce((total, file) => total + file.size, 0);
      if (totalBytes > EMAIL_DRAFT_ATTACHMENT_MAX_TOTAL_BYTES) {
        setError("Attachments must total 17 MB or less.");
        clearUploadAnchor();
        return;
      }
      if (
        options?.inlineImages &&
        files.some((file) => !canInlineEmailDraftMimeType(file.type))
      ) {
        setError("Inline images must be PNG, JPEG, GIF, or WebP files.");
        clearUploadAnchor();
        return;
      }

      setBusy("uploading");
      setError(null);
      const uploaded: EmailDraftAttachment[] = [];
      const uploadedPaths: string[] = [];
      const newPreviewUrls: Record<string, string> = {};
      try {
        const client = getSupabaseBrowserClient();
        const userResult = await client.auth.getUser();
        const userId = userResult.data.user?.id;
        if (!userId) throw new Error("Sign in again before uploading files.");
        for (const file of files) {
          const id = crypto.randomUUID();
          const filename = safeEmailDraftFilename(file.name);
          const mimeType = safeEmailDraftMimeType(file.type);
          const storagePath =
            `${userId}/email-drafts/${uploadSessionIdRef.current}/` +
            `${id}-${filename}`;
          const result = await client.storage
            .from(EMAIL_DRAFT_ATTACHMENT_BUCKET)
            .upload(storagePath, file, {
              cacheControl: "3600",
              contentType: mimeType,
              upsert: false,
            });
          if (result.error) throw new Error(result.error.message);
          const disposition =
            options?.inlineImages &&
            canInlineEmailDraftMimeType(mimeType)
              ? "inline"
              : "attachment";
          uploadedPaths.push(storagePath);
          uploaded.push({
            id,
            storagePath,
            filename,
            mimeType,
            size: file.size,
            disposition,
            contentId:
              disposition === "inline" ? emailDraftContentId(id) : null,
          });
          if (disposition === "inline") {
            newPreviewUrls[id] = URL.createObjectURL(file);
          }
        }
        const nextAttachments = [...current.attachments, ...uploaded];
        setPreviewUrls((existing) => ({
          ...existing,
          ...newPreviewUrls,
        }));
        const inline = uploaded.filter(
          (attachment) => attachment.disposition === "inline",
        );
        if (inline.length > 0 && current.bodyHtml === null) {
          const bodyOffset = options?.bodyOffset ?? current.body.length;
          focusAfterInlineIdRef.current = inline[inline.length - 1].id;
          update({
            attachments: nextAttachments,
            body: plainTextWithInlineImageLabels({
              body: current.body,
              offset: bodyOffset,
              attachments: inline,
            }),
            bodyHtml: plainTextWithInlineImages({
              body: current.body,
              offset: bodyOffset,
              attachments: inline,
            }),
          });
        } else if (inline.length > 0 && richBodyRef.current) {
          const root = richBodyRef.current;
          const anchor = options?.anchorId
            ? root.querySelector<HTMLElement>(
                `[data-email-upload-anchor="${options.anchorId}"]`,
              )
            : null;
          const fragment = document.createDocumentFragment();
          for (const attachment of inline) {
            const image = document.createElement("img");
            image.dataset.emailInlineId = attachment.id;
            image.src = newPreviewUrls[attachment.id] || "";
            image.alt = attachment.filename;
            image.className =
              "my-2 block max-h-[28rem] max-w-full rounded-lg border border-white/10 object-contain";
            fragment.append(image, document.createElement("br"));
          }
          focusAfterInlineIdRef.current = inline[inline.length - 1].id;
          if (anchor) anchor.replaceWith(fragment);
          else root.append(fragment);
          const serialized = serializeRichComposerBody(
            root,
            nextAttachments,
          );
          lastRichBodyHtmlRef.current = serialized.bodyHtml;
          update({
            attachments: nextAttachments,
            body: serialized.body,
            bodyHtml: serialized.bodyHtml,
          });
        } else {
          update({ attachments: nextAttachments });
        }
      } catch (reason) {
        for (const url of Object.values(newPreviewUrls)) {
          URL.revokeObjectURL(url);
        }
        if (uploadedPaths.length > 0) {
          void getSupabaseBrowserClient().storage
            .from(EMAIL_DRAFT_ATTACHMENT_BUCKET)
            .remove(uploadedPaths);
        }
        clearUploadAnchor();
        setError(
          reason instanceof Error ? reason.message : "Could not upload files.",
        );
      } finally {
        setBusy(null);
      }
    },
    [busy, update],
  );

  const removeDraftAttachment = useCallback(
    (attachment: EmailDraftAttachment) => {
      if (busy) return;
      const nextAttachments = latestValue.current.attachments.filter(
        (item) => item.id !== attachment.id,
      );
      const previewUrl = previewUrlsRef.current[attachment.id];
      if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
      setPreviewUrls((current) => {
        const next = { ...current };
        delete next[attachment.id];
        return next;
      });
      if (attachment.disposition === "inline" && richBodyRef.current) {
        const root = richBodyRef.current;
        for (const image of Array.from(
          root.querySelectorAll(
            `img[data-email-inline-id="${attachment.id}"]`,
          ),
        )) {
          image.remove();
        }
        const serialized = serializeRichComposerBody(root, nextAttachments);
        const hasInlineImages = nextAttachments.some(
          (item) => item.disposition === "inline",
        );
        lastRichBodyHtmlRef.current = hasInlineImages
          ? serialized.bodyHtml
          : "";
        update({
          attachments: nextAttachments,
          body: serialized.body,
          bodyHtml: hasInlineImages ? serialized.bodyHtml : null,
        });
      } else {
        update({ attachments: nextAttachments });
      }
      void getSupabaseBrowserClient().storage
        .from(EMAIL_DRAFT_ATTACHMENT_BUCKET)
        .remove([attachment.storagePath]);
    },
    [busy, update],
  );

  const askAi = useCallback(
    async (task: "complete" | "rewrite" | "steer", instruction = "") => {
      const snapshot = latestValue.current;
      if (snapshot.bodyHtml !== null) {
        if (task !== "complete") {
          setError(
            "Remove inline images before asking AI to rewrite the whole message.",
          );
        }
        return;
      }
      if (task === "complete" && !shouldRequestEmailCompletion(snapshot.body)) {
        return;
      }
      const version = ++completionVersion.current;
      const controller =
        task === "complete" ? new AbortController() : null;
      if (controller) {
        completionAbort.current?.abort();
        completionAbort.current = controller;
        setCompletionStatus("loading");
      }
      if (task !== "complete") setBusy("ai");
      setError(null);
      try {
        const payload = await jsonRequest<{
          ok: true;
          text: string;
          status?: "suggestion" | "no_suggestion";
        }>(
          "/api/email/assist",
          {
            method: "POST",
            ...(controller ? { signal: controller.signal } : {}),
            body: JSON.stringify(boundedEmailAssistPayload({
              task,
              instruction,
              currentBody: snapshot.body,
              subject: snapshot.subject,
              threadContext,
              connectionId: snapshot.connectionId,
            })),
          },
        );
        if (version !== completionVersion.current) return;
        if (task === "complete") {
          const textarea = bodyRef.current;
          if (
            !textarea ||
            !canShowEmailCompletion({
              requestedBody: snapshot.body,
              currentBody: latestValue.current.body,
              selectionStart: textarea.selectionStart,
              selectionEnd: textarea.selectionEnd,
            })
          ) {
            return;
          }
          if (
            classifyEmailCompletionResponse({
              body: snapshot.body,
              completion: payload.text,
              status: payload.status,
            }) === "no_suggestion"
          ) {
            setGhost("");
            setCompletionStatus("idle");
            return;
          }
          setGhost(payload.text);
          setCompletionStatus("idle");
        } else {
          update({ body: payload.text, aiGenerated: true });
          setSteerOpen(false);
          setSteer("");
          setGhost("");
        }
      } catch (reason) {
        if (reason instanceof Error && reason.name === "AbortError") return;
        if (task === "complete") {
          if (version === completionVersion.current) {
            setCompletionStatus("error");
          }
        } else {
          setError(
            reason instanceof Error ? reason.message : "AI is unavailable.",
          );
        }
      } finally {
        if (controller && completionAbort.current === controller) {
          completionAbort.current = null;
          setCompletionStatus((current) =>
            current === "loading" ? "idle" : current,
          );
        }
        if (task !== "complete") setBusy(null);
      }
    },
    [threadContext, update],
  );

  useEffect(() => {
    completionVersion.current += 1;
    completionAbort.current?.abort();
    setCompletionStatus("idle");
    const textarea = bodyRef.current;
    if (
      !textarea ||
      !shouldScheduleEmailCompletion({
        body: value.body,
        bodyHtml: value.bodyHtml,
        focused: bodyFocused,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
      })
    ) {
      setGhost("");
      return;
    }
    const timer = window.setTimeout(() => void askAi("complete"), 850);
    return () => {
      window.clearTimeout(timer);
      completionAbort.current?.abort();
    };
  }, [askAi, bodyFocused, value.body, value.bodyHtml]);

  const ghostSuffix = emailCompletionSuffix(value.body, ghost);
  const acceptGhost = useCallback(() => {
    if (!ghostSuffix) return;
    const nextBody = acceptEmailCompletion(value.body, ghost);
    update({ body: nextBody, aiGenerated: true });
    setGhost("");
    window.requestAnimationFrame(() => {
      const textarea = bodyRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextBody.length, nextBody.length);
    });
  }, [ghost, ghostSuffix, update, value.body]);

  const syncRichBody = useCallback(() => {
    const root = richBodyRef.current;
    if (!root) return;
    const currentAttachments = latestValue.current.attachments;
    const serialized = serializeRichComposerBody(
      root,
      currentAttachments,
    );
    const inlineIds = new Set(serialized.inlineAttachmentIds);
    const removedInline = currentAttachments.filter(
      (attachment) =>
        attachment.disposition === "inline" &&
        !inlineIds.has(attachment.id),
    );
    const attachments =
      removedInline.length > 0
        ? currentAttachments.filter(
            (attachment) => !removedInline.includes(attachment),
          )
        : currentAttachments;
    const hasInlineImages = attachments.some(
      (attachment) => attachment.disposition === "inline",
    );
    lastRichBodyHtmlRef.current = hasInlineImages
      ? serialized.bodyHtml
      : "";
    update({
      body: serialized.body,
      bodyHtml: hasInlineImages ? serialized.bodyHtml : null,
      ...(removedInline.length > 0 ? { attachments } : {}),
    });
    if (removedInline.length > 0) {
      setPreviewUrls((current) => {
        const next = { ...current };
        for (const attachment of removedInline) {
          const url = next[attachment.id];
          if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
          delete next[attachment.id];
        }
        return next;
      });
      void (async () => {
        await saveInFlightRef.current;
        await getSupabaseBrowserClient().storage
          .from(EMAIL_DRAFT_ATTACHMENT_BUCKET)
          .remove(
            removedInline.map((attachment) => attachment.storagePath),
          );
      })();
    }
  }, [update]);

  const uploadInlineFilesAtCursor = useCallback(
    (
      files: FileList | File[],
      point?: { x: number; y: number },
      useCapturedInsertionPoint = false,
    ) => {
      const capturedBodyOffset = useCapturedInsertionPoint
        ? pendingInlineBodyOffsetRef.current
        : null;
      const capturedRange = useCapturedInsertionPoint
        ? pendingInlineRangeRef.current
        : null;
      if (useCapturedInsertionPoint) {
        pendingInlineBodyOffsetRef.current = null;
        pendingInlineRangeRef.current = null;
      }
      if (latestValue.current.bodyHtml !== null) {
        const anchorId = crypto.randomUUID();
        insertRichUploadAnchor(anchorId, point, capturedRange);
        void uploadFiles(files, {
          inlineImages: true,
          anchorId,
        });
        return;
      }
      void uploadFiles(files, {
        inlineImages: true,
        bodyOffset:
          capturedBodyOffset ??
          bodyRef.current?.selectionStart ??
          latestValue.current.body.length,
      });
    },
    [insertRichUploadAnchor, uploadFiles],
  );

  const availableSnippets = snippets.filter(
    (snippet) =>
      snippet.mailboxConnectionIds.length === 0 ||
      snippet.mailboxConnectionIds.includes(value.connectionId),
  );
  const selectedMailbox = mailboxes.find(
    (mailbox) => mailbox.connectionId === value.connectionId,
  );
  const composerRecipientAddresses = recipientAddresses(
    [value.to, value.cc, value.bcc].join(", "),
  );
  const isConversationReply = Boolean(value.threadId || value.inReplyTo);
  const applySnippet = (snippet: EmailSnippet) => {
    const merge = (original: string, incoming: string[]) =>
      Array.from(
        new Set([
          ...original.split(",").map((item) => item.trim()).filter(Boolean),
          ...incoming,
        ]),
      ).join(", ");
    const renderTokens = (input: string) =>
      input.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key: string) => {
        if (key.toLowerCase() === "today") {
          return new Date().toLocaleDateString([], {
            month: "long",
            day: "numeric",
            year: "numeric",
          });
        }
        return snippetVariables?.[key.toLowerCase()] || match;
      });
    const renderedBody = renderTokens(snippet.body);
    const patch: Partial<ComposerState> = {
      to: merge(value.to, snippet.to),
      cc: merge(value.cc, snippet.cc),
      bcc: merge(value.bcc, snippet.bcc),
      subject: snippet.subject
        ? renderTokens(snippet.subject)
        : value.subject,
    };
    if (value.bodyHtml === null) {
      patch.body = renderedBody;
    }
    update(patch);
    if (value.bodyHtml !== null) {
      document.execCommand("insertText", false, renderedBody);
      window.requestAnimationFrame(syncRichBody);
    }
    setShowDetails(Boolean(snippet.cc.length || snippet.bcc.length));
    window.setTimeout(
      () => (value.bodyHtml === null ? bodyRef.current : richBodyRef.current)?.focus(),
      0,
    );
  };

  return (
    <div
      ref={composerRootRef}
      className="relative rounded-2xl border border-white/[0.09] bg-[#0d0e11] shadow-xl shadow-black/20"
      onKeyDown={(event) => {
        const enterPressed =
          event.key === "Enter" ||
          event.key === "Return" ||
          event.code === "Enter" ||
          event.code === "NumpadEnter";
        if (
          !event.nativeEvent.isComposing &&
          (event.metaKey || event.ctrlKey) &&
          enterPressed
        ) {
          event.preventDefault();
          event.stopPropagation();
          runComposerShortcut("mod-enter");
        } else if (
          !event.nativeEvent.isComposing &&
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "j"
        ) {
          event.preventDefault();
          event.stopPropagation();
          runComposerShortcut("mod-j");
        }
      }}
    >
      <div className="border-b border-white/[0.07] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <label
            htmlFor="email-sender-mailbox"
            className="shrink-0 text-xs font-medium text-zinc-500"
          >
            From
          </label>
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <select
              id="email-sender-mailbox"
              value={value.connectionId}
              onChange={(event) =>
                void changeSenderMailbox(event.target.value)
              }
              disabled={busy !== null || mailboxes.length < 2}
              className="h-10 w-full appearance-none truncate rounded-xl border border-white/[0.09] bg-white/[0.035] py-2 pl-3 pr-9 text-sm text-zinc-200 outline-none transition hover:border-white/[0.16] focus:border-cyan-300/35 focus:ring-2 focus:ring-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-70"
              aria-label="Sender mailbox"
            >
              {mailboxes.map((mailbox) => (
                <option
                  key={mailbox.connectionId}
                  value={mailbox.connectionId}
                  disabled={mailbox.status !== "connected"}
                >
                  {mailbox.displayName} — {mailbox.address}
                  {mailbox.status === "connected"
                    ? ""
                    : " — reconnect required"}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          </div>
        </div>
        {value.aiGenerated ||
        busy === "saving" ||
        busy === "uploading" ||
        value.draftId ? (
          <div className="mt-1.5 flex min-h-4 items-center gap-2 pl-10">
            {value.aiGenerated ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-cyan-400/[0.07] px-2 py-1 text-[10px] text-cyan-300">
                <Sparkles className="h-2.5 w-2.5" />
                AI draft
              </span>
            ) : null}
            <span
              className="ml-auto text-[10px] text-zinc-600"
              aria-live="polite"
              data-email-draft-status
            >
              {busy === "saving"
                ? "Saving draft…"
                : busy === "uploading"
                  ? "Uploading securely…"
                : value.draftId
                  ? "Draft saved in Gmail · Not sent"
                  : ""}
            </span>
          </div>
        ) : null}
        {isConversationReply && selectedMailbox ? (
          <p className="mt-1.5 pl-10 text-[10px] text-zinc-600">
            Replying from {selectedMailbox.displayName}. You can switch to any
            connected mailbox; Gmail may show the reply as a separate thread
            in the selected sender mailbox.
          </p>
        ) : null}
      </div>
      <div className="px-4">
        <RecipientField
          field="to"
          value={value.to}
          onChange={(to) => update({ to })}
          disabled={busy === "sending"}
          mailboxes={mailboxes}
          contactThreads={contactThreads}
          excludeEmails={composerRecipientAddresses}
          primary
          trailing={
            <button
              type="button"
              onClick={() => setShowDetails((current) => !current)}
              className="shrink-0 pt-1 text-[10px] text-zinc-600 hover:text-zinc-300"
            >
              Cc Bcc
            </button>
          }
        />
        {showDetails ? (
          <>
            <RecipientField
              field="cc"
              value={value.cc}
              onChange={(cc) => update({ cc })}
              disabled={busy === "sending"}
              mailboxes={mailboxes}
              contactThreads={contactThreads}
              excludeEmails={composerRecipientAddresses}
            />
            <RecipientField
              field="bcc"
              value={value.bcc}
              onChange={(bcc) => update({ bcc })}
              disabled={busy === "sending"}
              mailboxes={mailboxes}
              contactThreads={contactThreads}
              excludeEmails={composerRecipientAddresses}
            />
          </>
        ) : null}
        <input
          value={value.subject}
          onChange={(event) => update({ subject: event.target.value })}
          disabled={busy === "sending"}
          placeholder="Subject"
          className="h-10 w-full border-b border-white/[0.06] bg-transparent text-xs font-medium text-white outline-none"
        />
        <div
          className={`relative rounded-lg transition ${
            dragActive ? "bg-cyan-300/[0.06] ring-1 ring-cyan-300/30" : ""
          }`}
        >
          {value.bodyHtml === null ? (
            <>
              <div
                className="pointer-events-none absolute inset-0 overflow-hidden px-0 py-4 text-sm leading-6"
                aria-hidden="true"
                data-email-inline-completion
              >
                <div
                  ref={ghostContentRef}
                  className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] [will-change:transform]"
                >
                  <span className="text-transparent">{value.body}</span>
                  {ghostSuffix ? (
                    <span className="text-zinc-600">{ghostSuffix}</span>
                  ) : null}
                </div>
              </div>
              <textarea
                ref={bodyRef}
                value={value.body}
                disabled={busy === "sending" || busy === "uploading"}
                onFocus={() => setBodyFocused(true)}
                onBlur={() => {
                  setBodyFocused(false);
                  completionVersion.current += 1;
                  completionAbort.current?.abort();
                  setGhost("");
                  setCompletionStatus("idle");
                }}
                onChange={(event) => {
                  completionVersion.current += 1;
                  completionAbort.current?.abort();
                  const next = event.target.value;
                  const shortcut = next.match(/^\/([a-z0-9_-]+)\s$/i)?.[1];
                  const match = shortcut
                    ? availableSnippets.find(
                        (snippet) =>
                          snippet.shortcut.toLowerCase() ===
                          shortcut.toLowerCase(),
                      )
                    : null;
                  if (match) applySnippet(match);
                  else update({ body: next });
                  setGhost("");
                  setCompletionStatus("idle");
                }}
                onPaste={(event) => {
                  const images = clipboardImageFiles(event.clipboardData);
                  if (images.length > 0) {
                    event.preventDefault();
                    uploadInlineFilesAtCursor(images);
                    return;
                  }
                  const clipboardText = event.clipboardData.getData("text/plain");
                  const insertion = pasteTextPreservingStructure({
                    html: event.clipboardData.getData("text/html"),
                    text: clipboardText,
                  });
                  if (insertion === clipboardText) return;
                  event.preventDefault();
                  completionVersion.current += 1;
                  completionAbort.current?.abort();
                  setGhost("");
                  setCompletionStatus("idle");
                  const textarea = event.currentTarget;
                  const inserted = insertTextAtSelection({
                    value: textarea.value,
                    insertion,
                    selectionStart: textarea.selectionStart,
                    selectionEnd: textarea.selectionEnd,
                  });
                  update({ body: inserted.value });
                  window.requestAnimationFrame(() => {
                    bodyRef.current?.focus();
                    bodyRef.current?.setSelectionRange(
                      inserted.caret,
                      inserted.caret,
                    );
                  });
                }}
                onDragEnter={(event) => {
                  if (event.dataTransfer.types.includes("Files")) {
                    event.preventDefault();
                    setDragActive(true);
                  }
                }}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes("Files")) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                  }
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                    setDragActive(false);
                  }
                }}
                onDrop={(event) => {
                  const files = event.dataTransfer.files;
                  if (files.length === 0) return;
                  event.preventDefault();
                  setDragActive(false);
                  if (
                    Array.from(files).every((file) =>
                      canInlineEmailDraftMimeType(file.type),
                    )
                  ) {
                    uploadInlineFilesAtCursor(files);
                  } else {
                    void uploadFiles(files);
                  }
                }}
                onScroll={(event) => {
                  if (!ghostContentRef.current) return;
                  ghostContentRef.current.style.transform = `translate(${-event.currentTarget.scrollLeft}px, ${-event.currentTarget.scrollTop}px)`;
                }}
                onSelect={(event) => {
                  const textarea = event.currentTarget;
                  if (
                    !isEmailCompletionCaretAtEnd({
                      body: textarea.value,
                      selectionStart: textarea.selectionStart,
                      selectionEnd: textarea.selectionEnd,
                    })
                  ) {
                    completionVersion.current += 1;
                    completionAbort.current?.abort();
                    setGhost("");
                    setCompletionStatus("idle");
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Tab" && ghostSuffix) {
                    event.preventDefault();
                    acceptGhost();
                  } else if (event.key === "Escape" && ghostSuffix) {
                    event.preventDefault();
                    event.stopPropagation();
                    setGhost("");
                  }
                }}
                placeholder="Write naturally. Drop images at the cursor…"
                className="relative z-10 min-h-40 w-full resize-none overflow-x-hidden bg-transparent px-0 py-4 text-sm leading-6 text-zinc-200 outline-none [overflow-wrap:anywhere] placeholder:text-zinc-700"
              />
            </>
          ) : (
            <div
              ref={richBodyRef}
              contentEditable={busy !== "sending" && busy !== "uploading"}
              suppressContentEditableWarning
              role="textbox"
              aria-label="Email body"
              aria-multiline="true"
              data-placeholder="Write naturally. Drop images at the cursor…"
              onInput={syncRichBody}
              onPaste={(event) => {
                const files = clipboardImageFiles(event.clipboardData);
                if (files.length > 0) {
                  event.preventDefault();
                  uploadInlineFilesAtCursor(files);
                  return;
                }
                event.preventDefault();
                const clipboardText = event.clipboardData.getData("text/plain");
                document.execCommand(
                  "insertText",
                  false,
                  pasteTextPreservingStructure({
                    html: event.clipboardData.getData("text/html"),
                    text: clipboardText,
                  }),
                );
              }}
              onDragEnter={(event) => {
                if (event.dataTransfer.types.includes("Files")) {
                  event.preventDefault();
                  setDragActive(true);
                }
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setDragActive(false);
                }
              }}
              onDrop={(event) => {
                const files = event.dataTransfer.files;
                if (files.length === 0) return;
                event.preventDefault();
                setDragActive(false);
                if (
                  Array.from(files).every((file) =>
                    canInlineEmailDraftMimeType(file.type),
                  )
                ) {
                  uploadInlineFilesAtCursor(files, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                } else {
                  void uploadFiles(files);
                }
              }}
              className="relative z-10 min-h-40 w-full whitespace-pre-wrap break-words bg-transparent px-0 py-4 text-sm leading-6 text-zinc-200 outline-none [overflow-wrap:anywhere] empty:before:pointer-events-none empty:before:text-zinc-700 empty:before:content-[attr(data-placeholder)]"
            />
          )}
          {ghostSuffix && value.bodyHtml === null ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={acceptGhost}
              className="absolute bottom-2 right-2 z-20 inline-flex items-center gap-1.5 rounded-md border border-cyan-300/15 bg-[#111216]/95 px-2 py-1 text-[9px] text-zinc-400 shadow-sm backdrop-blur transition hover:border-cyan-300/25 hover:text-zinc-200"
              data-email-completion-hint
              aria-label="Insert email suggestion"
            >
              <kbd className="hidden font-mono text-cyan-300 sm:inline">
                Tab
              </kbd>
              <span className="font-medium text-cyan-300 sm:hidden">Tap</span>
              to insert
            </button>
          ) : null}
          <span className="sr-only" aria-live="polite">
            {ghostSuffix
              ? `Suggestion: ${ghostSuffix.trim()}. Press Tab to accept.`
              : ""}
          </span>
        </div>
        {ghostSuffix ? (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={acceptGhost}
            className="mb-3 flex w-full min-w-0 items-start gap-2 rounded-xl border border-cyan-300/10 bg-cyan-300/[0.035] px-3 py-2 text-left transition hover:border-cyan-300/20 hover:bg-cyan-300/[0.055]"
            data-email-completion-suggestion
          >
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300/80" />
            <span className="min-w-0 flex-1 text-xs leading-5 text-zinc-400">
              {ghostSuffix.trim()}
            </span>
            <span className="shrink-0 pt-0.5 text-[9px] font-medium text-cyan-300">
              Insert
            </span>
          </button>
        ) : completionStatus === "loading" ? (
          <div
            className="mb-3 flex items-center gap-2 px-1 text-[10px] text-zinc-600"
            aria-live="polite"
          >
            <LoaderCircle className="h-3 w-3 animate-spin" />
            Finishing your thought…
          </div>
        ) : completionStatus === "error" ? (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void askAi("complete")}
            className="mb-3 inline-flex items-center gap-2 rounded-lg px-1 text-[10px] text-amber-300/80 transition hover:text-amber-200"
          >
            <RefreshCw className="h-3 w-3" />
            Autocomplete failed. Tap to retry.
          </button>
        ) : null}
        {value.attachments.length > 0 || busy === "uploading" ? (
          <div
            className="mb-3 flex flex-wrap gap-2"
            aria-label="Email attachments"
          >
            {value.attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex max-w-full items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.035] py-1.5 pl-2 pr-1.5 text-[10px] text-zinc-400"
              >
                {attachment.disposition === "inline" ? (
                  <ImagePlus className="h-3 w-3 shrink-0 text-cyan-300" />
                ) : (
                  <Paperclip className="h-3 w-3 shrink-0 text-zinc-500" />
                )}
                <span className="max-w-48 truncate">
                  {attachment.filename}
                </span>
                <span className="shrink-0 text-zinc-700">
                  {formatAttachmentSize(attachment.size)}
                </span>
                <button
                  type="button"
                  onClick={() => removeDraftAttachment(attachment)}
                  disabled={busy !== null}
                  className="rounded-md p-1 text-zinc-600 hover:bg-red-400/[0.08] hover:text-red-300 disabled:opacity-40"
                  aria-label={`Remove ${attachment.filename}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {busy === "uploading" ? (
              <span className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/10 bg-cyan-300/[0.035] px-2.5 py-1.5 text-[10px] text-cyan-300">
                <LoaderCircle className="h-3 w-3 animate-spin" />
                Uploading securely…
              </span>
            ) : null}
          </div>
        ) : null}
        {steerOpen ? (
          <form
            className="mb-3 flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.04] p-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (steer.trim()) void askAi("steer", steer);
            }}
          >
            <WandSparkles className="ml-1 h-3.5 w-3.5 text-cyan-300" />
            <input
              autoFocus
              value={steer}
              onChange={(event) => setSteer(event.target.value)}
              placeholder="Make it warmer, shorter, more direct…"
              className="min-w-0 flex-1 bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
            />
            <button
              type="submit"
              disabled={!steer.trim() || busy === "ai"}
              className="rounded-lg bg-cyan-300 px-2.5 py-1 text-[10px] font-semibold text-black disabled:opacity-40"
            >
              {busy === "ai" ? "Thinking…" : "Apply"}
            </button>
          </form>
        ) : null}
        <div className="mb-3 flex items-start gap-2 border-t border-white/[0.05] pt-3 text-[10px] leading-4 text-zinc-600">
          <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-cyan-300/50" />
          <span>
            <span className="text-zinc-500">
              Added automatically when sent
            </span>
            <br />
            {GROOVY_AI_EMAIL_DISCLOSURE}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 border-t border-white/[0.07] px-3 py-2.5">
        <button
          type="button"
          onClick={() => setSteerOpen((current) => !current)}
          className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-cyan-300"
          title="Steer with AI (⌘J)"
        >
          <WandSparkles className="h-3.5 w-3.5" />
        </button>
        <input
          ref={attachmentInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = "";
            if (files.length) void uploadFiles(files);
          }}
        />
        <button
          type="button"
          onClick={() => attachmentInputRef.current?.click()}
          disabled={busy !== null}
          className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white disabled:opacity-40"
          title="Attach files"
          aria-label="Attach files"
        >
          <Paperclip className="h-3.5 w-3.5" />
        </button>
        <input
          ref={inlineImageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = "";
            if (files.length) {
              uploadInlineFilesAtCursor(files, undefined, true);
            }
          }}
        />
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            pendingInlineBodyOffsetRef.current =
              bodyRef.current?.selectionStart ?? null;
            const root = richBodyRef.current;
            const selection = window.getSelection();
            const range =
              root && selection?.rangeCount
                ? selection.getRangeAt(0)
                : null;
            pendingInlineRangeRef.current =
              range && root?.contains(range.startContainer)
                ? range.cloneRange()
                : null;
            inlineImageInputRef.current?.click();
          }}
          disabled={busy !== null}
          className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-cyan-300 disabled:opacity-40"
          title="Insert image at cursor"
          aria-label="Insert image at cursor"
        >
          <ImagePlus className="h-3.5 w-3.5" />
        </button>
        <div className="group relative">
          <button
            type="button"
            className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white"
            title="Insert snippet"
          >
            <FileText className="h-3.5 w-3.5" />
          </button>
          {availableSnippets.length ? (
            <div className="invisible absolute bottom-full left-0 z-20 mb-1 w-56 translate-y-1 rounded-xl border border-white/10 bg-[#15161a] p-1 opacity-0 shadow-2xl transition group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100">
              {availableSnippets.slice(0, 8).map((snippet) => (
                <button
                  key={snippet.id}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applySnippet(snippet)}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs text-zinc-300 hover:bg-white/[0.05]"
                >
                  <span className="truncate">{snippet.name}</span>
                  {snippet.shortcut ? (
                    <kbd className="ml-2 text-[9px] text-zinc-600">
                      /{snippet.shortcut}
                    </kbd>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy !== null}
          className="rounded-lg px-2 py-1.5 text-[10px] text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200 disabled:opacity-40"
        >
          Save
        </button>
        {emailComposerDraftHasContent(value) ? (
          <button
            type="button"
            onClick={() => setDiscardConfirmOpen(true)}
            disabled={busy !== null}
            className="rounded-lg p-2 text-zinc-600 hover:bg-red-400/[0.07] hover:text-red-300 disabled:opacity-40"
            aria-label="Discard draft"
            title="Discard draft"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void send(false)}
          disabled={busy !== null || !value.to.trim()}
          className="ml-auto inline-flex items-center gap-2 rounded-xl bg-white px-3.5 py-2 text-xs font-semibold text-black transition hover:bg-zinc-200 disabled:opacity-40"
          title="Send (⌘ Enter)"
        >
          {busy === "sending" ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          {busy === "sending" ? "Sending…" : "Send"}
          <kbd className="hidden font-mono text-[9px] text-zinc-600 sm:inline">
            ⌘↵
          </kbd>
        </button>
      </div>
      {busy === "sending" && sendStatus ? (
        <p
          className="border-t border-cyan-300/10 bg-cyan-300/[0.025] px-4 py-2 text-[11px] text-cyan-100/75"
          role="status"
          aria-live="polite"
        >
          {sendStatus}
        </p>
      ) : null}
      {error ? (
        <p className="border-t border-red-400/10 bg-red-400/[0.035] px-4 py-2 text-[11px] text-red-300">
          {error}
        </p>
      ) : null}
      {trackingPermissionOpen ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center rounded-2xl bg-[#0d0e11]/95 p-6 backdrop-blur"
          aria-busy={trackingPermissionBusy || busy === "sending"}
        >
          <div className="max-w-sm text-center">
            <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-cyan-400/[0.09] text-cyan-200">
              <Eye className="h-4 w-4" />
            </span>
            <p className="mt-3 text-sm font-semibold text-white">
              Identify who opens group email
            </p>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              Google requires a broader Gmail permission to deliver a
              separately tagged copy to each recipient. Groovy still sends
              through this Gmail account and uses its own tracking pixels—no
              separate email provider.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setTrackingPermissionOpen(false);
                  void send(confirmOpen, true);
                }}
                disabled={trackingPermissionBusy || busy === "sending"}
                className="rounded-xl border border-white/10 px-3 py-2 text-xs text-zinc-300 disabled:opacity-40"
              >
                Send with shared status
              </button>
              <button
                type="button"
                onClick={() => {
                  const mailbox = selectedMailbox;
                  if (!mailbox) {
                    setError("Choose a connected Gmail mailbox.");
                    return;
                  }
                  setTrackingPermissionBusy(true);
                  void onEnableRecipientTracking(mailbox)
                    .then((enabled) => {
                      if (!enabled) return;
                      setTrackingPermissionOpen(false);
                      void send(confirmOpen, false);
                    })
                    .finally(() => setTrackingPermissionBusy(false));
                }}
                disabled={trackingPermissionBusy || busy === "sending"}
                className="inline-flex min-w-32 items-center justify-center gap-2 rounded-xl bg-cyan-200 px-3 py-2 text-xs font-semibold text-black disabled:opacity-50"
              >
                {trackingPermissionBusy ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                {trackingPermissionBusy
                  ? "Waiting for Google…"
                  : "Reconnect Gmail"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmOpen ? (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center rounded-2xl bg-[#0d0e11]/95 p-6 backdrop-blur"
          aria-busy={busy === "sending"}
        >
          <div className="max-w-sm text-center">
            <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-amber-400/[0.09] text-amber-300">
              <CircleAlert className="h-4 w-4" />
            </span>
            <p className="mt-3 text-sm font-semibold text-white">
              Confirm the untouched AI draft
            </p>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              {busy === "sending"
                ? sendStatus || "Sending your email now…"
                : "Groovy never sends an AI-written reply without a deliberate confirmation."}
            </p>
            {error ? (
              <p
                className="mt-3 rounded-xl border border-red-400/15 bg-red-400/[0.05] px-3 py-2 text-xs leading-5 text-red-300"
                role="alert"
              >
                {error}
              </p>
            ) : null}
            <div className="mt-4 flex justify-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={busy === "sending"}
                className="rounded-xl border border-white/10 px-3 py-2 text-xs text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => void send(true)}
                disabled={busy === "sending"}
                className="inline-flex min-w-32 items-center justify-center gap-2 rounded-xl bg-amber-300 px-3 py-2 text-xs font-semibold text-black disabled:cursor-wait disabled:opacity-70"
              >
                {busy === "sending" ? (
                  <LoaderCircle
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                {busy === "sending"
                  ? sendStatus?.includes("retry")
                    ? "Retrying…"
                    : "Sending…"
                  : "Confirm and send"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {discardConfirmOpen ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center rounded-2xl bg-[#0d0e11]/95 p-6 backdrop-blur">
          <div className="max-w-sm text-center">
            <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-red-400/[0.08] text-red-300">
              <Trash2 className="h-4 w-4" />
            </span>
            <p className="mt-3 text-sm font-semibold text-white">
              {value.draftId
                ? "Discard this Gmail draft?"
                : "Discard this draft?"}
            </p>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              {value.draftId
                ? "The conversation stays in place. Only this saved draft is removed."
                : "This unfinished message will be removed from Groovy."}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <button
                type="button"
                onClick={() => setDiscardConfirmOpen(false)}
                className="rounded-xl border border-white/10 px-3 py-2 text-xs text-zinc-300"
              >
                Keep draft
              </button>
              <button
                type="button"
                onClick={() => void discard()}
                disabled={busy !== null}
                className="rounded-xl bg-red-300 px-3 py-2 text-xs font-semibold text-black disabled:opacity-40"
              >
                {busy === "discarding" ? "Discarding…" : "Discard draft"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function EmailWorkspace({ visible }: { visible: boolean }) {
  const emailCacheScope = useEmailCacheScope();
  const emailCacheScopeRef = useRef(emailCacheScope);
  emailCacheScopeRef.current = emailCacheScope;
  const device = useConnectorDevice();
  const initialNavigationLocationRef = useRef<
    ReturnType<typeof readEmailNavigationLocation> | undefined
  >(undefined);
  if (initialNavigationLocationRef.current === undefined) {
    initialNavigationLocationRef.current =
      readEmailNavigationLocation({ scope: emailCacheScope });
  }
  const [view, setView] = useState<WorkspaceView>(
    () => initialNavigationLocationRef.current?.view || "focus",
  );
  const [feed, setFeed] = useState<EmailFeedResponse>(EMPTY_FEED);
  const [navigationStats, setNavigationStats] =
    useState<EmailFeedResponse["stats"]>(EMPTY_FEED.stats);
  const [prefetchedNeedsReviewCount, setPrefetchedNeedsReviewCount] =
    useState<number | null>(null);
  const [cacheHydrated, setCacheHydrated] = useState(false);
  const [backgroundSnapshotScope, setBackgroundSnapshotScope] =
    useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingView, setLoadingView] = useState<EmailView | null>("focus");
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [organizationStatus, setOrganizationStatus] = useState<string | null>(
    null,
  );
  const [mailboxFilter, setMailboxFilter] = useState<string | null>(
    () => initialNavigationLocationRef.current?.connectionId || null,
  );
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] =
    useState<EmailSearchState>(EMPTY_SEARCH);
  const [indexedSearchState, setIndexedSearchState] =
    useState<IndexedEmailSearchState>(EMPTY_INDEXED_SEARCH);
  const [searchSuggestionsOpen, setSearchSuggestionsOpen] = useState(false);
  const [searchSuggestionIndex, setSearchSuggestionIndex] = useState(0);
  const [indexedSearchContacts, setIndexedSearchContacts] = useState<
    EmailContactSuggestion[]
  >([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<EmailThreadDetail | null>(null);
  const [openingThread, setOpeningThread] =
    useState<EmailThreadSummary | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [recoverableDrafts, setRecoverableDrafts] = useState<
    EmailComposerDraftSnapshot[]
  >([]);
  const [draftSyncing, setDraftSyncing] = useState(false);
  const [draftSyncError, setDraftSyncError] = useState<string | null>(null);
  const [draftDeleteTarget, setDraftDeleteTarget] =
    useState<EmailComposerDraftSnapshot | null>(null);
  const [draftDeletionBusyId, setDraftDeletionBusyId] = useState<string | null>(
    null,
  );
  const [threadComposeIntent, setThreadComposeIntent] =
    useState<ThreadComposeIntent | null>(null);
  const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [snippets, setSnippets] = useState<EmailSnippet[]>([]);
  const [selectedSnippetId, setSelectedSnippetId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mailboxSettingsOpen, setMailboxSettingsOpen] = useState(false);
  const [triageBusy, setTriageBusy] = useState(false);
  const [datagranScriptReady, setDatagranScriptReady] = useState(false);
  const [connectMailboxBusy, setConnectMailboxBusy] = useState(false);
  const [reconnectBusy, setReconnectBusy] = useState<string | null>(null);
  const [actionStates, setActionStates] = useState<
    Record<string, EmailActionUiState>
  >({});
  const [calendarRsvpStates, setCalendarRsvpStates] = useState<
    Record<string, CalendarRsvpUiState>
  >({});
  const [attachmentDownloadKey, setAttachmentDownloadKey] = useState<
    string | null
  >(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const feedRef = useRef(feed);
  const composerRef = useRef<ComposerState | null>(composer);
  const composerOwnerScopeRef = useRef<string | null>(
    composer ? emailCacheScope : null,
  );
  const composerDraftHydratedScopeRef = useRef<string | null>(null);
  const draftSyncRequestRef = useRef(0);
  const lastDraftSyncAtRef = useRef(0);
  composerRef.current = composer;
  const navigationStatsRef = useRef(navigationStats);
  const needsReviewCountRef = useRef<number | null>(null);
  const viewRef = useRef<WorkspaceView>(view);
  const mailboxFilterRef = useRef<string | null>(mailboxFilter);
  const feedCacheRef = useRef(
    new Map<string, WorkspaceFeedCacheEntry>(),
  );
  const hydratedCacheScopeRef = useRef<string | null>(null);
  const activatedFeedKeyRef = useRef<string | null>(null);
  const renderedFeedKeyRef = useRef<string | null>(null);
  const renderedFeedKeysRef = useRef(new Set<string>());
  const restoredNavigationFeedKeyRef = useRef<string | null>(null);
  const detailCacheRef = useRef(new Map<string, DetailCacheEntry>());
  const detailInflightRef = useRef(
    new Map<string, Promise<EmailThreadDetail>>(),
  );
  const detailAbortRef = useRef<AbortController | null>(null);
  const detailRequestRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchRequestRef = useRef(0);
  const indexedSearchAbortRef = useRef<AbortController | null>(null);
  const indexedSearchRequestRef = useRef(0);
  const searchContactAbortRef = useRef<AbortController | null>(null);
  const searchContactRequestRef = useRef(0);
  const locallyReadThreadCutoffsRef = useRef(new Map<string, number>());
  const pendingReadThreadIdentitiesRef = useRef(new Set<string>());
  const navigationSnapshotRef = useRef<EmailNavigationSnapshot | null>(null);
  const backgroundSnapshotRequestRef = useRef<{
    scope: string;
    promise: Promise<boolean>;
  } | null>(null);
  const focusDeltaAbortRef = useRef<AbortController | null>(null);
  const focusDeltaRequestRef = useRef(0);
  const lastFocusDeltaReconcileAtRef = useRef(0);
  const feedAbortRef = useRef<AbortController | null>(null);
  const needsReviewPrefetchAbortRef = useRef<AbortController | null>(null);
  const needsReviewPrefetchRequestRef = useRef(0);
  const feedRequestScopeRef = useRef<{
    view: EmailView;
    filter: string | null;
  } | null>(null);
  const feedRequestRef = useRef(0);
  const feedMutationVersionRef = useRef(0);
  const feedLimitRef = useRef(EMAIL_INITIAL_FEED_LIMIT);
  const lastFeedRequestAtRef = useRef(0);
  const foregroundLoadingRef = useRef(false);
  const backgroundRefreshingRef = useRef(false);
  const swipeActiveRef = useRef(false);
  const queuedBackgroundRefreshRef = useRef(false);
  const queuedMailboxHealthRef = useRef<EmailMailbox[] | null>(null);
  const mailboxHealthBusyRef = useRef(false);
  const pendingActionKeysRef = useRef(new Set<string>());
  const localWorkspaceCorrectionsRef = useRef(
    new Map<
      string,
      {
        correction: EmailWorkspaceCorrection;
        accepted: boolean;
        expiresAt: number;
      }
    >(),
  );
  const lastLocalEmailMutationAtRef = useRef(0);
  const completedSentRealtimeIdentitiesRef = useRef(new Set<string>());
  const attachmentDownloadKeyRef = useRef<string | null>(null);
  const actionQueueRef = useRef(new SerialEmailActionQueue());
  const lastWorkspaceShortcutRef = useRef<{
    shortcut: DesktopNativeEmailShortcut;
    source: "dom" | "native";
    at: number;
  } | null>(null);
  const triageBusyRef = useRef(false);
  const lastAutoTriageAtRef = useRef(0);
  const organizationStatusTimerRef = useRef<number | null>(null);
  const feedScrollRef = useRef<HTMLDivElement>(null);
  const detailScrollRef = useRef<HTMLDivElement>(null);
  const latestMessageRef = useRef<HTMLElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const mobileSwipeEnabled = useMobileSwipeEnabled();

  const showComposer = useCallback(
    (next: ComposerState) => {
      composerOwnerScopeRef.current = emailCacheScope;
      composerRef.current = next;
      setComposer(next);
    },
    [emailCacheScope],
  );

  const rememberComposer = useCallback(
    (draft: ComposerState, active = true) => {
      const storage = browserEmailDraftStorage();
      if (!storage) return;
      let state = persistEmailComposerDraft(
        storage,
        emailCacheScope,
        draft,
      );
      if (!active) {
        state = setActiveEmailComposerDraft(
          storage,
          emailCacheScope,
          null,
        );
      }
      setRecoverableDrafts((current) =>
        mergeEmailComposerDraftSnapshots(current, state.drafts),
      );
    },
    [emailCacheScope],
  );

  const deactivateComposer = useCallback(() => {
    const current = composerRef.current;
    if (
      current &&
      composerOwnerScopeRef.current === emailCacheScope
    ) {
      rememberComposer(current, false);
    }
    composerOwnerScopeRef.current = null;
    composerRef.current = null;
    setComposer(null);
  }, [emailCacheScope, rememberComposer]);

  const removeRecoverableDraft = useCallback(
    (localId: string) => {
      const storage = browserEmailDraftStorage();
      let localDrafts: EmailComposerDraftSnapshot[] = [];
      if (storage) {
        const state = removeEmailComposerDraft(
          storage,
          emailCacheScope,
          localId,
        );
        localDrafts = state.drafts;
      }
      setRecoverableDrafts((current) =>
        mergeEmailComposerDraftSnapshots(
          localDrafts,
          current.filter((draft) => draft.localId !== localId),
        ),
      );
      if (composerRef.current?.localId === localId) {
        composerOwnerScopeRef.current = null;
        composerRef.current = null;
        setComposer(null);
      }
    },
    [emailCacheScope],
  );

  const deleteRecoverableDraft = useCallback(
    async (draft: EmailComposerDraftSnapshot) => {
      if (draftDeletionBusyId) return;
      if (composerRef.current?.localId === draft.localId) {
        setDraftDeleteTarget(null);
        setError(
          "Use the trash button in the open composer to delete this draft safely.",
        );
        return;
      }
      const pendingSend = readPendingEmailSends(
        window.localStorage,
        emailCacheScope,
      ).some(
        (candidate) =>
          Boolean(draft.draftId) &&
          candidate.connectionId === draft.connectionId &&
          candidate.draftId === draft.draftId,
      );
      if (pendingSend) {
        setDraftDeleteTarget(null);
        setError(
          "This draft is currently being sent. Wait for Gmail to confirm it before deleting anything.",
        );
        return;
      }

      setDraftDeletionBusyId(draft.localId);
      setError(null);
      try {
        if (draft.draftId) {
          await jsonRequest("/api/email/draft", {
            method: "DELETE",
            body: JSON.stringify({
              connectionId: draft.connectionId,
              actionId: draft.actionId,
              draftId: draft.draftId,
              attachments: draft.attachments,
            }),
          });
        } else if (draft.attachments.length > 0) {
          const removed = await getSupabaseBrowserClient().storage
            .from(EMAIL_DRAFT_ATTACHMENT_BUCKET)
            .remove(
              draft.attachments.map((attachment) => attachment.storagePath),
            );
          if (removed.error) throw new Error(removed.error.message);
        }
        removeRecoverableDraft(draft.localId);
        setDraftDeleteTarget(null);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not delete this draft.",
        );
      } finally {
        setDraftDeletionBusyId(null);
      }
    },
    [draftDeletionBusyId, emailCacheScope, removeRecoverableDraft],
  );

  const openRecoverableDraft = useCallback(
    (snapshot: EmailComposerDraftSnapshot) => {
      deactivateComposer();
      setDetail(null);
      setOpeningThread(null);
      setThreadComposeIntent(null);
      setExpandedMessageIds(new Set());
      const restored = composerFromDraftSnapshot(snapshot);
      showComposer(restored);
      const storage = browserEmailDraftStorage();
      if (storage) {
        persistEmailComposerDraft(
          storage,
          emailCacheScope,
          snapshot,
          snapshot.updatedAt,
        );
        const state = setActiveEmailComposerDraft(
          storage,
          emailCacheScope,
          snapshot.localId,
        );
        setRecoverableDrafts((current) =>
          mergeEmailComposerDraftSnapshots(state.drafts, current),
        );
      }
    },
    [deactivateComposer, emailCacheScope, showComposer],
  );

  useEffect(() => {
    draftSyncRequestRef.current += 1;
    lastDraftSyncAtRef.current = 0;
    setDraftSyncing(false);
    setDraftSyncError(null);
    const storage = browserEmailDraftStorage();
    const state = storage
      ? readEmailComposerDraftState(storage, emailCacheScope)
      : { drafts: [], activeDraftId: null };
    composerDraftHydratedScopeRef.current = emailCacheScope;
    setRecoverableDrafts(state.drafts);
    const active = state.activeDraftId
      ? state.drafts.find((draft) => draft.localId === state.activeDraftId) ||
        null
      : null;
    const restored = active ? composerFromDraftSnapshot(active) : null;
    composerOwnerScopeRef.current = restored ? emailCacheScope : null;
    composerRef.current = restored;
    setComposer(restored);
    const legacyDrafts = state.drafts
      .filter(
        (draft): draft is EmailComposerDraftSnapshot & { draftId: string } =>
          Boolean(draft.draftId),
      )
      .slice(0, 5);
    void (async () => {
      for (const draft of legacyDrafts) {
        await fetch("/api/email/draft", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draft }),
        }).catch(() => undefined);
      }
    })();
  }, [emailCacheScope]);

  const syncRecoverableDrafts = useCallback(
    async (force = false) => {
      const now = Date.now();
      if (!force && now - lastDraftSyncAtRef.current < 10_000) return;
      const requestId = draftSyncRequestRef.current + 1;
      draftSyncRequestRef.current = requestId;
      const requestScope = emailCacheScope;
      setDraftSyncing(true);
      setDraftSyncError(null);
      try {
        const payload = await jsonRequest<{ ok: true; drafts: unknown[] }>(
          "/api/email/draft",
        );
        if (
          draftSyncRequestRef.current !== requestId ||
          emailCacheScopeRef.current !== requestScope
        ) {
          return;
        }
        const synced = payload.drafts
          .map(normalizeEmailComposerDraftSnapshot)
          .filter(
            (draft): draft is EmailComposerDraftSnapshot => Boolean(draft),
          );
        setRecoverableDrafts((current) =>
          mergeEmailComposerDraftSnapshots(current, synced),
        );
        lastDraftSyncAtRef.current = Date.now();
      } catch (reason) {
        if (
          draftSyncRequestRef.current !== requestId ||
          emailCacheScopeRef.current !== requestScope
        ) {
          return;
        }
        setDraftSyncError(
          reason instanceof Error
            ? reason.message
            : "Could not sync drafts across devices.",
        );
      } finally {
        if (draftSyncRequestRef.current === requestId) {
          setDraftSyncing(false);
        }
      }
    },
    [emailCacheScope],
  );

  useEffect(() => {
    if (!visible) return;
    void syncRecoverableDrafts();
  }, [syncRecoverableDrafts, visible, view]);

  useEffect(() => {
    if (!visible) return;
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible" && viewRef.current === "drafts") {
        void syncRecoverableDrafts();
      }
    };
    document.addEventListener("visibilitychange", syncWhenVisible);
    return () =>
      document.removeEventListener("visibilitychange", syncWhenVisible);
  }, [syncRecoverableDrafts, visible]);

  useEffect(() => {
    if (
      !composer ||
      composerDraftHydratedScopeRef.current !== emailCacheScope ||
      composerOwnerScopeRef.current !== emailCacheScope
    ) {
      return;
    }
    const timer = window.setTimeout(
      () => rememberComposer(composer),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [composer, emailCacheScope, rememberComposer]);

  useEffect(() => {
    const flush = () => {
      const current = composerRef.current;
      const storage = browserEmailDraftStorage();
      if (
        !current ||
        !storage ||
        composerOwnerScopeRef.current !== emailCacheScope
      ) {
        return;
      }
      persistEmailComposerDraft(storage, emailCacheScope, current);
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [emailCacheScope]);

  const applyAcceptedLocalWorkspaceCorrections = useCallback(
    (nextFeed: EmailFeedResponse): EmailFeedResponse => {
      const now = Date.now();
      const acceptedCorrections: EmailWorkspaceCorrection[] = [];
      for (const [identity, local] of localWorkspaceCorrectionsRef.current) {
        if (
          local.expiresAt <= now ||
          local.correction.userId !== emailCacheScopeRef.current
        ) {
          localWorkspaceCorrectionsRef.current.delete(identity);
          continue;
        }
        if (local.accepted) acceptedCorrections.push(local.correction);
      }
      return applyEmailWorkspaceCorrectionsToFeed(
        nextFeed,
        acceptedCorrections,
      );
    },
    [],
  );

  const replaceNavigationStats = useCallback(
    (
      next: EmailFeedResponse["stats"],
      authoritativeNeedsReviewCount?: number | null,
      sourceView: EmailView | "authoritative" = "authoritative",
    ) => {
      if (authoritativeNeedsReviewCount !== undefined) {
        needsReviewCountRef.current = authoritativeNeedsReviewCount;
        setPrefetchedNeedsReviewCount(authoritativeNeedsReviewCount);
      }
      const resolved = mergeEmailNavigationStats({
        current: navigationStatsRef.current,
        incoming: next,
        sourceView,
        authoritativeNeedsReviewCount:
          needsReviewCountRef.current ?? undefined,
      });
      navigationStatsRef.current = resolved;
      setNavigationStats(resolved);
    },
    [],
  );

  const cachedFeedFor = useCallback(
    (nextView: EmailView, connectionId: string | null) => {
      const key = emailFeedCacheKey(nextView, connectionId);
      const local = feedCacheRef.current.get(key);
      if (local) {
        const correctedFeed = applyAcceptedLocalWorkspaceCorrections(
          local.feed,
        );
        if (correctedFeed === local.feed) return local;
        const correctedEntry = {
          ...local,
          feed: correctedFeed,
          revision: nextEmailFeedCacheRevision(local),
        };
        feedCacheRef.current.set(key, correctedEntry);
        writeEmailFeedCache(
          emailCacheScope,
          nextView,
          connectionId,
          correctedEntry,
        );
        return correctedEntry;
      }
      const restored = readEmailFeedCache(
        emailCacheScope,
        nextView,
        connectionId,
      );
      if (!restored) return null;
      const entry: WorkspaceFeedCacheEntry = {
        ...restored,
        feed: applyAcceptedLocalWorkspaceCorrections(restored.feed),
        connectionId,
      };
      feedCacheRef.current.set(key, entry);
      return entry;
    },
    [applyAcceptedLocalWorkspaceCorrections, emailCacheScope],
  );

  const rememberFeed = useCallback(
    (
      nextView: EmailView,
      connectionId: string | null,
      nextFeed: EmailFeedResponse,
      limit: number,
      savedAt = Date.now(),
    ) => {
      const key = emailFeedCacheKey(nextView, connectionId);
      const current = feedCacheRef.current.get(key);
      const entry: WorkspaceFeedCacheEntry = {
        feed: nextFeed,
        limit,
        savedAt,
        connectionId,
        revision: nextEmailFeedCacheRevision(current),
      };
      feedCacheRef.current.set(key, entry);
      writeEmailFeedCache(emailCacheScope, nextView, connectionId, entry);
      if (
        nextView === viewRef.current &&
        connectionId === mailboxFilterRef.current
      ) {
        // iOS may terminate a suspended Home Screen app without running React
        // cleanup. Persist every rendered screen while it is current so the
        // next process can paint immediately from durable standalone storage.
        rememberEmailNavigationFeed({
          scope: emailCacheScope,
          view: nextView,
          connectionId,
          entry,
          capturedAt: savedAt,
        });
      }
      if (
        nextView === "inbox" &&
        connectionId === mailboxFilterRef.current
      ) {
        needsReviewCountRef.current = nextFeed.threads.length;
        setPrefetchedNeedsReviewCount(nextFeed.threads.length);
      }
      return entry;
    },
    [emailCacheScope],
  );

  const rememberConfirmedSentThread = useCallback(
    (sentThread: EmailThreadSummary | null) => {
      if (!sentThread) return;
      if (viewRef.current === "sent") {
        // Do not let an older in-flight Sent request overwrite the confirmed
        // Gmail result before the follow-up reconciliation starts.
        feedMutationVersionRef.current += 1;
      }
      for (const filter of new Set<string | null>([
        null,
        sentThread.connectionId,
      ])) {
        const cached = cachedFeedFor("sent", filter);
        const limit = cached?.limit || EMAIL_INITIAL_FEED_LIMIT;
        const current =
          cached?.feed ||
          ({
            ...EMPTY_FEED,
            view: "sent",
            mailboxes: feedRef.current.mailboxes,
            stats: navigationStatsRef.current,
          } satisfies EmailFeedResponse);
        const next = mergeConfirmedSentThread(current, sentThread, limit);
        rememberFeed("sent", filter, next, limit);
        if (
          viewRef.current === "sent" &&
          mailboxFilterRef.current === filter
        ) {
          const renderedKey = emailFeedCacheKey("sent", filter);
          feedRef.current = next;
          renderedFeedKeyRef.current = renderedKey;
          renderedFeedKeysRef.current.add(renderedKey);
          setFeed(next);
          setLoading(false);
          setLoadingView(null);
        }
      }
    },
    [cachedFeedFor, rememberFeed],
  );

  const keepSentConversationLocally = useCallback(
    (thread: EmailThreadSummary) => {
      const canonicalStats =
        thread.action?.lane === "ready"
          ? {
              ...navigationStatsRef.current,
              draftsReady: Math.max(
                0,
                navigationStatsRef.current.draftsReady - 1,
              ),
            }
          : navigationStatsRef.current;
      if (canonicalStats !== navigationStatsRef.current) {
        replaceNavigationStats(canonicalStats);
      }
      const savedAt = Date.now();
      for (const cached of Array.from(feedCacheRef.current.values())) {
        const updated = keepSentConversationInFeed(cached.feed, thread);
        const next =
          cached.connectionId === mailboxFilterRef.current
            ? { ...updated, stats: canonicalStats }
            : updated;
        if (next === cached.feed) continue;
        rememberFeed(
          cached.feed.view,
          cached.connectionId,
          next,
          cached.limit,
          savedAt,
        );
        if (
          viewRef.current === cached.feed.view &&
          mailboxFilterRef.current === cached.connectionId
        ) {
          feedRef.current = next;
          setFeed(next);
        }
      }
    },
    [rememberFeed, replaceNavigationStats],
  );

  const applyFocusActionDelta = useCallback(
    async (args: {
      actionIds?: string[];
      updatedAfter?: string;
      filter?: string | null;
    }): Promise<boolean> => {
      const actionIds = Array.from(
        new Set(
          (args.actionIds || []).filter((value) => Boolean(value)),
        ),
      ).slice(0, 50);
      if (actionIds.length === 0 && !args.updatedAfter) return false;
      const filter = args.filter ?? null;
      const requestId = focusDeltaRequestRef.current + 1;
      focusDeltaRequestRef.current = requestId;
      focusDeltaAbortRef.current?.abort();
      const controller = new AbortController();
      focusDeltaAbortRef.current = controller;
      const params = new URLSearchParams({
        view: "focus",
        limit: String(EMAIL_INITIAL_FEED_LIMIT),
        sync: "delta",
      });
      if (filter) params.set("connectionId", filter);
      for (const actionId of actionIds) {
        params.append("actionId", actionId);
      }
      if (args.updatedAfter) {
        params.set("updatedAfter", args.updatedAfter);
      }
      try {
        const payload = await jsonRequest<
          EmailFeedResponse & { ok: true }
        >(`/api/email/feed?${params.toString()}`, {
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          focusDeltaRequestRef.current !== requestId ||
          emailCacheScopeRef.current !== emailCacheScope
        ) {
          return false;
        }
        const cached = cachedFeedFor("focus", filter);
        const current =
          cached?.feed ||
          (viewRef.current === "focus" &&
          mailboxFilterRef.current === filter
            ? feedRef.current
            : {
                ...EMPTY_FEED,
                view: "focus" as const,
                mailboxes: payload.mailboxes,
              });
        const merged = mergeEmailFocusNotificationSnapshot(
          current,
          payload,
          Math.max(
            EMAIL_INITIAL_FEED_LIMIT,
            cached?.limit || feedLimitRef.current,
          ),
        );
        const reconciled = preserveLocallyReadEmailThreads(
          applyAcceptedLocalWorkspaceCorrections(merged),
          locallyReadThreadCutoffsRef.current,
        );
        const resilient = preserveTransientMailboxFailures(
          current,
          reconciled,
        );
        const resolved = preserveStableEmailThreadReferences(
          current,
          resilient,
        );
        const savedAt = Date.now();
        rememberFeed(
          "focus",
          filter,
          resolved,
          cached?.limit || EMAIL_INITIAL_FEED_LIMIT,
          savedAt,
        );
        if (
          viewRef.current === "focus" &&
          mailboxFilterRef.current === filter &&
          !swipeActiveRef.current &&
          pendingActionKeysRef.current.size === 0
        ) {
          feedRef.current = resolved;
          renderedFeedKeyRef.current = emailFeedCacheKey("focus", filter);
          renderedFeedKeysRef.current.add(
            emailFeedCacheKey("focus", filter),
          );
          setFeed(resolved);
          setLoading(false);
          setLoadingView(null);
        }
        replaceNavigationStats(resolved.stats, undefined, "focus");
        return true;
      } catch {
        return false;
      } finally {
        if (focusDeltaAbortRef.current === controller) {
          focusDeltaAbortRef.current = null;
        }
      }
    },
    [
      applyAcceptedLocalWorkspaceCorrections,
      cachedFeedFor,
      emailCacheScope,
      rememberFeed,
      replaceNavigationStats,
    ],
  );

  const reconcileFocusActionState = useCallback(
    async (force = false): Promise<boolean> => {
      const now = Date.now();
      if (
        !force &&
        now - lastFocusDeltaReconcileAtRef.current <
          EMAIL_FOCUS_DELTA_RECONCILE_COOLDOWN_MS
      ) {
        return false;
      }
      lastFocusDeltaReconcileAtRef.current = now;
      const filter = mailboxFilterRef.current;
      const cached = cachedFeedFor("focus", filter);
      const current =
        cached?.feed ||
        (viewRef.current === "focus" ? feedRef.current : null);
      const actionIds = (current?.threads || [])
        .map((thread) => thread.action?.id || "")
        .filter(Boolean);
      const exactApplied =
        actionIds.length > 0
          ? await applyFocusActionDelta({ actionIds, filter })
          : false;
      const recentApplied = await applyFocusActionDelta({
        updatedAfter: new Date(
          now - EMAIL_FOCUS_DELTA_RECONCILE_WINDOW_MS,
        ).toISOString(),
        filter,
      });
      return exactApplied || recentApplied;
    },
    [applyFocusActionDelta, cachedFeedFor],
  );

  const applyBackgroundFocusSnapshot = useCallback((): Promise<boolean> => {
    const existing = backgroundSnapshotRequestRef.current;
    if (existing?.scope === emailCacheScope) return existing.promise;
    const request = (async () => {
      const snapshot = await readEmailBackgroundFocusSnapshot({
        scope: emailCacheScope,
      });
      if (emailCacheScopeRef.current !== emailCacheScope) return false;
      if (
        snapshot &&
        viewRef.current === "focus" &&
        mailboxFilterRef.current === null &&
        !swipeActiveRef.current &&
        pendingActionKeysRef.current.size === 0
      ) {
        const current = feedCacheRef.current.get(
          emailFeedCacheKey("focus", null),
        );
        if (!current || snapshot.savedAt > current.savedAt) {
          const snapshotFeed =
            snapshot.kind === "notification"
              ? mergeEmailFocusNotificationSnapshot(
                  feedRef.current,
                  snapshot.feed,
                  Math.max(EMAIL_INITIAL_FEED_LIMIT, feedLimitRef.current),
                )
              : snapshot.feed;
          const reconciled = preserveLocallyReadEmailThreads(
            applyAcceptedLocalWorkspaceCorrections(snapshotFeed),
            locallyReadThreadCutoffsRef.current,
          );
          const resilient = preserveTransientMailboxFailures(
            feedRef.current,
            reconciled,
          );
          const resolved = preserveStableEmailThreadReferences(
            feedRef.current,
            resilient,
          );
          rememberFeed(
            "focus",
            null,
            resolved,
            EMAIL_INITIAL_FEED_LIMIT,
            snapshot.savedAt,
          );
          feedRef.current = resolved;
          const focusKey = emailFeedCacheKey("focus", null);
          renderedFeedKeyRef.current = focusKey;
          renderedFeedKeysRef.current.add(focusKey);
          lastFeedRequestAtRef.current = snapshot.savedAt;
          setFeed(resolved);
          replaceNavigationStats(resolved.stats, undefined, "focus");
          setLoading(false);
          setLoadingView(null);
          setRefreshFailed(false);
          setFeedError(null);
          setLastRefreshedAt(new Date(snapshot.savedAt));
          return true;
        }
      }
      return false;
    })().finally(() => {
      if (backgroundSnapshotRequestRef.current?.promise === request) {
        backgroundSnapshotRequestRef.current = null;
      }
    });
    backgroundSnapshotRequestRef.current = {
      scope: emailCacheScope,
      promise: request,
    };
    return request;
  }, [
    applyAcceptedLocalWorkspaceCorrections,
    emailCacheScope,
    rememberFeed,
    replaceNavigationStats,
  ]);

  useEffect(() => {
    if (!cacheHydrated) return;
    let cancelled = false;
    void applyBackgroundFocusSnapshot()
      .then(() => reconcileFocusActionState(true))
      .finally(() => {
        if (!cancelled) setBackgroundSnapshotScope(emailCacheScope);
      });
    return () => {
      cancelled = true;
    };
  }, [
    applyBackgroundFocusSnapshot,
    cacheHydrated,
    emailCacheScope,
    reconcileFocusActionState,
  ]);

  useEffect(() => {
    if (!cacheHydrated) return;
    const applySnapshot = () => {
      void applyBackgroundFocusSnapshot().then(() =>
        reconcileFocusActionState(),
      );
    };
    const onServiceWorkerMessage = (event: MessageEvent) => {
      if (
        event.data?.type !== "groovy-email-focus-snapshot" ||
        (typeof event.data.scope === "string" &&
          event.data.scope !== emailCacheScope)
      ) {
        return;
      }
      applySnapshot();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") applySnapshot();
    };
    navigator.serviceWorker?.addEventListener(
      "message",
      onServiceWorkerMessage,
    );
    window.addEventListener("focus", applySnapshot);
    window.addEventListener("pageshow", applySnapshot);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      navigator.serviceWorker?.removeEventListener(
        "message",
        onServiceWorkerMessage,
      );
      window.removeEventListener("focus", applySnapshot);
      window.removeEventListener("pageshow", applySnapshot);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    applyBackgroundFocusSnapshot,
    cacheHydrated,
    emailCacheScope,
    reconcileFocusActionState,
  ]);

  useLayoutEffect(() => {
    // React Activity reconnects layout effects whenever a hidden workspace is
    // shown again. Hydration is destructive when Focus has no fresh navigation
    // snapshot, so only hydrate once for a cache scope and preserve the live
    // component state on later Chat/Email switches.
    if (hydratedCacheScopeRef.current === emailCacheScope) return;
    hydratedCacheScopeRef.current = emailCacheScope;
    renderedFeedKeysRef.current = new Set();
    const restoredEntries = readEmailFeedCaches(emailCacheScope);
    const restoredMap = new Map<string, WorkspaceFeedCacheEntry>();
    for (const { view: cachedView, connectionId, entry } of restoredEntries) {
      restoredMap.set(emailFeedCacheKey(cachedView, connectionId), {
        ...entry,
        connectionId,
      });
    }
    feedCacheRef.current = restoredMap;

    const currentView = viewRef.current;
    const currentFilter = mailboxFilterRef.current;
    const currentKey = isEmailView(currentView)
      ? emailFeedCacheKey(currentView, currentFilter)
      : null;
    const navigationCurrent = isEmailView(currentView)
      ? readEmailNavigationFeed({
            scope: emailCacheScope,
            view: currentView,
            connectionId: currentFilter,
          })
      : null;
    const persistentCurrent =
      isEmailView(currentView) &&
      canHydrateEmailFeedFromCache(currentView)
        ? restoredMap.get(emailFeedCacheKey(currentView, currentFilter))
        : null;
    const current = navigationCurrent
      ? { ...navigationCurrent, connectionId: currentFilter }
      : persistentCurrent;
    restoredNavigationFeedKeyRef.current = navigationCurrent
      ? currentKey
      : null;
    if (current && currentKey) restoredMap.set(currentKey, current);
    const cachedNeedsReview = restoredMap.get(
      emailFeedCacheKey("inbox", currentFilter),
    );
    const cachedFocus = restoredMap.get(
      emailFeedCacheKey("focus", currentFilter),
    );
    const newestScopedEntry = restoredEntries.find(
      (entry) => entry.connectionId === currentFilter,
    );
    const hydratedNeedsReviewCount =
      currentView === "inbox" && current
        ? current.feed.threads.length
        : cachedNeedsReview?.feed.threads.length ?? null;
    replaceNavigationStats(
      navigationStatsFromCachedFeeds({
        fallback:
          newestScopedEntry?.entry.feed.stats ??
          current?.feed.stats ??
          EMPTY_FEED.stats,
        focus: cachedFocus?.feed.stats,
        needsReviewCount: hydratedNeedsReviewCount,
      }),
      hydratedNeedsReviewCount,
      "authoritative",
    );
    if (current) {
      renderedFeedKeyRef.current = currentKey;
      feedLimitRef.current = current.limit;
      feedRef.current = current.feed;
      if (navigationCurrent) {
        lastFeedRequestAtRef.current = current.savedAt;
      }
      setFeed(current.feed);
      setLoading(false);
      setLoadingView(null);
      setRefreshFailed(false);
      setFeedError(null);
      setLastRefreshedAt(new Date(current.savedAt));
    } else {
      renderedFeedKeyRef.current = null;
      feedLimitRef.current = EMAIL_INITIAL_FEED_LIMIT;
      feedRef.current = EMPTY_FEED;
      setFeed(EMPTY_FEED);
      setLoading(isEmailView(currentView));
      setLoadingView(isEmailView(currentView) ? currentView : null);
      setRefreshFailed(false);
      setFeedError(null);
      setLastRefreshedAt(null);
    }
    setCacheHydrated(true);
  }, [emailCacheScope, replaceNavigationStats]);

  useEffect(
    () => () => {
      const currentView = viewRef.current;
      if (!isEmailView(currentView)) return;
      const currentFilter = mailboxFilterRef.current;
      const cached = feedCacheRef.current.get(
        emailFeedCacheKey(currentView, currentFilter),
      );
      if (!cached || cached.feed.view !== currentView) return;
      rememberEmailNavigationFeed({
        scope: emailCacheScope,
        view: currentView,
        connectionId: currentFilter,
        entry: cached,
      });
    },
    [emailCacheScope],
  );

  const loadFeed = useCallback(
    async (
      nextView = view,
      filter = mailboxFilter,
      options?: {
        append?: boolean;
        background?: boolean;
        cursor?: string | null;
        limit?: number;
        totalLimit?: number;
        forceProvider?: boolean;
      },
    ) => {
      if (!isEmailView(nextView)) return;
      if (
        viewRef.current !== nextView ||
        mailboxFilterRef.current !== filter
      ) {
        return;
      }
      const background = options?.background === true;
      // Any feed request started while an action is pending can race the
      // mutation and be discarded by feedMutationVersionRef. Remember that
      // work even for a no-cache foreground navigation so the queue drain
      // performs one authoritative reconciliation after the mutation settles.
      if (pendingActionKeysRef.current.size > 0) {
        queuedBackgroundRefreshRef.current = true;
      }
      const limit = Math.min(
        EMAIL_MAX_FEED_LIMIT,
        Math.max(1, options?.limit || feedLimitRef.current),
      );
      const activeScope = feedRequestScopeRef.current;
      const sameActiveScope =
        activeScope?.view === nextView &&
        activeScope.filter === filter;
      const sameScopeRequestInFlight =
        sameActiveScope &&
        (foregroundLoadingRef.current || backgroundRefreshingRef.current);
      if (
        shouldCoalesceEmailFeedRequest({
          sameScope: sameActiveScope,
          requestInFlight: sameScopeRequestInFlight,
          append: options?.append === true,
          hasCursor: Boolean(options?.cursor),
        })
      ) {
        // Realtime, the action queue, visibility changes, and background sync
        // can all request the same reconciliation together. Aborting the
        // browser fetch does not stop an already-running serverless Gmail
        // request, so coalesce here instead of creating a provider request
        // storm. A mutation still schedules one authoritative post-drain run.
        if (pendingActionKeysRef.current.size > 0) {
          queuedBackgroundRefreshRef.current = true;
        }
        return;
      }
      if (
        background &&
        (swipeActiveRef.current ||
          pendingActionKeysRef.current.size > 0)
      ) {
        queuedBackgroundRefreshRef.current = true;
        return;
      }
      const requestId = feedRequestRef.current + 1;
      const mutationVersion = feedMutationVersionRef.current;
      feedRequestRef.current = requestId;
      feedAbortRef.current?.abort();
      const controller = new AbortController();
      feedAbortRef.current = controller;
      feedRequestScopeRef.current = { view: nextView, filter };
      lastFeedRequestAtRef.current = Date.now();
      if (background) {
        backgroundRefreshingRef.current = true;
        setBackgroundRefreshing(true);
      } else {
        foregroundLoadingRef.current = true;
        backgroundRefreshingRef.current = false;
        setBackgroundRefreshing(false);
        setLoading(true);
        setLoadingView(nextView);
        setFeedError(null);
        setError(null);
      }
      let snapshotApplied = false;
      const isCurrentRequest = () =>
        isCurrentEmailFeedRequest(
          {
            requestId,
            mutationVersion,
            view: nextView,
            connectionId: filter,
          },
          {
            requestId: feedRequestRef.current,
            mutationVersion: feedMutationVersionRef.current,
            view: isEmailView(viewRef.current)
              ? viewRef.current
              : "snippets",
            connectionId: mailboxFilterRef.current,
          },
        );
      const applyPayload = (
        payload: EmailFeedResponse,
        optionsForPayload: {
          backgroundLike: boolean;
          append: boolean;
        },
      ) => {
        if (!isCurrentRequest()) return false;
        if (
          optionsForPayload.backgroundLike &&
          (swipeActiveRef.current ||
            pendingActionKeysRef.current.size > 0)
        ) {
          queuedBackgroundRefreshRef.current = true;
          return false;
        }
        const reconciledPayload = preserveLocallyReadEmailThreads(
          applyAcceptedLocalWorkspaceCorrections(payload),
          locallyReadThreadCutoffsRef.current,
        );
        const resilientPayload = optionsForPayload.backgroundLike
          ? preserveTransientMailboxFailures(
              feedRef.current,
              reconciledPayload,
            )
          : reconciledPayload;
        const resolvedFeed = optionsForPayload.append
          ? mergeEmailFeedPage(
              feedRef.current,
              resilientPayload,
              options?.totalLimit || EMAIL_MAX_FEED_LIMIT,
            )
          : optionsForPayload.backgroundLike
            ? preserveStableEmailThreadReferences(
                feedRef.current,
                resilientPayload,
              )
            : resilientPayload;
        const cachedLimit = optionsForPayload.append
          ? options?.totalLimit || feedLimitRef.current
          : limit;
        const refreshedAt = Date.now();
        rememberFeed(
          nextView,
          filter,
          resolvedFeed,
          cachedLimit,
          refreshedAt,
        );
        if (
          !optionsForPayload.append &&
          reconciledPayload.warnings.length === 0
        ) {
          for (const cachedEntry of Array.from(
            feedCacheRef.current.values(),
          )) {
            if (
              cachedEntry.feed.view === nextView
            ) {
              continue;
            }
            const reconciledCachedFeed =
              removeEmailConversationsClaimedByFeed(
                cachedEntry.feed,
                reconciledPayload,
              );
            if (reconciledCachedFeed === cachedEntry.feed) continue;
            rememberFeed(
              cachedEntry.feed.view,
              cachedEntry.connectionId,
              reconciledCachedFeed,
              cachedEntry.limit,
              refreshedAt,
            );
            if (cachedEntry.connectionId === filter) {
              const currentStats = navigationStatsRef.current;
              if (cachedEntry.feed.view === "focus") {
                navigationStatsRef.current = {
                  ...currentStats,
                  focus: Math.max(
                    0,
                    currentStats.focus -
                      (cachedEntry.feed.stats.focus -
                        reconciledCachedFeed.stats.focus),
                  ),
                  draftsReady: Math.max(
                    0,
                    currentStats.draftsReady -
                      (cachedEntry.feed.stats.draftsReady -
                        reconciledCachedFeed.stats.draftsReady),
                  ),
                };
              } else if (cachedEntry.feed.view === "inbox") {
                navigationStatsRef.current = {
                  ...currentStats,
                  needsReview: Math.max(
                    0,
                    currentStats.needsReview -
                      (cachedEntry.feed.stats.needsReview -
                        reconciledCachedFeed.stats.needsReview),
                  ),
                };
              } else if (cachedEntry.feed.view === "noise") {
                navigationStatsRef.current = {
                  ...currentStats,
                  noiseCaught: Math.max(
                    0,
                    currentStats.noiseCaught -
                      (cachedEntry.feed.stats.noiseCaught -
                        reconciledCachedFeed.stats.noiseCaught),
                  ),
                };
              } else if (cachedEntry.feed.view === "handled") {
                navigationStatsRef.current = {
                  ...currentStats,
                  processed: Math.max(
                    0,
                    currentStats.processed -
                      (cachedEntry.feed.stats.processed -
                        reconciledCachedFeed.stats.processed),
                  ),
                };
              }
            }
          }
        }
        feedRef.current = resolvedFeed;
        const renderedKey = emailFeedCacheKey(nextView, filter);
        renderedFeedKeyRef.current = renderedKey;
        renderedFeedKeysRef.current.add(renderedKey);
        setFeed(resolvedFeed);
        const cachedNeedsReview =
          nextView === "inbox"
            ? null
            : feedCacheRef.current.get(
                emailFeedCacheKey("inbox", filter),
              );
        const authoritativeNeedsReviewCount =
          nextView === "inbox"
            ? resolvedFeed.threads.length
            : nextView === "focus" &&
                !optionsForPayload.append &&
                resolvedFeed.warnings.length === 0
              ? resolvedFeed.stats.needsReview
              : cachedNeedsReview
                ? cachedNeedsReview.feed.threads.length
                : undefined;
        replaceNavigationStats(
          resolvedFeed.stats,
          authoritativeNeedsReviewCount,
          nextView,
        );
        setRefreshFailed(resolvedFeed.warnings.length > 0);
        setFeedError(null);
        setLastRefreshedAt(new Date(refreshedAt));
        setSelectedKey((current) => {
          if (
            current &&
            resolvedFeed.threads.some((item) => item.key === current)
          ) {
            return current;
          }
          return null;
        });
        return true;
      };
      const params = new URLSearchParams({
        view: nextView,
        limit: String(limit),
      });
      if (filter) params.set("connectionId", filter);
      if (options?.cursor) params.set("cursor", options.cursor);
      if (options?.forceProvider) params.set("refresh", "force");
      const progressive =
        !background &&
        !options?.append &&
        !options?.cursor &&
        supportsProgressiveEmailSnapshot(nextView);
      try {
        if (progressive) {
          const snapshotParams = new URLSearchParams(params);
          snapshotParams.set("sync", "snapshot");
          try {
            const snapshot = await jsonRequest<
              EmailFeedResponse & { ok: true }
            >(`/api/email/feed?${snapshotParams.toString()}`, {
              signal: controller.signal,
            });
            snapshotApplied = applyPayload(snapshot, {
              backgroundLike: false,
              append: false,
            });
            if (snapshotApplied) {
              foregroundLoadingRef.current = false;
              setLoading(false);
              setLoadingView(null);
              backgroundRefreshingRef.current = true;
              setBackgroundRefreshing(true);
            }
          } catch {
            // The live request below remains the authoritative fallback.
          }
        }
        const payload = await jsonRequest<
          EmailFeedResponse & { ok: true }
        >(`/api/email/feed?${params.toString()}`, {
          signal: controller.signal,
        });
        applyPayload(payload, {
          backgroundLike: background || snapshotApplied,
          append: options?.append === true,
        });
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (!isCurrentRequest()) return;
        if (!background && !snapshotApplied) {
          setFeedError(
            reason instanceof Error
              ? reason.message
              : "Could not load your email.",
          );
        } else {
          setRefreshFailed(true);
        }
      } finally {
        if (feedRequestRef.current === requestId) {
          if (feedAbortRef.current === controller) {
            feedAbortRef.current = null;
            feedRequestScopeRef.current = null;
          }
          if (background || snapshotApplied) {
            backgroundRefreshingRef.current = false;
            setBackgroundRefreshing(false);
          }
          if (!background) {
            foregroundLoadingRef.current = false;
            setLoading(false);
            setLoadingView(null);
          }
        }
      }
    },
    [
      applyAcceptedLocalWorkspaceCorrections,
      mailboxFilter,
      rememberFeed,
      replaceNavigationStats,
      view,
    ],
  );

  const flushQueuedActionRefresh = useCallback(() => {
    if (pendingActionKeysRef.current.size > 0) return;
    const shouldRefresh = queuedBackgroundRefreshRef.current;
    queuedBackgroundRefreshRef.current = false;
    if (!shouldRefresh) return;
    window.setTimeout(() => {
      const activeView = viewRef.current;
      if (!isEmailView(activeView)) return;
      void loadFeed(activeView, mailboxFilterRef.current, {
        background: true,
        limit: feedLimitRef.current,
      });
    }, 220);
  }, [loadFeed]);

  const prefetchNeedsReview = useCallback(
    async (filter = mailboxFilterRef.current) => {
      if (viewRef.current === "inbox") {
        await loadFeed("inbox", filter, {
          background: true,
          limit: feedLimitRef.current,
        });
        return;
      }

      const cached = feedCacheRef.current.get(
        emailFeedCacheKey("inbox", filter),
      );
      const limit = Math.min(
        EMAIL_MAX_FEED_LIMIT,
        Math.max(EMAIL_INITIAL_FEED_LIMIT, cached?.limit || 0),
      );
      const requestId = needsReviewPrefetchRequestRef.current + 1;
      const mutationVersion = feedMutationVersionRef.current;
      needsReviewPrefetchRequestRef.current = requestId;
      needsReviewPrefetchAbortRef.current?.abort();
      const controller = new AbortController();
      needsReviewPrefetchAbortRef.current = controller;
      const params = new URLSearchParams({
        view: "inbox",
        limit: String(limit),
      });
      if (filter) params.set("connectionId", filter);

      try {
        const payload = await jsonRequest<
          EmailFeedResponse & { ok: true }
        >(`/api/email/feed?${params.toString()}`, {
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          needsReviewPrefetchRequestRef.current !== requestId ||
          mailboxFilterRef.current !== filter ||
          feedMutationVersionRef.current !== mutationVersion ||
          pendingActionKeysRef.current.size > 0 ||
          swipeActiveRef.current ||
          payload.warnings.length > 0
        ) {
          return;
        }
        const reconciled = preserveLocallyReadEmailThreads(
          applyAcceptedLocalWorkspaceCorrections(payload),
          locallyReadThreadCutoffsRef.current,
        );
        const resilient = cached
          ? preserveTransientMailboxFailures(cached.feed, reconciled)
          : reconciled;
        const resolved = cached
          ? preserveStableEmailThreadReferences(cached.feed, resilient)
          : resilient;
        rememberFeed("inbox", filter, resolved, limit);
        replaceNavigationStats(
          resolved.stats,
          resolved.threads.length,
          "inbox",
        );
      } catch {
        // This is a best-effort badge/cache refresh. The visible queue keeps
        // its existing state and opening Needs Review still performs a live
        // authoritative load.
      } finally {
        if (needsReviewPrefetchAbortRef.current === controller) {
          needsReviewPrefetchAbortRef.current = null;
        }
      }
    },
    [
      applyAcceptedLocalWorkspaceCorrections,
      loadFeed,
      rememberFeed,
      replaceNavigationStats,
    ],
  );

  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);

  useEffect(
    () => () => {
      focusDeltaAbortRef.current?.abort();
      feedAbortRef.current?.abort();
      needsReviewPrefetchAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    mailboxFilterRef.current = mailboxFilter;
  }, [mailboxFilter]);

  const applyMailboxHealth = useCallback(
    (mailboxes: EmailMailbox[]) => {
      for (const cached of feedCacheRef.current.values()) {
        rememberFeed(
          cached.feed.view,
          cached.connectionId,
          mergeEmailMailboxHealth(cached.feed, mailboxes),
          cached.limit,
          cached.savedAt,
        );
      }
      const nextFeed = mergeEmailMailboxHealth(feedRef.current, mailboxes);
      feedRef.current = nextFeed;
      setFeed(nextFeed);
    },
    [rememberFeed],
  );

  const loadMailboxHealth = useCallback(async () => {
    if (mailboxHealthBusyRef.current) return;
    mailboxHealthBusyRef.current = true;
    try {
      const payload = await jsonRequest<{
        ok: true;
        mailboxes: EmailMailbox[];
      }>("/api/email/mailboxes");
      if (swipeActiveRef.current) {
        queuedMailboxHealthRef.current = payload.mailboxes;
      } else {
        applyMailboxHealth(payload.mailboxes);
      }
    } catch {
      // Health verification is advisory; the email list should stay usable.
    } finally {
      mailboxHealthBusyRef.current = false;
    }
  }, [applyMailboxHealth]);

  const handleSwipeActivity = useCallback(
    (active: boolean) => {
      swipeActiveRef.current = active;
      if (!active && queuedMailboxHealthRef.current) {
        const mailboxes = queuedMailboxHealthRef.current;
        queuedMailboxHealthRef.current = null;
        applyMailboxHealth(mailboxes);
      }
      if (
        active ||
        !queuedBackgroundRefreshRef.current ||
        pendingActionKeysRef.current.size > 0
      ) {
        return;
      }
      queuedBackgroundRefreshRef.current = false;
      window.setTimeout(() => {
        void loadFeed(view, mailboxFilter, {
          background: true,
          limit: feedLimitRef.current,
        });
      }, 180);
    },
    [applyMailboxHealth, loadFeed, mailboxFilter, view],
  );

  const showOrganizationStatus = useCallback((message: string) => {
    setOrganizationStatus(message);
    if (organizationStatusTimerRef.current !== null) {
      window.clearTimeout(organizationStatusTimerRef.current);
    }
    organizationStatusTimerRef.current = window.setTimeout(() => {
      setOrganizationStatus(null);
      organizationStatusTimerRef.current = null;
    }, 5_000);
  }, []);

  const downloadAttachment = useCallback(
    async (args: { key: string; url: string; filename: string }) => {
      if (attachmentDownloadKeyRef.current) return;
      attachmentDownloadKeyRef.current = args.key;
      setAttachmentDownloadKey(args.key);
      setError(null);
      try {
        const response = await fetch(args.url);
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          if (response.status === 429) {
            throw new Error(
              "Gmail is temporarily busy. Please try this attachment again in a moment.",
            );
          }
          throw new Error(
            errorMessage(payload, "Could not download this attachment."),
          );
        }
        const blob = await response.blob();
        if (blob.size === 0) {
          throw new Error("This attachment is empty.");
        }
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = safeEmailAttachmentFilename(args.filename);
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
        showOrganizationStatus(`Downloaded ${args.filename}`);
      } catch (downloadError) {
        setError(
          downloadError instanceof Error
            ? downloadError.message
            : "Could not download this attachment.",
        );
      } finally {
        attachmentDownloadKeyRef.current = null;
        setAttachmentDownloadKey(null);
      }
    },
    [showOrganizationStatus],
  );

  const runTriage = useCallback(
    async (options?: { manual?: boolean }) => {
      const manual = options?.manual === true;
      if (triageBusyRef.current) return;
      if (
        !manual &&
        Date.now() - lastAutoTriageAtRef.current < EMAIL_TRIAGE_INTERVAL_MS
      ) {
        return;
      }
      triageBusyRef.current = true;
      if (!manual) lastAutoTriageAtRef.current = Date.now();
      setTriageBusy(true);
      if (manual) setError(null);
      try {
        const payload = await jsonRequest<{
          ok: true;
          discovery?: {
            checked?: number;
            newMessages?: number;
            remaining?: number;
          };
        }>("/api/email/triage", {
          method: "POST",
          body: JSON.stringify({}),
        });
        const organized = Number(payload.discovery?.newMessages || 0);
        const remaining = Number(payload.discovery?.remaining || 0);
        showOrganizationStatus(
          organized > 0
            ? `Organized ${organized} new ${organized === 1 ? "email" : "emails"}${
                remaining > 0 ? ` · ${remaining} next` : ""
              }`
            : "Focus is up to date",
        );
        await loadFeed(view, mailboxFilter, {
          background: true,
        });
      } catch (reason) {
        if (manual) {
          setError(
            reason instanceof Error ? reason.message : "Could not run triage.",
          );
        } else {
          showOrganizationStatus("AI organization will retry shortly");
        }
      } finally {
        triageBusyRef.current = false;
        setTriageBusy(false);
      }
    },
    [loadFeed, mailboxFilter, showOrganizationStatus, view],
  );

  const reconnectMailbox = useCallback(
    async (
      mailbox: EmailMailbox,
      options?: { recipientTracking?: boolean },
    ): Promise<boolean> => {
      const desktop = isDesktopShell();
      if (!desktop && (!datagranScriptReady || !window.DatagranLink)) {
        setError(
          "The secure Gmail connection window is still loading. Try again in a moment.",
        );
        return false;
      }
      setReconnectBusy(mailbox.connectionId);
      setError(null);
      try {
        if (desktop) {
          await connectDatagranInSystemBrowser({
            provider: "gmail",
            connectionId: mailbox.connectionId,
            recipientTracking: options?.recipientTracking,
          });
        } else {
          const token = await jsonRequest<{
            ok: true;
            agentId: string;
            linkToken: string;
          }>("/api/email/reconnect", {
            method: "POST",
            body: JSON.stringify({
              connectionId: mailbox.connectionId,
              ...(options?.recipientTracking
                ? { recipientTracking: true }
                : {}),
            }),
          });
          await new Promise<void>((resolve, reject) => {
            let connectionCompleted = false;
            window.DatagranLink!.open({
              linkToken: token.linkToken,
              onSuccess: async (payload) => {
                try {
                  if (!payload.connection_id) {
                    throw new Error("Gmail did not return a connection.");
                  }
                  await jsonRequest("/api/datagran/connection", {
                    method: "POST",
                    body: JSON.stringify({
                      agentId: token.agentId,
                      connectionId: payload.connection_id,
                    }),
                  });
                  connectionCompleted = true;
                  resolve();
                } catch (reason) {
                  reject(reason);
                }
              },
              onExit: () => {
                if (!connectionCompleted) {
                  reject(
                    new Error(
                      "The Gmail connection window closed before permission was granted.",
                    ),
                  );
                }
              },
            });
          });
        }
        showOrganizationStatus(
          options?.recipientTracking
            ? `Individual read receipts enabled for ${mailbox.displayName}`
            : `${mailbox.displayName} reconnected`,
        );
        lastAutoTriageAtRef.current = 0;
        await loadFeed(view, mailboxFilter, {
          background: true,
        });
        return true;
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not reconnect Gmail.",
        );
        return false;
      } finally {
        setReconnectBusy(null);
      }
    },
    [
      datagranScriptReady,
      loadFeed,
      mailboxFilter,
      showOrganizationStatus,
      view,
    ],
  );

  const connectMailbox = useCallback(async () => {
    const desktop = isDesktopShell();
    if (!desktop && (!datagranScriptReady || !window.DatagranLink)) {
      setError(
        "The secure Gmail connection window is still loading. Try again in a moment.",
      );
      return;
    }
    setConnectMailboxBusy(true);
    setError(null);
    try {
      let connected = true;
      if (desktop) {
        await connectDatagranInSystemBrowser({ provider: "gmail" });
      } else {
        const token = await jsonRequest<{
          linkToken?: string;
          link_token?: string;
        }>("/api/datagran/link-token", {
          method: "POST",
          body: JSON.stringify({ provider: "gmail" }),
        });
        const linkToken = token.linkToken || token.link_token || "";
        if (!linkToken) {
          throw new Error("Gmail did not return a secure connection token.");
        }
        connected = await new Promise<boolean>((resolve, reject) => {
          let connectionCompleting = false;
          window.DatagranLink!.open({
            linkToken,
            onSuccess: async (payload) => {
              connectionCompleting = true;
              try {
                const connectionId = payload.connection_id?.trim();
                if (!connectionId) {
                  throw new Error("Gmail did not return a connection.");
                }
                await jsonRequest("/api/agents", {
                  method: "POST",
                  body: JSON.stringify({
                    type: "datagran",
                    name: "Gmail",
                    datagranProvider: "gmail",
                    connectionId,
                  }),
                });
                resolve(true);
              } catch (reason) {
                reject(reason);
              }
            },
            onExit: () => {
              if (!connectionCompleting) resolve(false);
            },
          });
        });
      }
      if (!connected) return;
      showOrganizationStatus("Mailbox connected");
      lastAutoTriageAtRef.current = 0;
      const nextView: EmailView = isEmailView(view) ? view : "focus";
      if (!isEmailView(view)) {
        viewRef.current = "focus";
        setView("focus");
        setSelectedSnippetId(null);
      }
      await loadFeed(nextView, mailboxFilter, {
        background: false,
        limit: feedLimitRef.current,
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not connect Gmail.",
      );
    } finally {
      setConnectMailboxBusy(false);
    }
  }, [
    datagranScriptReady,
    loadFeed,
    mailboxFilter,
    showOrganizationStatus,
    view,
  ]);

  const detailCacheKey = useCallback(
    (thread: EmailThreadSummary) => `${view}:${thread.key}`,
    [view],
  );

  const threadDetailUrl = useCallback(
    (thread: EmailThreadSummary) => {
      const params = new URLSearchParams({
        connectionId: thread.connectionId,
        threadId: thread.threadId,
        messageId: thread.messageId,
        mailboxAddress: thread.mailbox.address,
        view,
        direction: thread.direction,
      });
      if (thread.action?.id) params.set("actionId", thread.action.id);
      for (const address of new Set(
        feed.mailboxes.map((mailbox) => mailbox.address).filter(Boolean),
      )) {
        params.append("ownedAddress", address);
      }
      return `/api/email/thread?${params.toString()}`;
    },
    [feed.mailboxes, view],
  );

  const requestThreadDetail = useCallback(
    async (thread: EmailThreadSummary): Promise<EmailThreadDetail> => {
      const cacheKey = detailCacheKey(thread);
      const cached = detailCacheRef.current.get(cacheKey);
      if (
        cached &&
        cached.expiresAt > Date.now() &&
        emailThreadDetailContainsMessage(cached.detail, thread.messageId)
      ) {
        return cached.detail;
      }
      if (cached) detailCacheRef.current.delete(cacheKey);

      const existing = detailInflightRef.current.get(cacheKey);
      if (existing) return existing;

      const request = jsonRequest<{
        ok: true;
        thread: EmailThreadDetail;
      }>(threadDetailUrl(thread)).then((payload) => {
        detailCacheRef.current.set(cacheKey, {
          detail: payload.thread,
          expiresAt: Date.now() + EMAIL_DETAIL_CACHE_TTL_MS,
        });
        return payload.thread;
      });
      detailInflightRef.current.set(cacheKey, request);
      try {
        return await request;
      } finally {
        if (detailInflightRef.current.get(cacheKey) === request) {
          detailInflightRef.current.delete(cacheKey);
        }
      }
    },
    [detailCacheKey, threadDetailUrl],
  );

  const prefetchThread = useCallback(
    (thread: EmailThreadSummary) => {
      void requestThreadDetail(thread).catch(() => {
        // Hover/focus prefetch is opportunistic and never interrupts the user.
      });
    },
    [requestThreadDetail],
  );
  const selectThread = useCallback((thread: EmailThreadSummary) => {
    setSelectedKey(thread.key);
  }, []);

  const captureNavigationSnapshot = useCallback(
    (thread: EmailThreadSummary) => {
      const scrollRoot = feedScrollRef.current;
      if (!scrollRoot) return;
      const row = Array.from(
        scrollRoot.querySelectorAll<HTMLElement>("[data-email-thread-key]"),
      ).find((candidate) => candidate.dataset.emailThreadKey === thread.key);
      navigationSnapshotRef.current = {
        threadKey: thread.key,
        scrollTop: scrollRoot.scrollTop,
        rowOffset: row
          ? row.getBoundingClientRect().top -
            scrollRoot.getBoundingClientRect().top
          : null,
      };
    },
    [],
  );

  const closeDetail = useCallback((restorePosition = true) => {
    detailRequestRef.current += 1;
    detailAbortRef.current?.abort();
    detailAbortRef.current = null;
    setDetailLoading(false);
    setOpeningThread(null);
    setDetail(null);
    deactivateComposer();
    setThreadComposeIntent(null);
    setExpandedMessageIds(new Set());
    setError(null);

    const snapshot = navigationSnapshotRef.current;
    if (!restorePosition || !snapshot) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const scrollRoot = feedScrollRef.current;
        if (!scrollRoot) return;
        const row = Array.from(
          scrollRoot.querySelectorAll<HTMLElement>(
            "[data-email-thread-key]",
          ),
        ).find(
          (candidate) =>
            candidate.dataset.emailThreadKey === snapshot.threadKey,
        );
        if (row && snapshot.rowOffset !== null) {
          const currentOffset =
            row.getBoundingClientRect().top -
            scrollRoot.getBoundingClientRect().top;
          scrollRoot.scrollTop += currentOffset - snapshot.rowOffset;
        } else {
          scrollRoot.scrollTop = snapshot.scrollTop;
        }
        // Keep the restored thread selected, but return focus to the neutral
        // list surface. Focusing the row button makes Electron draw its native
        // amber outline and causes Enter/native shortcuts to be interpreted as
        // button interaction instead of email workspace commands.
        scrollRoot.focus({ preventScroll: true });
      });
    });
  }, [deactivateComposer]);

  const invalidateThreadDetail = useCallback((threadKey: string) => {
    for (const key of detailCacheRef.current.keys()) {
      if (key.endsWith(`:${threadKey}`)) {
        detailCacheRef.current.delete(key);
      }
    }
  }, []);

  const completedSendIdsRef = useRef(new Set<string>());
  const reconcileCompletedSend = useCallback(
    (completion: CompletedEmailSend): boolean => {
      if (
        completion.userId !== emailCacheScope ||
        completedSendIdsRef.current.has(completion.requestId)
      ) {
        return false;
      }
      completedSendIdsRef.current.add(completion.requestId);
      while (completedSendIdsRef.current.size > 100) {
        const oldest = completedSendIdsRef.current.values().next().value;
        if (!oldest) break;
        completedSendIdsRef.current.delete(oldest);
      }
      rememberConfirmedSentThread(completion.result.sentThread || null);
      for (const [key, cached] of detailCacheRef.current.entries()) {
        if (
          cached.detail.summary.connectionId === completion.connectionId &&
          cached.detail.summary.threadId === completion.threadId
        ) {
          detailCacheRef.current.delete(key);
        }
      }
      return true;
    },
    [emailCacheScope, rememberConfirmedSentThread],
  );
  const refreshAfterCompletedSend = useCallback(() => {
    const activeView = viewRef.current;
    if (isEmailView(activeView)) {
      void loadFeed(activeView, mailboxFilterRef.current, {
        background: true,
      });
    }
  }, [loadFeed]);

  useEffect(() => {
    if (!visible) return;
    let reconciledStoredSend = false;
    try {
      for (const completion of recentCompletedEmailSends(emailCacheScope)) {
        reconciledStoredSend =
          reconcileCompletedSend(completion) || reconciledStoredSend;
      }
    } catch {
      // The live completion event still reconciles when storage is blocked.
    }
    if (reconciledStoredSend) refreshAfterCompletedSend();
    const onCompleted = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      if (reconcileCompletedSend(event.detail as CompletedEmailSend)) {
        refreshAfterCompletedSend();
      }
    };
    window.addEventListener(EMAIL_SEND_COMPLETED_EVENT, onCompleted);
    return () => {
      window.removeEventListener(EMAIL_SEND_COMPLETED_EVENT, onCompleted);
    };
  }, [
    emailCacheScope,
    reconcileCompletedSend,
    refreshAfterCompletedSend,
    visible,
  ]);

  const selectView = useCallback(
    (nextView: WorkspaceView) => {
      restoredNavigationFeedKeyRef.current = null;
      viewRef.current = nextView;
      closeDetail(false);
      navigationSnapshotRef.current = null;
      setSelectedKey(null);
      setSidebarOpen(false);
      setQuery("");
      if (nextView !== view && isEmailView(nextView)) {
        const key = emailFeedCacheKey(nextView, mailboxFilter);
        const candidate = cachedFeedFor(nextView, mailboxFilter);
        const navigationAction = emailFeedNavigationAction({
          view: nextView,
          hasCachedFeed: Boolean(candidate),
          renderedInSession: renderedFeedKeysRef.current.has(key),
          restoredNavigation: false,
          cachedSavedAt: candidate?.savedAt ?? null,
          now: Date.now(),
          refreshCooldownMs: EMAIL_FOCUS_REFRESH_COOLDOWN_MS,
        });
        const cached = navigationAction === "foreground" ? null : candidate;
        if (cached) {
          feedLimitRef.current = cached.limit;
          feedRef.current = cached.feed;
          renderedFeedKeyRef.current = key;
          lastFeedRequestAtRef.current = cached.savedAt;
          setFeed(cached.feed);
          setLastRefreshedAt(new Date(cached.savedAt));
        }
        setLoading(!cached);
        setLoadingView(cached ? null : nextView);
      }
      setView(nextView);
    },
    [cachedFeedFor, closeDetail, mailboxFilter, view],
  );

  const selectMailbox = useCallback(
    (connectionId: string | null) => {
      if (connectionId === mailboxFilter) return;
      restoredNavigationFeedKeyRef.current = null;
      mailboxFilterRef.current = connectionId;
      if (isEmailView(view)) {
        const key = emailFeedCacheKey(view, connectionId);
        const candidate = cachedFeedFor(view, connectionId);
        const navigationAction = emailFeedNavigationAction({
          view,
          hasCachedFeed: Boolean(candidate),
          renderedInSession: renderedFeedKeysRef.current.has(key),
          restoredNavigation: false,
          cachedSavedAt: candidate?.savedAt ?? null,
          now: Date.now(),
          refreshCooldownMs: EMAIL_FOCUS_REFRESH_COOLDOWN_MS,
        });
        const cached = navigationAction === "foreground" ? null : candidate;
        if (cached) {
          feedLimitRef.current = cached.limit;
          feedRef.current = cached.feed;
          renderedFeedKeyRef.current = key;
          lastFeedRequestAtRef.current = cached.savedAt;
          setFeed(cached.feed);
          setLastRefreshedAt(new Date(cached.savedAt));
        }
        setLoading(!cached);
        setLoadingView(cached ? null : view);
      }
      closeDetail(false);
      navigationSnapshotRef.current = null;
      setSelectedKey(null);
      setMailboxFilter(connectionId);
    },
    [cachedFeedFor, closeDetail, mailboxFilter, view],
  );

  const loadSnippets = useCallback(async () => {
    try {
      const payload = await jsonRequest<{
        ok: true;
        snippets: EmailSnippet[];
      }>("/api/email/snippets");
      setSnippets(payload.snippets);
    } catch {
      // Snippets remain optional if the migration has not been applied yet.
    }
  }, []);

  useEffect(() => {
    void loadSnippets();
  }, [loadSnippets]);

  useEffect(() => {
    if (window.DatagranLink) {
      setDatagranScriptReady(true);
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.datagran.io/embed/link.js"]',
    );
    const script = existing || document.createElement("script");
    const onLoad = () => setDatagranScriptReady(true);
    script.addEventListener("load", onLoad);
    if (!existing) {
      script.src = "https://www.datagran.io/embed/link.js";
      script.async = true;
      document.head.appendChild(script);
    }
    return () => script.removeEventListener("load", onLoad);
  }, []);

  useEffect(
    () => () => {
      if (organizationStatusTimerRef.current !== null) {
        window.clearTimeout(organizationStatusTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (
      !cacheHydrated ||
      backgroundSnapshotScope !== emailCacheScope
    ) return;
    const emailView = isEmailView(view) ? view : null;
    const currentKey = emailView
      ? emailFeedCacheKey(emailView, mailboxFilter)
      : null;
    const resumeAction =
      activatedFeedKeyRef.current === currentKey
        ? emailFeedResumeAction({
            currentKey,
            renderedKey: renderedFeedKeyRef.current,
            lastRequestAt: lastFeedRequestAtRef.current,
            now: Date.now(),
            refreshCooldownMs: EMAIL_FOCUS_REFRESH_COOLDOWN_MS,
          })
        : "not-rendered";
    if (emailView && resumeAction !== "not-rendered") {
      // Activity keeps component state but reconnects effects. Keep the
      // already-rendered mailbox and refresh it quietly when it is old enough
      // instead of blanking the workspace and issuing a foreground load.
      if (resumeAction === "refresh") {
        void loadFeed(emailView, mailboxFilter, {
          background: true,
          limit: feedLimitRef.current,
        });
      }
      return;
    }
    const restoredNavigation =
      Boolean(currentKey) &&
      restoredNavigationFeedKeyRef.current === currentKey;
    const candidate = emailView
      ? cachedFeedFor(emailView, mailboxFilter)
      : null;
    const navigationAction = emailView
      ? emailFeedNavigationAction({
          view: emailView,
          hasCachedFeed: Boolean(candidate),
          renderedInSession: Boolean(
            currentKey && renderedFeedKeysRef.current.has(currentKey),
          ),
          restoredNavigation,
          cachedSavedAt: candidate?.savedAt ?? null,
          now: Date.now(),
          refreshCooldownMs: EMAIL_FOCUS_REFRESH_COOLDOWN_MS,
        })
      : "foreground";
    const cached = navigationAction === "foreground" ? null : candidate;
    activatedFeedKeyRef.current = currentKey;
    feedLimitRef.current = cached?.limit || EMAIL_INITIAL_FEED_LIMIT;
    if (isEmailView(view)) {
      if (cached) {
        renderedFeedKeyRef.current = currentKey;
        if (currentKey) renderedFeedKeysRef.current.add(currentKey);
        feedRef.current = cached.feed;
        lastFeedRequestAtRef.current = cached.savedAt;
        setFeed(cached.feed);
        if (emailView === "inbox") {
          needsReviewCountRef.current = cached.feed.threads.length;
          setPrefetchedNeedsReviewCount(cached.feed.threads.length);
        }
        setLoading(false);
        setLoadingView(null);
        setLastRefreshedAt(new Date(cached.savedAt));
        setSelectedKey((current) =>
          current && cached.feed.threads.some((item) => item.key === current)
            ? current
            : null,
        );
      }
      if (
        navigationAction === "foreground" ||
        navigationAction === "refresh"
      ) {
        void loadFeed(view, mailboxFilter, {
          background: Boolean(cached),
          limit: cached?.limit || EMAIL_INITIAL_FEED_LIMIT,
        });
      }
    }
    else void loadSnippets();
  }, [
    backgroundSnapshotScope,
    cacheHydrated,
    cachedFeedFor,
    emailCacheScope,
    loadFeed,
    loadSnippets,
    mailboxFilter,
    view,
  ]);

  useEffect(() => {
    if (!cacheHydrated) return;
    const newestScopedEntry = Array.from(
      feedCacheRef.current.values(),
    )
      .filter((entry) => entry.connectionId === mailboxFilter)
      .sort((left, right) => right.savedAt - left.savedAt)[0];
    const cachedNeedsReview = cachedFeedFor("inbox", mailboxFilter);
    const cachedFocus = cachedFeedFor("focus", mailboxFilter);
    replaceNavigationStats(
      navigationStatsFromCachedFeeds({
        fallback: newestScopedEntry?.feed.stats ?? EMPTY_FEED.stats,
        focus: cachedFocus?.feed.stats,
        needsReviewCount: cachedNeedsReview?.feed.threads.length ?? null,
      }),
      cachedNeedsReview?.feed.threads.length ?? null,
      "authoritative",
    );
  }, [
    cacheHydrated,
    cachedFeedFor,
    mailboxFilter,
    replaceNavigationStats,
  ]);

  useEffect(() => {
    if (feed.mailboxes.length === 0) return;
    const initial = window.setTimeout(() => {
      void loadMailboxHealth();
    }, EMAIL_MAILBOX_HEALTH_INITIAL_DELAY_MS);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadMailboxHealth();
      }
    }, EMAIL_MAILBOX_HEALTH_INTERVAL_MS);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [feed.mailboxes.length, loadMailboxHealth]);

  useEffect(() => {
    if (!cacheHydrated || !isEmailView(view)) return;
    const refresh = (force = false) => {
      if (document.visibilityState !== "visible") return;
      if (
        !force &&
        Date.now() - lastFeedRequestAtRef.current <
        EMAIL_FOCUS_REFRESH_COOLDOWN_MS
      ) {
        return;
      }
      void loadFeed(view, mailboxFilter, { background: true });
    };
    const onFocus = () => refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh(true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [cacheHydrated, loadFeed, mailboxFilter, view]);

  useEffect(() => {
    if (!cacheHydrated) return;
    const onWorkspaceCorrection = (event: Event) => {
      let correction =
        event instanceof CustomEvent
          ? (event.detail as EmailWorkspaceCorrection | null)
          : null;
      if (
        !correction?.userId ||
        correction.userId !== emailCacheScope ||
        !correction.connectionId ||
        !correction.threadId
      ) {
        return;
      }
      const correctionIdentity = `${correction.connectionId}:${correction.threadId}`;
      const localCorrection = localWorkspaceCorrectionsRef.current.get(
        correctionIdentity,
      );
      if (localCorrection && localCorrection.expiresAt < Date.now()) {
        localWorkspaceCorrectionsRef.current.delete(correctionIdentity);
      } else if (
        correction.targetView &&
        localCorrection?.correction.targetView === correction.targetView
      ) {
        // Suppress only the placement echo. Corrections merge queue and read
        // dimensions, so the same event may also carry a newer read/unread
        // change from another device that must still be applied.
        correction = {
          ...correction,
          targetView: undefined,
          targetViewChangedAt: undefined,
        };
        if (correction.unread === undefined) return;
      }
      let navigationCorrectionApplied = false;
      let readCorrectionApplies = false;
      const cachedFeeds = Array.from(feedCacheRef.current.values()).sort(
        (left, right) => {
          const leftExclusive =
            left.feed.view === "focus" ||
            left.feed.view === "inbox" ||
            left.feed.view === "noise" ||
            left.feed.view === "handled";
          const rightExclusive =
            right.feed.view === "focus" ||
            right.feed.view === "inbox" ||
            right.feed.view === "noise" ||
            right.feed.view === "handled";
          return Number(rightExclusive) - Number(leftExclusive);
        },
      );
      for (const cached of cachedFeeds) {
        const correctedThread = cached.feed.threads.find(
          (item) =>
            item.connectionId === correction.connectionId &&
            item.threadId === correction.threadId,
        );
        if (
          correctedThread &&
          emailWorkspaceReadStateAppliesToThread(
            correction,
            correctedThread,
          )
        ) {
          readCorrectionApplies = true;
        }
        const nextFeed = applyEmailWorkspaceCorrectionToFeed(
          cached.feed,
          correction,
        );
        if (nextFeed === cached.feed) continue;
        if (
          correction.targetView &&
          !navigationCorrectionApplied &&
          correctedThread &&
          emailWorkspacePlacementAppliesToThread(
            correction,
            correctedThread,
          ) &&
          cached.connectionId === mailboxFilterRef.current
        ) {
          const correctedStats = applyOptimisticEmailNavigationStats(
            navigationStatsRef.current,
            correctedThread,
            emailWorkspaceOperationForTargetView(correction.targetView),
            cached.feed.view,
          );
          replaceNavigationStats(
            correctedStats,
            correctedStats.needsReview,
            "authoritative",
          );
          navigationCorrectionApplied = true;
        }
        rememberFeed(
          cached.feed.view,
          cached.connectionId,
          nextFeed,
          cached.limit,
          // A persisted correction updates one conversation, not the source
          // feed snapshot itself. Preserve its age so a newer service-worker
          // Focus snapshot (for example from a just-received push) can still
          // replace it immediately.
          cached.savedAt,
        );
        if (
          viewRef.current === cached.feed.view &&
          mailboxFilterRef.current === cached.connectionId
        ) {
          feedRef.current = nextFeed;
          setFeed(nextFeed);
        }
      }
      const correctedUnread = correction.unread;
      if (correctedUnread !== undefined) {
        if (correctedUnread) {
          locallyReadThreadCutoffsRef.current.delete(correctionIdentity);
        } else if (readCorrectionApplies) {
          const correctedAt = Date.parse(
            correction.readChangedAt || correction.correctedAt,
          );
          locallyReadThreadCutoffsRef.current.set(
            correctionIdentity,
            Number.isFinite(correctedAt) ? correctedAt : Date.now(),
          );
        }
        setSearchState((current) => ({
          ...current,
          results: setSearchConversationUnread(
            current.results,
            correction,
            correctedUnread,
            correction,
          ),
        }));
        setIndexedSearchState((current) => ({
          ...current,
          results: setSearchConversationUnread(
            current.results,
            correction,
            correctedUnread,
            correction,
          ),
        }));
        setDetail((current) =>
          current?.summary.connectionId === correction.connectionId &&
          current.summary.threadId === correction.threadId &&
          emailWorkspaceReadStateAppliesToThread(
            correction,
            current.summary,
          ) &&
          current.summary.unread !== correctedUnread
            ? {
                ...current,
                summary: {
                  ...current.summary,
                  unread: correctedUnread,
                },
              }
            : current,
        );
      }
      const currentView = viewRef.current;
      if (
        !correction.targetView ||
        !isEmailView(currentView) ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      void loadFeed(currentView, mailboxFilterRef.current, {
        background: true,
        limit: feedLimitRef.current,
      });
    };
    window.addEventListener(
      EMAIL_WORKSPACE_CORRECTION_EVENT,
      onWorkspaceCorrection,
    );
    for (const correction of recentEmailWorkspaceCorrections(
      emailCacheScope,
    )) {
      onWorkspaceCorrection(
        new CustomEvent(EMAIL_WORKSPACE_CORRECTION_EVENT, {
          detail: correction,
        }),
      );
    }
    return () => {
      window.removeEventListener(
        EMAIL_WORKSPACE_CORRECTION_EVENT,
        onWorkspaceCorrection,
      );
    };
  }, [
    cacheHydrated,
    emailCacheScope,
    loadFeed,
    rememberFeed,
    replaceNavigationStats,
  ]);

  useEffect(() => {
    if (!cacheHydrated) return;
    const onBackgroundSync = (event: Event) => {
      const detail =
        event instanceof CustomEvent
          ? (event.detail as {
              userId?: string;
              remote?: boolean;
              syncedAt?: number;
              snapshotReady?: boolean;
              liveRefresh?: boolean;
              actionIds?: string[];
            })
          : null;
      if (detail?.userId && detail.userId !== emailCacheScope) return;
      const currentView = viewRef.current;
      const currentFilter = mailboxFilterRef.current;
      if (!isEmailView(currentView)) return;
      if (
        swipeActiveRef.current ||
        pendingActionKeysRef.current.size > 0
      ) {
        queuedBackgroundRefreshRef.current = true;
        return;
      }
      // Refresh the visible queue, and independently materialize Needs Review
      // so its badge and cached list update before the user opens that tab.
      // Discovery broadcasts only when it finds work, so this does not add a
      // second feed request to every polling pass. When discovery already
      // prepared the unified Focus snapshot, promote it instead of making the
      // same Gmail request again.
      if (document.visibilityState !== "visible") return;
      const refreshCurrent = () => {
        if (
          viewRef.current !== currentView ||
          mailboxFilterRef.current !== currentFilter
        ) {
          return;
        }
        void loadFeed(currentView, currentFilter, {
          background: true,
          limit: feedLimitRef.current,
          forceProvider: detail?.liveRefresh === true,
        });
      };
      const actionIds = Array.from(
        new Set(
          (detail?.actionIds || []).filter(
            (value): value is string =>
              typeof value === "string" && Boolean(value.trim()),
          ),
        ),
      ).slice(0, 50);
      if (
        detail?.snapshotReady === true &&
        currentView === "focus" &&
        currentFilter === null
      ) {
        void applyBackgroundFocusSnapshot().then((applied) => {
          if (!applied && actionIds.length > 0) {
            void applyFocusActionDelta({
              actionIds,
              filter: currentFilter,
            }).then((deltaApplied) => {
              if (!deltaApplied || detail?.liveRefresh === true) {
                refreshCurrent();
              }
            });
            return;
          }
          if (!applied || detail?.liveRefresh === true) {
            refreshCurrent();
          }
        });
        return;
      }
      if (actionIds.length > 0) {
        const delta = applyFocusActionDelta({
          actionIds,
          filter: currentFilter,
        });
        if (currentView === "focus") {
          void delta.then((applied) => {
            if (!applied || detail?.liveRefresh === true) refreshCurrent();
          });
          return;
        }
        void delta;
      }
      if (detail?.liveRefresh !== true && actionIds.length > 0) return;
      refreshCurrent();
      if (currentView !== "inbox") {
        void prefetchNeedsReview(currentFilter);
      }
    };
    window.addEventListener(EMAIL_BACKGROUND_SYNC_EVENT, onBackgroundSync);
    return () => {
      window.removeEventListener(
        EMAIL_BACKGROUND_SYNC_EVENT,
        onBackgroundSync,
      );
    };
  }, [
    applyFocusActionDelta,
    applyBackgroundFocusSnapshot,
    cacheHydrated,
    emailCacheScope,
    loadFeed,
    prefetchNeedsReview,
  ]);

  useEffect(() => {
    const normalized = normalizeEmailSearchQuery(query);
    searchRequestRef.current += 1;
    const requestId = searchRequestRef.current;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;

    if (!normalized) {
      setSearchState(EMPTY_SEARCH);
      return;
    }
    if (normalized.length < 2) {
      setSearchState({
        ...EMPTY_SEARCH,
        query: normalized,
        connectionId: mailboxFilter,
        totalMailboxCount: mailboxFilter ? 1 : feed.mailboxes.length,
      });
      return;
    }

    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchState({
      ...EMPTY_SEARCH,
      query: normalized,
      connectionId: mailboxFilter,
      loading: true,
      totalMailboxCount: mailboxFilter ? 1 : feed.mailboxes.length,
    });
    const timer = window.setTimeout(async () => {
      try {
        const payload = await jsonRequest<
          EmailSearchResponse & { ok: true }
        >("/api/email/search", {
          method: "POST",
          body: JSON.stringify({
            query: normalized,
            limit: EMAIL_SEARCH_RESULT_LIMIT,
            ...(mailboxFilter ? { connectionId: mailboxFilter } : {}),
          }),
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          searchRequestRef.current !== requestId
        ) {
          return;
        }
        const locallyRead = locallyReadThreadCutoffsRef.current;
        const results = payload.results.map((result) =>
          result.unread &&
          localEmailReadAppliesToThread(result, locallyRead)
            ? { ...result, unread: false }
            : result,
        );
        setSearchState({
          query: payload.query,
          connectionId: mailboxFilter,
          results,
          loading: false,
          resolved: true,
          error: null,
          warnings: payload.warnings,
          searchedMailboxCount: payload.searchedMailboxCount,
          totalMailboxCount: payload.totalMailboxCount,
        });
      } catch (reason) {
        if (
          controller.signal.aborted ||
          (reason instanceof DOMException && reason.name === "AbortError") ||
          searchRequestRef.current !== requestId
        ) {
          return;
        }
        setSearchState({
          ...EMPTY_SEARCH,
          query: normalized,
          connectionId: mailboxFilter,
          error:
            reason instanceof Error
              ? reason.message
              : "Could not search your mailboxes.",
          totalMailboxCount: mailboxFilter ? 1 : feed.mailboxes.length,
        });
      } finally {
        if (searchAbortRef.current === controller) {
          searchAbortRef.current = null;
        }
      }
    }, EMAIL_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (searchAbortRef.current === controller) {
        searchAbortRef.current = null;
      }
    };
  }, [feed.mailboxes.length, mailboxFilter, query]);

  const normalizedSearchQuery = normalizeEmailSearchQuery(query);
  useEffect(() => {
    indexedSearchRequestRef.current += 1;
    const requestId = indexedSearchRequestRef.current;
    indexedSearchAbortRef.current?.abort();
    indexedSearchAbortRef.current = null;
    if (normalizedSearchQuery.length < 2) {
      setIndexedSearchState(EMPTY_INDEXED_SEARCH);
      return;
    }

    const controller = new AbortController();
    indexedSearchAbortRef.current = controller;
    const timer = window.setTimeout(() => {
      void jsonRequest<EmailSearchResponse & { ok: true }>(
        "/api/email/search/index",
        {
          method: "POST",
          body: JSON.stringify({
            query: normalizedSearchQuery,
            limit: EMAIL_SEARCH_RESULT_LIMIT,
            ...(mailboxFilter ? { connectionId: mailboxFilter } : {}),
          }),
          signal: controller.signal,
        },
      )
        .then((payload) => {
          if (
            controller.signal.aborted ||
            indexedSearchRequestRef.current !== requestId
          ) {
            return;
          }
          const locallyRead = locallyReadThreadCutoffsRef.current;
          setIndexedSearchState({
            query: payload.query,
            connectionId: mailboxFilter,
            results: payload.results.map((result) =>
              result.unread &&
              localEmailReadAppliesToThread(result, locallyRead)
                ? { ...result, unread: false }
                : result,
            ),
          });
        })
        .catch(() => {
          // The loaded feed and authoritative Gmail search remain available.
        })
        .finally(() => {
          if (indexedSearchAbortRef.current === controller) {
            indexedSearchAbortRef.current = null;
          }
        });
    }, 60);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (indexedSearchAbortRef.current === controller) {
        indexedSearchAbortRef.current = null;
      }
    };
  }, [mailboxFilter, normalizedSearchQuery]);
  const searchMailboxAddresses = useMemo(
    () => feed.mailboxes.map((mailbox) => mailbox.address).filter(Boolean),
    [feed.mailboxes],
  );
  useEffect(() => {
    searchContactRequestRef.current += 1;
    const requestId = searchContactRequestRef.current;
    searchContactAbortRef.current?.abort();
    searchContactAbortRef.current = null;
    if (normalizedSearchQuery.length < 2) {
      setIndexedSearchContacts([]);
      return;
    }

    const cacheKey = emailRecipientSuggestionCacheKey({
      scope: emailCacheScope,
      mailboxAddresses: searchMailboxAddresses,
      query: normalizedSearchQuery,
    });
    const cached = cachedRecipientSuggestions(cacheKey);
    if (cached) setIndexedSearchContacts(cached);
    else setIndexedSearchContacts([]);

    const controller = new AbortController();
    searchContactAbortRef.current = controller;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        query: normalizedSearchQuery,
        limit: "10",
      });
      for (const address of searchMailboxAddresses) {
        params.append("ownedAddress", address);
      }
      void jsonRequest<{
        ok: true;
        query: string;
        suggestions: EmailContactSuggestion[];
      }>(`/api/email/contacts?${params.toString()}`, {
        signal: controller.signal,
      })
        .then((payload) => {
          if (
            controller.signal.aborted ||
            searchContactRequestRef.current !== requestId ||
            normalizeEmailSearchQuery(payload.query) !==
              normalizedSearchQuery
          ) {
            return;
          }
          cacheRecipientSuggestions(cacheKey, payload.suggestions);
          setIndexedSearchContacts(payload.suggestions);
        })
        .catch(() => {
          // Exact-address and in-memory suggestions stay interactive if the
          // local contact index is temporarily unavailable.
        })
        .finally(() => {
          if (searchContactAbortRef.current === controller) {
            searchContactAbortRef.current = null;
          }
        });
    }, EMAIL_RECIPIENT_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (searchContactAbortRef.current === controller) {
        searchContactAbortRef.current = null;
      }
    };
  }, [
    emailCacheScope,
    normalizedSearchQuery,
    searchMailboxAddresses,
  ]);
  const knownContactThreads = useMemo(() => {
    const byConversation = new Map<string, EmailThreadSummary>();
    for (const cached of feedCacheRef.current.values()) {
      for (const thread of cached.feed.threads) {
        byConversation.set(emailConversationIdentity(thread), thread);
      }
    }
    for (const thread of feed.threads) {
      byConversation.set(emailConversationIdentity(thread), thread);
    }
    for (const result of searchState.results) {
      byConversation.set(emailConversationIdentity(result), result);
    }
    if (detail) {
      byConversation.set(
        emailConversationIdentity(detail.summary),
        detail.summary,
      );
    }
    return [...byConversation.values()];
  }, [detail, feed, searchState.results]);
  const contactSuggestions = useMemo(() => {
    const local = suggestEmailContacts(
      normalizedSearchQuery,
      knownContactThreads,
      {
        excludeEmails: searchMailboxAddresses,
        limit: 10,
      },
    );
    const indexed = filterEmailContactSuggestions(
      normalizedSearchQuery,
      indexedSearchContacts,
      {
        excludeEmails: searchMailboxAddresses,
        limit: 10,
      },
    );
    const merged = new Map(
      local.map((suggestion) => [
        suggestion.email.toLocaleLowerCase(),
        suggestion,
      ]),
    );
    for (const suggestion of indexed) {
      const key = suggestion.email.toLocaleLowerCase();
      const existing = merged.get(key);
      merged.set(key, {
        email: suggestion.email,
        name:
          suggestion.name &&
          suggestion.name.toLocaleLowerCase() !== key
            ? suggestion.name
            : existing?.name || suggestion.email,
        receivedAt:
          suggestion.lastContactAt ||
          existing?.receivedAt ||
          new Date(0).toISOString(),
      });
    }
    return [...merged.values()].slice(0, 6);
  }, [
    indexedSearchContacts,
    knownContactThreads,
    normalizedSearchQuery,
    searchMailboxAddresses,
  ]);
  useEffect(() => {
    setSearchSuggestionIndex(0);
  }, [normalizedSearchQuery]);
  const localSearchResults = useMemo(
    () => {
      if (!normalizedSearchQuery) return [];
      const indexedReady =
        indexedSearchState.query === normalizedSearchQuery &&
        indexedSearchState.connectionId === mailboxFilter;
      const merged = new Map<string, EmailSearchResult>();
      for (const result of [
        ...(indexedReady ? indexedSearchState.results : []),
        ...rankEmailSearchSummaries(normalizedSearchQuery, feed.threads),
      ]) {
        const identity = emailConversationIdentity(result);
        const existing = merged.get(identity);
        if (!existing || result.searchScore > existing.searchScore) {
          merged.set(identity, result);
        }
      }
      return [...merged.values()]
        .sort((a, b) => {
          const score = b.searchScore - a.searchScore;
          if (score !== 0) return score;
          return Date.parse(b.receivedAt) - Date.parse(a.receivedAt);
        })
        .slice(0, EMAIL_SEARCH_RESULT_LIMIT);
    },
    [
      feed.threads,
      indexedSearchState,
      mailboxFilter,
      normalizedSearchQuery,
    ],
  );
  const remoteSearchReady =
    normalizedSearchQuery.length >= 2 &&
    searchState.query === normalizedSearchQuery &&
    searchState.connectionId === mailboxFilter &&
    searchState.resolved;
  const activeSearchResults = useMemo(() => {
    if (!normalizedSearchQuery) return [];
    if (!remoteSearchReady) return localSearchResults;
    const byConversation = new Map<string, EmailSearchResult>();
    for (const result of [...searchState.results, ...localSearchResults]) {
      const identity = emailConversationIdentity(result);
      if (!byConversation.has(identity)) byConversation.set(identity, result);
    }
    return Array.from(byConversation.values())
      .sort((a, b) => {
        const score = b.searchScore - a.searchScore;
        if (score !== 0) return score;
        return Date.parse(b.receivedAt) - Date.parse(a.receivedAt);
      })
      .slice(0, EMAIL_SEARCH_RESULT_LIMIT);
  }, [
    localSearchResults,
    normalizedSearchQuery,
    remoteSearchReady,
    searchState.results,
  ]);
  const visibleThreads = useMemo(() => {
    return normalizedSearchQuery ? activeSearchResults : feed.threads;
  }, [activeSearchResults, feed.threads, normalizedSearchQuery]);
  const searchMatchesByKey = useMemo(
    () =>
      new Map(
        activeSearchResults.map((result) => [result.key, result]),
      ),
    [activeSearchResults],
  );

  const loadMoreThreads = useCallback(() => {
    if (
      !feed.nextCursor ||
      query ||
      foregroundLoadingRef.current ||
      backgroundRefreshingRef.current
    ) {
      return;
    }
    const pageSize = emailFeedPageSize(feed.view);
    const nextLimit = nextAutoLoadedEmailFeedDepth({
      currentDepth: feedLimitRef.current,
      loadedThreadCount: feed.threads.length,
      pageSize,
    });
    feedLimitRef.current = nextLimit;
    void loadFeed(view, mailboxFilter, {
      append: true,
      background: true,
      cursor: feed.nextCursor,
      limit: pageSize,
      totalLimit: nextLimit,
    });
  }, [
    feed.nextCursor,
    feed.threads.length,
    feed.view,
    loadFeed,
    mailboxFilter,
    query,
    view,
  ]);

  const handleFeedScroll = useCallback(
    (element: HTMLDivElement) => {
      if (
        !shouldAutoLoadEmailFeed(feed.view) ||
        !feed.nextCursor ||
        query ||
        !shouldLoadMoreEmailNearScrollEnd({
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          threshold: emailFeedAutoLoadThreshold(feed.view),
        })
      ) {
        return;
      }
      loadMoreThreads();
    },
    [feed.nextCursor, feed.view, loadMoreThreads, query],
  );

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const scrollRoot = feedScrollRef.current;
    if (
      !shouldAutoLoadEmailFeed(feed.view) ||
      !sentinel ||
      !scrollRoot ||
      !feed.nextCursor ||
      query
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMoreThreads();
        }
      },
      {
        root: scrollRoot,
        rootMargin: `${emailFeedAutoLoadThreshold(feed.view)}px 0px`,
        threshold: 0.01,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    backgroundRefreshing,
    feed.nextCursor,
    feed.view,
    loadMoreThreads,
    query,
  ]);

  const updateConversationUnread = useCallback(
    (thread: EmailThreadSummary, unread: boolean) => {
      for (const cached of feedCacheRef.current.values()) {
        const nextFeed = setEmailConversationUnread(
          cached.feed,
          thread,
          unread,
        );
        if (nextFeed !== cached.feed) {
          rememberFeed(
            cached.feed.view,
            cached.connectionId,
            nextFeed,
            cached.limit,
            cached.savedAt,
          );
        }
      }
      const nextFeed = setEmailConversationUnread(
        feedRef.current,
        thread,
        unread,
      );
      if (nextFeed !== feedRef.current) {
        feedRef.current = nextFeed;
        setFeed(nextFeed);
      }
      setSearchState((current) => ({
        ...current,
        results: setSearchConversationUnread(
          current.results,
          thread,
          unread,
        ),
      }));
      setDetail((current) =>
        current?.summary.connectionId === thread.connectionId &&
        current.summary.threadId === thread.threadId &&
        current.summary.unread !== unread
          ? {
              ...current,
              summary: { ...current.summary, unread },
            }
          : current,
      );
    },
    [rememberFeed],
  );

  const markThreadReadOnOpen = useCallback(
    (thread: EmailThreadSummary) => {
      const identity = emailConversationIdentity(thread);
      if (
        !thread.unread ||
        localEmailReadAppliesToThread(
          thread,
          locallyReadThreadCutoffsRef.current,
        ) ||
        pendingReadThreadIdentitiesRef.current.has(identity)
      ) {
        return;
      }
      pendingReadThreadIdentitiesRef.current.add(identity);
      const receivedAt = Date.parse(thread.receivedAt);
      locallyReadThreadCutoffsRef.current.set(
        identity,
        Number.isFinite(receivedAt) ? receivedAt : Date.now(),
      );
      lastLocalEmailMutationAtRef.current = Date.now();
      updateConversationUnread(thread, false);
      const enqueued = actionQueueRef.current.enqueue({
        key: `read:${identity}`,
        run: async () => {
          try {
            await runEmailActionWithRetry({
              execute: async () => {
                await jsonRequest("/api/email/action", {
                  method: "POST",
                  body: JSON.stringify({
                    operation: "read",
                    connectionId: thread.connectionId,
                    threadId: thread.threadId,
                  }),
                });
              },
            });
            lastLocalEmailMutationAtRef.current = Date.now();
          } catch (reason) {
            locallyReadThreadCutoffsRef.current.delete(identity);
            updateConversationUnread(thread, true);
            setError(
              reason instanceof Error
                ? reason.message
                : "The conversation opened, but it could not be marked read.",
            );
          } finally {
            pendingReadThreadIdentitiesRef.current.delete(identity);
          }
        },
      });
      if (!enqueued) {
        pendingReadThreadIdentitiesRef.current.delete(identity);
      }
    },
    [updateConversationUnread],
  );

  const openThread = useCallback(
    async (
      thread: EmailThreadSummary,
      composeMode?: "reply_all" | "forward",
    ) => {
      captureNavigationSnapshot(thread);
      setSelectedKey(thread.key);
      setOpeningThread(thread);
      setDetail(null);
      deactivateComposer();
      setThreadComposeIntent(null);
      setExpandedMessageIds(new Set());
      setDetailLoading(true);
      setError(null);
      void markThreadReadOnOpen(thread);
      detailAbortRef.current?.abort();
      const controller = new AbortController();
      detailAbortRef.current = controller;
      const requestId = detailRequestRef.current + 1;
      detailRequestRef.current = requestId;
      try {
        // Gmail transport already applies bounded backoff. Reissuing the same
        // full-thread request here doubled quota use precisely when upstream
        // was rate limited.
        const resolvedDetail = await requestThreadDetail(thread);
        if (
          detailRequestRef.current !== requestId ||
          controller.signal.aborted
        ) {
          return;
        }
        const locallyRead = localEmailReadAppliesToThread(
          resolvedDetail.summary,
          locallyReadThreadCutoffsRef.current,
        );
        const nextDetail =
          locallyRead && resolvedDetail.summary.unread
            ? {
                ...resolvedDetail,
                summary: { ...resolvedDetail.summary, unread: false },
              }
            : resolvedDetail;
        const latestMessage =
          nextDetail.messages[nextDetail.messages.length - 1] || null;
        const draftSourceMessage = nextDetail.draft?.sourceMessageId
          ? nextDetail.messages.find(
              (message) =>
                message.id === nextDetail.draft?.sourceMessageId,
            ) || null
          : null;
        setExpandedMessageIds(
          new Set(
            [latestMessage?.id].filter(
              (messageId): messageId is string => Boolean(messageId),
            ),
          ),
        );
        const sourceMessage =
          composeMode === "forward"
            ? latestMessage
            : draftSourceMessage || latestMessage;
        setDetail(nextDetail);
        showComposer(
          composeMode === "forward" && latestMessage
            ? composerFromMessage(nextDetail, latestMessage, "forward")
            : composerFromDetail(
                nextDetail,
                feedRef.current.mailboxes.map(
                  (mailbox) => mailbox.address,
                ),
              ),
        );
        setThreadComposeIntent(
          sourceMessage
            ? {
                messageId: sourceMessage.id,
                mode:
                  composeMode === "forward" ? "forward" : "reply_all",
              }
            : null,
        );
        setOpeningThread(null);
        if (composeMode) {
          window.setTimeout(() => {
            if (detailRequestRef.current !== requestId) return;
            const target =
              composeMode === "forward"
                ? document.querySelector<HTMLInputElement>(
                    "[data-email-recipient-input]",
                  )
                : document.querySelector<HTMLTextAreaElement>(
                    "[data-email-composer-body] textarea",
                  );
            target?.focus();
          }, 50);
        }
      } catch (reason) {
        if (
          controller.signal.aborted ||
          (reason instanceof DOMException && reason.name === "AbortError") ||
          detailRequestRef.current !== requestId
        ) {
          return;
        }
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not open this conversation.",
        );
      } finally {
        if (detailRequestRef.current === requestId) {
          detailAbortRef.current = null;
          setDetailLoading(false);
        }
      }
    },
    [
      captureNavigationSnapshot,
      deactivateComposer,
      markThreadReadOnOpen,
      requestThreadDetail,
      showComposer,
    ],
  );

  const detailIdentity = detail
    ? `${detail.summary.key}:${detail.messages.length}`
    : null;
  useEffect(() => {
    if (!detailIdentity) return;
    const frame = window.requestAnimationFrame(() => {
      const scrollRoot = detailScrollRef.current;
      const latestMessage = latestMessageRef.current;
      if (!scrollRoot || !latestMessage) return;
      const targetTop =
        latestMessage.getBoundingClientRect().top -
        scrollRoot.getBoundingClientRect().top +
        scrollRoot.scrollTop -
        Math.min(180, scrollRoot.clientHeight * 0.28);
      scrollRoot.scrollTop = Math.max(0, targetTop);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detailIdentity]);

  useEffect(() => {
    if (!cacheHydrated || !emailCacheScope) return;
    const supabase = getSupabaseBrowserClient();
    let disposed = false;
    let debounceTimer: number | null = null;
    const isLocalEcho = () =>
      Date.now() - lastLocalEmailMutationAtRef.current <
      EMAIL_REALTIME_SELF_ECHO_WINDOW_MS;
    const fireRefresh = () => {
      debounceTimer = null;
      if (disposed) return;
      const currentView = viewRef.current;
      if (!isEmailView(currentView)) return;
      if (
        isLocalEcho() ||
        swipeActiveRef.current ||
        pendingActionKeysRef.current.size > 0
      ) {
        // Defer instead of dropping: a change from another device that
        // arrives while this one is mid-action still reconciles once the
        // local burst settles.
        debounceTimer = window.setTimeout(
          fireRefresh,
          EMAIL_REALTIME_RETRY_MS,
        );
        return;
      }
      void loadFeed(currentView, mailboxFilterRef.current, {
        background: true,
        limit: feedLimitRef.current,
      });
    };
    const scheduleRefresh = () => {
      if (disposed) return;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(
        fireRefresh,
        EMAIL_REALTIME_REFRESH_DEBOUNCE_MS,
      );
    };
    // Triage on another device (or the server heartbeat) writes
    // inbox_actions rows; refreshing on those events is what makes a
    // "done" on the desktop disappear here within seconds instead of on
    // the 5-minute sync loop.
    const channel = supabase
      .channel(`email-feed-sync-${emailCacheScope}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "inbox_actions",
          filter: `user_id=eq.${emailCacheScope}`,
        },
        (payload) => {
          const row = payload.new as {
            id?: unknown;
            metadata?: unknown;
            status?: unknown;
          } | null;
          const rowMetadata =
            row?.metadata &&
            typeof row.metadata === "object" &&
            !Array.isArray(row.metadata)
              ? (row.metadata as Record<string, unknown>)
              : null;
          // Ignore intermediate tracking writes, but make a final send visible
          // in another tab/device that is already sitting in Sent. Marking a
          // cached Sent page stale also guarantees the next navigation
          // reconciles instead of reusing a recently opened snapshot.
          if (rowMetadata?.email_tracking_record === true) {
            const completedSendIdentity =
              emailTrackingCompletedSendIdentity(payload.new, payload.old);
            const seenCompletedSends =
              completedSentRealtimeIdentitiesRef.current;
            if (
              completedSendIdentity &&
              !seenCompletedSends.has(completedSendIdentity)
            ) {
              seenCompletedSends.add(completedSendIdentity);
              while (seenCompletedSends.size > 300) {
                const oldest = seenCompletedSends.values().next().value;
                if (typeof oldest !== "string") break;
                seenCompletedSends.delete(oldest);
              }
              for (const cached of Array.from(
                feedCacheRef.current.values(),
              )) {
                if (cached.feed.view !== "sent") continue;
                rememberFeed(
                  "sent",
                  cached.connectionId,
                  cached.feed,
                  cached.limit,
                  0,
                );
              }
              if (viewRef.current === "sent") scheduleRefresh();
            }
            return;
          }
          // The global notification bridge applies explicit queue/read
          // corrections immediately (and replays them if this workspace is
          // mounting). Do not also issue one action-delta request per
          // historical row updated by the same conversation-level action.
          const correction = emailWorkspaceCorrectionFromRow(payload.new);
          const rowStatus =
            typeof row?.status === "string" ? row.status.trim() : "";
          const terminalAction =
            rowStatus === "done" ||
            rowStatus === "rejected" ||
            rowStatus === "failed";
          if (correction && !terminalAction) return;
          const actionId =
            typeof row?.id === "string" ? row.id.trim() : "";
          if (actionId) {
            const delta = applyFocusActionDelta({
              actionIds: [actionId],
              filter: mailboxFilterRef.current,
            });
            if (viewRef.current === "focus") {
              void delta.then((applied) => {
                if (!applied) scheduleRefresh();
              });
              return;
            }
            void delta;
          }
          scheduleRefresh();
        },
      )
      .subscribe();
    return () => {
      disposed = true;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      void supabase.removeChannel(channel);
    };
  }, [
    applyFocusActionDelta,
    cacheHydrated,
    emailCacheScope,
    loadFeed,
    rememberFeed,
  ]);

  useEffect(() => {
    if (
      !cacheHydrated ||
      !isEmailView(view) ||
      query ||
      loading ||
      backgroundRefreshing
    ) {
      return;
    }
    const candidates = feed.threads.slice(
      0,
      mobileSwipeEnabled ? 2 : EMAIL_PREFETCH_THREAD_COUNT,
    );
    if (candidates.length === 0) return;
    let cancelled = false;
    // Hover prefetch never fires on touch devices, so warm the top of the
    // list shortly after it settles; requestThreadDetail dedupes against
    // the detail cache and in-flight requests.
    const timer = window.setTimeout(() => {
      if (cancelled || document.visibilityState !== "visible") return;
      const queue = candidates.filter((thread) => {
        const cached = detailCacheRef.current.get(detailCacheKey(thread));
        return !(
          cached &&
          cached.expiresAt > Date.now() &&
          emailThreadDetailContainsMessage(cached.detail, thread.messageId)
        );
      });
      void Promise.all(
        Array.from({
          length: mobileSwipeEnabled ? 1 : EMAIL_PREFETCH_CONCURRENCY,
        }, async () => {
          while (!cancelled) {
            const thread = queue.shift();
            if (!thread) return;
            try {
              await requestThreadDetail(thread);
            } catch {
              // Prefetch is opportunistic and never surfaces errors.
            }
          }
        }),
      );
    }, EMAIL_PREFETCH_START_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    backgroundRefreshing,
    cacheHydrated,
    detailCacheKey,
    feed.threads,
    loading,
    mobileSwipeEnabled,
    query,
    requestThreadDetail,
    view,
  ]);

  const openThreadFromDeepLink = useCallback(
    async (target: {
      connectionId: string;
      threadId: string;
      messageId: string | null;
    }) => {
      const known = feedRef.current.threads.find(
        (thread) =>
          thread.connectionId === target.connectionId &&
          thread.threadId === target.threadId,
      );
      // The service worker warms the body when the push arrives, so this
      // usually resolves without touching the network.
      const prefetched = await readEmailBackgroundThreadSnapshot({
        scope: emailCacheScope,
        connectionId: target.connectionId,
        threadId: target.threadId,
      });
      if (
        prefetched &&
        emailThreadDetailContainsMessage(
          prefetched.detail,
          target.messageId,
        )
      ) {
        const summary = prefetched.detail.summary;
        detailCacheRef.current.set(`${viewRef.current}:${summary.key}`, {
          detail: prefetched.detail,
          expiresAt: Date.now() + EMAIL_DETAIL_CACHE_TTL_MS,
        });
        void openThread(summary);
        return;
      }
      if (known) {
        void openThread(known);
        return;
      }
      // Nothing cached (cold start with no warm-up): reveal the conversation
      // pane right away so the tap lands on the message, not the list.
      setSelectedKey(null);
      setDetail(null);
      setDetailLoading(true);
      const params = new URLSearchParams({
        connectionId: target.connectionId,
        threadId: target.threadId,
      });
      if (target.messageId) params.set("messageId", target.messageId);
      // Without this the route re-derives the address from Gmail, adding a
      // serialized profile round trip in front of the thread fetch.
      const mailboxAddress = feedRef.current.mailboxes.find(
        (mailbox) => mailbox.connectionId === target.connectionId,
      )?.address;
      if (mailboxAddress) params.set("mailboxAddress", mailboxAddress);
      for (const address of new Set(
        feedRef.current.mailboxes
          .map((mailbox) => mailbox.address)
          .filter(Boolean),
      )) {
        params.append("ownedAddress", address);
      }
      try {
        const payload = await jsonRequest<{
          ok: true;
          thread: EmailThreadDetail;
        }>(`/api/email/thread?${params.toString()}`);
        const summary = payload.thread.summary;
        detailCacheRef.current.set(`${viewRef.current}:${summary.key}`, {
          detail: payload.thread,
          expiresAt: Date.now() + EMAIL_DETAIL_CACHE_TTL_MS,
        });
        void openThread(summary);
      } catch {
        // The list stays usable when the linked conversation is gone.
        setDetailLoading(false);
      }
    },
    [emailCacheScope, openThread],
  );

  const consumeEmailDeepLink = useCallback(
    (search: string) => {
      const params = new URLSearchParams(search);
      const threadId = params.get("openThreadId")?.trim() || "";
      const connectionId = params.get("openConnectionId")?.trim() || "";
      const messageId = params.get("openMessageId")?.trim() || null;
      if (!threadId || !connectionId) return;
      params.delete("openThreadId");
      params.delete("openConnectionId");
      params.delete("openMessageId");
      const remaining = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${remaining ? `?${remaining}` : ""}${
          window.location.hash
        }`,
      );
      void openThreadFromDeepLink({ connectionId, threadId, messageId });
    },
    [openThreadFromDeepLink],
  );

  const consumeEmailDeepLinkRef = useRef(consumeEmailDeepLink);
  consumeEmailDeepLinkRef.current = consumeEmailDeepLink;

  useEffect(() => {
    if (!cacheHydrated) return;
    // Reading through a ref keeps this effect single-run per mount; the
    // callback's identity churns with every feed refresh, and re-running
    // here would re-open the linked thread later.
    consumeEmailDeepLinkRef.current(window.location.search);
    const onAppNavigate = (event: Event) => {
      const url =
        event instanceof CustomEvent
          ? (event.detail as { url?: unknown } | null)?.url
          : null;
      if (typeof url !== "string") return;
      try {
        const parsed = new URL(url, window.location.origin);
        if (parsed.pathname === "/email") {
          consumeEmailDeepLinkRef.current(parsed.search);
        }
      } catch {
        // Malformed URLs from other windows are ignored.
      }
    };
    window.addEventListener(APP_NAVIGATE_EVENT, onAppNavigate);
    return () =>
      window.removeEventListener(APP_NAVIGATE_EVENT, onAppNavigate);
  }, [cacheHydrated]);

  const toggleConversationMessage = useCallback((messageId: string) => {
    setExpandedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const composeFromConversationMessage = useCallback(
    (message: EmailMessage, mode: ThreadComposeMode) => {
      if (!detail) return;
      setExpandedMessageIds((current) => new Set(current).add(message.id));
      setThreadComposeIntent({ messageId: message.id, mode });
      showComposer(composerFromMessage(detail, message, mode));
      window.requestAnimationFrame(() => {
        const composerRoot = document.querySelector<HTMLElement>(
          "[data-email-composer-body]",
        );
        composerRoot?.scrollIntoView({ behavior: "smooth", block: "start" });
        window.requestAnimationFrame(() => {
          composerRoot?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
        });
      });
    },
    [detail, showComposer],
  );

  const setThreadActionState = useCallback(
    (threadKey: string, next: EmailActionUiState | null) => {
      setActionStates((current) => {
        if (next) return { ...current, [threadKey]: next };
        if (!(threadKey in current)) return current;
        const updated = { ...current };
        delete updated[threadKey];
        return updated;
      });
    },
    [],
  );

  const setCalendarRsvpState = useCallback(
    (threadKey: string, next: CalendarRsvpUiState | null) => {
      setCalendarRsvpStates((current) => {
        if (next) return { ...current, [threadKey]: next };
        if (!(threadKey in current)) return current;
        const updated = { ...current };
        delete updated[threadKey];
        return updated;
      });
    },
    [],
  );

  const runAction = useCallback(
    (
      thread: EmailThreadSummary,
      operation: EmailWorkspaceOperation,
    ) => {
      if (pendingActionKeysRef.current.has(thread.key)) return;
      if (
        feedAbortRef.current ||
        foregroundLoadingRef.current ||
        backgroundRefreshingRef.current
      ) {
        // The version bump below invalidates the active response. Ensure it is
        // replaced after the action queue settles instead of silently losing
        // a foreground or background navigation request.
        queuedBackgroundRefreshRef.current = true;
      }
      feedMutationVersionRef.current += 1;
      const queuedView: EmailView = isEmailView(view) ? view : "focus";
      const queuedMailboxFilter = mailboxFilter;
      const queuedFeedLimit = feedLimitRef.current;
      const requestId = globalThis.crypto.randomUUID();
      const localTargetView = emailWorkspaceOverrideForOperation(operation);
      const localCorrectionIdentity = `${thread.connectionId}:${thread.threadId}`;
      if (localTargetView) {
        const correctedAt = new Date().toISOString();
        localWorkspaceCorrectionsRef.current.set(localCorrectionIdentity, {
          correction: {
            userId: emailCacheScope,
            connectionId: thread.connectionId,
            threadId: thread.threadId,
            targetView: localTargetView,
            targetViewChangedAt: correctedAt,
            correctedAt,
          },
          accepted: false,
          expiresAt: Date.now() + EMAIL_LOCAL_WORKSPACE_CORRECTION_TTL_MS,
        });
      }
      pendingActionKeysRef.current.add(thread.key);
      lastLocalEmailMutationAtRef.current = Date.now();
      setError(null);
      setThreadActionState(thread.key, {
        phase: "queued",
        operation,
        attempt: 0,
      });
      let optimisticBaseline:
        | {
            feed: EmailFeedResponse;
            stats: EmailFeedResponse["stats"];
            limit: number;
            revision: number;
          }
        | null = null;
      let optimisticCanonicalStats: EmailFeedResponse["stats"] | null =
        null;

      // Paint before enqueueing the provider mutation. Opening an unread
      // conversation already has a read request in the serial queue; Done
      // must still disappear immediately instead of waiting behind it.
      const optimisticViewIsActive =
        viewRef.current === queuedView &&
        mailboxFilterRef.current === queuedMailboxFilter;
      const optimisticCached = cachedFeedFor(
        queuedView,
        queuedMailboxFilter,
      );
      const optimisticCurrentFeed = optimisticViewIsActive
        ? feedRef.current
        : optimisticCached?.feed;
      if (optimisticCurrentFeed) {
        const optimisticStats =
          queuedMailboxFilter === mailboxFilterRef.current
            ? navigationStatsRef.current
            : optimisticCurrentFeed.stats;
        optimisticCanonicalStats = applyOptimisticEmailNavigationStats(
          optimisticStats,
          thread,
          operation,
          queuedView,
        );
        const optimisticListFeed = applyOptimisticEmailOperation(
          optimisticCurrentFeed,
          thread,
          operation,
          queuedView,
        );
        const optimisticFeed = {
          ...optimisticListFeed,
          stats: optimisticCanonicalStats,
        };
        const optimisticEntry = rememberFeed(
          queuedView,
          queuedMailboxFilter,
          optimisticFeed,
          optimisticCached?.limit || queuedFeedLimit,
        );
        optimisticBaseline = {
          feed: optimisticCurrentFeed,
          stats: optimisticStats,
          limit: optimisticCached?.limit || queuedFeedLimit,
          revision: optimisticEntry.revision || 0,
        };
        if (queuedMailboxFilter === mailboxFilterRef.current) {
          replaceNavigationStats(
            optimisticCanonicalStats,
            optimisticCanonicalStats.needsReview,
          );
        }
        if (optimisticViewIsActive) {
          const previousIndex = optimisticCurrentFeed.threads.findIndex(
            (item) => item.key === thread.key,
          );
          feedRef.current = optimisticFeed;
          setFeed(optimisticFeed);
          if (
            optimisticFeed.threads.length <
            optimisticCurrentFeed.threads.length
          ) {
            const nextSelection =
              optimisticFeed.threads[
                Math.min(
                  Math.max(previousIndex, 0),
                  Math.max(optimisticFeed.threads.length - 1, 0),
                )
              ]?.key || null;
            setSelectedKey((current) =>
              current === thread.key ? nextSelection : current,
            );
            if (
              detail?.summary.key === thread.key ||
              openingThread?.key === thread.key
            ) {
              closeDetail(false);
            }
          }
        }
      }

      const rollbackOptimistic = () => {
        if (!optimisticBaseline) return;
        const latest = cachedFeedFor(queuedView, queuedMailboxFilter);
        // Only roll back the exact optimistic revision. A newer correction
        // wins and the authoritative refresh resolves the failed request.
        if ((latest?.revision || 0) !== optimisticBaseline.revision) return;
        rememberFeed(
          queuedView,
          queuedMailboxFilter,
          optimisticBaseline.feed,
          optimisticBaseline.limit,
        );
        if (queuedMailboxFilter === mailboxFilterRef.current) {
          replaceNavigationStats(
            optimisticBaseline.stats,
            optimisticBaseline.stats.needsReview,
          );
        }
        if (
          viewRef.current === queuedView &&
          mailboxFilterRef.current === queuedMailboxFilter
        ) {
          feedRef.current = optimisticBaseline.feed;
          setFeed(optimisticBaseline.feed);
          setSelectedKey(thread.key);
        }
      };

      const enqueued = actionQueueRef.current.enqueue({
        key: thread.key,
        run: async () => {
          let lastAttempt = 0;
          try {
            await runEmailActionWithRetry({
              execute: async () => {
                await jsonRequest("/api/email/action", {
                  method: "POST",
                  body: JSON.stringify({
                    operation,
                    connectionId: thread.connectionId,
                    threadId: thread.threadId,
                    messageId: thread.messageId,
                    actionId: thread.action?.id,
                    senderEmail: thread.senderEmail,
                    senderName: thread.senderName,
                    subject: thread.subject,
                    snippet: thread.snippet,
                    receivedAt: thread.receivedAt,
                    previousView: queuedView,
                    requestId,
                  }),
                });
              },
              onState: (state) => {
                lastAttempt = state.attempt;
                setThreadActionState(thread.key, {
                  phase: state.phase,
                  operation,
                  attempt: state.attempt,
                });
              },
            });
            feedMutationVersionRef.current += 1;
            lastLocalEmailMutationAtRef.current = Date.now();
            invalidateThreadDetail(thread.key);
            const localCorrection =
              localWorkspaceCorrectionsRef.current.get(
                localCorrectionIdentity,
              );
            if (localCorrection) {
              localWorkspaceCorrectionsRef.current.set(
                localCorrectionIdentity,
                {
                  ...localCorrection,
                  accepted: true,
                  expiresAt:
                    Date.now() + EMAIL_LOCAL_WORKSPACE_CORRECTION_TTL_MS,
                },
              );
            }

            const actionViewIsActive =
              viewRef.current === queuedView &&
              mailboxFilterRef.current === queuedMailboxFilter;
            const cached = cachedFeedFor(
              queuedView,
              queuedMailboxFilter,
            );
            const currentFeed = actionViewIsActive
              ? feedRef.current
              : cached?.feed;
            const acceptedAt = Date.now();
            const queuedScopeStats =
              queuedMailboxFilter === mailboxFilterRef.current
                ? navigationStatsRef.current
                : Array.from(feedCacheRef.current.values())
                    .filter(
                      (entry) =>
                        entry.connectionId === queuedMailboxFilter,
                    )
                    .sort(
                      (left, right) => right.savedAt - left.savedAt,
                    )[0]?.feed.stats ?? currentFeed?.stats;
            const canonicalStats = optimisticBaseline
              ? queuedScopeStats || optimisticCanonicalStats
              : queuedScopeStats
                ? applyOptimisticEmailNavigationStats(
                    queuedScopeStats,
                    thread,
                    operation,
                    queuedView,
                  )
                : null;
            if (
              canonicalStats &&
              queuedMailboxFilter === mailboxFilterRef.current
            ) {
              replaceNavigationStats(
                canonicalStats,
                canonicalStats.needsReview,
              );
            }
            if (currentFeed) {
              const previousIndex = currentFeed.threads.findIndex(
                (item) => item.key === thread.key,
              );
              const acceptedListFeed = applyOptimisticEmailOperation(
                currentFeed,
                thread,
                operation,
                queuedView,
              );
              const acceptedFeed = canonicalStats
                ? { ...acceptedListFeed, stats: canonicalStats }
                : acceptedListFeed;
              const removedFromView =
                acceptedFeed.threads.length < currentFeed.threads.length;
              const acceptedKeys = new Set(
                acceptedFeed.threads.map((item) => item.key),
              );
              const removedKeys = new Set(
                currentFeed.threads
                  .filter((item) => !acceptedKeys.has(item.key))
                  .map((item) => item.key),
              );
              rememberFeed(
                queuedView,
                queuedMailboxFilter,
                acceptedFeed,
                cached?.limit || queuedFeedLimit,
                acceptedAt,
              );
              if (actionViewIsActive) {
                feedRef.current = acceptedFeed;
                setFeed(acceptedFeed);
                if (removedFromView) {
                  const nextSelection =
                    acceptedFeed.threads[
                      Math.min(
                        Math.max(previousIndex, 0),
                        Math.max(acceptedFeed.threads.length - 1, 0),
                      )
                    ]?.key || null;
                  setSelectedKey((current) =>
                    current && removedKeys.has(current)
                      ? nextSelection
                      : current,
                  );
                  if (
                    detail?.summary.key === thread.key ||
                    openingThread?.key === thread.key
                  ) {
                    closeDetail(false);
                  }
                }
              }
            }

            if (
              operation !== "read" &&
              operation !== "unread" &&
              operation !== "star" &&
              operation !== "unstar"
            ) {
              for (const cachedEntry of Array.from(
                feedCacheRef.current.values(),
              )) {
                if (
                  cachedEntry.feed.view === queuedView &&
                  cachedEntry.connectionId === queuedMailboxFilter
                ) {
                  continue;
                }
                const mutatesExclusiveList =
                  cachedEntry.feed.view === "focus" ||
                  cachedEntry.feed.view === "inbox" ||
                  cachedEntry.feed.view === "noise" ||
                  cachedEntry.feed.view === "handled";
                const nextCachedListFeed = mutatesExclusiveList
                  ? applyOptimisticEmailOperation(
                      cachedEntry.feed,
                      thread,
                      operation,
                      cachedEntry.feed.view,
                    )
                  : cachedEntry.feed;
                const nextCachedFeed =
                  canonicalStats &&
                  cachedEntry.connectionId === queuedMailboxFilter
                    ? {
                        ...nextCachedListFeed,
                        stats: canonicalStats,
                      }
                    : nextCachedListFeed;
                const destinationCacheMissingConversation = Boolean(
                  localTargetView &&
                    cachedEntry.feed.view === localTargetView &&
                    (cachedEntry.connectionId === null ||
                      cachedEntry.connectionId === thread.connectionId) &&
                    !cachedEntry.feed.threads.some(
                      (candidate) =>
                        candidate.connectionId === thread.connectionId &&
                        candidate.threadId === thread.threadId,
                    ),
                );
                if (
                  nextCachedFeed === cachedEntry.feed &&
                  !destinationCacheMissingConversation
                ) {
                  continue;
                }
                if (
                  destinationCacheMissingConversation &&
                  viewRef.current === cachedEntry.feed.view &&
                  mailboxFilterRef.current === cachedEntry.connectionId
                ) {
                  // The user may have opened the destination queue while the
                  // provider mutation was still pending. Staling its cache is
                  // sufficient for a later navigation, but the already-open
                  // queue also needs the single post-drain reconciliation.
                  queuedBackgroundRefreshRef.current = true;
                }
                rememberFeed(
                  cachedEntry.feed.view,
                  cachedEntry.connectionId,
                  nextCachedFeed,
                  cachedEntry.limit,
                  // Updating canonical totals does not materialize the moved
                  // card in its destination queue. Keep that cache visibly
                  // usable, but mark it stale so opening the queue fetches the
                  // authoritative card instead of reusing a falsely fresh
                  // snapshot for the full navigation cooldown.
                  destinationCacheMissingConversation ? 0 : acceptedAt,
                );
                if (
                  viewRef.current === cachedEntry.feed.view &&
                  mailboxFilterRef.current === cachedEntry.connectionId
                ) {
                  feedRef.current = nextCachedFeed;
                  setFeed(nextCachedFeed);
                }
              }
            }

            if (operation === "read" || operation === "unread") {
              const unread = operation === "unread";
              const identity = emailConversationIdentity(thread);
              if (unread) {
                locallyReadThreadCutoffsRef.current.delete(identity);
              } else {
                const receivedAt = Date.parse(thread.receivedAt);
                locallyReadThreadCutoffsRef.current.set(
                  identity,
                  Number.isFinite(receivedAt) ? receivedAt : Date.now(),
                );
              }
              updateConversationUnread(thread, unread);
            } else if (operation === "star" || operation === "unstar") {
              const starred = operation === "star";
              setDetail((current) =>
                current?.summary.key === thread.key
                  ? {
                      ...current,
                      summary: { ...current.summary, starred },
                    }
                  : current,
              );
            }
            setThreadActionState(thread.key, null);
          } catch (reason) {
            // A failed request can follow a partial Gmail mutation, and the
            // optimistic rollback intentionally yields to any newer cache
            // revision. One post-drain refresh resolves both cases.
            queuedBackgroundRefreshRef.current = true;
            localWorkspaceCorrectionsRef.current.delete(
              localCorrectionIdentity,
            );
            rollbackOptimistic();
            const message =
              reason instanceof Error
                ? reason.message
                : "Could not update email.";
            setThreadActionState(thread.key, {
              phase: "failed",
              operation,
              attempt: lastAttempt,
              error: message,
            });
            const actionViewIsActive =
              viewRef.current === queuedView &&
              mailboxFilterRef.current === queuedMailboxFilter;
            if (actionViewIsActive) setError(message);
          } finally {
            feedMutationVersionRef.current += 1;
            pendingActionKeysRef.current.delete(thread.key);
            flushQueuedActionRefresh();
          }
        },
      });
      if (!enqueued) {
        rollbackOptimistic();
        localWorkspaceCorrectionsRef.current.delete(localCorrectionIdentity);
        pendingActionKeysRef.current.delete(thread.key);
        setThreadActionState(thread.key, null);
        flushQueuedActionRefresh();
      }
    },
    [
      closeDetail,
      cachedFeedFor,
      detail?.summary.key,
      emailCacheScope,
      flushQueuedActionRefresh,
      invalidateThreadDetail,
      mailboxFilter,
      rememberFeed,
      openingThread?.key,
      replaceNavigationStats,
      setThreadActionState,
      updateConversationUnread,
      view,
    ],
  );

  const runCalendarRsvp = useCallback(
    (
      thread: EmailThreadSummary,
      responseStatus: CalendarRsvpStatus,
    ) => {
      if (pendingActionKeysRef.current.has(thread.key)) return;
      const queuedView: EmailView = isEmailView(view) ? view : "focus";
      const queuedMailboxFilter = mailboxFilter;
      const localCorrectionIdentity = `${thread.connectionId}:${thread.threadId}`;
      const correctedAt = new Date().toISOString();
      localWorkspaceCorrectionsRef.current.set(localCorrectionIdentity, {
        correction: {
          userId: emailCacheScope,
          connectionId: thread.connectionId,
          threadId: thread.threadId,
          targetView: "handled",
          targetViewChangedAt: correctedAt,
          correctedAt,
        },
        accepted: false,
        expiresAt: Date.now() + EMAIL_LOCAL_WORKSPACE_CORRECTION_TTL_MS,
      });
      pendingActionKeysRef.current.add(thread.key);
      setError(null);
      setCalendarRsvpState(thread.key, {
        phase: "queued",
        responseStatus,
      });

      const enqueued = actionQueueRef.current.enqueue({
        key: thread.key,
        run: async () => {
          try {
            const payload = await runEmailActionWithRetry<{
              ok: true;
              invite: EmailCalendarInvite;
              warning?: string;
            }>({
              execute: async () => {
                return jsonRequest<{
                  ok: true;
                  invite: EmailCalendarInvite;
                  warning?: string;
                }>("/api/email/calendar-rsvp", {
                  method: "POST",
                  body: JSON.stringify({
                    connectionId: thread.connectionId,
                    threadId: thread.threadId,
                    messageId: thread.messageId,
                    actionId: thread.action?.id,
                    subject: thread.subject,
                    snippet: thread.snippet,
                    receivedAt: thread.receivedAt,
                    responseStatus,
                  }),
                });
              },
              onState: (state) => {
                setCalendarRsvpState(thread.key, {
                  phase: state.phase,
                  responseStatus,
                });
              },
            });
            feedMutationVersionRef.current += 1;
            invalidateThreadDetail(thread.key);
            const localCorrection =
              localWorkspaceCorrectionsRef.current.get(
                localCorrectionIdentity,
              );
            if (localCorrection) {
              localWorkspaceCorrectionsRef.current.set(
                localCorrectionIdentity,
                {
                  ...localCorrection,
                  correction: {
                    ...localCorrection.correction,
                    targetViewChangedAt:
                      payload.invite.respondedAt ||
                      localCorrection.correction.targetViewChangedAt,
                    correctedAt:
                      payload.invite.respondedAt ||
                      localCorrection.correction.correctedAt,
                  },
                  accepted: true,
                  expiresAt:
                    Date.now() + EMAIL_LOCAL_WORKSPACE_CORRECTION_TTL_MS,
                },
              );
            }
            const acceptedAt = Date.now();
            const queuedScopeStats =
              queuedMailboxFilter === mailboxFilterRef.current
                ? navigationStatsRef.current
                : Array.from(feedCacheRef.current.values())
                    .filter(
                      (entry) =>
                        entry.connectionId === queuedMailboxFilter,
                    )
                    .sort(
                      (left, right) => right.savedAt - left.savedAt,
                    )[0]?.feed.stats;
            const canonicalStats = queuedScopeStats
              ? applyOptimisticEmailNavigationStats(
                  queuedScopeStats,
                  thread,
                  "move_handled",
                  queuedView,
                )
              : null;
            if (
              canonicalStats &&
              queuedMailboxFilter === mailboxFilterRef.current
            ) {
              replaceNavigationStats(
                canonicalStats,
                canonicalStats.needsReview,
              );
            }

            for (const cached of Array.from(
              feedCacheRef.current.values(),
            )) {
              const nextListFeed = applyCalendarRsvpToFeed(
                cached.feed,
                thread,
                payload.invite,
              );
              const nextFeed =
                canonicalStats &&
                cached.connectionId === queuedMailboxFilter
                  ? { ...nextListFeed, stats: canonicalStats }
                  : nextListFeed;
              if (nextFeed !== cached.feed) {
                rememberFeed(
                  cached.feed.view,
                  cached.connectionId,
                  nextFeed,
                  cached.limit,
                  acceptedAt,
                );
              }
            }

            const currentFeed = feedRef.current;
            const nextListFeed = applyCalendarRsvpToFeed(
              currentFeed,
              thread,
              payload.invite,
            );
            const nextFeed =
              canonicalStats &&
              mailboxFilterRef.current === queuedMailboxFilter
                ? { ...nextListFeed, stats: canonicalStats }
                : nextListFeed;
            if (nextFeed !== currentFeed) {
              const previousIndex = currentFeed.threads.findIndex(
                (item) => item.key === thread.key,
              );
              feedRef.current = nextFeed;
              setFeed(nextFeed);
              if (nextFeed.threads.length < currentFeed.threads.length) {
                const nextSelection =
                  nextFeed.threads[
                    Math.min(
                      Math.max(previousIndex, 0),
                      Math.max(nextFeed.threads.length - 1, 0),
                    )
                  ]?.key || null;
                setSelectedKey((current) =>
                  current === thread.key ? nextSelection : current,
                );
                if (
                  detail?.summary.key === thread.key ||
                  openingThread?.key === thread.key
                ) {
                  closeDetail(false);
                }
              }
            }
            setSearchState((current) => ({
              ...current,
              results: current.results.map((item) =>
                item.connectionId === thread.connectionId &&
                item.threadId === thread.threadId
                  ? { ...item, calendarInvite: payload.invite }
                  : item,
              ),
            }));
            setDetail((current) =>
              current?.summary.connectionId === thread.connectionId &&
              current.summary.threadId === thread.threadId
                ? {
                    ...current,
                    summary: {
                      ...current.summary,
                      calendarInvite: payload.invite,
                    },
                  }
                : current,
            );
            showOrganizationStatus(
              payload.warning ||
                `Invitation ${calendarRsvpLabel(responseStatus).toLowerCase()}`,
            );
            setCalendarRsvpState(thread.key, null);
          } catch (reason) {
            localWorkspaceCorrectionsRef.current.delete(
              localCorrectionIdentity,
            );
            const message =
              reason instanceof Error
                ? reason.message
                : "Could not respond to this calendar invitation.";
            const errorPayload =
              reason &&
              typeof reason === "object" &&
              "payload" in reason &&
              reason.payload &&
              typeof reason.payload === "object" &&
              !Array.isArray(reason.payload)
                ? (reason.payload as Record<string, unknown>)
                : null;
            setCalendarRsvpState(thread.key, {
              phase: "failed",
              responseStatus,
              error: message,
              code:
                typeof errorPayload?.code === "string"
                  ? errorPayload.code
                  : undefined,
              requiredCalendarEmail:
                typeof errorPayload?.requiredCalendarEmail === "string"
                  ? errorPayload.requiredCalendarEmail
                  : undefined,
              openInGmailUrl:
                typeof errorPayload?.openInGmailUrl === "string"
                  ? errorPayload.openInGmailUrl
                  : undefined,
            });
            setError(message);
          } finally {
            // Calendar RSVP reconciliation still requires an authoritative
            // pass. Carry that requirement across any later queued action so
            // the final task, whichever kind it is, flushes it exactly once.
            queuedBackgroundRefreshRef.current = true;
            pendingActionKeysRef.current.delete(thread.key);
            flushQueuedActionRefresh();
          }
        },
      });
      if (!enqueued) {
        localWorkspaceCorrectionsRef.current.delete(localCorrectionIdentity);
        pendingActionKeysRef.current.delete(thread.key);
        setCalendarRsvpState(thread.key, null);
        flushQueuedActionRefresh();
      }
    },
    [
      closeDetail,
      detail?.summary.key,
      emailCacheScope,
      flushQueuedActionRefresh,
      invalidateThreadDetail,
      mailboxFilter,
      openingThread?.key,
      rememberFeed,
      replaceNavigationStats,
      setCalendarRsvpState,
      showOrganizationStatus,
      view,
    ],
  );

  const startCompose = useCallback(() => {
    const mailbox = defaultComposerMailbox(feed.mailboxes, mailboxFilter);
    closeDetail(false);
    navigationSnapshotRef.current = null;
    setSelectedKey(null);
    if (!isEmailView(view)) {
      viewRef.current = "drafts";
      setView("drafts");
      setSelectedSnippetId(null);
    }
    showComposer(emptyComposer(mailbox));
  }, [closeDetail, feed.mailboxes, mailboxFilter, showComposer, view]);

  useEffect(
    () => () => {
      detailRequestRef.current += 1;
      detailAbortRef.current?.abort();
      searchRequestRef.current += 1;
      searchAbortRef.current?.abort();
    },
    [],
  );

  const runWorkspaceShortcut = useCallback(
    (
      shortcut: DesktopNativeEmailShortcut,
      source: "dom" | "native",
    ): boolean => {
      const now = Date.now();
      const previous = lastWorkspaceShortcutRef.current;
      if (
        previous?.shortcut === shortcut &&
        previous.source !== source &&
        now - previous.at < 300
      ) {
        return true;
      }

      const handled = () => {
        lastWorkspaceShortcutRef.current = { shortcut, source, at: now };
        return true;
      };
      if (shortcut === "escape") {
        if (shortcutsOpen) setShortcutsOpen(false);
        else if (mailboxSettingsOpen) setMailboxSettingsOpen(false);
        else if (detail || openingThread) closeDetail();
        else if (composer) deactivateComposer();
        else return false;
        return handled();
      }
      if (shortcut === "open-shortcuts") {
        setShortcutsOpen(true);
        return handled();
      }
      if (shortcut === "search") {
        searchRef.current?.focus();
        return handled();
      }
      if (shortcut === "compose") {
        startCompose();
        return handled();
      }

      const currentIndex = visibleThreads.findIndex(
        (item) => item.key === selectedKey,
      );
      if (shortcut === "next" || shortcut === "previous") {
        const delta = shortcut === "next" ? 1 : -1;
        const baseIndex =
          currentIndex < 0 ? (delta > 0 ? -1 : 0) : currentIndex;
        const nextIndex = Math.min(
          visibleThreads.length - 1,
          Math.max(0, baseIndex + delta),
        );
        setSelectedKey(visibleThreads[nextIndex]?.key || null);
        return handled();
      }

      const thread = visibleThreads[currentIndex < 0 ? 0 : currentIndex];
      if (!thread) return false;
      if (shortcut === "open-reply-all") {
        void openThread(thread, "reply_all");
      } else if (shortcut === "forward") {
        void openThread(thread, "forward");
      } else if (shortcut === "mark-done" && view !== "sent") {
        void runAction(thread, "move_handled");
      } else if (shortcut === "archive" && view !== "sent") {
        void runAction(thread, "archive");
      } else if (shortcut === "toggle-star") {
        void runAction(thread, thread.starred ? "unstar" : "star");
      } else if (shortcut === "mark-unread" && view !== "sent") {
        void runAction(thread, "unread");
      } else {
        return false;
      }
      return handled();
    },
    [
      closeDetail,
      composer,
      deactivateComposer,
      detail,
      mailboxSettingsOpen,
      openThread,
      openingThread,
      runAction,
      selectedKey,
      shortcutsOpen,
      startCompose,
      view,
      visibleThreads,
    ],
  );

  useEffect(() => {
    const shortcutForEvent = (
      event: KeyboardEvent,
    ): DesktopNativeEmailShortcut | null => {
      if (event.key === "Escape") return "escape";
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k"
      ) {
        return "open-shortcuts";
      }
      if (!isPlainEmailShortcut(event)) return null;
      const key = event.key.toLowerCase();
      const code = event.code.toLowerCase();
      if (key === "?") return "open-shortcuts";
      if (key === "/") return "search";
      if (key === "c") return "compose";
      if (key === "j" || key === "arrowdown" || code === "arrowdown") {
        return "next";
      }
      if (key === "k" || key === "arrowup" || code === "arrowup") {
        return "previous";
      }
      if (
        key === "enter" ||
        key === "return" ||
        code === "enter" ||
        code === "numpadenter"
      ) {
        return "open-reply-all";
      }
      if (key === "f") return "forward";
      if (key === "d") return "mark-done";
      if (key === "e") return "archive";
      if (key === "s") return "toggle-star";
      if (key === "u") return "mark-unread";
      return null;
    };
    const isTypingTarget = (target: HTMLElement | null) =>
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      target?.tagName === "SELECT" ||
      target?.isContentEditable;
    const canRunShortcut = (
      shortcut: DesktopNativeEmailShortcut,
      target: HTMLElement | null,
    ) =>
      canRunEmailWorkspaceShortcut({
        shortcut,
        typing: Boolean(isTypingTarget(target)),
        overlayOpen: shortcutsOpen || mailboxSettingsOpen,
        inDialog: Boolean(target?.closest("[role='dialog']")),
        // Single-letter commands are global to the email workspace, including
        // when an email row button still owns focus after a click. Preserve the
        // native semantics of Enter and menu/select arrow navigation.
        enterControlFocused: Boolean(
          target?.closest(
            "button, a, select, [role='button'], [role='menuitem']",
          ),
        ),
        navigationControlFocused: Boolean(
          target?.closest("select, [role='menuitem']"),
        ),
      });

    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = shortcutForEvent(event);
      if (
        !shortcut ||
        !canRunShortcut(shortcut, event.target as HTMLElement | null)
      ) {
        return;
      }
      if (runWorkspaceShortcut(shortcut, "dom")) event.preventDefault();
    };
    const onNativeShortcut = (shortcut: DesktopNativeEmailShortcut) => {
      const target = document.activeElement as HTMLElement | null;
      if (!canRunShortcut(shortcut, target)) return;
      runWorkspaceShortcut(shortcut, "native");
    };

    document.addEventListener("keydown", onKeyDown);
    const unsubscribeNative = isDesktopShell()
      ? getDesktopApi().onNativeEmailShortcut(onNativeShortcut)
      : () => {};
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      unsubscribeNative();
    };
  }, [
    mailboxSettingsOpen,
    runWorkspaceShortcut,
    shortcutsOpen,
  ]);

  const laneGroups = useMemo(() => {
    if (view !== "focus" || normalizedSearchQuery) return null;
    const definitions = [
      ["ready", "Ready to send", "AI drafts waiting for your eyes"],
      ["read", "Worth reading", "Relevant, no reply required yet"],
    ] as const;
    const groups = definitions
      .map(([id, label, description]) => ({
        id,
        label,
        description,
        threads: visibleThreads.filter(
          (thread) => (thread.action?.lane || "read") === id,
        ),
      }))
      .filter((group) => group.threads.length > 0);
    return groups.length > 0 ? groups : null;
  }, [normalizedSearchQuery, view, visibleThreads]);

  const selectedSnippet =
    snippets.find((snippet) => snippet.id === selectedSnippetId) || null;
  const visibleRecoverableDrafts = mailboxFilter
    ? recoverableDrafts.filter(
        (draft) => draft.connectionId === mailboxFilter,
      )
    : recoverableDrafts;
  const reauthMailboxes = feed.mailboxes.filter(
    (mailbox) => mailbox.status === "reauth_required",
  );
  const unavailableMailboxes = feed.mailboxes.filter(
    (mailbox) => mailbox.status === "error",
  );
  const emailView: EmailView = isEmailView(view) ? view : "focus";
  const searchActive = Boolean(normalizedSearchQuery);
  const searchRequestActive =
    searchActive &&
    searchState.query === normalizedSearchQuery &&
    searchState.connectionId === mailboxFilter;
  const searchLoading = searchRequestActive && searchState.loading;
  const searchError = searchRequestActive ? searchState.error : null;
  const searchWarnings =
    searchRequestActive && searchState.resolved ? searchState.warnings : [];
  const canMarkSelectedDone = canMarkEmailDone(emailView);
  const selectedActionState = detail
    ? actionStates[detail.summary.key]
    : undefined;
  const selectedActionBusy = emailActionIsBusy(selectedActionState);
  const currentSwipeActions = getEmailSwipeActions(emailView);
  const loadingLabel =
    VIEW_ITEMS.find((item) => item.id === loadingView)?.label || "email";
  const isFocusZero =
    view === "focus" &&
    !loading &&
    !query &&
    feed.mailboxes.length > 0 &&
    feed.threads.length === 0;
  const threadContext =
    detail?.messages
      .slice(-5)
      .map(
        (message) =>
          `From: ${message.from}\nDate: ${message.sentAt}\n${message.body}`,
      )
      .join("\n\n---\n\n") || "";
  const activeComposeMessage =
    detail && threadComposeIntent
      ? detail.messages.find(
          (message) => message.id === threadComposeIntent.messageId,
        ) || null
      : null;
  const composeActionLabel =
    threadComposeIntent?.mode === "forward"
      ? `Forward message from ${activeComposeMessage?.isFromUser ? "you" : activeComposeMessage?.from || "this conversation"}`
      : threadComposeIntent?.mode === "reply"
        ? `Reply to ${activeComposeMessage?.isFromUser ? "your sent message" : activeComposeMessage?.from || "sender"}`
        : `Reply all to ${activeComposeMessage?.isFromUser ? "your sent message" : activeComposeMessage?.from || "the conversation"}`;
  const allMessagesExpanded = Boolean(
    detail?.messages.length &&
      detail.messages.every((message) => expandedMessageIds.has(message.id)),
  );
  const needsReviewCount = needsReviewNavigationCount(
    feed,
    prefetchedNeedsReviewCount,
  );

  return (
    <div className="app-viewport-shell flex w-full max-w-full flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <WorkspaceSwitcher
        modalOnly
        fallbackName="Workspace"
        switchDestination="/email"
      />
      <AppHeader
        device={device}
        workspaceName="Workspace"
        switchDestination="/email"
        endControls={
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            className="hidden h-9 items-center gap-2 rounded-xl border border-white/[0.07] px-2.5 text-xs text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200 sm:flex"
            title="Keyboard shortcuts"
          >
            <Command className="h-3.5 w-3.5" />
            <span className="hidden min-[1320px]:inline">Shortcuts</span>
          </button>
        }
      />
      <main className="relative flex min-h-0 flex-1 overflow-hidden">
        {sidebarOpen ? (
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="absolute inset-0 z-20 bg-black/60 lg:hidden"
            aria-label="Close email navigation"
          />
        ) : null}
        <aside
          className="email-workspace-sidebar inset-y-0 left-0 z-30 flex w-64 shrink-0 flex-col border-r border-white/[0.07]"
          data-open={sidebarOpen ? "true" : "false"}
        >
          <div className="p-3">
            <button
              type="button"
              onClick={() => {
                startCompose();
                setSidebarOpen(false);
              }}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-cyan-300/15 bg-gradient-to-r from-cyan-500/15 to-cyan-500/10 px-2.5 text-xs font-semibold text-cyan-50 shadow-sm shadow-cyan-950/20 transition hover:border-cyan-300/25 hover:from-cyan-500/20 hover:to-cyan-500/10"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-cyan-200 text-[#071317]">
                <Plus className="h-3 w-3" />
              </span>
              Compose
              <kbd className="ml-auto rounded border border-cyan-100/10 bg-black/15 px-1.5 py-0.5 font-mono text-[9px] text-cyan-100/45">
                C
              </kbd>
            </button>
          </div>
          <nav className="space-y-0.5 px-2">
            {VIEW_ITEMS.map((item) => {
              const Icon = item.icon;
              const count =
                item.id === "focus"
                  ? navigationStats.focus
                  : item.id === "noise"
                    ? navigationStats.noiseCaught
                    : item.id === "handled"
                      ? navigationStats.processed
                      : item.id === "sent"
                        ? view === "sent"
                          ? feed.threads.length
                          : 0
                        : item.id === "inbox"
                          ? needsReviewCount
                          : item.id === "all"
                            ? view === "all"
                              ? feed.threads.length
                              : 0
                            : item.id === "drafts"
                              ? recoverableDrafts.length
                              : snippets.length;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectView(item.id)}
                  className={classNames(
                    "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition",
                    view === item.id
                      ? "bg-white/[0.075] text-white"
                      : "text-zinc-500 hover:bg-white/[0.035] hover:text-zinc-300",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium">{item.label}</span>
                    <span className="block truncate text-[9px] text-zinc-600">
                      {item.description}
                    </span>
                  </span>
                  {count > 0 ? (
                    <span className="text-[10px] tabular-nums text-zinc-600">
                      {count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
          <div className="mt-5 px-3">
            <div className="flex items-center">
              <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-700">
                Mailboxes
              </p>
              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => void connectMailbox()}
                  disabled={connectMailboxBusy}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[9px] font-medium text-zinc-600 hover:bg-white/[0.04] hover:text-cyan-300 disabled:opacity-50"
                  aria-label="Add mailbox"
                  title="Connect another Gmail mailbox"
                >
                  {connectMailboxBusy ? (
                    <LoaderCircle className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => setMailboxSettingsOpen(true)}
                  className="rounded-md p-1 text-zinc-700 hover:text-zinc-300"
                  aria-label="Customize mailboxes"
                  title="Customize mailbox colors and visibility"
                >
                  <Settings2 className="h-3 w-3" />
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => selectMailbox(null)}
              className={classNames(
                "mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs",
                mailboxFilter === null
                  ? "bg-white/[0.055] text-zinc-200"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              <span className="flex w-5 items-center">
                {feed.mailboxes.slice(0, 3).map((mailbox, index) => (
                  <span
                    key={mailbox.connectionId}
                    className="-mr-1 h-2.5 w-2.5 rounded-full border-2 border-[#0d0e11]"
                    style={{
                      backgroundColor: mailbox.color,
                      zIndex: 3 - index,
                    }}
                  />
                ))}
              </span>
              Unified
            </button>
            {feed.mailboxes.map((mailbox) => (
              <button
                key={mailbox.connectionId}
                type="button"
                onClick={() => selectMailbox(mailbox.connectionId)}
                className={classNames(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs",
                  mailboxFilter === mailbox.connectionId
                    ? "bg-white/[0.055] text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: mailbox.color }}
                />
                <span className="min-w-0 flex-1 truncate text-left">
                  {mailbox.displayName}
                </span>
                {mailbox.status !== "connected" ? (
                  <CircleAlert className="h-3 w-3 text-amber-300" />
                ) : null}
              </button>
            ))}
          </div>
          <div className="mt-auto border-t border-white/[0.06] p-3">
            <div
              className="mb-1 flex items-center gap-2 rounded-lg px-2 py-2 text-[10px] text-zinc-600"
              title="Adding someone to a workspace does not share your mailbox."
            >
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-300/60" />
              <span>
                Private to you
                <span className="block text-[9px] text-zinc-700">
                  Workspace access is not mail access
                </span>
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-[11px] text-zinc-600 hover:bg-white/[0.035] hover:text-zinc-300"
            >
              <Keyboard className="h-3.5 w-3.5" />
              Keyboard map
              <kbd className="ml-auto font-mono text-[9px]">?</kbd>
            </button>
          </div>
        </aside>

        {view === "snippets" ? (
          <>
            <section className="flex w-full min-w-0 flex-col border-r border-white/[0.07] sm:w-80">
              <div className="flex h-14 items-center gap-2 border-b border-white/[0.07] px-3">
                <button
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  className="rounded-lg p-2 text-zinc-500 lg:hidden"
                  aria-label="Open email navigation"
                >
                  <Mail className="h-4 w-4" />
                </button>
                <div>
                  <p className="text-sm font-semibold text-white">Snippets</p>
                  <p className="text-[10px] text-zinc-600">Templates with memory</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedSnippetId(null)}
                  className="ml-auto rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white"
                  aria-label="New snippet"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {snippets.map((snippet) => (
                  <button
                    key={snippet.id}
                    type="button"
                    onClick={() => setSelectedSnippetId(snippet.id)}
                    className={classNames(
                      "w-full border-b border-white/[0.055] px-4 py-3.5 text-left",
                      selectedSnippetId === snippet.id
                        ? "bg-white/[0.07]"
                        : "hover:bg-white/[0.035]",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">
                        {snippet.name}
                      </span>
                      {snippet.shortcut ? (
                        <kbd className="text-[9px] text-zinc-600">
                          /{snippet.shortcut}
                        </kbd>
                      ) : null}
                    </span>
                    <span className="mt-1 block truncate text-[10px] text-zinc-600">
                      {snippet.subject || snippet.body || "Empty snippet"}
                    </span>
                  </button>
                ))}
                {snippets.length === 0 ? (
                  <div className="p-6 text-center">
                    <FileText className="mx-auto h-5 w-5 text-zinc-700" />
                    <p className="mt-2 text-xs text-zinc-500">No snippets yet.</p>
                    <p className="mt-1 text-[10px] text-zinc-700">
                      Create one, then type its /shortcut while composing.
                    </p>
                  </div>
                ) : null}
              </div>
            </section>
            <SnippetEditor
              key={selectedSnippet?.id || "new"}
              snippet={selectedSnippet}
              mailboxes={feed.mailboxes}
              onSaved={(snippet) => {
                setSnippets((current) => {
                  const exists = current.some((item) => item.id === snippet.id);
                  return exists
                    ? current.map((item) =>
                        item.id === snippet.id ? snippet : item,
                      )
                    : [snippet, ...current];
                });
                setSelectedSnippetId(snippet.id);
              }}
              onDeleted={(id) => {
                setSnippets((current) =>
                  current.filter((item) => item.id !== id),
                );
                setSelectedSnippetId(null);
              }}
            />
          </>
        ) : view === "drafts" ? (
          <>
            <section
              className={classNames(
                "flex w-full min-w-0 flex-col border-r border-white/[0.07] sm:w-80",
                composer ? "max-md:hidden" : "",
              )}
            >
              <div className="flex h-14 items-center gap-2 border-b border-white/[0.07] px-3">
                <button
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  className="rounded-lg p-2 text-zinc-500 lg:hidden"
                  aria-label="Open email navigation"
                >
                  <Mail className="h-4 w-4" />
                </button>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">Drafts</p>
                  <p className="truncate text-[10px] text-zinc-600">
                    Saved as you write · synced across devices
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void syncRecoverableDrafts(true)}
                  disabled={draftSyncing}
                  className="ml-auto rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white disabled:opacity-50"
                  aria-label="Sync email drafts"
                  title="Sync drafts"
                >
                  <RefreshCw
                    className={classNames(
                      "h-3.5 w-3.5",
                      draftSyncing ? "animate-spin" : "",
                    )}
                  />
                </button>
                <button
                  type="button"
                  onClick={startCompose}
                  className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white"
                  aria-label="New email draft"
                  title="New email"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {draftSyncError ? (
                  <div className="border-b border-amber-300/10 bg-amber-300/[0.04] px-4 py-2.5 text-[10px] leading-4 text-amber-200/75">
                    {draftSyncError} Showing drafts saved on this device.
                  </div>
                ) : null}
                {visibleRecoverableDrafts.map((draft) => {
                  const mailbox = feed.mailboxes.find(
                    (candidate) =>
                      candidate.connectionId === draft.connectionId,
                  );
                  const recipient =
                    draft.to || draft.cc || draft.bcc || "No recipient yet";
                  const preview =
                    draft.body.replace(/\s+/g, " ").trim() ||
                    (draft.attachments.length
                      ? `${draft.attachments.length} attachment${draft.attachments.length === 1 ? "" : "s"}`
                      : "Start writing your message");
                  return (
                    <div
                      key={draft.localId}
                      className={classNames(
                        "group flex w-full items-center border-b border-white/[0.055] transition",
                        composer?.localId === draft.localId
                          ? "bg-white/[0.07]"
                          : "hover:bg-white/[0.035]",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => openRecoverableDraft(draft)}
                        className="min-w-0 flex-1 px-4 py-3.5 text-left"
                      >
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">
                            {recipient}
                          </span>
                          <span className="shrink-0 text-[9px] text-zinc-700">
                            {formatWhen(new Date(draft.updatedAt).toISOString())}
                          </span>
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 text-[10px] text-zinc-500">
                          {mailbox ? (
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ backgroundColor: mailbox.color }}
                            />
                          ) : null}
                          <span className="truncate">
                            {draft.subject || "(no subject)"}
                          </span>
                        </span>
                        <span className="mt-1 block truncate text-[10px] text-zinc-700">
                          {preview}
                        </span>
                      </button>
                      {composer?.localId !== draft.localId ? (
                        <button
                          type="button"
                          onClick={() => setDraftDeleteTarget(draft)}
                          disabled={draftDeletionBusyId !== null}
                          className="mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-700 transition hover:bg-red-400/[0.08] hover:text-red-300 focus-visible:text-red-300 disabled:opacity-40"
                          aria-label={`Delete draft${draft.subject ? `: ${draft.subject}` : ""}`}
                          title="Delete draft"
                        >
                          {draftDeletionBusyId === draft.localId ? (
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
                {visibleRecoverableDrafts.length === 0 && draftSyncing ? (
                  <div className="flex items-center justify-center gap-2 p-8 text-xs text-zinc-600">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    Syncing drafts…
                  </div>
                ) : visibleRecoverableDrafts.length === 0 ? (
                  <div className="p-8 text-center">
                    <FileText className="mx-auto h-5 w-5 text-zinc-700" />
                    <p className="mt-2 text-xs text-zinc-500">
                      No unfinished messages.
                    </p>
                    <button
                      type="button"
                      onClick={startCompose}
                      className="mt-3 rounded-xl border border-white/[0.08] px-3 py-2 text-xs text-zinc-300 hover:bg-white/[0.04]"
                    >
                      Compose email
                    </button>
                  </div>
                ) : null}
              </div>
            </section>
            <section
              className={classNames(
                "min-w-0 flex-1",
                composer ? "" : "max-md:hidden",
              )}
            >
              {composer ? (
                <div className="flex h-full flex-col">
                  <div className="flex h-14 items-center gap-3 border-b border-white/[0.07] px-4">
                    <button
                      type="button"
                      onClick={deactivateComposer}
                      className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white md:hidden"
                      aria-label="Back to drafts"
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </button>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">
                        {composer.subject || "New message"}
                      </p>
                      <p className="text-[10px] text-zinc-600">
                        Changes are saved automatically.
                      </p>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6">
                    <div className="mx-auto w-full min-w-0 max-w-3xl">
                      <Composer
                        key={composer.localId}
                        value={composer}
                        mailboxes={feed.mailboxes}
                        snippets={snippets}
                        contactThreads={knownContactThreads}
                        threadContext=""
                        onChange={showComposer}
                        onSaved={showComposer}
                        onSent={(sentThread, outcome) => {
                          const localId = composer.localId;
                          rememberConfirmedSentThread(sentThread);
                          removeRecoverableDraft(localId);
                          if (outcome.warning) setError(outcome.warning);
                        }}
                        onDiscarded={() => {
                          removeRecoverableDraft(composer.localId);
                        }}
                        onEnableRecipientTracking={(mailbox) =>
                          reconnectMailbox(mailbox, {
                            recipientTracking: true,
                          })
                        }
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center p-8">
                  <div className="max-w-sm text-center">
                    <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.025] text-zinc-600">
                      <FileText className="h-5 w-5" />
                    </span>
                    <p className="mt-4 text-sm font-medium text-zinc-300">
                      Pick up where you left off
                    </p>
                    <p className="mt-2 text-xs leading-5 text-zinc-600">
                      Open a draft on the left or start a new message.
                    </p>
                  </div>
                </div>
              )}
            </section>
          </>
        ) : (
          <>
            <section
              className={classNames(
                "flex min-w-0 flex-col border-r border-white/[0.07]",
                detail || composer || openingThread ? "max-md:hidden" : "",
              )}
              style={
                detail || composer || openingThread
                  ? { width: "24rem", flex: "0 0 24rem" }
                  : { width: "100%", flex: "1 1 100%" }
              }
              aria-busy={loading}
            >
              <div className="border-b border-white/[0.07] px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    className="rounded-lg p-2 text-zinc-500 lg:hidden"
                    aria-label="Open email navigation"
                  >
                    <Mail className="h-4 w-4" />
                  </button>
                  <div
                    className="relative min-w-0 flex-1"
                    onBlur={(event) => {
                      if (
                        !event.currentTarget.contains(
                          event.relatedTarget as Node | null,
                        )
                      ) {
                        setSearchSuggestionsOpen(false);
                      }
                    }}
                  >
                    <label className="flex h-9 min-w-0 items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 focus-within:border-cyan-400/20">
                      <Search className="h-3.5 w-3.5 text-zinc-600" />
                      <input
                        ref={searchRef}
                        type="search"
                        value={query}
                        onFocus={() => setSearchSuggestionsOpen(true)}
                        onChange={(event) => {
                          setQuery(event.target.value);
                          setSearchSuggestionsOpen(true);
                        }}
                        onKeyDown={(event) => {
                          if (
                            !searchSuggestionsOpen ||
                            contactSuggestions.length === 0
                          ) {
                            return;
                          }
                          if (event.key === "ArrowDown") {
                            event.preventDefault();
                            setSearchSuggestionIndex(
                              (current) =>
                                (current + 1) % contactSuggestions.length,
                            );
                          } else if (event.key === "ArrowUp") {
                            event.preventDefault();
                            setSearchSuggestionIndex(
                              (current) =>
                                (current - 1 + contactSuggestions.length) %
                                contactSuggestions.length,
                            );
                          } else if (event.key === "Enter") {
                            event.preventDefault();
                            const suggestion =
                              contactSuggestions[searchSuggestionIndex];
                            if (suggestion) {
                              setQuery(suggestion.email);
                              setSearchSuggestionsOpen(false);
                            }
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setSearchSuggestionsOpen(false);
                          }
                        }}
                        placeholder={
                          mailboxFilter
                            ? "Search this mailbox"
                            : "Search every mailbox"
                        }
                        aria-label={
                          mailboxFilter
                            ? "Search this mailbox"
                            : "Search every connected mailbox"
                        }
                        aria-autocomplete="list"
                        role="combobox"
                        aria-controls="email-search-suggestions"
                        aria-expanded={
                          searchSuggestionsOpen &&
                          contactSuggestions.length > 0
                        }
                        autoComplete="off"
                        spellCheck={false}
                        className="min-w-0 flex-1 appearance-none bg-transparent text-xs text-zinc-300 outline-none placeholder:text-zinc-700 [&::-webkit-search-cancel-button]:hidden"
                      />
                      {query ? (
                        <button
                          type="button"
                          onClick={() => {
                            setQuery("");
                            searchRef.current?.focus();
                          }}
                          aria-label="Clear search"
                        >
                          <X className="h-3 w-3 text-zinc-600" />
                        </button>
                      ) : (
                        <kbd className="text-[9px] text-zinc-700">/</kbd>
                      )}
                    </label>
                    {searchSuggestionsOpen &&
                    contactSuggestions.length > 0 ? (
                      <div
                        id="email-search-suggestions"
                        role="listbox"
                        className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-xl border border-white/10 bg-[#15161a] p-1 shadow-2xl"
                      >
                        {contactSuggestions.map((suggestion, index) => (
                          <button
                            key={suggestion.email.toLowerCase()}
                            type="button"
                            role="option"
                            aria-selected={index === searchSuggestionIndex}
                            onMouseEnter={() =>
                              setSearchSuggestionIndex(index)
                            }
                            onClick={() => {
                              setQuery(suggestion.email);
                              setSearchSuggestionsOpen(false);
                              searchRef.current?.focus();
                            }}
                            className={classNames(
                              "grid w-full grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 rounded-lg px-3 py-2 text-left text-xs",
                              index === searchSuggestionIndex
                                ? "bg-white/[0.07] text-white"
                                : "text-zinc-400 hover:bg-white/[0.045]",
                            )}
                          >
                            <span className="truncate font-medium">
                              {suggestion.name}
                            </span>
                            <span className="truncate text-zinc-500">
                              {suggestion.email}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {view !== "sent" ? (
                    <button
                      type="button"
                      onClick={() => void runTriage({ manual: true })}
                      disabled={triageBusy}
                      className="rounded-xl border border-white/[0.07] p-2.5 text-zinc-500 hover:bg-white/[0.04] hover:text-cyan-300 disabled:opacity-40"
                      title="Run AI triage now"
                    >
                      {triageBusy ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : null}
                </div>
                <div className="mt-2 flex items-center gap-2 px-1">
                  {searchActive ? (
                    normalizedSearchQuery.length < 2 ? (
                      <p className="text-[10px] text-zinc-600">
                        Keep typing to search full message content
                      </p>
                    ) : searchLoading ? (
                      <p className="inline-flex items-center gap-1.5 text-[10px] text-cyan-200/75">
                        <LoaderCircle className="h-3 w-3 animate-spin" />
                        Searching every folder…
                      </p>
                    ) : searchError ? (
                      <p className="truncate text-[10px] text-amber-200/80">
                        {searchError}
                      </p>
                    ) : remoteSearchReady ? (
                      <p className="text-[10px] text-emerald-200/70">
                        {visibleThreads.length} best{" "}
                        {visibleThreads.length === 1 ? "match" : "matches"}
                      </p>
                    ) : (
                      <p className="text-[10px] text-zinc-600">
                        {visibleThreads.length} instant{" "}
                        {visibleThreads.length === 1 ? "match" : "matches"}
                      </p>
                    )
                  ) : loading ? (
                    <p className="inline-flex items-center gap-1.5 text-[10px] text-cyan-200/75">
                      <LoaderCircle className="h-3 w-3 animate-spin" />
                      Loading {loadingLabel}…
                    </p>
                  ) : triageBusy ? (
                    <p className="inline-flex items-center gap-1.5 text-[10px] text-violet-200/80">
                      <Sparkles className="h-3 w-3 animate-pulse" />
                      Organizing new mail…
                    </p>
                  ) : backgroundRefreshing ? (
                    <p className="inline-flex items-center gap-1.5 text-[10px] text-cyan-200/75">
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      Checking for new mail…
                    </p>
                  ) : refreshFailed ? (
                    <p className="text-[10px] text-amber-200/80">
                      Couldn&apos;t refresh
                      {lastRefreshedAt
                        ? ` · Cached ${formatUpdatedAt(lastRefreshedAt)}`
                        : ""}
                    </p>
                  ) : organizationStatus ? (
                    <p className="text-[10px] text-emerald-200/70">
                      {organizationStatus}
                    </p>
                  ) : (
                    <p className="text-[10px] text-zinc-600">
                      {visibleThreads.length} conversations
                      {lastRefreshedAt
                        ? ` · Updated ${formatUpdatedAt(lastRefreshedAt)}`
                        : ""}
                    </p>
                  )}
                  {mailboxFilter ? (
                    <MailboxBadge
                      mailbox={
                        feed.mailboxes.find(
                          (item) => item.connectionId === mailboxFilter,
                        ) || feed.mailboxes[0]
                      }
                    />
                  ) : (
                    <span
                      className={classNames(
                        "text-[10px] text-zinc-700",
                        loading && "max-sm:hidden",
                      )}
                    >
                      {remoteSearchReady
                        ? `searched ${searchState.searchedMailboxCount}/${searchState.totalMailboxCount} mailboxes`
                        : `across ${feed.mailboxes.length} mailboxes`}
                    </span>
                  )}
                  {!loading && !searchActive && view !== "sent" ? (
                    <span className="ml-auto text-[9px] text-zinc-700 md:hidden">
                      → {currentSwipeActions.right.label} · ←{" "}
                      {currentSwipeActions.left.label}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      void loadFeed(view, mailboxFilter, {
                        background: true,
                        forceProvider: true,
                      })
                    }
                    disabled={loading}
                    className={classNames(
                      "rounded-md p-1 text-zinc-700 hover:text-zinc-300 disabled:opacity-50",
                      !loading && "max-md:ml-0 md:ml-auto",
                      loading && "ml-auto",
                    )}
                    aria-label="Refresh email"
                  >
                    <RefreshCw
                      className={classNames(
                        "h-3 w-3",
                        (loading || backgroundRefreshing) && "animate-spin",
                      )}
                    />
                  </button>
                </div>
              </div>
              <div
                ref={feedScrollRef}
                onScroll={(event) => handleFeedScroll(event.currentTarget)}
                tabIndex={-1}
                data-email-shortcut-surface
                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain outline-none"
              >
                {!loading && reauthMailboxes.length > 0 ? (
                  <div className="border-b border-amber-300/15 bg-amber-300/[0.045] px-4 py-3">
                    <div className="flex items-start gap-2.5">
                      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-amber-100">
                          Gmail needs you
                        </p>
                        <p className="mt-0.5 text-[10px] leading-4 text-amber-200/65">
                          New mail is paused only for the{" "}
                          {reauthMailboxes.length === 1
                            ? "account below"
                            : "accounts below"}
                          . Your other mailboxes keep working.
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {reauthMailboxes.map((mailbox) => (
                            <button
                              key={mailbox.connectionId}
                              type="button"
                              onClick={() => void reconnectMailbox(mailbox)}
                              disabled={
                                !datagranScriptReady ||
                                reconnectBusy === mailbox.connectionId
                              }
                              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-200 px-2.5 py-1.5 text-[10px] font-semibold text-black disabled:opacity-50"
                            >
                              {reconnectBusy === mailbox.connectionId ? (
                                <LoaderCircle className="h-3 w-3 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3 w-3" />
                              )}
                              Reconnect {mailbox.displayName}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : !loading && unavailableMailboxes.length > 0 ? (
                  <div className="border-b border-amber-300/10 bg-amber-300/[0.035] px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <CircleAlert className="h-3.5 w-3.5 shrink-0 text-amber-300/80" />
                      <p className="min-w-0 flex-1 text-[10px] leading-4 text-amber-200/70">
                        {unavailableMailboxes
                          .map((mailbox) => mailbox.displayName)
                          .join(", ")}{" "}
                        could not be checked. This looks temporary.
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          void loadFeed(view, mailboxFilter, {
                            background: true,
                          })
                        }
                        className="shrink-0 rounded-lg border border-amber-200/15 px-2 py-1 text-[10px] text-amber-100"
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                ) : null}
                {!loading && !searchActive && view === "sent" ? (
                  <div className="flex items-start gap-2 border-b border-emerald-300/10 bg-emerald-300/[0.025] px-4 py-2.5">
                    <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300/70" />
                    <p className="text-[10px] leading-4 text-zinc-600">
                      Open status starts with messages sent from Groovy. One
                      recipient mail names the likely opener. Group mail lists
                      the possible recipients because one shared email cannot
                      identify which person loaded the tracking image.
                    </p>
                  </div>
                ) : null}
                {searchWarnings.length > 0 ? (
                  <div className="border-b border-amber-300/10 bg-amber-300/[0.035] px-4 py-2">
                    <p className="text-[10px] leading-4 text-amber-200/70">
                      Partial results · {searchWarnings.join(" ")}
                    </p>
                  </div>
                ) : null}
                {searchActive && searchLoading && visibleThreads.length === 0 ? (
                  <div className="space-y-px" aria-label="Searching email">
                    {Array.from({ length: 5 }).map((_, index) => (
                      <div
                        key={index}
                        className="h-28 animate-pulse border-b border-white/[0.05] bg-white/[0.018] motion-reduce:animate-none"
                      />
                    ))}
                  </div>
                ) : searchActive && searchError && visibleThreads.length === 0 ? (
                  <div className="p-8 text-center">
                    <CircleAlert className="mx-auto h-5 w-5 text-amber-300" />
                    <p className="mt-3 text-xs text-zinc-400">
                      {searchError}
                    </p>
                    <p className="mt-1 text-[10px] text-zinc-600">
                      Loaded messages will still match instantly as you edit the
                      search.
                    </p>
                  </div>
                ) : loading && !searchActive ? (
                  <div className="space-y-px">
                    {Array.from({ length: 7 }).map((_, index) => (
                      <div
                        key={index}
                        className="h-28 animate-pulse border-b border-white/[0.05] bg-white/[0.018] motion-reduce:animate-none"
                      />
                    ))}
                  </div>
                ) : feedError && feed.threads.length === 0 ? (
                  <div className="p-8 text-center">
                    <CircleAlert className="mx-auto h-5 w-5 text-amber-300" />
                    <p className="mt-3 text-xs text-zinc-400">{feedError}</p>
                    <button
                      type="button"
                      onClick={() => void loadFeed()}
                      className="mt-3 text-xs text-cyan-300"
                    >
                      Try again
                    </button>
                  </div>
                ) : laneGroups ? (
                  laneGroups.map((group) => (
                    <div key={group.id}>
                      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/[0.055] bg-[var(--bg-primary)]/95 px-4 py-2 backdrop-blur">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                          {group.label}
                        </p>
                        <span className="text-[9px] text-zinc-700">
                          {group.description}
                        </span>
                        <span className="ml-auto text-[9px] text-zinc-700">
                          {group.threads.length}
                        </span>
                      </div>
                      {group.threads.map((thread) => (
                        <ThreadRow
                          key={thread.key}
                          thread={thread}
                          selected={selectedKey === thread.key}
                          view={emailView}
                          searchMatch={searchMatchesByKey.get(thread.key)}
                          searchMode={searchActive}
                          swipeEnabled={
                            !searchActive &&
                            mobileSwipeEnabled &&
                            emailView !== "sent"
                          }
                          actionState={actionStates[thread.key]}
                          calendarRsvpState={calendarRsvpStates[thread.key]}
                          onOpen={openThread}
                          onSelect={selectThread}
                          onPrefetch={prefetchThread}
                          onAction={runAction}
                          onCalendarRsvp={runCalendarRsvp}
                          onSwipeActivity={handleSwipeActivity}
                        />
                      ))}
                    </div>
                  ))
                ) : visibleThreads.length ? (
                  visibleThreads.map((thread) => (
                    <ThreadRow
                      key={thread.key}
                      thread={thread}
                      selected={selectedKey === thread.key}
                      view={emailView}
                      searchMatch={searchMatchesByKey.get(thread.key)}
                      searchMode={searchActive}
                      swipeEnabled={
                        !searchActive &&
                        mobileSwipeEnabled &&
                        emailView !== "sent"
                      }
                      actionState={actionStates[thread.key]}
                      calendarRsvpState={calendarRsvpStates[thread.key]}
                      onOpen={openThread}
                      onSelect={selectThread}
                      onPrefetch={prefetchThread}
                      onAction={runAction}
                      onCalendarRsvp={runCalendarRsvp}
                      onSwipeActivity={handleSwipeActivity}
                    />
                  ))
                ) : feed.mailboxes.length === 0 ? (
                  <div className="p-8 text-center">
                    <Mail className="mx-auto h-6 w-6 text-zinc-700" />
                    <p className="mt-3 text-sm text-zinc-300">
                      Connect your first Gmail
                    </p>
                    <p className="mt-1 text-xs leading-5 text-zinc-600">
                      Every address will appear in one color-coded stream.
                    </p>
                    <button
                      type="button"
                      onClick={() => void connectMailbox()}
                      disabled={connectMailboxBusy}
                      className="mt-4 inline-flex rounded-xl bg-white px-3 py-2 text-xs font-semibold text-black"
                    >
                      {connectMailboxBusy ? "Connecting…" : "Connect Gmail"}
                    </button>
                  </div>
                ) : isFocusZero ? (
                  <FocusZeroCard onOpenInbox={() => selectView("inbox")} />
                ) : (
                  <div className="p-10 text-center">
                    <CheckCircle2 className="mx-auto h-6 w-6 text-emerald-300/60" />
                    <p className="mt-3 text-sm text-zinc-300">
                      {query
                        ? "Nothing matches."
                        : view === "sent"
                          ? "No sent mail yet."
                          : view === "all"
                            ? "No mail found."
                          : "This view is clear."}
                    </p>
                    <p className="mt-1 text-xs text-zinc-600">
                      {query
                        ? "Try an email address, sender, subject, or words from the message."
                        : view === "sent"
                          ? "Messages you send from any connected mailbox will appear here."
                          : view === "all"
                            ? "Every non-draft, non-trash Gmail message will appear here."
                          : "Groovy will surface the next thing that deserves you."}
                    </p>
                  </div>
                )}
                {!loading && !query && feed.nextCursor ? (
                  view === "focus" || view === "inbox" ? (
                    <div className="flex h-16 items-center justify-center border-t border-white/[0.045]">
                      <button
                        type="button"
                        onClick={loadMoreThreads}
                        disabled={backgroundRefreshing}
                        className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] px-3 py-2 text-[10px] font-medium text-zinc-500 hover:border-white/[0.14] hover:text-zinc-300 disabled:cursor-wait disabled:opacity-50"
                      >
                        {backgroundRefreshing ? (
                          <LoaderCircle className="h-3 w-3 animate-spin" />
                        ) : null}
                        {backgroundRefreshing
                          ? "Loading older conversations…"
                          : "Load older conversations"}
                      </button>
                    </div>
                  ) : (
                    <div
                      ref={loadMoreSentinelRef}
                      className="flex h-14 items-center justify-center text-[10px] text-zinc-700"
                      aria-label="Loading more email"
                    >
                      {backgroundRefreshing ? (
                        <>
                          <LoaderCircle className="mr-2 h-3 w-3 animate-spin" />
                          Loading more…
                        </>
                      ) : (
                        "More email loads as you scroll"
                      )}
                    </div>
                  )
                ) : null}
              </div>
            </section>

            <section
              className={classNames(
                "min-w-0 flex-1 overflow-hidden",
                !detail && !composer && !openingThread ? "max-md:hidden" : "",
              )}
            >
              {detailLoading ? (
                <div className="flex h-full flex-col">
                  <div className="flex min-h-14 items-center gap-3 border-b border-white/[0.07] px-3 sm:px-5">
                    <button
                      type="button"
                      onClick={() => closeDetail()}
                      className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white md:hidden"
                      aria-label="Back to message list"
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">
                        {openingThread?.subject || "Opening message"}
                      </p>
                      {openingThread ? (
                        <div className="mt-0.5">
                          <MailboxBadge mailbox={openingThread.mailbox} />
                        </div>
                      ) : null}
                    </div>
                    <LoaderCircle className="h-4 w-4 animate-spin text-cyan-300/70" />
                  </div>
                  <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
                    <div className="h-24 animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.02] motion-reduce:animate-none" />
                    <div className="h-48 animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.02] motion-reduce:animate-none" />
                  </div>
                </div>
              ) : openingThread && error ? (
                <div className="flex h-full flex-col">
                  <div className="flex min-h-14 items-center gap-3 border-b border-white/[0.07] px-3 sm:px-5">
                    <button
                      type="button"
                      onClick={() => closeDetail()}
                      className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white"
                      aria-label="Back to message list"
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">
                        {openingThread.subject}
                      </p>
                      <div className="mt-0.5">
                        <MailboxBadge mailbox={openingThread.mailbox} />
                      </div>
                    </div>
                  </div>
                  <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                    <div className="max-w-sm text-center">
                      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-amber-300/15 bg-amber-300/[0.05] text-amber-200">
                        <CircleAlert className="h-5 w-5" />
                      </span>
                      <p className="mt-4 text-sm font-medium text-zinc-200">
                        This conversation could not load
                      </p>
                      <p className="mt-2 text-xs leading-5 text-zinc-500">
                        {error}
                      </p>
                      <div className="mt-4 flex items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => void openThread(openingThread)}
                          className="rounded-xl bg-white px-3 py-2 text-xs font-semibold text-black transition hover:bg-zinc-200"
                        >
                          Try again
                        </button>
                        <button
                          type="button"
                          onClick={() => closeDetail()}
                          className="rounded-xl border border-white/[0.08] px-3 py-2 text-xs text-zinc-400 transition hover:bg-white/[0.04] hover:text-zinc-200"
                        >
                          Back to list
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : composer && !detail ? (
                <div className="flex h-full flex-col">
                  <div className="flex h-14 items-center gap-3 border-b border-white/[0.07] px-4">
                    <button
                      type="button"
                      onClick={deactivateComposer}
                      className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white md:hidden"
                      aria-label="Back to message list"
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </button>
                    <div>
                      <p className="text-sm font-semibold text-white">New message</p>
                      <p className="text-[10px] text-zinc-600">
                        One calm surface, any sender identity.
                      </p>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6">
                    <div className="mx-auto w-full min-w-0 max-w-3xl">
                      <Composer
                        key={composer.localId}
                        value={composer}
                        mailboxes={feed.mailboxes}
                        snippets={snippets}
                        contactThreads={knownContactThreads}
                        threadContext=""
                        onChange={showComposer}
                        onSaved={showComposer}
                        onSent={(sentThread, outcome) => {
                          const localId = composer.localId;
                          rememberConfirmedSentThread(sentThread);
                          removeRecoverableDraft(localId);
                          if (outcome.warning) setError(outcome.warning);
                        }}
                        onDiscarded={() => {
                          removeRecoverableDraft(composer.localId);
                          void loadFeed(emailView, mailboxFilter, {
                            background: true,
                          });
                        }}
                        onEnableRecipientTracking={(mailbox) =>
                          reconnectMailbox(mailbox, {
                            recipientTracking: true,
                          })
                        }
                      />
                    </div>
                  </div>
                </div>
              ) : detail && composer ? (
                <div className="flex h-full flex-col">
                  <div className="flex min-h-14 items-center gap-2 border-b border-white/[0.07] px-3 sm:px-5">
                    <button
                      type="button"
                      onClick={() => closeDetail()}
                      className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white md:hidden"
                      aria-label="Back to message list"
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">
                        {detail.summary.subject}
                      </p>
                      <div className="mt-0.5 flex items-center gap-2">
                        <MailboxBadge mailbox={detail.summary.mailbox} />
                        <span className="truncate text-[10px] text-zinc-600">
                          {detail.messages.length} message
                          {detail.messages.length === 1 ? "" : "s"}
                        </span>
                        {selectedActionState ? (
                          <span
                            className={classNames(
                              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px]",
                              selectedActionState.phase === "failed"
                                ? "border-red-400/15 bg-red-400/[0.07] text-red-300"
                                : "border-cyan-400/15 bg-cyan-400/[0.07] text-cyan-200",
                            )}
                            title={selectedActionState.error}
                          >
                            {selectedActionBusy ? (
                              <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
                            ) : (
                              <CircleAlert className="h-2.5 w-2.5" />
                            )}
                            {selectedActionState.phase === "queued"
                              ? "Queued"
                              : selectedActionState.phase === "processing"
                                ? "Processing…"
                                : selectedActionState.phase === "retrying"
                                  ? "Retrying…"
                                  : "Not updated"}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void runAction(
                          detail.summary,
                          detail.summary.starred ? "unstar" : "star",
                        )
                      }
                      disabled={selectedActionBusy}
                      className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-amber-300 disabled:opacity-40"
                      aria-label={
                        detail.summary.starred ? "Unstar email" : "Star email"
                      }
                    >
                      <Star
                        className={classNames(
                          "h-4 w-4",
                          detail.summary.starred &&
                            "fill-amber-300 text-amber-300",
                        )}
                      />
                    </button>
                    {view === "inbox" ? (
                      <button
                        type="button"
                        onClick={() =>
                          void runAction(detail.summary, "move_focus")
                        }
                        disabled={selectedActionBusy}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/15 bg-cyan-300/[0.07] px-2.5 py-2 text-[10px] font-medium text-cyan-200 transition hover:bg-cyan-300/[0.12] disabled:opacity-40"
                        title="Move to Focus"
                        aria-label="Move to Focus"
                      >
                        <Zap className="h-3.5 w-3.5" />
                        <span className="max-sm:hidden">Focus</span>
                      </button>
                    ) : null}
                    {canMarkSelectedDone ? (
                      <button
                        type="button"
                        onClick={() =>
                          void runAction(detail.summary, "move_handled")
                        }
                        disabled={selectedActionBusy}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300/15 bg-emerald-300/[0.07] px-2.5 py-2 text-[10px] font-medium text-emerald-200 transition hover:bg-emerald-300/[0.12] disabled:opacity-40"
                        title={
                          detail.summary.draft
                            ? "Move to Handled and keep the draft attached"
                            : "Mark this email Done"
                        }
                        aria-label="Mark Done"
                      >
                        {selectedActionBusy ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        <span className="max-sm:hidden">
                          {selectedActionState?.phase === "failed" &&
                          (selectedActionState.operation === "move_handled" ||
                            selectedActionState.operation === "archive")
                            ? "Retry Done"
                            : "Done"}
                        </span>
                      </button>
                    ) : null}
                    {view !== "sent" ? (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            void runAction(detail.summary, "archive")
                          }
                          disabled={selectedActionBusy}
                          className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-white disabled:opacity-40"
                          aria-label="Archive"
                        >
                          <Archive className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void runAction(
                              detail.summary,
                              view === "noise" || view === "handled"
                                ? "move_inbox"
                                : "move_noise",
                            )
                          }
                          disabled={selectedActionBusy}
                          className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.05] hover:text-violet-300 disabled:opacity-40"
                          aria-label={
                            view === "noise" || view === "handled"
                              ? "Return to Needs Review"
                              : "Move to noise"
                          }
                        >
                          {view === "noise" || view === "handled" ? (
                            <Inbox className="h-4 w-4" />
                          ) : (
                            <ShieldCheck className="h-4 w-4" />
                          )}
                        </button>
                      </>
                    ) : null}
                  </div>
                  <div
                    ref={detailScrollRef}
                    className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
                  >
                    <div className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4 sm:p-6">
                      {detail.summary.direction === "outgoing" ? (
                        <div className="flex items-start gap-3 rounded-2xl border border-emerald-300/10 bg-emerald-300/[0.035] p-4">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-300/[0.07] text-emerald-200">
                            <Eye className="h-3.5 w-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <OpenStatusBadge
                              status={detail.summary.openStatus}
                            />
                            <p className="mt-2 text-[10px] leading-4 text-zinc-600">
                              Open status is an estimate from image loading.
                              Privacy relays and security scanners can affect
                              the result.
                            </p>
                          </div>
                        </div>
                      ) : null}
                      {detail.summary.action ? (
                        <div className="rounded-2xl border border-cyan-400/10 bg-gradient-to-r from-cyan-400/[0.055] to-transparent p-4">
                          <div className="flex items-start gap-3">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-cyan-400/[0.08] text-cyan-300">
                              <Bot className="h-3.5 w-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-xs font-semibold text-zinc-200">
                                  Groovy&apos;s read
                                </p>
                                {percent(detail.summary.action.confidence) ? (
                                  <span className="text-[9px] text-zinc-600">
                                    {percent(detail.summary.action.confidence)}{" "}
                                    confidence
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 text-xs leading-5 text-zinc-500">
                                {detail.summary.action.reason ||
                                  detail.summary.action.summary}
                              </p>
                              {detail.summary.action.keyAsk ? (
                                <p className="mt-2 text-[11px] text-zinc-400">
                                  <span className="text-zinc-600">The ask:</span>{" "}
                                  {detail.summary.action.keyAsk}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ) : null}
                      <div data-email-conversation>
                        <div className="mb-3 flex items-center gap-3 px-1">
                          <div className="min-w-0 flex-1">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                              Conversation
                            </p>
                            <p className="mt-0.5 text-[10px] text-zinc-700">
                              {detail.messages.length} message
                              {detail.messages.length === 1 ? "" : "s"} ·
                              oldest to newest
                            </p>
                          </div>
                          {detail.messages.length > 1 ? (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedMessageIds(
                                  allMessagesExpanded
                                    ? new Set()
                                    : new Set(
                                        detail.messages.map(
                                          (message) => message.id,
                                        ),
                                      ),
                                )
                              }
                              className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-[10px] font-medium text-zinc-500 transition hover:border-white/[0.12] hover:text-zinc-300"
                            >
                              {allMessagesExpanded
                                ? "Collapse all"
                                : "Expand all"}
                            </button>
                          ) : null}
                        </div>
                        <div className="relative space-y-2 before:absolute before:bottom-4 before:left-[11px] before:top-4 before:w-px before:bg-gradient-to-b before:from-white/[0.12] before:via-white/[0.07] before:to-transparent sm:before:left-[15px]">
                          {detail.messages.map((message, index) => {
                            const expanded = expandedMessageIds.has(message.id);
                            const latest =
                              index === detail.messages.length - 1;
                            const senderLabel = message.isFromUser
                              ? "You"
                              : message.from;
                            const preview =
                              message.snippet ||
                              message.body.replace(/\s+/g, " ").trim();
                            return (
                              <div
                                key={message.id}
                                className="relative pl-6 sm:pl-8"
                              >
                                <span
                                  className={classNames(
                                    "absolute left-[7px] top-6 z-10 h-2.5 w-2.5 rounded-full border-2 border-[var(--bg-primary)] sm:left-[11px]",
                                    latest
                                      ? "bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.45)]"
                                      : message.isFromUser
                                        ? "bg-zinc-600"
                                        : "bg-zinc-500",
                                  )}
                                  aria-hidden="true"
                                />
                                <article
                                  ref={latest ? latestMessageRef : undefined}
                                  data-email-message-id={message.id}
                                  data-email-message-expanded={
                                    expanded ? "true" : "false"
                                  }
                                  className={classNames(
                                    "min-w-0 max-w-full overflow-hidden rounded-xl border border-l-2 transition",
                                    expanded
                                      ? "border-white/[0.105] bg-white/[0.035] shadow-lg shadow-black/10"
                                      : "border-white/[0.065] bg-white/[0.018] hover:border-white/[0.1] hover:bg-white/[0.03]",
                                  )}
                                  style={{
                                    borderLeftColor: message.isFromUser
                                      ? "#67e8f9"
                                      : detail.summary.mailbox.color,
                                  }}
                                >
                                  <div className="flex min-w-0 items-start gap-1.5 p-3 sm:p-4">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        toggleConversationMessage(message.id)
                                      }
                                      className="flex min-w-0 flex-1 items-start gap-3 text-left"
                                      aria-expanded={expanded}
                                      aria-label={`${expanded ? "Collapse" : "Expand"} message ${index + 1} from ${senderLabel}`}
                                    >
                                      <span
                                        className={classNames(
                                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
                                          message.isFromUser
                                            ? "border-cyan-300/15 bg-cyan-300/[0.07] text-cyan-100"
                                            : "border-white/10 bg-white/[0.045] text-zinc-300",
                                        )}
                                      >
                                        {message.isFromUser
                                          ? "YOU"
                                          : initials(message.from)}
                                      </span>
                                      <span className="min-w-0 flex-1">
                                        <span className="flex min-w-0 items-center gap-2">
                                          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-200">
                                            {senderLabel}
                                          </span>
                                          {latest ? (
                                            <span className="shrink-0 rounded-full border border-cyan-300/10 bg-cyan-300/[0.055] px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.12em] text-cyan-200/70">
                                              Latest
                                            </span>
                                          ) : null}
                                          <span className="shrink-0 text-[9px] text-zinc-600">
                                            {formatWhen(message.sentAt)}
                                          </span>
                                          {expanded ? (
                                            <ChevronUp className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                                          ) : (
                                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                                          )}
                                        </span>
                                        <span className="mt-0.5 block truncate text-[10px] text-zinc-600">
                                          to{" "}
                                          {message.to.join(", ") ||
                                            "undisclosed recipients"}
                                        </span>
                                        {!expanded ? (
                                          <span className="mt-1.5 block truncate text-[11px] leading-4 text-zinc-500">
                                            {preview}
                                          </span>
                                        ) : (
                                          <span className="mt-1.5 block text-[9px] text-zinc-700">
                                            Message {index + 1} of{" "}
                                            {detail.messages.length} ·{" "}
                                            {formatMessageDate(message.sentAt)}
                                          </span>
                                        )}
                                      </span>
                                    </button>
                                    <div
                                      className="flex shrink-0 items-center gap-0.5"
                                      aria-label={`Actions for message ${index + 1}`}
                                    >
                                      <button
                                        type="button"
                                        onClick={() =>
                                          composeFromConversationMessage(
                                            message,
                                            "reply",
                                          )
                                        }
                                        className="rounded-lg p-2 text-zinc-600 transition hover:bg-white/[0.06] hover:text-cyan-200"
                                        aria-label={`Reply to message ${index + 1}`}
                                        title="Reply"
                                      >
                                        <CornerUpLeft className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          composeFromConversationMessage(
                                            message,
                                            "reply_all",
                                          )
                                        }
                                        className="rounded-lg p-2 text-zinc-600 transition hover:bg-white/[0.06] hover:text-cyan-200"
                                        aria-label={`Reply all to message ${index + 1}`}
                                        title="Reply all"
                                      >
                                        <UsersRound className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          composeFromConversationMessage(
                                            message,
                                            "forward",
                                          )
                                        }
                                        className="rounded-lg p-2 text-zinc-600 transition hover:bg-white/[0.06] hover:text-cyan-200"
                                        aria-label={`Forward message ${index + 1}`}
                                        title="Forward"
                                      >
                                        <ForwardIcon className="h-3.5 w-3.5" />
                                      </button>
                                    </div>
                                  </div>
                                  {expanded ? (
                                    <div className="border-t border-white/[0.065] px-4 pb-4 pt-1 sm:px-5 sm:pb-5">
                                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-600">
                                        <span>
                                          <span className="text-zinc-700">
                                            Subject
                                          </span>{" "}
                                          {message.subject}
                                        </span>
                                        {message.cc.length ? (
                                          <span>
                                            <span className="text-zinc-700">
                                              Cc
                                            </span>{" "}
                                            {message.cc.join(", ")}
                                          </span>
                                        ) : null}
                                      </div>
                                      <EmailBody
                                        body={message.body}
                                        htmlBody={message.htmlBody}
                                      />
                                      {message.contentTruncated ? (
                                        <p className="mt-3 rounded-lg border border-amber-300/10 bg-amber-300/[0.035] px-3 py-2 text-[10px] leading-4 text-amber-100/60">
                                          This unusually large message was
                                          shortened for the in-app view. The
                                          original remains unchanged in Gmail.
                                        </p>
                                      ) : null}
                                      {message.attachments.some(
                                        (attachment) => !attachment.inline,
                                      ) ? (
                                        <div className="mt-4 flex flex-wrap gap-2 border-t border-white/[0.055] pt-3">
                                          {message.attachments
                                            .filter(
                                              (attachment) =>
                                                !attachment.inline,
                                            )
                                            .map((attachment) => (
                                              <EmailAttachmentChip
                                                key={`${message.id}:${attachment.id}:${attachment.filename}`}
                                                attachment={attachment}
                                                connectionId={
                                                  detail.summary.connectionId
                                                }
                                                messageId={message.id}
                                                threadId={message.threadId}
                                                activeDownloadKey={
                                                  attachmentDownloadKey
                                                }
                                                onDownload={downloadAttachment}
                                              />
                                            ))}
                                        </div>
                                      ) : null}
                                      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.055] pt-3">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            composeFromConversationMessage(
                                              message,
                                              "reply",
                                            )
                                          }
                                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.075] bg-white/[0.025] px-2.5 py-1.5 text-[10px] font-medium text-zinc-500 transition hover:border-cyan-300/15 hover:bg-cyan-300/[0.045] hover:text-cyan-200"
                                        >
                                          <CornerUpLeft className="h-3 w-3" />
                                          Reply
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            composeFromConversationMessage(
                                              message,
                                              "reply_all",
                                            )
                                          }
                                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.075] bg-white/[0.025] px-2.5 py-1.5 text-[10px] font-medium text-zinc-500 transition hover:border-cyan-300/15 hover:bg-cyan-300/[0.045] hover:text-cyan-200"
                                        >
                                          <UsersRound className="h-3 w-3" />
                                          Reply all
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            composeFromConversationMessage(
                                              message,
                                              "forward",
                                            )
                                          }
                                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.075] bg-white/[0.025] px-2.5 py-1.5 text-[10px] font-medium text-zinc-500 transition hover:border-cyan-300/15 hover:bg-cyan-300/[0.045] hover:text-cyan-200"
                                        >
                                          <ForwardIcon className="h-3 w-3" />
                                          Forward
                                        </button>
                                      </div>
                                    </div>
                                  ) : null}
                                </article>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <div>
                        <div className="mb-2 flex items-center gap-2 px-1">
                          {threadComposeIntent?.mode === "forward" ? (
                            <ForwardIcon className="h-3.5 w-3.5 text-zinc-600" />
                          ) : threadComposeIntent?.mode === "reply" ? (
                            <CornerUpLeft className="h-3.5 w-3.5 text-zinc-600" />
                          ) : (
                            <UsersRound className="h-3.5 w-3.5 text-zinc-600" />
                          )}
                          <p
                            className="min-w-0 truncate text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-600"
                            data-email-compose-mode={
                              threadComposeIntent?.mode || "reply_all"
                            }
                          >
                            {composeActionLabel}
                          </p>
                          {activeComposeMessage ? (
                            <span className="ml-auto shrink-0 text-[9px] text-zinc-700">
                              Message{" "}
                              {detail.messages.findIndex(
                                (message) =>
                                  message.id === activeComposeMessage.id,
                              ) + 1}
                            </span>
                          ) : null}
                        </div>
                        <div data-email-composer-body>
                          <Composer
                            key={`thread-composer:${threadComposeIntent?.messageId || composer.sourceMessageId || "latest"}:${threadComposeIntent?.mode || "reply_all"}`}
                            value={composer}
                            mailboxes={feed.mailboxes}
                            snippets={snippets}
                            contactThreads={knownContactThreads}
                            threadContext={threadContext}
                            snippetVariables={{
                              first_name:
                                detail.summary.senderName.split(/\s+/)[0] || "",
                              company:
                                detail.summary.senderEmail
                                  .split("@")[1]
                                  ?.split(".")[0] || "",
                            }}
                            onChange={showComposer}
                            onSaved={showComposer}
                            onSent={(sentThread, outcome) => {
                              const localId = composer.localId;
                              rememberConfirmedSentThread(sentThread);
                              // Sending consumes the draft, not the Focus
                              // item. Only the explicit Done action moves the
                              // conversation out of its current queue.
                              keepSentConversationLocally(detail.summary);
                              invalidateThreadDetail(detail.summary.key);
                              removeRecoverableDraft(localId);
                              closeDetail();
                              if (outcome.warning) setError(outcome.warning);
                            }}
                            onDiscarded={() => {
                              invalidateThreadDetail(detail.summary.key);
                              removeRecoverableDraft(composer.localId);
                              closeDetail();
                              void loadFeed(emailView, mailboxFilter, {
                                background: true,
                              });
                            }}
                            onEnableRecipientTracking={(mailbox) =>
                              reconnectMailbox(mailbox, {
                                recipientTracking: true,
                              })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                ) : feed.mailboxes.length === 0 ? (
                  <div className="p-10 text-center">
                    <Mail className="mx-auto h-6 w-6 text-zinc-700" />
                    <p className="mt-3 text-sm text-zinc-300">
                      Connect your first Gmail
                    </p>
                    <p className="mt-1 text-xs leading-5 text-zinc-600">
                      Groovy will merge every connected address here while
                      preserving a clear color identity.
                    </p>
                    <button
                      type="button"
                      onClick={() => void connectMailbox()}
                      disabled={connectMailboxBusy}
                      className="mt-4 inline-flex rounded-xl bg-white px-3 py-2 text-xs font-semibold text-black"
                    >
                      {connectMailboxBusy ? "Connecting…" : "Connect Gmail"}
                    </button>
                  </div>
                ) : (
                <div className="flex h-full items-center justify-center p-8">
                  <div className="max-w-md text-center">
                    <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.025] text-zinc-600">
                      <MailOpen className="h-5 w-5" />
                    </span>
                    <p className="mt-4 text-sm font-medium text-zinc-300">
                      Your attention, not your inbox
                    </p>
                    <p className="mt-2 text-xs leading-5 text-zinc-600">
                      Move with J and K. Press Enter to reply all. Groovy keeps
                      mailbox identity visible without making you switch
                      contexts.
                    </p>
                    <button
                      type="button"
                      onClick={() => setShortcutsOpen(true)}
                      className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/[0.08] px-3 py-2 text-xs text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200"
                    >
                      <Keyboard className="h-3.5 w-3.5" />
                      See keyboard map
                    </button>
                  </div>
                </div>
              )}
            </section>
          </>
        )}
        {(error || (feedError && feed.threads.length > 0)) &&
        !(openingThread && !detail && !composer) ? (
          <div className="absolute bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-red-400/15 bg-[#171113] px-3 py-2 text-xs text-red-300 shadow-xl">
            <CircleAlert className="h-3.5 w-3.5" />
            {error || feedError}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setFeedError(null);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </main>
      {draftDeleteTarget ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-email-draft-title"
        >
          <div className="w-full max-w-sm rounded-2xl border border-white/[0.09] bg-[#111318] p-5 shadow-2xl">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-red-400/[0.08] text-red-300">
              <Trash2 className="h-4 w-4" />
            </span>
            <h2
              id="delete-email-draft-title"
              className="mt-3 text-sm font-semibold text-white"
            >
              Delete this draft?
            </h2>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              {draftDeleteTarget.draftId
                ? draftDeleteTarget.subject
                  ? `“${draftDeleteTarget.subject}” will be removed from Groovy and Gmail.`
                  : "This unfinished message will be removed from Groovy and Gmail."
                : draftDeleteTarget.subject
                  ? `“${draftDeleteTarget.subject}” will be removed from Groovy.`
                  : "This unfinished message will be removed from Groovy."}
              {" "}This cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDraftDeleteTarget(null)}
                disabled={draftDeletionBusyId !== null}
                autoFocus
                className="rounded-xl border border-white/[0.09] px-3 py-2 text-xs text-zinc-300 hover:bg-white/[0.04] disabled:opacity-40"
              >
                Keep draft
              </button>
              <button
                type="button"
                onClick={() => void deleteRecoverableDraft(draftDeleteTarget)}
                disabled={draftDeletionBusyId !== null}
                className="inline-flex min-w-28 items-center justify-center gap-2 rounded-xl bg-red-300 px-3 py-2 text-xs font-semibold text-black hover:bg-red-200 disabled:opacity-50"
              >
                {draftDeletionBusyId ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                {draftDeletionBusyId ? "Deleting…" : "Delete draft"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {shortcutsOpen ? (
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      ) : null}
      {mailboxSettingsOpen ? (
        <MailboxSettings
          mailboxes={feed.mailboxes}
          onClose={() => setMailboxSettingsOpen(false)}
          onSaved={(mailboxes) =>
            setFeed((current) => ({ ...current, mailboxes }))
          }
        />
      ) : null}
    </div>
  );
}
