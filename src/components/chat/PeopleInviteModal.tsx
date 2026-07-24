"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CustomSelect } from "@/components/ui/CustomSelect";

type InviteChannel = {
  id: string;
  name: string;
  visibility: "workspace" | "private";
};

export function PeopleInviteModal({
  channels,
  onClose,
}: {
  channels: InviteChannel[];
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "guest">("member");
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    email: string;
    inviteUrl: string | null;
    emailSent: boolean;
    emailError: string | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const selectedChannels = useMemo(
    () => channels.filter((channel) => channelIds.includes(channel.id)),
    [channelIds, channels],
  );

  const toggleChannel = (channelId: string) => {
    setChannelIds((current) =>
      current.includes(channelId)
        ? current.filter((id) => id !== channelId)
        : [...current, channelId],
    );
    setError(null);
  };

  const sendInvite = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || busy) return;
    if (role === "guest" && channelIds.length === 0) {
      setError("Choose at least one channel for a channel guest.");
      return;
    }

    setBusy(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const res = await fetch("/api/workspaces/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: normalizedEmail,
          role,
          channelIds,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Could not create invitation");
      }
      setResult({
        email: normalizedEmail,
        inviteUrl:
          typeof payload.inviteUrl === "string" ? payload.inviteUrl : null,
        emailSent: payload.emailSent === true,
        emailError:
          typeof payload.emailError === "string" ? payload.emailError : null,
      });
      setEmail("");
      setChannelIds([]);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create invitation",
      );
    } finally {
      setBusy(false);
    }
  };

  const copyInviteLink = async () => {
    if (!result?.inviteUrl) return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopied(true);
    } catch {
      setError("Could not copy the invitation link.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="people-invite-title"
        className="animate-slide-up max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-white/10 bg-[#0c0d11] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:animate-none sm:max-w-xl sm:rounded-2xl sm:pb-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="people-invite-title" className="text-base font-medium">
              Invite a person
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              Full members can use the workspace. Channel guests only see the
              channels you choose.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-2 py-1 text-lg leading-none text-zinc-500 hover:bg-white/5 hover:text-white disabled:opacity-40"
            aria-label="Close invitation"
          >
            ×
          </button>
        </div>

        <form
          className="mt-5"
          onSubmit={(event) => {
            event.preventDefault();
            void sendInvite();
          }}
        >
          <label
            htmlFor="invite-person-email"
            className="mb-1.5 block text-[11px] font-medium uppercase tracking-widest text-zinc-500"
          >
            Email
          </label>
          <input
            ref={emailRef}
            id="invite-person-email"
            type="email"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setError(null);
              setResult(null);
            }}
            placeholder="person@company.com"
            disabled={busy}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm outline-none placeholder:text-zinc-600 focus:border-cyan-400/40"
          />

          <div
            className="mb-1.5 mt-4 block text-[11px] font-medium uppercase tracking-widest text-zinc-500"
          >
            Access
          </div>
          <CustomSelect
            value={role}
            onChange={(nextValue) => {
              setRole(nextValue === "guest" ? "guest" : "member");
              setError(null);
              setResult(null);
            }}
            options={[
              {
                value: "member",
                label: "Full workspace member",
                description: "Workspace settings and visible channels",
              },
              {
                value: "guest",
                label: "Channel guest",
                description: "Only the channels selected below",
              },
            ]}
            ariaLabel="Invitation access"
            disabled={busy}
          />

          <div className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">
                Initial channels
              </div>
              <div className="text-[10px] text-zinc-600">
                {role === "guest" ? "Required" : "Optional"}
              </div>
            </div>
            <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">
              {channels.map((channel) => (
                <label
                  key={channel.id}
                  className="flex items-center gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5"
                >
                  <input
                    type="checkbox"
                    checked={channelIds.includes(channel.id)}
                    onChange={() => toggleChannel(channel.id)}
                    disabled={busy}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">
                    #{channel.name}
                  </span>
                  <span className="text-[9px] uppercase tracking-wider text-zinc-600">
                    {channel.visibility}
                  </span>
                </label>
              ))}
              {channels.length === 0 ? (
                <p className="rounded-lg border border-white/10 p-3 text-xs leading-relaxed text-zinc-600">
                  Create a channel before inviting a channel guest. Full
                  workspace members can still be invited now.
                </p>
              ) : null}
            </div>
            {selectedChannels.length ? (
              <p className="mt-2 text-xs text-zinc-500">
                Access:{" "}
                {selectedChannels
                  .map((channel) => `#${channel.name}`)
                  .join(", ")}
              </p>
            ) : null}
          </div>

          {error ? (
            <div className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-200">
              {error}
            </div>
          ) : null}

          {result ? (
            <div className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-xs leading-relaxed text-emerald-100">
              <div>
                {result.emailSent
                  ? `Invitation sent to ${result.email}.`
                  : `Invitation created for ${result.email}, but email delivery was unavailable.`}
              </div>
              {!result.emailSent && result.emailError ? (
                <div className="mt-1 text-amber-200/80">{result.emailError}</div>
              ) : null}
              {result.inviteUrl ? (
                <button
                  type="button"
                  onClick={() => void copyInviteLink()}
                  className="mt-2 break-all text-left font-medium underline"
                >
                  {copied ? "Copied invitation link" : "Copy invitation link"}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="mt-5 flex justify-end gap-2 border-t border-white/10 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-300 disabled:opacity-40"
            >
              Done
            </button>
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-200 disabled:opacity-40"
            >
              {busy ? "Sending…" : "Send invitation"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
