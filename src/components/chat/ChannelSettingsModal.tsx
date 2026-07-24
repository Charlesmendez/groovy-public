"use client";

import { useEffect, useState } from "react";
import {
  Bell,
  Bot,
  Check,
  FileText,
  Hash,
  Lock,
  MessageSquareText,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import type { ChannelSkillOption } from "@/components/chat/ChannelCreateModal";
import { RoomNotificationPanel } from "@/components/notifications/RoomNotificationControl";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { MAX_CHANNEL_ORCHESTRATOR_INSTRUCTIONS } from "@/lib/chat/channelConfig";
import {
  GUEST_SAFE_MIND_REQUIREMENT,
  isGuestSafeMind,
} from "@/lib/chat/guestMind";

type Channel = {
  id: string;
  name: string;
  topic: string | null;
  visibility: "workspace" | "private";
  profile_id: string | null;
  orchestrator_mode: "mention" | "always" | "off";
  orchestrator_instructions: string | null;
};

type Profile = {
  id: string;
  name: string;
  is_default: boolean;
  surface: string;
  authorization_stance: string;
  memory_scope: string;
  inherit_workspace_skills: boolean;
  inherit_workspace_integrations: boolean;
};

type Person = {
  user_id: string;
  email?: string | null;
  role?: "admin" | "member" | "guest";
};

type Agent = {
  id: string;
  name: string;
  harness: string;
  model: string | null;
  deviceOnline: boolean;
};

type ChannelMember = {
  id?: string;
  channel_id: string;
  member_type: "user" | "agent" | "orchestrator";
  user_id: string | null;
  agent_id: string | null;
};

type SkillAssignment = {
  id: string;
  channel_id: string;
  artifact_id: string;
  created_at?: string;
};

type SettingsSection =
  | "general"
  | "orchestrator"
  | "notifications"
  | "access"
  | "capabilities";

type ChannelDraft = {
  name: string;
  topic: string;
  visibility: "workspace" | "private";
  profileId: string;
  orchestratorMode: "mention" | "always" | "off";
  orchestratorInstructions: string;
};

const SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  shortLabel: string;
  description: string;
  icon: typeof Settings2;
}> = [
  {
    id: "general",
    label: "General",
    shortLabel: "General",
    description: "Identity and visibility",
    icon: Settings2,
  },
  {
    id: "orchestrator",
    label: "Mind & behavior",
    shortLabel: "Mind",
    description: "Prompt and attention",
    icon: MessageSquareText,
  },
  {
    id: "notifications",
    label: "Notifications",
    shortLabel: "Alerts",
    description: "Your personal alerts",
    icon: Bell,
  },
  {
    id: "access",
    label: "People & agents",
    shortLabel: "Access",
    description: "Who can participate",
    icon: Users,
  },
  {
    id: "capabilities",
    label: "Skills & docs",
    shortLabel: "Skills",
    description: "Channel-only context",
    icon: Sparkles,
  },
];

const inputClass =
  "w-full rounded-xl border border-white/10 bg-black/25 px-3.5 py-3 text-sm text-zinc-100 outline-none transition focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/10 placeholder:text-zinc-650 disabled:cursor-not-allowed disabled:opacity-50";

function draftFromChannel(channel: Channel): ChannelDraft {
  return {
    name: channel.name,
    topic: channel.topic || "",
    visibility: channel.visibility,
    profileId: channel.profile_id || "",
    orchestratorMode: channel.orchestrator_mode,
    orchestratorInstructions: channel.orchestrator_instructions || "",
  };
}

function SelectionRow({
  active,
  disabled,
  icon,
  label,
  meta,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
        active
          ? "border-cyan-400/30 bg-cyan-400/[0.07]"
          : "border-white/10 bg-black/15 hover:border-white/20 hover:bg-white/[0.025]"
      } disabled:cursor-not-allowed disabled:opacity-45`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          active
            ? "bg-cyan-400/12 text-cyan-300"
            : "bg-white/[0.04] text-zinc-500"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-zinc-200">{label}</span>
        <span className="block truncate text-[10px] text-zinc-500">{meta}</span>
      </span>
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
          active
            ? "border-cyan-300/60 bg-cyan-300 text-black"
            : "border-white/15"
        }`}
      >
        {active ? <Check className="h-3.5 w-3.5" /> : null}
      </span>
    </button>
  );
}

