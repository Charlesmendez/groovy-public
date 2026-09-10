"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { webhookMessageLabel } from "@/lib/chat/incomingWebhook";
import {
  Bookmark,
  Bot,
  Hash,
  Loader2,
  Lock,
  Search,
  UserRound,
  X,
} from "lucide-react";
import { toPlainChatPreview } from "@/lib/chat/messageFormatting";
import { ChatMemberAvatar } from "@/components/chat/ChatMemberAvatar";
import {
  memberDisplayName,
  type ChatMemberPresence,
  type ChatMemberProfile,
} from "@/lib/chat/social";
import { chatSearchRoomScopeLabel } from "@/lib/chat/searchScope";

type SearchChannel = {
  id: string;
  name: string;
  kind: "channel" | "dm";
  visibility?: "workspace" | "private";
};

type SearchMessage = {
  metadata?: Record<string, unknown> | null;
  id: string;
  channel_id: string;
  author_type: "user" | "agent" | "orchestrator" | "system";
  author_user_id: string | null;
  author_agent_id: string | null;
  profile_id: string | null;
  content: string;
  created_at: string;
  thread_root_message_id?: string | null;
  channel: SearchChannel | null;
};

type SavedResult = {
  saved_at: string;
  channel: SearchChannel | null;
  message: SearchMessage;
};

