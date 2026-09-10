"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  AtSign,
  Bold,
  Bookmark,
  Braces,
  CalendarClock,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  FileText,
  Italic,
  Link2,
  List as ListIcon,
  ListOrdered,
  LoaderCircle,
  MessageSquareText,
  PencilLine,
  Plus,
  Quote,
  Send,
  Smile,
  Strikethrough,
  Trash2,
  Underline,
  Upload,
  Video,
  X,
} from "lucide-react";
import { shouldFollowTimelineGrowth } from "@/lib/chat/conversationState";
import {
  insertTextAtSelection,
  pasteTextPreservingStructure,
} from "@/lib/composer/pasteFormatting";
import { FormattedMessageContent } from "@/components/common/FormattedMessageContent";
import {
  ChatMentionMenu,
  type ChatMentionOption,
} from "@/components/chat/ChatMentionMenu";
import { ChatDateSeparator } from "@/components/chat/ChatDateSeparator";
import { ChatTextSnippetCard } from "@/components/chat/ChatTextSnippetCard";
import { ChatVoiceRecorderButton } from "@/components/chat/ChatVoiceRecorderButton";
import {
  applyChatComposerFormat,
  type ChatComposerFormat,
} from "@/lib/chat/composerFormatting";
import type { ChatTextSnippet } from "@/lib/chat/snippets";
import {
  formatVoiceNoteDuration,
  type PendingChatVoiceNote,
} from "@/lib/chat/voiceNotes.client";
import {
  CHAT_ATTACHMENT_ACCEPT,
  isChatImageAttachment,
  isSupportedChatAttachmentFile,
  MAX_CHAT_ATTACHMENT_FILES,
} from "@/lib/chat/attachments.client";
import { isDifferentChatCalendarDate } from "@/lib/chat/messageDates";
import { MAX_CHAT_MESSAGE_CHARACTERS } from "@/lib/chat/messageLimits";

export type ChannelThreadAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export type ChannelThreadVoiceNote = {
  id: string;
  name: string;
  durationMs: number;
};

export type ChannelThreadRecentImage = {
  id: string;
  name: string;
};

export type ChannelThreadMessageView = {
  id: string;
  label: string;
  authorType: "user" | "orchestrator" | "agent" | "system";
  content: string;
  createdAt: string;
  pending: boolean;
  ownMessage: boolean;
  imageOnly: boolean;
  fileOnly: boolean;
  voiceOnly: boolean;
  snippetOnly: boolean;
  attachments: ChannelThreadAttachment[];
  voiceNote: ChannelThreadVoiceNote | null;
  snippet: ChatTextSnippet | null;
  taskResult: boolean;
  taskStatus: unknown;
  deleted: boolean;
  edited: boolean;
};

const THREAD_COMPOSER_MAX_HEIGHT = 144;

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
}

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1_000) return `${sizeBytes} B`;
  if (sizeBytes < 1_000_000) return `${Math.ceil(sizeBytes / 1_000)} KB`;
  return `${(sizeBytes / 1_000_000).toFixed(1)} MB`;
}

function usesMobileKeyboard(): boolean {
  return (
    window.matchMedia("(max-width: 767px)").matches ||
    window.matchMedia("(hover: none) and (pointer: coarse)").matches
  );
}

function resizeComposer(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.style.height = "auto";
  const nextHeight = Math.min(
    Math.max(textarea.scrollHeight, 52),
    THREAD_COMPOSER_MAX_HEIGHT,
  );
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > THREAD_COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
}