export function ChannelSettingsModal({
  channel,
  profiles,
  people,
  agents,
  skills,
  members,
  skillAssignments,
  canManage,
  canManageAgents,
  onInviteNew,
  onClose,
  onChanged,
}: {
  channel: Channel;
  profiles: Profile[];
  people: Person[];
  agents: Agent[];
  skills: ChannelSkillOption[];
  members: ChannelMember[];
  skillAssignments: SkillAssignment[];
  canManage: boolean;
  canManageAgents: boolean;
  onInviteNew: () => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const incomingDraftKey = JSON.stringify(draftFromChannel(channel));
  const [section, setSection] = useState<SettingsSection>("general");
  const [baseline, setBaseline] = useState<ChannelDraft>(() =>
    draftFromChannel(channel),
  );
  const [draft, setDraft] = useState<ChannelDraft>(() =>
    draftFromChannel(channel),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    const next = JSON.parse(incomingDraftKey) as ChannelDraft;
    setBaseline(next);
    setDraft(next);
    setError(null);
    setSaved(false);
  }, [channel.id, incomingDraftKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      if (JSON.stringify(draft) !== JSON.stringify(baseline)) {
        setConfirmDiscard(true);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [baseline, busy, draft, onClose]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const hasGuests = people.some(
    (person) =>
      person.role === "guest" &&
      members.some(
        (member) =>
          member.member_type === "user" &&
          member.user_id === person.user_id,
      ),
  );
  const selectedProfile =
    profiles.find((profile) => profile.id === draft.profileId) || null;
  const selectedProfileIsGuestSafe = isGuestSafeMind(selectedProfile);
  const guestMindRequired =
    hasGuests && draft.orchestratorMode !== "off";
  const selectedSkillCount = skillAssignments.length;
  const selectedParticipantCount = members.filter(
    (member) =>
      member.member_type === "user" || member.member_type === "agent",
  ).length;

  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const requestInvite = () => {
    if (dirty) {
      setError("Save or discard your channel changes before opening an invite.");
      return;
    }
    onInviteNew();
  };

  const saveConfiguration = async () => {
    if (!canManage || !draft.name.trim() || busy) return;
    if (guestMindRequired && !selectedProfileIsGuestSafe) {
      setSection("orchestrator");
      setError(
        `${GUEST_SAFE_MIND_REQUIREMENT} Choose a guest-ready Mind or configure the selected Mind first.`,
      );
      return;
    }
    setBusy("configuration");
    setError(null);
    setSaved(false);
    try {
      const patch: Record<string, unknown> = {
        name: draft.name.trim(),
        topic: draft.topic.trim() || null,
        visibility: draft.visibility,
        profileId: draft.profileId || null,
        orchestratorMode: draft.orchestratorMode,
      };
      if (
        draft.orchestratorInstructions.trim() !==
        baseline.orchestratorInstructions.trim()
      ) {
        patch.orchestratorInstructions =
          draft.orchestratorInstructions.trim() || null;
      }
      const res = await fetch(`/api/chat/channels/${channel.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Could not save channel settings.");
      }
      const next = draftFromChannel(payload.channel as Channel);
      setBaseline(next);
      setDraft(next);
      setSaved(true);
      await onChanged();
      window.setTimeout(() => setSaved(false), 2200);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save channel settings.",
      );
    } finally {
      setBusy(null);
    }
  };

  const runImmediateMutation = async (
    busyKey: string,
    request: () => Promise<Response>,
    fallbackError: string,
  ) => {
    setBusy(busyKey);
    setError(null);
    try {
      const res = await request();
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || fallbackError);
      }
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallbackError);
    } finally {
      setBusy(null);
    }
  };

  const togglePerson = async (person: Person) => {
    if (!canManage || busy) return;
    const existing = members.find(
      (member) =>
        member.member_type === "user" && member.user_id === person.user_id,
    );
    if (
      !existing &&
      person.role === "guest" &&
      skillAssignments.length > 0 &&
      !window.confirm(
        `Add this channel guest? ${skillAssignments.length} internal ${
          skillAssignments.length === 1 ? "capability" : "capabilities"
        } will be paused while any guest participates.`,
      )
    ) {
      return;
    }
    await runImmediateMutation(
      `person:${person.user_id}`,
      () =>
        fetch(`/api/chat/channels/${channel.id}/members`, {
          method: existing ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            existing
              ? { memberId: existing.id }
              : { memberType: "user", userId: person.user_id },
          ),
        }),
      "Could not update channel access.",
    );
  };

  const toggleAgent = async (agent: Agent) => {
    if (!canManageAgents || busy) return;
    const existing = members.find(
      (member) =>
        member.member_type === "agent" && member.agent_id === agent.id,
    );
    await runImmediateMutation(
      `agent:${agent.id}`,
      () =>
        fetch(`/api/chat/channels/${channel.id}/members`, {
          method: existing ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            existing
              ? { memberId: existing.id }
              : { memberType: "agent", agentId: agent.id },
          ),
        }),
      "Could not update channel agents.",
    );
  };

  const toggleSkill = async (skill: ChannelSkillOption) => {
    if (!canManage || busy) return;
    const existing = skillAssignments.find(
      (assignment) => assignment.artifact_id === skill.id,
    );
    await runImmediateMutation(
      `skill:${skill.id}`,
      () =>
        fetch(`/api/chat/channels/${channel.id}/skills`, {
          method: existing ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            existing
              ? { assignmentId: existing.id }
              : { artifactId: skill.id },
          ),
        }),
      "Could not update channel capabilities.",
    );
  };

  const sectionMeta = SECTIONS.find((item) => item.id === section)!;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={requestClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-settings-title"
        className="relative flex h-[94dvh] w-full max-w-5xl flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#0b0c10] shadow-2xl sm:h-[min(780px,92dvh)] sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-white/10 px-4 py-4 sm:px-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-400">
            {channel.visibility === "private" ? (
              <Lock className="h-4 w-4" />
            ) : (
              <Hash className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="channel-settings-title"
              className="truncate text-base font-semibold text-white"
            >
              {channel.name}
            </h2>
            <p className="mt-0.5 truncate text-xs text-zinc-500">
              Channel settings · {sectionMeta.description}
            </p>
          </div>
          {!canManage ? (
            <span className="hidden rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-zinc-500 sm:inline-flex">
              View only
            </span>
          ) : null}
          <button
            type="button"
            onClick={requestClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-white"
            aria-label="Close channel settings"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid shrink-0 grid-cols-5 gap-1 border-b border-white/10 bg-black/15 p-2 md:hidden">
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            const active = item.id === section;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={`flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-2 text-[10px] transition ${
                  active
                    ? "bg-white/[0.08] text-white"
                    : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300"
                }`}
                aria-current={active ? "page" : undefined}
              >
                <Icon className="h-4 w-4" />
                <span className="truncate">{item.shortLabel}</span>
              </button>
            );
          })}
        </div>

        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-56 shrink-0 border-r border-white/10 bg-black/10 p-3 md:flex md:flex-col">
            <nav className="space-y-1" aria-label="Channel settings sections">
              {SECTIONS.map((item) => {
                const Icon = item.icon;
                const active = item.id === section;
                const count =
                  item.id === "access"
                    ? selectedParticipantCount
                    : item.id === "capabilities"
                      ? selectedSkillCount
                      : null;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSection(item.id)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                      active
                        ? "bg-white/[0.08] text-white"
                        : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200"
                    }`}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{item.label}</span>
                      <span className="mt-0.5 block truncate text-[9px] text-zinc-600">
                        {item.description}
                      </span>
                    </span>
                    {count !== null ? (
                      <span className="text-[10px] tabular-nums text-zinc-600">
                        {count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </nav>
            <div className="mt-auto rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
              <div className="flex items-center gap-2 text-[10px] font-medium text-zinc-400">
                <ShieldCheck className="h-3.5 w-3.5 text-cyan-300" />
                Channel boundary
              </div>
              <p className="mt-1.5 text-[9px] leading-relaxed text-zinc-600">
                Mind settings add context but never expand profile permissions
                or tool-policy enforcement.
              </p>
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-2xl px-4 py-5 sm:px-7 sm:py-7">
              {error ? (
                <div
                  role="alert"
                  className="mb-5 rounded-xl border border-red-400/25 bg-red-400/[0.08] px-4 py-3 text-xs text-red-200"
                >
                  {error}
                </div>
              ) : null}

              {section === "general" ? (
                <div>
                  <div className="mb-6">
                    <h3 className="text-lg font-semibold">Channel details</h3>
                    <p className="mt-1 text-sm leading-relaxed text-zinc-500">
                      Give the room a clear purpose and choose who can discover
                      it.
                    </p>
                  </div>
                  <label
                    htmlFor="channel-settings-name"
                    className="mb-1.5 block text-[11px] font-medium uppercase tracking-widest text-zinc-500"
                  >
                    Name
                  </label>
                  <input
                    id="channel-settings-name"
                    value={draft.name}
                    maxLength={100}
                    disabled={!canManage}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    className={inputClass}
                  />
                  <label
                    htmlFor="channel-settings-topic"
                    className="mb-1.5 mt-5 block text-[11px] font-medium uppercase tracking-widest text-zinc-500"
                  >
                    Topic
                  </label>
                  <textarea
                    id="channel-settings-topic"
                    value={draft.topic}
                    rows={3}
                    maxLength={500}
                    disabled={!canManage}
                    placeholder="What belongs in this channel?"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        topic: event.target.value,
                      }))
                    }
                    className={`${inputClass} resize-none`}
                  />
                  <div className="mb-2 mt-6 text-[11px] font-medium uppercase tracking-widest text-zinc-500">
                    Visibility
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[
                      {
                        id: "workspace" as const,
                        icon: Users,
                        label: "Workspace",
                        detail: "Full members can discover and open it.",
                      },
                      {
                        id: "private" as const,
                        icon: Lock,
                        label: "Private",
                        detail: "Only admins and explicit members.",
                      },
                    ].map((option) => {
                      const Icon = option.icon;
                      const active = draft.visibility === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          disabled={!canManage}
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              visibility: option.id,
                            }))
                          }
                          className={`rounded-xl border p-3 text-left transition ${
                            active
                              ? "border-cyan-400/35 bg-cyan-400/[0.07]"
                              : "border-white/10 bg-black/15 hover:border-white/20"
                          } disabled:cursor-not-allowed disabled:opacity-50`}
                        >
                          <div className="flex items-start gap-3">
                            <Icon
                              className={`mt-0.5 h-4 w-4 ${
                                active ? "text-cyan-300" : "text-zinc-500"
                              }`}
                            />
                            <span>
                              <span className="block text-sm text-zinc-200">
                                {option.label}
                              </span>
                              <span className="mt-1 block text-[10px] leading-relaxed text-zinc-500">
                                {option.detail}
                              </span>
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {baseline.visibility === "workspace" &&
                  draft.visibility === "private" ? (
                    <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.07] px-3 py-2.5 text-xs leading-relaxed text-amber-100">
                      Saving will immediately remove access for workspace
                      members who were not explicitly added to this channel.
                    </div>
                  ) : null}
                </div>
              ) : null}

              {section === "orchestrator" ? (
                <div>
                  <div className="mb-6">
                    <h3 className="text-lg font-semibold">Mind & behavior</h3>
                    <p className="mt-1 text-sm leading-relaxed text-zinc-500">
                      Choose the channel Mind, when it should answer, and the
                      operating brief it follows here.
                    </p>
                  </div>
                  <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-widest text-zinc-500">
                    Channel Mind
                  </label>
                  <CustomSelect
                    value={draft.profileId}
                    onChange={(profileId) =>
                      setDraft((current) => ({ ...current, profileId }))
                    }
                    options={[
                      {
                        value: "",
                        label: "Groovy default",
                        description: guestMindRequired
                          ? "Unavailable while guests can talk to the Mind"
                          : "Use the workspace’s default Mind.",
                        disabled: guestMindRequired,
                      },
                      ...profiles.map((profile) => ({
                        value: profile.id,
                        label: profile.name,
                        description: isGuestSafeMind(profile)
                          ? "Guest-ready · External · Restricted"
                          : guestMindRequired
                            ? "Internal Mind · configure before using with guests"
                            : profile.is_default
                              ? "Workspace default"
                              : "Workspace Mind",
                        disabled:
                          guestMindRequired && !isGuestSafeMind(profile),
                      })),
                    ]}
                    disabled={!canManage}
                    size="lg"
                    ariaLabel="Channel Mind"
                  />
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-zinc-600">
                      {selectedProfile
                        ? `${selectedProfile.name} supplies the identity, model, memory, and tool policy.`
                        : "The workspace default supplies the identity, model, memory, and tool policy."}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        if (dirty) {
                          setError(
                            "Save or discard your channel changes before leaving this page.",
                          );
                          return;
                        }
                        window.location.href = selectedProfile
                          ? `/settings/minds?profile=${selectedProfile.id}`
                          : "/settings/minds";
                      }}
                      className="text-[11px] text-cyan-300/80 hover:text-cyan-200"
                    >
                      Edit Mind defaults ↗
                    </button>
                  </div>
                  {guestMindRequired && !selectedProfileIsGuestSafe ? (
                    <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.08] p-3">
                      <div className="flex items-start gap-2.5">
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-amber-100">
                            This Mind cannot reply to channel guests yet
                          </p>
                          <p className="mt-1 text-[11px] leading-relaxed text-amber-100/70">
                            {GUEST_SAFE_MIND_REQUIREMENT} In Mind settings,
                            change Audience boundary to External &amp; guests;
                            Groovy will enforce the remaining restrictions. If
                            everyone here is a trusted teammate, make them a
                            workspace Member instead.
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {selectedProfile ? (
                              <button
                                type="button"
                                onClick={() => {
                                  if (dirty) {
                                    setError(
                                      "Save or discard your channel changes before leaving this page.",
                                    );
                                    return;
                                  }
                                  window.location.href = `/settings/minds?profile=${selectedProfile.id}`;
                                }}
                                className="rounded-lg border border-amber-300/20 bg-amber-300/[0.08] px-2.5 py-1.5 text-[11px] font-medium text-amber-100 transition hover:bg-amber-300/[0.12]"
                              >
                                Configure {selectedProfile.name}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => {
                                if (dirty) {
                                  setError(
                                    "Save or discard your channel changes before leaving this page.",
                                  );
                                  return;
                                }
                                window.location.href = "/settings/team";
                              }}
                              className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-zinc-300 transition hover:border-white/20 hover:text-white"
                            >
                              Manage member roles
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="mb-2 mt-6 text-[11px] font-medium uppercase tracking-widest text-zinc-500">
                    Attention
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {[
                      {
                        id: "mention" as const,
                        label: "@mention",
                        detail: "Replies only when summoned.",
                      },
                      {
                        id: "always" as const,
                        label: "Always",
                        detail: "Responds to every message.",
                      },
                      {
                        id: "off" as const,
                        label: "Humans only",
                        detail: "The Mind stays silent.",
                      },
                    ].map((option) => {
                      const active = draft.orchestratorMode === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          disabled={!canManage}
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              orchestratorMode: option.id,
                            }))
                          }
                          className={`rounded-xl border px-3 py-3 text-left transition ${
                            active
                              ? "border-cyan-400/35 bg-cyan-400/[0.07]"
                              : "border-white/10 bg-black/15 hover:border-white/20"
                          } disabled:cursor-not-allowed disabled:opacity-50`}
                        >
                          <span className="block text-sm text-zinc-200">
                            {option.label}
                          </span>
                          <span className="mt-1 block text-[10px] leading-relaxed text-zinc-500">
                            {option.detail}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-6 flex items-end justify-between gap-4">
                    <label
                      htmlFor="channel-orchestrator-instructions"
                      className="block text-[11px] font-medium uppercase tracking-widest text-zinc-500"
                    >
                      Channel instructions
                    </label>
                    <span className="text-[10px] tabular-nums text-zinc-600">
                      {draft.orchestratorInstructions.length.toLocaleString()} /
                      {" "}
                      {MAX_CHANNEL_ORCHESTRATOR_INSTRUCTIONS.toLocaleString()}
                    </span>
                  </div>
                  <textarea
                    id="channel-orchestrator-instructions"
                    value={draft.orchestratorInstructions}
                    rows={10}
                    maxLength={MAX_CHANNEL_ORCHESTRATOR_INSTRUCTIONS}
                    disabled={!canManage}
                    placeholder={`Example: Keep this channel focused on customer launches. Start with a concise status summary, call out blockers, and ask before changing production.`}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        orchestratorInstructions: event.target.value,
                      }))
                    }
                    className={`${inputClass} mt-2 resize-y font-mono text-[13px] leading-relaxed`}
                  />
                  <div className="mt-3 flex gap-2.5 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.04] p-3">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                    <p className="text-[11px] leading-relaxed text-zinc-400">
                      This brief shapes behavior in this channel. It cannot
                      grant tools, override the Mind’s authorization boundary,
                      expose other channels, or widen memory access. Do not put
                      secrets here.
                    </p>
                  </div>
                  {hasGuests ? (
                    <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.07] p-3 text-xs leading-relaxed text-amber-100">
                      Guest channels still require a guest-ready Mind. Channel
                      instructions cannot loosen that audience boundary.
                    </div>
                  ) : null}
                </div>
              ) : null}

              {section === "notifications" ? (
                <RoomNotificationPanel
                  room={{
                    id: channel.id,
                    kind: "channel",
                    name: channel.name,
                  }}
                />
              ) : null}

              {section === "access" ? (
                <div>
                  <div className="mb-6 flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold">People & agents</h3>
                      <p className="mt-1 text-sm leading-relaxed text-zinc-500">
                        Choose who participates and which agents can be
                        mentioned.
                      </p>
                    </div>
                    {canManage ? (
                      <button
                        type="button"
                        onClick={requestInvite}
                        className="shrink-0 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.07] px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-400/10"
                      >
                        Invite
                      </button>
                    ) : null}
                  </div>
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-widest text-zinc-500">
                    People
                  </div>
                  <div className="space-y-2">
                    {people.map((person) => {
                      const included = members.some(
                        (member) =>
                          member.member_type === "user" &&
                          member.user_id === person.user_id,
                      );
                      return (
                        <SelectionRow
                          key={person.user_id}
                          active={included}
                          disabled={
                            !canManage ||
                            busy === `person:${person.user_id}` ||
                            busy !== null
                          }
                          icon={<Users className="h-4 w-4" />}
                          label={person.email || person.user_id}
                          meta={
                            person.role === "guest"
                              ? "Channel guest"
                              : person.role === "admin"
                                ? "Workspace admin"
                                : "Workspace member"
                          }
                          onClick={() => void togglePerson(person)}
                        />
                      );
                    })}
                    {people.length === 0 ? (
                      <p className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-center text-xs text-zinc-600">
                        No other workspace members yet.
                      </p>
                    ) : null}
                  </div>

                  <div className="mb-2 mt-7 text-[11px] font-medium uppercase tracking-widest text-zinc-500">
                    Worker agents
                  </div>
                  <p className="mb-3 text-[11px] leading-relaxed text-zinc-600">
                    This roster belongs to this channel, so the same Mind can
                    work with different agents elsewhere. Only workspace
                    admins can change it; admins can also add an agent from the
                    @ menu.
                  </p>
                  {hasGuests ? (
                    <p className="mb-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-100/75">
                      This channel contains guests. Assigning an agent
                      authorizes it to act on guest messages and return its
                      results here.
                    </p>
                  ) : null}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {agents.map((agent) => {
                      const included = members.some(
                        (member) =>
                          member.member_type === "agent" &&
                          member.agent_id === agent.id,
                      );
                      return (
                        <SelectionRow
                          key={agent.id}
                          active={included}
                          disabled={
                            !canManageAgents ||
                            busy === `agent:${agent.id}` ||
                            busy !== null
                          }
                          icon={<Bot className="h-4 w-4" />}
                          label={agent.name}
                          meta={`${agent.harness}${
                            agent.deviceOnline ? " · online" : " · offline"
                          }`}
                          onClick={() => void toggleAgent(agent)}
                        />
                      );
                    })}
                    {agents.length === 0 ? (
                      <p className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-center text-xs text-zinc-600 sm:col-span-2">
                        No worker agents are configured for this workspace.
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {section === "capabilities" ? (
                <div>
                  <div className="mb-6">
                    <h3 className="text-lg font-semibold">Skills & docs</h3>
                    <p className="mt-1 text-sm leading-relaxed text-zinc-500">
                      Add channel-specific capabilities on top of the selected
                      Mind.
                    </p>
                  </div>
                  {hasGuests ? (
                    <div className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.07] p-3 text-xs leading-relaxed text-amber-100">
                      Internal channel capabilities are paused while a guest
                      participates. Remove all guests before assigning more.
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    {skills.map((skill) => {
                      const included = skillAssignments.some(
                        (assignment) =>
                          assignment.artifact_id === skill.id,
                      );
                      return (
                        <SelectionRow
                          key={skill.id}
                          active={included}
                          disabled={
                            !canManage ||
                            busy === `skill:${skill.id}` ||
                            busy !== null ||
                            (hasGuests && !included)
                          }
                          icon={
                            skill.artifact_type === "skill" ? (
                              <Sparkles className="h-4 w-4" />
                            ) : (
                              <FileText className="h-4 w-4" />
                            )
                          }
                          label={skill.name}
                          meta={
                            skill.description ||
                            (skill.artifact_type === "skill"
                              ? "Skill"
                              : "Instruction document")
                          }
                          onClick={() => void toggleSkill(skill)}
                        />
                      );
                    })}
                    {skills.length === 0 ? (
                      <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs leading-relaxed text-zinc-600">
                        No Team Chat capabilities are available yet. Add skills
                        and instruction documents in Workspace Settings.
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </main>
        </div>

        {canManage &&
        (dirty || section === "general" || section === "orchestrator") ? (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-white/10 bg-[#0b0c10]/95 px-4 py-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] sm:px-5 sm:pb-3">
            <span className="min-w-0 truncate text-xs text-zinc-600">
              {saved
                ? "Changes saved"
                : dirty
                  ? "You have unsaved changes"
                  : "Everything is up to date"}
            </span>
            <button
              type="button"
              onClick={() => void saveConfiguration()}
              disabled={!dirty || !draft.name.trim() || busy !== null}
              className="shrink-0 rounded-xl border border-cyan-300/30 bg-cyan-300 px-4 py-2 text-sm font-medium text-black transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.05] disabled:text-zinc-600"
            >
              {busy === "configuration" ? "Saving…" : "Save changes"}
            </button>
          </footer>
        ) : null}

        {confirmDiscard ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/75 p-5 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#111319] p-5 shadow-2xl">
              <h3 className="text-base font-semibold">Discard your changes?</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-500">
                The channel settings you changed have not been saved.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDiscard(false)}
                  className="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300"
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-red-400/25 bg-red-400/[0.08] px-3 py-2 text-sm text-red-200"
                >
                  Discard
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
