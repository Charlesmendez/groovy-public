"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CustomSelect } from "@/components/ui/CustomSelect";

type WorkspaceMember = {
  user_id: string;
  role: "admin" | "member" | "guest";
  email?: string | null;
};

type Channel = {
  id: string;
  name: string;
  kind: "channel" | "dm";
  visibility: "workspace" | "private";
};

type Invite = {
  id: string;
  email: string;
  role: "member" | "guest";
  expires_at: string;
  channels: Array<{ id: string; name: string }>;
};

export function TeamAccessSettings() {
  const [role, setRole] = useState<"admin" | "member" | "guest" | null>(
    null,
  );
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "guest">("member");
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [workspaceRes, channelsRes] = await Promise.all([
      fetch("/api/workspaces/current", { cache: "no-store" }),
      fetch("/api/chat/channels", { cache: "no-store" }),
    ]);
    const workspacePayload = await workspaceRes.json().catch(() => ({}));
    const channelsPayload = await channelsRes.json().catch(() => ({}));
    if (!workspaceRes.ok) {
      throw new Error(workspacePayload.error || "Could not load workspace");
    }
    if (!channelsRes.ok) {
      throw new Error(channelsPayload.error || "Could not load channels");
    }
    setRole(workspacePayload.workspace?.role || null);
    setMembers(
      Array.isArray(workspacePayload.workspace?.members)
        ? workspacePayload.workspace.members
        : [],
    );
    setChannels(
      (Array.isArray(channelsPayload.channels)
        ? channelsPayload.channels
        : []
      ).filter((channel: Channel) => channel.kind === "channel"),
    );
    if (workspacePayload.workspace?.role === "admin") {
      const invitesRes = await fetch("/api/workspaces/invites", {
        cache: "no-store",
      });
      const invitesPayload = await invitesRes.json().catch(() => ({}));
      if (!invitesRes.ok) {
        throw new Error(invitesPayload.error || "Could not load invitations");
      }
      setInvites(Array.isArray(invitesPayload.invites) ? invitesPayload.invites : []);
    }
  }, []);

  useEffect(() => {
    void load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Could not load access"),
    );
  }, [load]);

  useEffect(() => {
    if (channels.length === 0 || typeof window === "undefined") return;
    const requestedChannel = new URLSearchParams(window.location.search).get(
      "channel",
    );
    if (
      requestedChannel &&
      channels.some((channel) => channel.id === requestedChannel)
    ) {
      setChannelIds((current) =>
        current.includes(requestedChannel)
          ? current
          : [...current, requestedChannel],
      );
    }
  }, [channels]);

  const selectedChannels = useMemo(
    () => channels.filter((channel) => channelIds.includes(channel.id)),
    [channelIds, channels],
  );

  const sendInvite = async () => {
    if (!email.trim()) return;
    if (inviteRole === "guest" && channelIds.length === 0) {
      setError("Choose at least one channel for a channel guest.");
      return;
    }
    setBusy(true);
    setError(null);
    setCreatedUrl(null);
    try {
      const res = await fetch("/api/workspaces/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          role: inviteRole,
          channelIds,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Could not create invitation");
      }
      setCreatedUrl(
        typeof payload.inviteUrl === "string" ? payload.inviteUrl : null,
      );
      setEmail("");
      setChannelIds([]);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create invitation",
      );
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (userId: string) => {
    if (!window.confirm("Remove this person from the workspace and every channel?")) {
      return;
    }
    setBusy(true);
    const res = await fetch("/api/workspaces/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", userId }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) setError(payload.error || "Could not remove member");
    await load().catch(() => undefined);
    setBusy(false);
  };

  const cancelInvite = async (inviteId: string) => {
    setBusy(true);
    const res = await fetch("/api/workspaces/invites", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteId }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) setError(payload.error || "Could not cancel invitation");
    await load().catch(() => undefined);
    setBusy(false);
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="max-w-2xl">
        <h2 className="text-xl font-semibold">People &amp; access</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Full members can use the workspace and its workspace-visible channels.
          Channel guests can only open channels explicitly selected for them.
        </p>
      </div>

      {error ? (
        <div className="mt-5 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {role === "admin" ? (
        <section className="mt-7 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h3 className="text-sm font-medium">Invite someone</h3>
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_220px]">
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="person@company.com"
              type="email"
              className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-cyan-400/40"
            />
            <CustomSelect
              value={inviteRole}
              onChange={(nextValue) =>
                setInviteRole(nextValue === "guest" ? "guest" : "member")
              }
              options={[
                { value: "member", label: "Full workspace member" },
                { value: "guest", label: "Channel guest" },
              ]}
              ariaLabel="Invitation access"
            />
          </div>

          <div className="mt-4">
            <div className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">
              Initial channels
              {inviteRole === "guest" ? " · required" : " · optional"}
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {channels.map((channel) => (
                <label
                  key={channel.id}
                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-zinc-300"
                >
                  <input
                    type="checkbox"
                    checked={channelIds.includes(channel.id)}
                    onChange={() =>
                      setChannelIds((current) =>
                        current.includes(channel.id)
                          ? current.filter((id) => id !== channel.id)
                          : [...current, channel.id],
                      )
                    }
                  />
                  <span className="truncate">#{channel.name}</span>
                  <span className="ml-auto text-[9px] text-zinc-600">
                    {channel.visibility}
                  </span>
                </label>
              ))}
              {channels.length === 0 ? (
                <p className="text-xs text-zinc-600">
                  Create a Chat channel before inviting a channel guest.
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || !email.trim()}
              onClick={() => void sendInvite()}
              className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-200 disabled:opacity-40"
            >
              {busy ? "Working…" : "Send invitation"}
            </button>
            {selectedChannels.length ? (
              <span className="text-xs text-zinc-500">
                Access:{" "}
                {selectedChannels.map((channel) => `#${channel.name}`).join(", ")}
              </span>
            ) : null}
          </div>
          {createdUrl ? (
            <div className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-xs text-emerald-100">
              Invitation created. If email delivery is unavailable, copy this
              link:{" "}
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(createdUrl)}
                className="break-all text-left underline"
              >
                {createdUrl}
              </button>
            </div>
          ) : null}
        </section>
      ) : (
        <div className="mt-7 rounded-xl border border-white/10 p-4 text-sm text-zinc-500">
          Only workspace administrators can invite or remove people.
        </div>
      )}

      <div className="mt-7 grid gap-5 lg:grid-cols-2">
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h3 className="text-sm font-medium">Current people</h3>
          <div className="mt-3 space-y-2">
            {members.map((member) => (
              <div
                key={member.user_id}
                className="flex items-center gap-3 rounded-lg border border-white/10 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-zinc-300">
                    {member.email || member.user_id}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-600">
                    {member.role === "guest"
                      ? "Channel guest"
                      : member.role}
                  </div>
                </div>
                {role === "admin" && member.role !== "admin" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void removeMember(member.user_id)}
                    className="text-xs text-red-300/80"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">Pending invitations</h3>
            <Link href="/chat" className="text-xs text-cyan-300">
              Manage channels
            </Link>
          </div>
          <div className="mt-3 space-y-2">
            {invites.map((invite) => (
              <div
                key={invite.id}
                className="rounded-lg border border-white/10 px-3 py-2"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-zinc-300">
                      {invite.email}
                    </div>
                    <div className="mt-1 text-[10px] text-zinc-600">
                      {invite.role === "guest" ? "Channel guest" : "Full member"}
                      {invite.channels?.length
                        ? ` · ${invite.channels
                            .map((channel) => `#${channel.name}`)
                            .join(", ")}`
                        : ""}
                    </div>
                  </div>
                  {role === "admin" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void cancelInvite(invite.id)}
                      className="text-xs text-red-300/80"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {invites.length === 0 ? (
              <p className="text-xs text-zinc-600">No pending invitations.</p>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