function ThreadMessage({
  channelId,
  message,
  root = false,
  onEdit,
  onDelete,
}: {
  channelId: string;
  message: ChannelThreadMessageView;
  root?: boolean;
  onEdit?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
}) {
  const imageAttachments = message.attachments.filter((attachment) =>
    attachment.mimeType.startsWith("image/"),
  );
  const fileAttachments = message.attachments.filter(
    (attachment) => !attachment.mimeType.startsWith("image/"),
  );
  return (
    <article
      id={`chat-message-${message.id}`}
      className={`group/thread-message ${
        root
          ? "rounded-2xl border border-white/10 bg-white/[0.025] p-3.5"
          : "py-3"
      } ${message.pending ? "opacity-70" : ""}`}
    >
      <div className="flex gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.035] text-[10px] text-zinc-300">
          {message.authorType === "orchestrator"
            ? "✦"
            : message.label.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              className={`truncate text-xs font-medium ${
                message.authorType === "orchestrator"
                  ? "text-cyan-300"
                  : "text-zinc-200"
              }`}
            >
              {message.label}
            </span>
            <time className="shrink-0 text-[9px] text-zinc-600">
              {message.pending ? "Sending…" : displayTime(message.createdAt)}
            </time>
            {message.edited && !message.deleted ? (
              <span className="text-[9px] text-zinc-700">edited</span>
            ) : null}
            {message.ownMessage &&
            !message.pending &&
            !message.deleted &&
            (onDelete ||
              (onEdit &&
                !message.imageOnly &&
                !message.fileOnly &&
                !message.voiceOnly &&
                !message.snippetOnly &&
                message.content.trim())) ? (
              <span className="ml-auto flex shrink-0 items-center opacity-70 transition sm:opacity-0 sm:group-hover/thread-message:opacity-100 sm:group-focus-within/thread-message:opacity-100">
                {onEdit &&
                !message.imageOnly &&
                !message.fileOnly &&
                !message.voiceOnly &&
                !message.snippetOnly &&
                message.content.trim() ? (
                  <button
                    type="button"
                    onClick={() => onEdit(message.id)}
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-zinc-600 transition hover:bg-white/[0.04] hover:text-zinc-300"
                    aria-label="Edit this thread reply"
                  >
                    <PencilLine className="h-3 w-3" />
                    Edit
                  </button>
                ) : null}
                {onDelete ? (
                  <button
                    type="button"
                    onClick={() => onDelete(message.id)}
                    className="rounded-md p-1 text-zinc-600 transition hover:bg-rose-400/[0.07] hover:text-rose-300"
                    aria-label="Delete this thread message"
                    title="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
          {message.deleted ? (
            <p className="mt-1 text-[13px] italic text-zinc-600">
              This message was deleted.
            </p>
          ) : message.taskResult ? (
            <div
              className={`mt-1.5 rounded-xl border px-3 py-2.5 ${
                message.taskStatus === "done"
                  ? "border-emerald-400/25 bg-emerald-400/[0.05]"
                  : "border-red-400/25 bg-red-400/[0.05]"
              }`}
            >
              <FormattedMessageContent
                content={message.content}
                className="space-y-2 text-xs leading-relaxed text-zinc-300"
                textClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
              />
            </div>
          ) : !message.imageOnly &&
            !message.fileOnly &&
            !message.voiceOnly &&
            !message.snippetOnly ? (
            <FormattedMessageContent
              content={message.content}
              className="mt-1 space-y-2 text-[13px] leading-relaxed text-zinc-300"
              textClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
            />
          ) : null}
          {imageAttachments.length > 0 ? (
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {imageAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className={`group/thread-image relative overflow-hidden rounded-lg border border-white/10 bg-black/20 ${
                    imageAttachments.length === 1 ? "col-span-2" : ""
                  }`}
                >
                  <a
                    href={`/api/chat/channels/${channelId}/attachments/${attachment.id}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${attachment.name}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/chat/channels/${channelId}/attachments/${attachment.id}`}
                      alt={attachment.name}
                      loading="lazy"
                      className={`w-full object-cover ${
                        imageAttachments.length === 1
                          ? "max-h-64"
                          : "h-28"
                      }`}
                    />
                  </a>
                  <a
                    href={`/api/chat/channels/${channelId}/attachments/${attachment.id}?download=1`}
                    className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-lg border border-white/15 bg-black/75 text-white opacity-100 shadow-lg transition hover:bg-black sm:opacity-0 sm:group-hover/thread-image:opacity-100 sm:focus:opacity-100"
                    aria-label={`Download ${attachment.name}`}
                    title="Download image"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </a>
                </div>
              ))}
            </div>
          ) : null}
          {fileAttachments.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1.5">
              {fileAttachments.map((attachment) => (
                <a
                  key={attachment.id}
                  href={`/api/chat/channels/${channelId}/attachments/${attachment.id}?download=1`}
                  className="flex min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 transition hover:border-cyan-300/25 hover:bg-white/[0.04]"
                  aria-label={`Download ${attachment.name}`}
                >
                  <FileText className="h-4 w-4 shrink-0 text-cyan-300/75" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-300">
                    {attachment.name}
                  </span>
                  <span className="shrink-0 text-[9px] text-zinc-600">
                    {formatAttachmentSize(attachment.sizeBytes)}
                  </span>
                  <Download className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                </a>
              ))}
            </div>
          ) : null}
          {message.voiceNote ? (
            <div className="mt-2 rounded-xl border border-white/10 bg-black/20 p-2.5">
              <div className="mb-2 flex items-center justify-between gap-2 text-[9px] text-zinc-500">
                <span>
                  Voice note ·{" "}
                  {formatVoiceNoteDuration(message.voiceNote.durationMs)}
                </span>
                <a
                  href={`/api/chat/channels/${channelId}/attachments/${message.voiceNote.id}?download=1`}
                  className="flex items-center gap-1 text-zinc-500 hover:text-white"
                >
                  <Download className="h-3 w-3" />
                  Download
                </a>
              </div>
              <audio
                controls
                preload="metadata"
                src={`/api/chat/channels/${channelId}/attachments/${message.voiceNote.id}`}
                className="h-9 w-full"
              />
            </div>
          ) : null}
          {message.snippet ? (
            <ChatTextSnippetCard snippet={message.snippet} compact />
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function ChannelThreadPanel({
  channelId,
  channelName,
  root,
  replies,
  replyCount,
  draft,
  busy,
  initialLoading,
  historyLoading,
  hasOlder,
  hasNewer,
  working,
  error,
  typingLabel,
  resendSourceLabel,
  mentionQuery,
  mentionOptions,
  mentionActiveIndex,
  mentionBusyId,
  selectedImages,
  voiceNote,
  snippet,
  recentImages,
  recentBusyId,
  canSchedule,
  canStartHuddle,
  onDraftChange,
  onMentionActiveIndexChange,
  onMentionSelect,
  onMentionDismiss,
  onImagesSelected,
  onRemoveImage,
  onVoiceRecorded,
  onClearVoice,
  onOpenSnippet,
  onClearSnippet,
  onReuseRecentImage,
  onOpenSchedule,
  onStartHuddle,
  onComposerError,
  onSend,
  onEdit,
  onDelete,
  onCancelResend,
  onLoadOlder,
  onJumpLatest,
  onClose,
}: {
  channelId: string;
  channelName: string;
  root: ChannelThreadMessageView;
  replies: ChannelThreadMessageView[];
  replyCount: number;
  draft: string;
  busy: boolean;
  initialLoading: boolean;
  historyLoading: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  working: boolean;
  error: string | null;
  typingLabel?: string | null;
  resendSourceLabel: string | null;
  mentionQuery: string | null;
  mentionOptions: ChatMentionOption[];
  mentionActiveIndex: number;
  mentionBusyId: string | null;
  selectedImages: File[];
  voiceNote: PendingChatVoiceNote | null;
  snippet: ChatTextSnippet | null;
  recentImages: ChannelThreadRecentImage[];
  recentBusyId: string | null;
  canSchedule: boolean;
  canStartHuddle: boolean;
  onDraftChange: (value: string, cursor: number | null) => void;
  onMentionActiveIndexChange: (index: number) => void;
  onMentionSelect: (option: ChatMentionOption) => void;
  onMentionDismiss: () => void;
  onImagesSelected: (files: File[]) => void;
  onRemoveImage: (index: number) => void;
  onVoiceRecorded: (note: PendingChatVoiceNote) => void;
  onClearVoice: () => void;
  onOpenSnippet: (mode: "snippet" | "canvas") => void;
  onClearSnippet: () => void;
  onReuseRecentImage: (imageId: string) => void;
  onOpenSchedule: () => void;
  onStartHuddle: () => void;
  onComposerError: (message: string | null) => void;
  onSend: () => void;
  onEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onCancelResend: () => void;
  onLoadOlder: () => Promise<void>;
  onJumpLatest: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingScrollRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const sticksToBottomRef = useRef(true);
  const previousRootIdRef = useRef<string | null>(null);
  const [isDrawer, setIsDrawer] = useState(false);
  const [formatOpen, setFormatOpen] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
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

  useLayoutEffect(() => {
    resizeComposer(composerRef.current);
  }, [draft]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const restore = pendingScrollRestoreRef.current;
    const rootChanged = previousRootIdRef.current !== root.id;
    if (rootChanged) {
      pendingScrollRestoreRef.current = null;
      sticksToBottomRef.current = true;
      scroller.scrollTop = scroller.scrollHeight;
    } else if (restore) {
      pendingScrollRestoreRef.current = null;
      scroller.scrollTop =
        scroller.scrollHeight - restore.scrollHeight + restore.scrollTop;
    } else if (!hasNewer && sticksToBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
    previousRootIdRef.current = root.id;
  }, [hasNewer, replies, root.id, working]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === "undefined") {
      return;
    }
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (
        !shouldFollowTimelineGrowth({
          sticksToBottom: sticksToBottomRef.current,
          hasNewer,
          restoringHistory: Boolean(pendingScrollRestoreRef.current),
        })
      ) {
        return;
      }
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (
          shouldFollowTimelineGrowth({
            sticksToBottom: sticksToBottomRef.current,
            hasNewer,
            restoringHistory: Boolean(pendingScrollRestoreRef.current),
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
  }, [channelId, hasNewer, root.id]);

  useEffect(() => {
    if (!resendSourceLabel) return;
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      const length = composerRef.current?.value.length || 0;
      composerRef.current?.setSelectionRange(length, length);
    });
  }, [resendSourceLabel]);

  useEffect(() => {
    const drawerMedia = window.matchMedia("(max-width: 1279px)");
    const syncDrawer = () => {
      setIsDrawer(drawerMedia.matches);
      if (!drawerMedia.matches) return;
      panelRef.current
        ?.querySelector<HTMLButtonElement>("[data-thread-panel-close]")
        ?.focus();
    };
    const trapFocus = (event: globalThis.KeyboardEvent) => {
      if (
        !drawerMedia.matches ||
        event.key !== "Tab" ||
        !panelRef.current
      ) {
        return;
      }
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    syncDrawer();
    drawerMedia.addEventListener("change", syncDrawer);
    document.addEventListener("keydown", trapFocus);
    return () => {
      drawerMedia.removeEventListener("change", syncDrawer);
      document.removeEventListener("keydown", trapFocus);
    };
  }, [root.id]);

  const applyFormat = (format: ChatComposerFormat) => {
    const textarea = composerRef.current;
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
        onComposerError("Links must use a valid http:// or https:// URL.");
        return;
      }
    }
    const result = applyChatComposerFormat(
      { value: draft, selectionStart, selectionEnd },
      format,
      { href },
    );
    onDraftChange(result.value, result.selectionEnd);
    onComposerError(null);
    window.requestAnimationFrame(() => {
      resizeComposer(composerRef.current);
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(
        result.selectionStart,
        result.selectionEnd,
      );
    });
  };

  const insertAtCursor = (value: string, activateMention = false) => {
    const textarea = composerRef.current;
    const selectionStart = textarea?.selectionStart ?? draft.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const needsLeadingSpace =
      activateMention &&
      selectionStart > 0 &&
      !/\s/.test(draft[selectionStart - 1] || "");
    const insertion = `${needsLeadingSpace ? " " : ""}${value}`;
    const next =
      draft.slice(0, selectionStart) +
      insertion +
      draft.slice(selectionEnd);
    const cursor = selectionStart + insertion.length;
    onDraftChange(next, cursor);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      !event.nativeEvent.isComposing &&
      mentionQuery !== null &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      if (mentionOptions.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      onMentionActiveIndexChange(
        (mentionActiveIndex + delta + mentionOptions.length) %
          mentionOptions.length,
      );
      return;
    }
    if (
      !event.nativeEvent.isComposing &&
      mentionQuery !== null &&
      !event.shiftKey &&
      (event.key === "Tab" ||
        (event.key === "Enter" && !usesMobileKeyboard())) &&
      mentionOptions.length > 0
    ) {
      event.preventDefault();
      const option =
        mentionOptions[
          Math.min(mentionActiveIndex, mentionOptions.length - 1)
        ];
      if (option) onMentionSelect(option);
      return;
    }
    if (
      !event.nativeEvent.isComposing &&
      mentionQuery !== null &&
      event.key === "Escape"
    ) {
      event.preventDefault();
      onMentionDismiss();
      return;
    }
    if (
      !event.nativeEvent.isComposing &&
      event.key === "Enter" &&
      !event.shiftKey &&
      !usesMobileKeyboard()
    ) {
      event.preventDefault();
      onSend();
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm xl:hidden"
        aria-label="Close thread"
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-50 flex w-[min(26rem,calc(100vw-.5rem))] flex-col border-l border-white/10 bg-[#0d0f13] shadow-2xl shadow-black/70 outline-none xl:static xl:z-auto xl:w-[25rem] xl:shrink-0 xl:shadow-none"
        aria-label={`Thread in ${channelName}`}
        aria-modal={isDrawer || undefined}
        role={isDrawer ? "dialog" : undefined}
      >
        <header className="flex items-start gap-3 border-b border-white/[0.08] px-4 pb-4 pt-[calc(1rem+env(safe-area-inset-top))] xl:pt-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.07] text-cyan-300">
            <MessageSquareText className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Thread</h2>
              {replyCount > 0 ? (
                <span className="rounded-full border border-white/[0.08] bg-white/[0.025] px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-500">
                  {replyCount}
                </span>
              ) : null}
            </div>
            <p className="mt-1 truncate text-[11px] text-zinc-600">
              {channelName}
            </p>
          </div>
          <button
            data-thread-panel-close
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-600 transition hover:bg-white/[0.04] hover:text-zinc-300"
            aria-label="Close thread"
            title="Close thread"
          >
            <ChevronRight className="hidden h-4 w-4 xl:block" />
            <X className="h-4 w-4 xl:hidden" />
          </button>
        </header>

        <div
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            sticksToBottomRef.current =
              element.scrollHeight -
                element.scrollTop -
                element.clientHeight <
              100;
            if (
              element.scrollTop < 140 &&
              hasOlder &&
              !historyLoading
            ) {
              pendingScrollRestoreRef.current = {
                scrollHeight: element.scrollHeight,
                scrollTop: element.scrollTop,
              };
              void onLoadOlder().catch(() => {
                pendingScrollRestoreRef.current = null;
              });
            }
          }}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3.5 py-4"
        >
          <div ref={contentRef} className="min-h-full">
          {hasNewer ? (
            <div className="sticky top-0 z-20 mb-3 flex justify-center">
              <button
                type="button"
                onClick={onJumpLatest}
                className="inline-flex items-center gap-1.5 rounded-full border border-cyan-300/20 bg-[#15191e]/95 px-3 py-1.5 text-[10px] font-medium text-cyan-200 shadow-lg backdrop-blur"
              >
                <ChevronDown className="h-3 w-3" />
                Back to latest replies
              </button>
            </div>
          ) : null}
          <ChatDateSeparator timestamp={root.createdAt} compact />
          <ThreadMessage
            channelId={channelId}
            message={root}
            root
            onDelete={onDelete}
          />
          <div className="my-4 flex items-center gap-3">
            <span className="h-px flex-1 bg-white/[0.07]" />
            <span className="text-[9px] font-medium uppercase tracking-[0.16em] text-zinc-700">
              {replyCount === 0
                ? "Start the thread"
                : `${replyCount} ${
                    replyCount === 1 ? "reply" : "replies"
                  }`}
            </span>
            <span className="h-px flex-1 bg-white/[0.07]" />
          </div>
          {initialLoading ? (
            <div
              className="flex items-center justify-center gap-2 py-8 text-[11px] text-zinc-500"
              role="status"
            >
              <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              Loading replies…
            </div>
          ) : historyLoading ? (
            <div
              className="flex items-center justify-center gap-2 py-3 text-[10px] text-zinc-600"
              role="status"
            >
              <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" />
              Loading earlier replies…
            </div>
          ) : replies.length > 0 && !hasOlder ? (
            <p className="pb-2 text-center text-[9px] uppercase tracking-[0.14em] text-zinc-700">
              First reply
            </p>
          ) : null}
          <div>
            {replies.map((message, index) => (
              <div
                key={message.id}
                className="border-b border-white/[0.055] last:border-b-0"
              >
                {isDifferentChatCalendarDate(
                  (index === 0 ? root : replies[index - 1]).createdAt,
                  message.createdAt,
                ) ? (
                  <ChatDateSeparator timestamp={message.createdAt} compact />
                ) : null}
                <ThreadMessage
                  channelId={channelId}
                  message={message}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              </div>
            ))}
          </div>
          {working ? (
            <div className="mt-2 flex items-center gap-2 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.04] px-3 py-2.5 text-[11px] text-cyan-200">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              Groovy is working in this thread…
            </div>
          ) : null}
          </div>
        </div>

        <footer className="border-t border-white/[0.08] bg-[#0d0f13] p-3.5 pb-[calc(.875rem+env(safe-area-inset-bottom))]">
          {resendSourceLabel ? (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.05] px-2.5 py-2 text-[10px] text-cyan-100">
              <span className="truncate">
                Editing {resendSourceLabel}. Saving updates the text only.
              </span>
              <button
                type="button"
                onClick={onCancelResend}
                className="shrink-0 text-zinc-500 hover:text-zinc-200"
              >
                Cancel
              </button>
            </div>
          ) : null}
          <div
            className="relative rounded-xl border border-white/10 bg-black/20 focus-within:border-cyan-400/30"
            onDragOver={(event) => {
              if (resendSourceLabel || voiceNote || snippet) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(event) => {
              if (resendSourceLabel || voiceNote || snippet) return;
              const files = Array.from(event.dataTransfer.files || []);
              if (files.length === 0) return;
              event.preventDefault();
              onImagesSelected(files);
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
                onSelect={onMentionSelect}
              />
            ) : null}
            <input
              ref={imageInputRef}
              type="file"
              accept={CHAT_ATTACHMENT_ACCEPT}
              multiple
              className="sr-only"
              onChange={(event) => {
                onImagesSelected(Array.from(event.target.files || []));
                event.target.value = "";
              }}
            />
            {formatOpen ? (
              <div
                className="flex items-center gap-0.5 overflow-x-auto border-b border-white/[0.07] px-2 py-1.5"
                role="toolbar"
                aria-label="Thread reply formatting"
              >
                {[
                  ["bold", "Bold", Bold],
                  ["italic", "Italic", Italic],
                  ["underline", "Underline", Underline],
                  ["strike", "Strikethrough", Strikethrough],
                ].map(([format, label, Icon]) => (
                  <button
                    key={String(format)}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applyFormat(format as ChatComposerFormat)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                    aria-label={String(label)}
                    title={String(label)}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                ))}
                <span className="mx-0.5 h-4 w-px shrink-0 bg-white/[0.08]" />
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyFormat("link")}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                  aria-label="Add link"
                  title="Add link"
                >
                  <Link2 className="h-3.5 w-3.5" />
                </button>
                {[
                  ["ordered-list", "Numbered list", ListOrdered],
                  ["bullet-list", "Bulleted list", ListIcon],
                  ["quote", "Block quote", Quote],
                  ["inline-code", "Inline code", Code2],
                  ["code-block", "Code block", Braces],
                ].map(([format, label, Icon]) => (
                  <button
                    key={String(format)}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applyFormat(format as ChatComposerFormat)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                    aria-label={String(label)}
                    title={String(label)}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                ))}
              </div>
            ) : null}
            {selectedImagePreviews.length > 0 ? (
              <div className="flex gap-2 overflow-x-auto px-2.5 pt-2.5">
                {selectedImagePreviews.map(({ file, url, index }) => (
                  <div
                    key={`${file.name}-${file.lastModified}-${index}`}
                    className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-black/30"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={file.name}
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => onRemoveImage(index)}
                      className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/80 text-white"
                      aria-label={`Remove ${file.name}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {selectedFilePreviews.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
                {selectedFilePreviews.map(({ file, index }) => (
                  <div
                    key={`${file.name}-${file.lastModified}-${index}`}
                    className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-white/10 bg-black/25 px-2.5 py-2 text-[10px]"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-cyan-300/70" />
                    <span className="min-w-0 truncate text-zinc-300">
                      {file.name}
                    </span>
                    <span className="shrink-0 text-zinc-600">
                      {formatAttachmentSize(file.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemoveImage(index)}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                      aria-label={`Remove ${file.name}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {voiceNote ? (
              <div className="px-2.5 pt-2.5">
                <div className="flex items-center gap-2 rounded-lg border border-rose-300/15 bg-rose-300/[0.035] p-2">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 text-[9px] text-zinc-500">
                      Voice note · {formatVoiceNoteDuration(voiceNote.durationMs)}
                    </div>
                    <audio
                      controls
                      preload="metadata"
                      src={voiceNote.previewUrl}
                      className="h-8 w-full"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={onClearVoice}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                    aria-label="Remove voice note"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ) : null}
            {snippet ? (
              <div className="relative px-2.5 pt-1">
                <ChatTextSnippetCard snippet={snippet} compact />
                <button
                  type="button"
                  onClick={onClearSnippet}
                  className="absolute right-4 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-black/75 text-zinc-400 hover:text-white"
                  aria-label="Remove text snippet"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : null}
            <div className="px-3 pb-1 pt-2">
              <textarea
                ref={composerRef}
                rows={1}
                wrap="soft"
                value={draft}
                onPaste={(event) => {
                  if (!resendSourceLabel && !voiceNote && !snippet) {
                    const files = Array.from(
                      event.clipboardData.files || [],
                    ).filter(isSupportedChatAttachmentFile);
                    if (files.length > 0) {
                      event.preventDefault();
                      onImagesSelected(files);
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
                  onDraftChange(inserted.value, inserted.caret);
                  window.requestAnimationFrame(() => {
                    resizeComposer(composerRef.current);
                    composerRef.current?.focus();
                    composerRef.current?.setSelectionRange(
                      inserted.caret,
                      inserted.caret,
                    );
                  });
                }}
                onChange={(event) => {
                  resizeComposer(event.currentTarget);
                  onDraftChange(
                    event.target.value,
                    event.target.selectionStart,
                  );
                }}
                onClick={(event) =>
                  onDraftChange(
                    event.currentTarget.value,
                    event.currentTarget.selectionStart,
                  )
                }
                onKeyDown={handleKeyDown}
                onBlur={() => {
                  window.setTimeout(() => {
                    if (document.activeElement !== composerRef.current) {
                      onMentionDismiss();
                    }
                  }, 120);
                }}
                placeholder="Reply in thread"
                className="max-h-36 min-h-[52px] w-full resize-none overflow-x-hidden whitespace-pre-wrap break-words bg-transparent py-2 text-sm leading-5 text-zinc-200 outline-none placeholder:text-zinc-600"
                aria-label="Reply in thread"
                aria-haspopup="listbox"
                aria-autocomplete="list"
              />
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-white/[0.055] px-2 py-2">
              <div className="flex min-w-0 items-center gap-0.5">
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setAddOpen((current) => !current);
                    setEmojiOpen(false);
                  }}
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
                    addOpen
                      ? "bg-white/[0.1] text-white"
                      : "bg-white/[0.05] text-zinc-500 hover:text-white"
                  }`}
                  aria-label="Add to thread reply"
                  aria-expanded={addOpen}
                >
                  <Plus
                    className={`h-4 w-4 transition ${addOpen ? "rotate-45" : ""}`}
                  />
                </button>
                {addOpen ? (
                  <div className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-60 rounded-xl border border-white/10 bg-[#17191e] p-1.5 shadow-2xl">
                    <button
                      type="button"
                      disabled={
                        busy ||
                        Boolean(resendSourceLabel) ||
                        selectedImages.length > 0 ||
                        Boolean(voiceNote) ||
                        Boolean(snippet)
                      }
                      onClick={() => {
                        setAddOpen(false);
                        onOpenSnippet("canvas");
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs text-zinc-300 hover:bg-white/[0.06] disabled:opacity-35"
                    >
                      <FileText className="h-4 w-4 text-violet-300/75" />
                      Canvas
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAddOpen(false);
                        applyFormat("checklist");
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs text-zinc-300 hover:bg-white/[0.06]"
                    >
                      <CheckSquare className="h-4 w-4 text-zinc-500" />
                      List
                    </button>
                    <div>
                      <button
                        type="button"
                        disabled={
                          busy ||
                          Boolean(resendSourceLabel) ||
                          Boolean(voiceNote) ||
                          Boolean(snippet) ||
                          selectedImages.length >= MAX_CHAT_ATTACHMENT_FILES
                        }
                        onClick={() => {
                          if (recentImages.length === 0) {
                            setAddOpen(false);
                            onComposerError(
                              "No recent images are available in this conversation yet.",
                            );
                            return;
                          }
                          setRecentOpen((current) => !current);
                        }}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs text-zinc-300 hover:bg-white/[0.06] disabled:opacity-35"
                      >
                        <Bookmark className="h-4 w-4 text-zinc-500" />
                        Recent file
                      </button>
                      {recentOpen ? (
                        <div className="mx-2 mb-1 max-h-32 overflow-y-auto rounded-lg border border-white/[0.07] bg-black/20 p-1">
                          {recentImages.map((image) => (
                            <button
                              key={image.id}
                              type="button"
                              disabled={Boolean(recentBusyId)}
                              onClick={() => {
                                onReuseRecentImage(image.id);
                                setRecentOpen(false);
                                setAddOpen(false);
                              }}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[10px] text-zinc-400 hover:bg-white/[0.05] hover:text-white disabled:opacity-40"
                            >
                              {recentBusyId === image.id ? (
                                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <FileText className="h-3.5 w-3.5 text-zinc-600" />
                              )}
                              <span className="truncate">{image.name}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        Boolean(resendSourceLabel) ||
                        selectedImages.length > 0 ||
                        Boolean(voiceNote) ||
                        Boolean(snippet)
                      }
                      onClick={() => {
                        setAddOpen(false);
                        onOpenSnippet("snippet");
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs text-zinc-300 hover:bg-white/[0.06] disabled:opacity-35"
                    >
                      <FileText className="h-4 w-4 text-cyan-300/70" />
                      <span>
                        Text snippet
                        <span className="block text-[9px] text-zinc-600">
                          Share long text or code
                        </span>
                      </span>
                    </button>
                    {canSchedule ? (
                      <button
                        type="button"
                        onClick={() => {
                          setAddOpen(false);
                          onOpenSchedule();
                        }}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs text-zinc-300 hover:bg-white/[0.06]"
                      >
                        <CalendarClock className="h-4 w-4 text-zinc-500" />
                        Scheduled workflow
                      </button>
                    ) : null}
                    {canStartHuddle ? (
                      <button
                        type="button"
                        onClick={() => {
                          setAddOpen(false);
                          onStartHuddle();
                        }}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs text-zinc-300 hover:bg-white/[0.06]"
                      >
                        <Video className="h-4 w-4 text-zinc-500" />
                        Start or join huddle
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={
                        busy ||
                        Boolean(resendSourceLabel) ||
                        Boolean(voiceNote) ||
                        Boolean(snippet) ||
                        selectedImages.length >= MAX_CHAT_ATTACHMENT_FILES
                      }
                      onClick={() => {
                        setAddOpen(false);
                        imageInputRef.current?.click();
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs text-zinc-300 hover:bg-white/[0.06] disabled:opacity-35"
                    >
                      <Upload className="h-4 w-4 text-zinc-500" />
                      Upload files
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setFormatOpen((current) => !current)}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-medium underline underline-offset-2 ${
                  formatOpen
                    ? "bg-white/[0.06] text-zinc-200"
                    : "text-zinc-500 hover:text-white"
                }`}
                aria-label="Toggle formatting"
                aria-pressed={formatOpen}
              >
                Aa
              </button>
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setEmojiOpen((current) => !current);
                    setAddOpen(false);
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                  aria-label="Add emoji"
                  aria-expanded={emojiOpen}
                >
                  <Smile className="h-4 w-4" />
                </button>
                {emojiOpen ? (
                  <div className="absolute bottom-[calc(100%+8px)] left-0 z-50 grid w-52 grid-cols-6 gap-1 rounded-xl border border-white/10 bg-[#17191e] p-2 shadow-2xl">
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
                          insertAtCursor(emoji);
                          setEmojiOpen(false);
                        }}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-base hover:bg-white/[0.08]"
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
                onClick={() => {
                  setAddOpen(false);
                  setEmojiOpen(false);
                  insertAtCursor("@", true);
                }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                aria-label="Mention someone"
                title="Mention someone"
              >
                <AtSign className="h-4 w-4" />
              </button>
              <ChatVoiceRecorderButton
                disabled={
                  busy ||
                  Boolean(resendSourceLabel) ||
                  selectedImages.length > 0 ||
                  Boolean(snippet)
                }
                hasVoiceNote={Boolean(voiceNote)}
                onRecorded={onVoiceRecorded}
                onError={onComposerError}
              />
              </div>
              <button
                type="button"
                onClick={onSend}
                disabled={
                  busy ||
                  (!draft.trim() &&
                    selectedImages.length === 0 &&
                    !voiceNote &&
                    !snippet)
                }
                className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] text-cyan-300 transition hover:bg-cyan-400/[0.12] disabled:opacity-35"
                aria-label="Send thread reply"
              >
                {busy ? (
                  <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
            {draft.trim().length > MAX_CHAT_MESSAGE_CHARACTERS * 0.9 ? (
              <p
                className={`px-3 pb-1 text-right text-[10px] ${
                  draft.trim().length > MAX_CHAT_MESSAGE_CHARACTERS
                    ? "text-red-300"
                    : "text-zinc-500"
                }`}
              >
                {draft.trim().length.toLocaleString()} /{" "}
                {MAX_CHAT_MESSAGE_CHARACTERS.toLocaleString()} characters
              </p>
            ) : null}
          </div>
          <p
            className={`mt-1.5 min-h-4 px-1 text-[10px] ${
              typingLabel ? "text-zinc-500" : "text-transparent"
            }`}
            aria-live="polite"
          >
            {typingLabel ? `${typingLabel}…` : "No one typing"}
          </p>
          {error ? (
            <p className="mt-2 text-[11px] leading-relaxed text-red-300">
              {error}
            </p>
          ) : null}
        </footer>
      </aside>
    </>
  );
}
