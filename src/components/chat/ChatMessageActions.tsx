"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  BookmarkCheck,
  Copy,
  Ellipsis,
  MessageSquareText,
  PencilLine,
  Pin,
  PinOff,
  Reply,
  SmilePlus,
  Trash2,
} from "lucide-react";
import {
  chatMessageMenuPlacement,
  type ChatMessageMenuPlacement,
} from "@/lib/chat/messageActions";
import { QUICK_REACTION_EMOJIS } from "@/lib/chat/social";

export function ChatMessageActions({
  canEdit,
  canDelete,
  saved,
  pinned,
  messageDisabled,
  socialDisabled,
  onThread,
  onReply,
  onEdit,
  onDelete,
  onSave,
  onPin,
  onCopyLink,
  onReaction,
  onOpenChange,
}: {
  canEdit: boolean;
  canDelete: boolean;
  saved: boolean;
  pinned: boolean;
  messageDisabled?: boolean;
  socialDisabled?: boolean;
  onThread: () => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSave: () => void;
  onPin: () => void;
  onCopyLink: () => void;
  onReaction: (emoji: string) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [morePlacement, setMorePlacement] =
    useState<ChatMessageMenuPlacement>("above");
  const rootRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const reportedOpenRef = useRef(false);

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  useEffect(() => {
    const open = emojiOpen || moreOpen;
    if (reportedOpenRef.current !== open) {
      reportedOpenRef.current = open;
      onOpenChangeRef.current?.(open);
    }
    return () => {
      if (reportedOpenRef.current) {
        reportedOpenRef.current = false;
        onOpenChangeRef.current?.(false);
      }
    };
  }, [emojiOpen, moreOpen]);

  useEffect(() => {
    if (!emojiOpen && !moreOpen) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setEmojiOpen(false);
        setMoreOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setEmojiOpen(false);
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [emojiOpen, moreOpen]);

  const menuItem =
    "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-zinc-300 transition hover:bg-white/[0.06] hover:text-white";

  return (
    <div
      ref={rootRef}
      className={`relative flex items-center rounded-full bg-black/45 p-0.5 shadow-lg backdrop-blur sm:rounded-lg sm:border sm:border-white/[0.08] sm:bg-[#17191e]/95 sm:shadow-xl ${
        emojiOpen || moreOpen ? "z-50" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => {
          setEmojiOpen((current) => !current);
          setMoreOpen(false);
        }}
        disabled={messageDisabled || socialDisabled}
        className="hidden rounded-md p-1.5 text-zinc-400 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-40 sm:inline-flex"
        aria-label="Add reaction"
        title="Add reaction"
      >
        <SmilePlus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onThread}
        disabled={messageDisabled}
        className="hidden rounded-md p-1.5 text-zinc-400 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-40 sm:inline-flex"
        aria-label="Reply in thread"
        title="Reply in thread"
      >
        <MessageSquareText className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={messageDisabled || socialDisabled}
        className={`hidden rounded-md p-1.5 transition hover:bg-white/[0.07] disabled:opacity-40 sm:inline-flex ${
          saved ? "text-amber-300" : "text-zinc-400 hover:text-white"
        }`}
        aria-label={saved ? "Remove from Later" : "Save for later"}
        title={saved ? "Remove from Later" : "Save for later"}
      >
        {saved ? (
          <BookmarkCheck className="h-3.5 w-3.5" />
        ) : (
          <Bookmark className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={() => {
          const rootBounds = rootRef.current?.getBoundingClientRect();
          if (rootBounds) {
            setMorePlacement(
              chatMessageMenuPlacement({
                rootTop: rootBounds.top,
                rootBottom: rootBounds.bottom,
                viewportHeight: window.innerHeight,
              }),
            );
          }
          setMoreOpen((current) => !current);
          setEmojiOpen(false);
        }}
        disabled={messageDisabled}
        className={`rounded-full p-1.5 transition disabled:opacity-40 sm:rounded-md ${
          moreOpen
            ? "bg-white/[0.09] text-white"
            : "text-zinc-400 hover:bg-white/[0.07] hover:text-white"
        }`}
        aria-label="More message actions"
        title="More actions"
        aria-expanded={moreOpen}
      >
        <Ellipsis className="h-3.5 w-3.5" />
      </button>

      {emojiOpen ? (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 flex gap-1 rounded-xl border border-white/10 bg-[#17191e] p-1.5 shadow-2xl sm:bottom-[calc(100%+6px)] sm:top-auto">
          {QUICK_REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                onReaction(emoji);
                setEmojiOpen(false);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-base transition hover:bg-white/[0.08] hover:scale-110"
              aria-label={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}

      {moreOpen ? (
        <div
          className={`absolute right-0 top-[calc(100%+6px)] z-30 max-h-[min(24rem,calc(100vh-2rem))] w-[min(18rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-white/10 bg-[#17191e]/98 p-1.5 shadow-2xl backdrop-blur-xl sm:w-48 sm:rounded-xl ${
            morePlacement === "above"
              ? "sm:bottom-[calc(100%+6px)] sm:top-auto"
              : "sm:bottom-auto sm:top-[calc(100%+6px)]"
          }`}
        >
          <div className="mb-1 border-b border-white/[0.07] pb-1.5 sm:hidden">
            <div className="flex items-center justify-between gap-0.5 px-1 py-1">
              {QUICK_REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  disabled={socialDisabled}
                  onClick={() => {
                    onReaction(emoji);
                    setMoreOpen(false);
                  }}
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-lg transition active:scale-95 active:bg-white/[0.1] disabled:opacity-40"
                  aria-label={`React with ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => {
                  onThread();
                  setMoreOpen(false);
                }}
                className="flex items-center justify-center gap-2 rounded-xl px-2 py-2 text-xs font-medium text-zinc-300 transition active:bg-white/[0.07]"
              >
                <MessageSquareText className="h-3.5 w-3.5" />
                Thread
              </button>
              <button
                type="button"
                disabled={socialDisabled}
                onClick={() => {
                  onSave();
                  setMoreOpen(false);
                }}
                className={`flex items-center justify-center gap-2 rounded-xl px-2 py-2 text-xs font-medium transition active:bg-white/[0.07] disabled:opacity-40 ${
                  saved ? "text-amber-300" : "text-zinc-300"
                }`}
              >
                {saved ? (
                  <BookmarkCheck className="h-3.5 w-3.5" />
                ) : (
                  <Bookmark className="h-3.5 w-3.5" />
                )}
                {saved ? "Saved" : "Later"}
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              onReply();
              setMoreOpen(false);
            }}
            className={menuItem}
          >
            <Reply className="h-3.5 w-3.5" />
            Reply in channel
          </button>
          {canEdit ? (
            <button
              type="button"
              onClick={() => {
                onEdit();
                setMoreOpen(false);
              }}
              className={menuItem}
            >
              <PencilLine className="h-3.5 w-3.5" />
              Edit message
            </button>
          ) : null}
          <button
            type="button"
            disabled={socialDisabled}
            onClick={() => {
              onPin();
              setMoreOpen(false);
            }}
            className={`${menuItem} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {pinned ? (
              <PinOff className="h-3.5 w-3.5" />
            ) : (
              <Pin className="h-3.5 w-3.5" />
            )}
            {pinned ? "Unpin from room" : "Pin to room"}
          </button>
          <button
            type="button"
            onClick={() => {
              onCopyLink();
              setMoreOpen(false);
            }}
            className={menuItem}
          >
            <Copy className="h-3.5 w-3.5" />
            Copy message link
          </button>
          {canDelete ? (
            <>
              <div className="my-1 h-px bg-white/[0.07]" />
              <button
                type="button"
                onClick={() => {
                  onDelete();
                  setMoreOpen(false);
                }}
                className={`${menuItem} text-rose-300 hover:bg-rose-400/[0.08] hover:text-rose-200`}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete message
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
