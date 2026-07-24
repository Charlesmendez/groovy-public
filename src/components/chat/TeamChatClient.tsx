"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { AppNav } from "@/components/AppNav";
import { ChannelAccessModal } from "@/components/chat/ChannelAccessModal";
import { PeopleInviteModal } from "@/components/chat/PeopleInviteModal";

type Channel = {
  id: string;
  kind: "channel" | "dm";
  name: string;
  slug: string;
  topic: string | null;
  profile_id: string | null;
  orchestrator_mode: "mention" | "always" | "off";
  visibility: "workspace" | "private";
  created_by: string;
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

type Profile = {
  id: string;
  name: string;
  slug: string;
  surface: string;
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

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return Array.from(byId.values()).sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function TeamChatClient({ initialChannelId }: { initialChannelId?: string }) {
  const router = useRouter();
  const [workspaceName, setWorkspaceName] = useState("Workspace");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [channelComposerOpen, setChannelComposerOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelVisibility, setNewChannelVisibility] = useState<
    "workspace" | "private"
  >("workspace");
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [channelCreateError, setChannelCreateError] = useState<string | null>(
    null,
  );
  const [channels, setChannels] = useState<Channel[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [channelMembers, setChannelMembers] = useState<ChannelMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [workspaceRole, setWorkspaceRole] = useState<
    "admin" | "member" | "guest"
  >("member");
  const [activeId, setActiveId] = useState<string | null>(initialChannelId || null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [activeWork, setActiveWork] = useState<ActiveWork>({
    orchestrator: null,
    agents: [],
  });
  const [controlBusy, setControlBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [peopleInviteOpen, setPeopleInviteOpen] = useState(false);
  const [roomSheetOpen, setRoomSheetOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const channelNameRef = useRef<HTMLInputElement>(null);

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
    setActiveId((current) => {
      if (current && nextChannels.some((channel: Channel) => channel.id === current)) {
        return current;
      }
      return nextChannels[0]?.id || null;
    });
  }, []);

  const loadMessages = useCallback(async (channelId: string) => {
    const res = await fetch(`/api/chat/channels/${channelId}/messages`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Could not load channel messages.");
    const payload = await res.json();
    setMessages(Array.isArray(payload.messages) ? payload.messages : []);
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
    setActiveWork(next);
    setThinking(Boolean(next.orchestrator));
  }, []);

  useEffect(() => {
    void loadSidebar().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Could not load chat."),
    );
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
          void loadSidebar();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(realtime);
    };
  }, [loadSidebar]);

  useEffect(() => {
    try {
      setSidebarCollapsed(
        window.localStorage.getItem("groovy-chat-sidebar-collapsed") === "1",
      );
    } catch {
      // Storage can be unavailable in hardened/private browser contexts.
    }
  }, []);

  useEffect(() => {
    if (!channelComposerOpen) return;
    channelNameRef.current?.focus();
  }, [channelComposerOpen]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      setActiveWork({ orchestrator: null, agents: [] });
      return;
    }
    void loadMessages(activeId).catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Could not load messages."),
    );
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
            mergeMessages(current, [payload.new as Message]),
          );
        },
      )
      .subscribe();
    return () => {
      clearInterval(activeWorkPoll);
      void supabase.removeChannel(realtime);
    };
  }, [activeId, loadActiveWork, loadMessages]);

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
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const canManageActive =
    Boolean(active) &&
    (workspaceRole === "admin" || active?.created_by === currentUserId);

  const selectChannel = (id: string) => {
    setActiveId(id);
    setReplyTo(null);
    setMobileNavOpen(false);
    router.replace(`/chat/${id}`);
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

  const openChannelComposer = () => {
    if (workspaceRole === "guest") return;
    setChannelCreateError(null);
    setChannelComposerOpen(true);
    if (window.matchMedia("(max-width: 767px)").matches) {
      setMobileNavOpen(true);
    } else {
      setDesktopSidebarCollapsed(false);
    }
  };

  const closeChannelComposer = () => {
    if (creatingChannel) return;
    setChannelComposerOpen(false);
    setNewChannelName("");
    setNewChannelVisibility("workspace");
    setChannelCreateError(null);
  };

  const createChannel = async () => {
    const name = newChannelName.trim();
    if (workspaceRole === "guest" || !name || creatingChannel) return;
    setCreatingChannel(true);
    setChannelCreateError(null);
    try {
      const res = await fetch("/api/chat/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          profileId: profiles.find((profile) => profile.is_default)?.id || null,
          orchestratorMode: "mention",
          visibility: newChannelVisibility,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Could not create channel.");
      }
      setChannelComposerOpen(false);
      setNewChannelName("");
      setNewChannelVisibility("workspace");
      await loadSidebar();
      selectChannel(payload.channel.id);
    } catch (cause) {
      setChannelCreateError(
        cause instanceof Error ? cause.message : "Could not create channel.",
      );
    } finally {
      setCreatingChannel(false);
    }
  };

  const openAgentDm = async (agent: Agent) => {
    const existing = channels.find(
      (channel) => channel.kind === "dm" && channel.slug === `agent-${agent.id}`,
    );
    if (existing) {
      selectChannel(existing.id);
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
        profileId: profiles.find((profile) => profile.is_default)?.id || null,
        orchestratorMode: "always",
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(payload.error || "Could not open agent conversation.");
      return;
    }
    await loadSidebar();
    selectChannel(payload.channel.id);
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
      setError(payload.error || "Could not open teammate conversation.");
      return;
    }
    await loadSidebar();
    selectChannel(payload.channel.id);
  };

  const patchChannel = async (patch: Record<string, unknown>) => {
    if (!active) return;
    const res = await fetch(`/api/chat/channels/${active.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(payload.error || "Could not update channel.");
      return;
    }
    setChannels((current) =>
      current.map((channel) =>
        channel.id === active.id ? { ...channel, ...payload.channel } : channel,
      ),
    );
  };

  const send = async () => {
    if (!active || !draft.trim() || busy) return;
    const content = draft.trim();
    setBusy(true);
    setDraft("");
    setError(null);
    try {
      const res = await fetch(`/api/chat/channels/${active.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          replyToMessageId: replyTo?.id || null,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Could not send message.");
      }
      const received = [payload.message, payload.orchestrator].filter(Boolean);
      setMessages((current) => mergeMessages(current, received));
      if (payload.error) setError(payload.error);
      setReplyTo(null);
    } catch (cause) {
      setDraft(content);
      setError(cause instanceof Error ? cause.message : "Could not send message.");
      await loadMessages(active.id).catch(() => undefined);
    } finally {
      setBusy(false);
      setThinking(false);
    }
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
      {/* Mobile: the sidebar becomes a slide-over so the conversation gets the
          full viewport. md+ keeps the fixed rail. */}
      {mobileNavOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden
        />
      ) : null}
      <aside
        className={`${
          mobileNavOpen ? "flex" : "hidden"
        } fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] shrink-0 flex-col border-r border-[var(--glass-border)] bg-[var(--bg-secondary)] max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] md:static md:z-auto md:w-64 md:max-w-none md:bg-[var(--bg-secondary)]/70 ${
          sidebarCollapsed ? "md:hidden" : "md:flex"
        }`}
      >
        <div className="border-b border-[var(--glass-border)] px-4 py-4">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate font-display text-sm tracking-wider">
              {workspaceName}
            </div>
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              className="rounded-md px-2 py-1 text-lg leading-none text-[var(--text-secondary)] hover:bg-white/5 hover:text-white md:hidden"
              aria-label="Close channels panel"
              title="Close"
            >
              ×
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
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="flex items-center justify-between px-2 pb-1 pt-2 text-[10px] uppercase tracking-widest text-[var(--text-secondary)]">
            <span>Channels</span>
            {workspaceRole !== "guest" ? (
              <button
                type="button"
                onClick={openChannelComposer}
                className="flex h-6 w-6 items-center justify-center rounded-md text-base leading-none text-[var(--text-secondary)] hover:bg-white/5 hover:text-white"
                aria-label="Create channel"
                title="Create channel"
              >
                +
              </button>
            ) : null}
          </div>
          {channelComposerOpen ? (
            <form
              className="mx-1 mb-2 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-primary)] p-2.5"
              onSubmit={(event) => {
                event.preventDefault();
                void createChannel();
              }}
            >
              <label
                htmlFor="new-channel-name"
                className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)]"
              >
                Channel name
              </label>
              <div className="flex items-center rounded-lg border border-[var(--glass-border)] bg-[var(--bg-secondary)] px-2.5">
                <span className="text-sm text-[var(--text-secondary)]">#</span>
                <input
                  ref={channelNameRef}
                  id="new-channel-name"
                  value={newChannelName}
                  onChange={(event) => {
                    setNewChannelName(event.target.value);
                    setChannelCreateError(null);
                  }}
                  maxLength={100}
                  placeholder="project-updates"
                  className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm outline-none placeholder:text-zinc-600"
                  disabled={creatingChannel}
                />
              </div>
              <select
                value={newChannelVisibility}
                onChange={(event) =>
                  setNewChannelVisibility(
                    event.target.value === "private" ? "private" : "workspace",
                  )
                }
                className="mt-2 w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-secondary)] px-2.5 py-2 text-xs text-[var(--text-secondary)] outline-none"
                aria-label="Channel visibility"
                disabled={creatingChannel}
              >
                <option value="workspace">Workspace — everyone can find it</option>
                <option value="private">Private — invited members only</option>
              </select>
              {channelCreateError ? (
                <p className="mt-2 text-xs leading-relaxed text-red-300">
                  {channelCreateError}
                </p>
              ) : null}
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeChannelComposer}
                  disabled={creatingChannel}
                  className="rounded-md px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:text-white disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingChannel || !newChannelName.trim()}
                  className="rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1.5 text-xs text-cyan-300 disabled:opacity-40"
                >
                  {creatingChannel ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          ) : null}
          {channels
            .filter((channel) => channel.kind === "channel")
            .map((channel) => (
              <button
                key={channel.id}
                onClick={() => selectChannel(channel.id)}
                className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm ${
                  channel.id === activeId
                    ? "bg-[var(--bg-tertiary)] text-white"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
                }`}
              >
                <span className="mr-2">#</span>
                {channel.visibility === "private" ? (
                  <span className="mr-1 text-[10px] text-zinc-500">●</span>
                ) : null}
                <span className="truncate">{channel.name}</span>
              </button>
            ))}
          <div className="px-2 pb-1 pt-5 text-[10px] uppercase tracking-widest text-[var(--text-secondary)]">
            Direct
          </div>
          {channels
            .filter((channel) => channel.kind === "dm")
            .map((channel) => (
              <button
                key={channel.id}
                onClick={() => selectChannel(channel.id)}
                className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm ${
                  channel.id === activeId
                    ? "bg-[var(--bg-tertiary)] text-white"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
                }`}
              >
                <span className="mr-2 text-[var(--accent-green)]">●</span>
                <span className="truncate">{channel.name}</span>
              </button>
            ))}
          <div className="flex items-center justify-between px-2 pb-1 pt-5 text-[10px] uppercase tracking-widest text-[var(--text-secondary)]">
            <span>People</span>
            {workspaceRole === "admin" ? (
              <button
                type="button"
                onClick={() => setPeopleInviteOpen(true)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-base leading-none text-[var(--text-secondary)] hover:bg-white/5 hover:text-white"
                aria-label="Invite people"
                title="Invite people"
              >
                +
              </button>
            ) : null}
          </div>
          {workspaceRole !== "guest"
            ? people
                .filter((person) => person.user_id !== currentUserId)
                .map((person) => (
                  <button
                    key={person.user_id}
                    onClick={() => void openPersonDm(person)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-white"
                  >
                    <span className="text-[var(--accent-green)]">●</span>
                    <span className="min-w-0 flex-1 truncate">
                      {person.email?.split("@")[0] || "Teammate"}
                    </span>
                    <span className="text-[9px] uppercase tracking-wider text-zinc-600">
                      {person.role === "guest" ? "guest" : person.role}
                    </span>
                  </button>
                ))
            : null}
          {workspaceRole !== "guest" &&
          people.filter((person) => person.user_id !== currentUserId).length ===
            0 ? (
            <p className="px-3 py-2 text-xs text-zinc-600">
              No teammates yet.
            </p>
          ) : null}
          <div className="px-2 pb-1 pt-5 text-[10px] uppercase tracking-widest text-[var(--text-secondary)]">
            Agents
          </div>
          {workspaceRole !== "guest" ? agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => void openAgentDm(agent)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-white"
            >
              <span className={agent.deviceOnline ? "text-emerald-400" : "text-zinc-600"}>◆</span>
              <span className="min-w-0">
                <span className="block truncate">{agent.name}</span>
                <span className="block truncate text-[10px] opacity-60">
                  {agent.harness}
                  {agent.model ? ` · ${agent.model}` : ""}
                </span>
              </span>
            </button>
          )) : null}
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {sidebarCollapsed ? (
          <button
            type="button"
            onClick={() => setDesktopSidebarCollapsed(false)}
            className="absolute left-3 top-2.5 z-20 hidden rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] p-2 text-[var(--text-secondary)] shadow-lg hover:text-white md:inline-flex"
            aria-label="Show channels panel"
            title="Show channels panel"
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
          </button>
        ) : null}
        {active ? (
          <>
            <header
              className={`flex items-center gap-3 border-b border-[var(--glass-border)] bg-[var(--bg-secondary)]/40 px-4 py-3 sm:px-5 ${
                sidebarCollapsed ? "md:pl-16" : ""
              }`}
            >
              <button
                onClick={() => setMobileNavOpen(true)}
                className="-ml-1 shrink-0 rounded-lg p-2 text-[var(--text-secondary)] hover:text-white md:hidden"
                aria-label="Open channels"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-sm font-semibold">
                  {active.kind === "channel" ? "#" : ""}
                  {active.name}
                </h1>
                {active.topic ? (
                  <p className="truncate text-xs text-[var(--text-secondary)]">{active.topic}</p>
                ) : null}
              </div>
              {/* Room controls: inline on md+, collapsed into a bottom sheet on mobile */}
              <div className="hidden items-center gap-3 md:flex">
                <select
                  value={active.profile_id || ""}
                  onChange={(event) =>
                    void patchChannel({ profileId: event.target.value || null })
                  }
                  className="rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs"
                  aria-label="Channel harness profile"
                  disabled={!canManageActive}
                >
                  <option value="">Groovy default</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
                <select
                  value={active.orchestrator_mode}
                  onChange={(event) =>
                    void patchChannel({ orchestratorMode: event.target.value })
                  }
                  className="rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs"
                  aria-label="Orchestrator attention mode"
                  disabled={!canManageActive}
                >
                  <option value="mention">@mention</option>
                  <option value="always">always</option>
                  <option value="off">off</option>
                </select>
                {active.kind === "channel" && canManageActive ? (
                  <button
                    type="button"
                    onClick={() => setAccessOpen(true)}
                    className="rounded-lg border border-[var(--glass-border)] px-2 py-1.5 text-xs text-[var(--text-secondary)] hover:text-white"
                  >
                    Access
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setRoomSheetOpen(true)}
                className="shrink-0 rounded-lg border border-[var(--glass-border)] px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-white md:hidden"
                aria-label="Room settings"
              >
                ⋯
              </button>
            </header>

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {messages.map((message) => {
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
                  <article key={message.id} className="group mb-4 flex gap-3">
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
                          {displayTime(message.created_at)}
                        </time>
                        <button
                          onClick={() => setReplyTo(message)}
                          className="px-1 py-1 text-[11px] text-[var(--text-secondary)] opacity-60 sm:opacity-0 sm:group-hover:opacity-100"
                        >
                          Reply
                        </button>
                      </div>
                      {quoted ? (
                        <div className="my-1 border-l-2 border-[var(--glass-border)] pl-2 text-xs text-[var(--text-secondary)]">
                          {quoted.content.slice(0, 180)}
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
                        <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
                          {message.content}
                        </p>
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
              <div className="flex items-end gap-3 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-primary)] px-4 py-3">
                <textarea
                  rows={1}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={`Message ${active.kind === "channel" ? "#" : ""}${active.name} — use @ to summon`}
                  className="max-h-40 flex-1 resize-none bg-transparent text-sm outline-none"
                />
                <button
                  onClick={() => void send()}
                  disabled={busy || !draft.trim()}
                  className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-300 disabled:opacity-40"
                >
                  {busy ? "Sending…" : "Send"}
                </button>
              </div>
              {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <button
              onClick={() => setMobileNavOpen(true)}
              className="mb-4 rounded-lg border border-[var(--glass-border)] px-3 py-2 text-xs text-[var(--text-secondary)] hover:text-white md:hidden"
            >
              ☰ Channels & agents
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
      {roomSheetOpen && active ? (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/60 md:hidden"
          onClick={() => setRoomSheetOpen(false)}
        >
          <div
            className="animate-slide-up w-full rounded-t-2xl border-t border-[var(--glass-border)] bg-[var(--bg-secondary)] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/15" />
            <div className="mb-4 text-sm font-semibold">
              {active.kind === "channel" ? "#" : ""}
              {active.name}
            </div>
            <label className="mb-1 block text-[10px] uppercase tracking-widest text-[var(--text-secondary)]">
              Mind
            </label>
            <select
              value={active.profile_id || ""}
              onChange={(event) => void patchChannel({ profileId: event.target.value || null })}
              className="mb-4 w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm"
              disabled={!canManageActive}
            >
              <option value="">Groovy default</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <label className="mb-1 block text-[10px] uppercase tracking-widest text-[var(--text-secondary)]">
              Orchestrator attention
            </label>
            <select
              value={active.orchestrator_mode}
              onChange={(event) => void patchChannel({ orchestratorMode: event.target.value })}
              className="mb-4 w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm"
              disabled={!canManageActive}
            >
              <option value="mention">@mention only</option>
              <option value="always">always listening</option>
              <option value="off">off — humans only</option>
            </select>
            <div className="flex gap-2">
              {active.kind === "channel" && canManageActive ? (
                <button
                  type="button"
                  onClick={() => {
                    setRoomSheetOpen(false);
                    setAccessOpen(true);
                  }}
                  className="flex-1 rounded-lg border border-[var(--glass-border)] py-2.5 text-sm text-[var(--text-secondary)]"
                >
                  Manage access
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setRoomSheetOpen(false)}
                className="flex-1 rounded-lg border border-cyan-400/30 bg-cyan-400/10 py-2.5 text-sm text-cyan-300"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {accessOpen && active && active.kind === "channel" ? (
        <ChannelAccessModal
          channel={active}
          people={people}
          members={channelMembers.filter(
            (member) => member.channel_id === active.id,
          )}
          onClose={() => setAccessOpen(false)}
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
          onClose={() => setPeopleInviteOpen(false)}
        />
      ) : null}
    </div>
  );
}
