"use client";

import { useState } from "react";
import { Bot, FileText, Lock, Sparkles, Users } from "lucide-react";
import type { ChannelSkillOption } from "@/components/chat/ChannelCreateModal";

type Channel = {
  id: string;
  name: string;
  visibility: "workspace" | "private";
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

export function ChannelAccessModal({
  channel,
  people,
  agents,
  skills,
  members,
  skillAssignments,
  onInviteNew,
  onClose,
  onChanged,
}: {
  channel: Channel;
  people: Person[];
  agents: Agent[];
  skills: ChannelSkillOption[];
  members: ChannelMember[];
  skillAssignments: SkillAssignment[];
  onInviteNew: () => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const patchVisibility = async (visibility: "workspace" | "private") => {
    if (
      visibility === "private" &&
      channel.visibility !== "private" &&
      !window.confirm(
        "Make this channel private? Workspace members without an explicit channel membership will immediately lose access.",
      )
    ) {
      return;
    }
    setBusy("visibility");
    setError(null);
    const res = await fetch(`/api/chat/channels/${channel.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) setError(payload.error || "Could not update visibility");
    else await onChanged();
    setBusy(null);
  };

  const togglePerson = async (person: Person) => {
    const existing = members.find(
      (member) =>
        member.member_type === "user" &&
        member.user_id === person.user_id,
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
    setBusy(`person:${person.user_id}`);
    setError(null);
    const res = await fetch(`/api/chat/channels/${channel.id}/members`, {
      method: existing ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        existing
          ? { memberId: existing.id }
          : { memberType: "user", userId: person.user_id },
      ),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) setError(payload.error || "Could not update channel access");
    else await onChanged();
    setBusy(null);
  };

  const toggleAgent = async (agent: Agent) => {
    const existing = members.find(
      (member) =>
        member.member_type === "agent" && member.agent_id === agent.id,
    );
    setBusy(`agent:${agent.id}`);
    setError(null);
    const res = await fetch(`/api/chat/channels/${channel.id}/members`, {
      method: existing ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        existing
          ? { memberId: existing.id }
          : { memberType: "agent", agentId: agent.id },
      ),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(payload.error || "Could not update channel agents");
    } else {
      await onChanged();
    }
    setBusy(null);
  };

  const toggleSkill = async (skill: ChannelSkillOption) => {
    const existing = skillAssignments.find(
      (assignment) => assignment.artifact_id === skill.id,
    );
    setBusy(`skill:${skill.id}`);
    setError(null);
    const res = await fetch(`/api/chat/channels/${channel.id}/skills`, {
      method: existing ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        existing
          ? { assignmentId: existing.id }
          : { artifactId: skill.id },
      ),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(payload.error || "Could not update channel capabilities");
    } else {
      await onChanged();
    }
    setBusy(null);
  };

  const hasGuests = people.some(
    (person) =>
      person.role === "guest" &&
      members.some(
        (member) =>
          member.member_type === "user" &&
          member.user_id === person.user_id,
      ),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="animate-slide-up max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-white/10 bg-[#0c0d11] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:animate-none sm:max-w-xl sm:rounded-2xl sm:pb-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-base font-medium">
              {channel.visibility === "private" ? (
                <Lock className="h-4 w-4 text-zinc-400" />
              ) : (
                <span className="text-zinc-500">#</span>
              )}
              {channel.name} settings
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Manage who participates and which capabilities are available in
              this room.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-white"
          >
            ×
          </button>
        </div>

        {error ? (
          <div className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-200">
            {error}
          </div>
        ) : null}

        <section className="mt-5">
          <div className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">
            Visibility
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {[
              {
                id: "workspace" as const,
                icon: <Users className="h-4 w-4" />,
                label: "Workspace",
                detail: "Admins and full members can discover and open it.",
              },
              {
                id: "private" as const,
                icon: <Lock className="h-4 w-4" />,
                label: "Private",
                detail: "Only administrators and explicit channel members.",
              },
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={busy === "visibility"}
                onClick={() => void patchVisibility(option.id)}
                className={`rounded-xl border p-3 text-left ${
                  channel.visibility === option.id
                    ? "border-cyan-400/35 bg-cyan-400/10"
                    : "border-white/10 bg-black/20"
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={
                      channel.visibility === option.id
                        ? "text-cyan-300"
                        : "text-zinc-500"
                    }
                  >
                    {option.icon}
                  </span>
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
            ))}
          </div>
        </section>

        <section className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">
                People
              </div>
              <div className="mt-1 text-[10px] text-zinc-600">
                Explicit members retain access when this channel is private.
              </div>
            </div>
            <button
              type="button"
              onClick={onInviteNew}
              className="text-xs text-cyan-300"
            >
              Invite someone new
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {people.map((person) => {
              const included = members.some(
                (member) =>
                  member.member_type === "user" &&
                  member.user_id === person.user_id,
              );
              return (
                <label
                  key={person.user_id}
                  className="flex items-center gap-3 rounded-lg border border-white/10 px-3 py-2"
                >
                  <input
                    type="checkbox"
                    checked={included}
                    disabled={busy === `person:${person.user_id}`}
                    onChange={() => void togglePerson(person)}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">
                    {person.email || person.user_id}
                  </span>
                  <span className="text-[9px] uppercase text-zinc-600">
                    {person.role === "guest" ? "guest" : person.role}
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        <section className="mt-6">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">
              Agents
            </div>
            <div className="mt-1 text-[10px] text-zinc-600">
              Mention an added agent by name to route work to it.
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {agents.map((agent) => {
              const included = members.some(
                (member) =>
                  member.member_type === "agent" &&
                  member.agent_id === agent.id,
              );
              return (
                <label
                  key={agent.id}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                    included
                      ? "border-violet-400/30 bg-violet-400/[0.06]"
                      : "border-white/10"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={included}
                    disabled={busy === `agent:${agent.id}`}
                    onChange={() => void toggleAgent(agent)}
                  />
                  <Bot className="h-4 w-4 shrink-0 text-violet-300" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-300">
                      {agent.name}
                    </span>
                    <span className="block truncate text-[9px] text-zinc-600">
                      {agent.harness}
                      {agent.deviceOnline ? " · online" : " · offline"}
                    </span>
                  </span>
                </label>
              );
            })}
            {agents.length === 0 ? (
              <p className="rounded-lg border border-dashed border-white/10 p-3 text-xs text-zinc-600 sm:col-span-2">
                No worker agents are configured for this workspace.
              </p>
            ) : null}
          </div>
        </section>

        <section className="mt-6">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">
              Capabilities
            </div>
            <div className="mt-1 text-[10px] text-zinc-600">
              Additive skills and instruction documents for this channel.
            </div>
          </div>
          {hasGuests ? (
            <div className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs leading-relaxed text-amber-100">
              Channel capabilities are disabled while a guest participates.
              Remove all guests before assigning internal skills.
            </div>
          ) : null}
          <div className="mt-3 space-y-2">
            {skills.map((skill) => {
              const included = skillAssignments.some(
                (assignment) => assignment.artifact_id === skill.id,
              );
              return (
                <label
                  key={skill.id}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                    included
                      ? "border-cyan-400/30 bg-cyan-400/[0.06]"
                      : "border-white/10"
                  } ${hasGuests ? "opacity-50" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={included}
                    disabled={
                      (hasGuests && !included) ||
                      busy === `skill:${skill.id}`
                    }
                    onChange={() => void toggleSkill(skill)}
                  />
                  {skill.artifact_type === "skill" ? (
                    <Sparkles className="h-4 w-4 shrink-0 text-cyan-300" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-cyan-300" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-300">
                      {skill.name}
                    </span>
                    <span className="block truncate text-[9px] text-zinc-600">
                      {skill.description ||
                        (skill.artifact_type === "skill"
                          ? "Skill"
                          : "Instruction document")}
                    </span>
                  </span>
                </label>
              );
            })}
            {skills.length === 0 ? (
              <p className="rounded-lg border border-dashed border-white/10 p-3 text-xs text-zinc-600">
                No Team Chat capabilities are available. Add them in Settings
                → Skills.
              </p>
            ) : null}
          </div>
        </section>

        <div className="mt-6 flex justify-end border-t border-white/10 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-300"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