export function ChatSearchDialog({
  open,
  initialTab = "search",
  initialScope = "workspace",
  activeChannelId,
  channels,
  profiles,
  people,
  presence,
  agentNames,
  profileNames,
  onClose,
  onOpenResult,
}: {
  open: boolean;
  initialTab?: "search" | "saved";
  initialScope?: "workspace" | "channel";
  activeChannelId: string | null;
  channels: SearchChannel[];
  profiles: Map<string, ChatMemberProfile>;
  people: Array<{ user_id: string; email?: string | null }>;
  presence: Map<string, ChatMemberPresence>;
  agentNames: Map<string, string>;
  profileNames: Map<string, string>;
  onClose: () => void;
  onOpenResult: (channelId: string, messageId: string) => void;
}) {
  const [tab, setTab] = useState<"search" | "saved">(initialTab);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"workspace" | "channel">("workspace");
  const [author, setAuthor] = useState("all");
  const [results, setResults] = useState<SearchMessage[]>([]);
  const [saved, setSaved] = useState<SavedResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [savedLoaded, setSavedLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchSessionOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      searchSessionOpenRef.current = false;
      return;
    }
    if (!searchSessionOpenRef.current) {
      searchSessionOpenRef.current = true;
      setTab(initialTab);
      setScope(
        initialScope === "channel" && activeChannelId
          ? "channel"
          : "workspace",
      );
      setQuery("");
      setAuthor("all");
      setResults([]);
      setError(null);
    }
    const previous = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeChannelId, initialScope, initialTab, onClose, open]);

  useEffect(() => {
    if (!open || tab !== "search") return;
    const normalized = query.trim();
    if (normalized.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const url = new URL("/api/chat/search", window.location.origin);
        url.searchParams.set("q", normalized);
        if (scope === "channel" && activeChannelId) {
          url.searchParams.set("channelId", activeChannelId);
        }
        if (author !== "all") url.searchParams.set("author", author);
        const response = await fetch(url.href, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || "Could not search messages.");
        }
        setResults(Array.isArray(payload.results) ? payload.results : []);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof Error ? cause.message : "Could not search messages.",
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeChannelId, author, open, query, scope, tab]);

  useEffect(() => {
    if (!open || tab !== "saved" || savedLoaded) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch("/api/chat/saved", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || "Could not load saved messages.");
        }
        if (!controller.signal.aborted) {
          setSaved(Array.isArray(payload.saved) ? payload.saved : []);
          setSavedLoaded(true);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load saved messages.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, savedLoaded, tab]);

  const personById = useMemo(
    () => new Map(people.map((person) => [person.user_id, person])),
    [people],
  );
  const activeChannel = channels.find(
    (channel) => channel.id === activeChannelId,
  );

  if (!open) return null;

  const authorDetails = (message: SearchMessage) => {
    if (message.author_type === "user" && message.author_user_id) {
      const person = personById.get(message.author_user_id);
      const profile = profiles.get(message.author_user_id);
      return {
        label: memberDisplayName({
          email: person?.email,
          profile,
        }),
        avatar: (
          <ChatMemberAvatar
            userId={message.author_user_id}
            name={memberDisplayName({ email: person?.email, profile })}
            profile={profile}
            presence={presence.get(message.author_user_id)}
            size={34}
          />
        ),
      };
    }
    if (message.author_type === "agent") {
      return {
        label: agentNames.get(message.author_agent_id || "") || "Agent",
        avatar: (
          <span className="flex h-[34px] w-[34px] items-center justify-center rounded-xl border border-violet-300/20 bg-violet-300/[0.08] text-violet-200">
            <Bot className="h-4 w-4" />
          </span>
        ),
      };
    }
    if (message.author_type === "orchestrator") {
      return {
        label: profileNames.get(message.profile_id || "") || "Groovy",
        avatar: (
          <span className="flex h-[34px] w-[34px] items-center justify-center rounded-full border border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-200">
            ✦
          </span>
        ),
      };
    }
    return {
      label: webhookMessageLabel(message) || "System",
      avatar: (
        <span className="flex h-[34px] w-[34px] items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-400">
          <UserRound className="h-4 w-4" />
        </span>
      ),
    };
  };

  const renderResult = (
    message: SearchMessage,
    key: string,
    savedAt?: string,
  ) => {
    const details = authorDetails(message);
    const room =
      channels.find((channel) => channel.id === message.channel_id) ||
      message.channel ||
      null;
    return (
      <button
        type="button"
        key={key}
        onClick={() => {
          onOpenResult(message.channel_id, message.id);
          onClose();
        }}
        className="group flex w-full gap-3 border-b border-white/[0.055] px-4 py-3 text-left transition hover:bg-white/[0.035] focus-visible:bg-white/[0.05] focus-visible:outline-none"
      >
        {details.avatar}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-200">
              {details.label}
            </span>
            <span className="truncate text-[11px] text-zinc-600">
              {room?.kind === "channel" ? "#" : ""}
              {room?.name || "Room"}
            </span>
            <time className="ml-auto shrink-0 text-[10px] text-zinc-600">
              {new Date(savedAt || message.created_at).toLocaleDateString([], {
                month: "short",
                day: "numeric",
              })}
            </time>
          </span>
          <span className="mt-1 line-clamp-2 block text-[13px] leading-relaxed text-zinc-400 group-hover:text-zinc-300">
            {toPlainChatPreview(message.content)}
          </span>
          {message.thread_root_message_id ? (
            <span className="mt-1 block text-[10px] font-medium uppercase tracking-wider text-cyan-300/60">
              Thread reply
            </span>
          ) : null}
        </span>
      </button>
    );
  };

  const visibleResults =
    tab === "search"
      ? results
      : saved.map((item) => ({
          ...item.message,
          channel: item.channel,
        }));

  return (
    <div
      className="fixed inset-0 z-[95] flex items-start justify-center bg-black/70 p-0 backdrop-blur-sm sm:p-6 sm:pt-[8vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Search and saved messages"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div className="flex h-[100dvh] w-full flex-col overflow-hidden border-white/10 bg-[#0f1115] shadow-2xl sm:h-[min(760px,84dvh)] sm:max-w-2xl sm:rounded-3xl sm:border">
        <div className="border-b border-white/[0.07] px-4 pt-[calc(1rem+env(safe-area-inset-top))] sm:px-5 sm:pt-4">
          <div className="flex items-center gap-2">
            <Search className="h-5 w-5 shrink-0 text-zinc-500" />
            {scope === "channel" && activeChannel ? (
              <button
                type="button"
                onClick={() => setScope("workspace")}
                className="inline-flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 rounded-md border border-cyan-300/20 bg-cyan-300/[0.09] px-2 py-1 text-xs font-medium text-cyan-200 transition hover:bg-cyan-300/[0.13]"
                aria-label={`Remove ${chatSearchRoomScopeLabel(activeChannel)} search filter`}
                title="Search all conversations instead"
              >
                {activeChannel.kind === "dm" ? (
                  <UserRound className="h-3 w-3 shrink-0" />
                ) : activeChannel.visibility === "private" ? (
                  <Lock className="h-3 w-3 shrink-0" />
                ) : (
                  <Hash className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate">
                  {chatSearchRoomScopeLabel(activeChannel)}
                </span>
                <X className="h-3 w-3 shrink-0 opacity-60" />
              </button>
            ) : null}
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                if (tab !== "search") setTab("search");
              }}
              placeholder={
                scope === "channel" && activeChannel
                  ? "Search this conversation"
                  : "Search every conversation"
              }
              className="min-w-0 flex-1 bg-transparent py-2 text-base text-white outline-none placeholder:text-zinc-600"
              aria-label={
                scope === "channel" && activeChannel
                  ? `Search ${chatSearchRoomScopeLabel(activeChannel)}`
                  : "Search every conversation"
              }
            />
            <span className="hidden rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-600 sm:block">
              esc
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-zinc-500 hover:bg-white/[0.06] hover:text-white"
              aria-label="Close search"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-1 overflow-x-auto">
            <button
              type="button"
              onClick={() => setTab("search")}
              className={`rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium ${
                tab === "search"
                  ? "border-cyan-300 text-cyan-200"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Search
            </button>
            <button
              type="button"
              onClick={() => setTab("saved")}
              className={`inline-flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium ${
                tab === "saved"
                  ? "border-cyan-300 text-cyan-200"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Bookmark className="h-3.5 w-3.5" />
              Later
            </button>
          </div>
        </div>

        {tab === "search" ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.055] px-4 py-2.5 text-xs">
            <button
              type="button"
              onClick={() => setScope("workspace")}
              aria-pressed={scope === "workspace"}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 transition ${
                scope === "workspace"
                  ? "border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-200"
                  : "border-white/[0.08] bg-white/[0.03] text-zinc-500 hover:text-white"
              }`}
            >
              <Search className="h-3 w-3" />
              All conversations
            </button>
            <button
              type="button"
              onClick={() => setScope("channel")}
              disabled={!activeChannel}
              aria-pressed={scope === "channel"}
              className={`inline-flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 transition disabled:opacity-40 ${
                scope === "channel"
                  ? "border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-200"
                  : "border-white/[0.08] bg-white/[0.03] text-zinc-500 hover:text-white"
              }`}
            >
              {activeChannel?.kind === "dm" ? (
                <UserRound className="h-3 w-3" />
              ) : activeChannel?.visibility === "private" ? (
                <Lock className="h-3 w-3" />
              ) : (
                <Hash className="h-3 w-3" />
              )}
              <span className="max-w-40 truncate">
                {activeChannel
                  ? `${activeChannel.kind === "channel" ? "#" : ""}${
                      activeChannel.name
                    }`
                  : "Current conversation"}
              </span>
            </button>
            <select
              value={author}
              onChange={(event) => setAuthor(event.target.value)}
              className="rounded-lg border border-white/[0.08] bg-[#15171c] px-2.5 py-1.5 text-zinc-400 outline-none hover:text-white"
              aria-label="Filter by sender type"
            >
              <option value="all">Anyone</option>
              <option value="user">People</option>
              <option value="orchestrator">Minds</option>
              <option value="agent">Agents</option>
            </select>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              {tab === "search" ? "Searching…" : "Loading saved messages…"}
            </div>
          ) : error ? (
            <div className="mx-4 mt-5 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-3 text-sm text-rose-200">
              {error}
            </div>
          ) : tab === "search" && query.trim().length < 2 ? (
            <div className="px-6 py-16 text-center">
              <Search className="mx-auto h-7 w-7 text-zinc-700" />
              <p className="mt-3 text-sm font-medium text-zinc-300">
                Find anything without digging
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Search messages, decisions, links, and agent results.
              </p>
            </div>
          ) : visibleResults.length === 0 ? (
            <div className="px-6 py-16 text-center">
              {tab === "saved" ? (
                <Bookmark className="mx-auto h-7 w-7 text-zinc-700" />
              ) : (
                <Search className="mx-auto h-7 w-7 text-zinc-700" />
              )}
              <p className="mt-3 text-sm font-medium text-zinc-300">
                {tab === "saved"
                  ? "Nothing saved for later yet"
                  : `No results for “${query.trim()}”`}
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                {tab === "saved"
                  ? "Save a message from its quick actions and it will appear here."
                  : "Try a shorter phrase or search all rooms."}
              </p>
            </div>
          ) : tab === "search" ? (
            results.map((message) =>
              renderResult(message, `search-${message.id}`),
            )
          ) : (
            saved.map((item) =>
              renderResult(
                { ...item.message, channel: item.channel },
                `saved-${item.message.id}`,
                item.saved_at,
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}
