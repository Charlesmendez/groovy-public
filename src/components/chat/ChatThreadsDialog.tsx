"use client";

import { useEffect, useMemo } from "react";
import { webhookMessageLabel } from "@/lib/chat/incomingWebhook";
import {
  Bot,
  Hash,
  Loader2,
  MessageSquareText,
  RefreshCw,
  UserRound,
  X,
} from "lucide-react";
import { ChatMemberAvatar } from "@/components/chat/ChatMemberAvatar";
import {
  memberDisplayName,
  type ChatMemberPresence,
  type ChatMemberProfile,
} from "@/lib/chat/social";
import { toPlainChatPreview } from "@/lib/chat/messageFormatting";

type ThreadChannel = {
  id: string;
  name: string;
  kind: "channel" | "dm";
  slug: string;
};

export type ChatThreadInboxMessage = {
  metadata?: Record<string, unknown> | null;
  id: string;
  channel_id: string;
  author_type: "user" | "agent" | "orchestrator" | "system";
  author_user_id: string | null;
  author_agent_id: string | null;
  profile_id: string | null;
  content: string;
  created_at: string;
  thread_root_message_id: string | null;
};

export type ChatThreadInboxItem = {
  thread_root_message_id: string;
  channel: ThreadChannel;
  root_message: ChatThreadInboxMessage;
  latest_reply: ChatThreadInboxMessage;
  reply_count: number;
  unread: boolean;
  last_read_at: string | null;
};

function relativeThreadTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

export function ChatThreadsDialog({
  open,
  threads,
  loading,
  error,
  migrationPending,
  profiles,
  people,
  presence,
  agentNames,
  profileNames,
  onClose,
  onRefresh,
  onOpenThread,
}: {
  open: boolean;
  threads: ChatThreadInboxItem[];
  loading: boolean;
  error: string | null;
  migrationPending: boolean;
  profiles: Map<string, ChatMemberProfile>;
  people: Array<{ user_id: string; email?: string | null }>;
  presence: Map<string, ChatMemberPresence>;
  agentNames: Map<string, string>;
  profileNames: Map<string, string>;
  onClose: () => void;
  onRefresh: () => void;
  onOpenThread: (channelId: string, rootMessageId: string) => void;
}) {
  const personById = useMemo(
    () => new Map(people.map((person) => [person.user_id, person])),
    [people],
  );

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open]);

  if (!open) return null;

  const authorDetails = (message: ChatThreadInboxMessage) => {
    if (message.author_type === "user" && message.author_user_id) {
      const person = personById.get(message.author_user_id);
      const profile = profiles.get(message.author_user_id);
      const label = memberDisplayName({ email: person?.email, profile });
      return {
        label,
        avatar: (
          <ChatMemberAvatar
            userId={message.author_user_id}
            name={label}
            profile={profile}
            presence={presence.get(message.author_user_id)}
            size={28}
          />
        ),
      };
    }
    const label =
      (message.author_agent_id
        ? agentNames.get(message.author_agent_id)
        : null) ||
      (message.profile_id ? profileNames.get(message.profile_id) : null) ||
      (message.author_type === "system"
        ? webhookMessageLabel(message) || "System"
        : "Groovy");
    return {
      label,
      avatar: (
        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
          <Bot className="h-3.5 w-3.5" />
        </span>
      ),
    };
  };

  return (
    <div className="fixed inset-0 z-[105] flex items-start justify-center bg-black/65 px-3 pb-3 pt-[max(4rem,env(safe-area-inset-top))] backdrop-blur-sm sm:px-6 sm:pt-20">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close Threads"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-threads-title"
        className="relative flex max-h-[min(780px,calc(100dvh-5rem))] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#111318] shadow-2xl shadow-black/60"
      >
        <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3.5 sm:px-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
            <MessageSquareText className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="chat-threads-title" className="text-sm font-semibold text-white">
              Threads
            </h2>
            <p className="text-xs text-zinc-500">
              Replies to messages you started or joined
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/5 hover:text-white disabled:opacity-40"
            aria-label="Refresh Threads"
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/5 hover:text-white"
            aria-label="Close Threads"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {migrationPending ? (
          <div className="border-b border-amber-400/15 bg-amber-400/[0.06] px-5 py-2.5 text-xs text-amber-200/80">
            Threads are available now. The latest database update will keep
            unread status synchronized across devices.
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-3">
          {loading && threads.length === 0 ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading threads…
            </div>
          ) : error ? (
            <div className="m-2 rounded-xl border border-red-400/20 bg-red-400/[0.06] px-4 py-5 text-center">
              <p className="text-sm text-red-200">{error}</p>
              <button
                type="button"
                onClick={onRefresh}
                className="mt-3 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5"
              >
                Try again
              </button>
            </div>
          ) : threads.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
              <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-white/[0.04] text-zinc-600">
                <MessageSquareText className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium text-zinc-300">No threads yet</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-zinc-600">
                Start a thread from any message. Replies to conversations you
                start or join will stay collected here.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {threads.map((thread) => {
                const latestAuthor = authorDetails(thread.latest_reply);
                const roomIcon =
                  thread.channel.kind === "channel" ? (
                    <Hash className="h-3 w-3" />
                  ) : (
                    <UserRound className="h-3 w-3" />
                  );
                return (
                  <button
                    key={thread.thread_root_message_id}
                    type="button"
                    onClick={() =>
                      onOpenThread(
                        thread.channel.id,
                        thread.thread_root_message_id,
                      )
                    }
                    className={`group w-full rounded-xl border px-3.5 py-3 text-left transition ${
                      thread.unread
                        ? "border-cyan-400/20 bg-cyan-400/[0.055] hover:bg-cyan-400/[0.085]"
                        : "border-transparent hover:border-white/[0.07] hover:bg-white/[0.035]"
                    }`}
                  >
                    <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                      <span className="flex items-center gap-1">
                        {roomIcon}
                        {thread.channel.kind === "channel" ? "#" : ""}
                        {thread.channel.name}
                      </span>
                      <span>·</span>
                      <span>
                        {thread.reply_count}{" "}
                        {thread.reply_count === 1 ? "reply" : "replies"}
                      </span>
                      <span className="ml-auto">
                        {relativeThreadTime(thread.latest_reply.created_at)}
                      </span>
                      {thread.unread ? (
                        <span
                          className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.6)]"
                          aria-label="Unread thread"
                        />
                      ) : null}
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm font-medium leading-relaxed text-zinc-200">
                      {toPlainChatPreview(thread.root_message.content) ||
                        "Shared message"}
                    </p>
                    <div className="mt-2.5 flex items-start gap-2">
                      {latestAuthor.avatar}
                      <p className="min-w-0 flex-1 text-xs leading-relaxed text-zinc-500">
                        <span className="font-medium text-zinc-400">
                          {latestAuthor.label}
                        </span>{" "}
                        <span className="line-clamp-2">
                          {toPlainChatPreview(thread.latest_reply.content) ||
                            "Shared a reply"}
                        </span>
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
