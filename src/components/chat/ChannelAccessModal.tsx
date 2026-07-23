"use client";

import Link from "next/link";
import { useState } from "react";

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

type ChannelMember = {
  id?: string;
  channel_id: string;
  member_type: "user" | "agent" | "orchestrator";
  user_id: string | null;
  agent_id: string | null;
};

export function ChannelAccessModal({
  channel,
  people,
  members,
  onClose,
  onChanged,
}: {
  channel: Channel;
  people: Person[];
  members: ChannelMember[];
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
    setBusy(person.user_id);
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
            <h2 className="text-base font-medium">#{channel.name} access</h2>
            <p className="mt-1 text-xs text-zinc-500">
              Visibility and explicit human membership are enforced by database
              policies, not only by this UI.
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
                label: "Workspace",
                detail: "Admins and full members can discover and open it.",
              },
              {
                id: "private" as const,
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
                <div className="text-sm text-zinc-200">{option.label}</div>
                <div className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                  {option.detail}
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
            <Link
              href={`/settings/team?channel=${encodeURIComponent(channel.id)}`}
              className="text-xs text-cyan-300"
            >
              Invite someone new
            </Link>
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
                    disabled={busy === person.user_id}
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
