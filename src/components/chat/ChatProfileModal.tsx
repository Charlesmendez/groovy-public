"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, Smile, X } from "lucide-react";
import { ChatMemberAvatar } from "@/components/chat/ChatMemberAvatar";
import type {
  ChatMemberPresence,
  ChatMemberProfile,
} from "@/lib/chat/social";

const STATUS_PRESETS = ["✨", "🎯", "🏡", "🤒", "🌴", "🚫"];

export function ChatProfileModal({
  open,
  profile,
  presence,
  email,
  onClose,
  onChanged,
}: {
  open: boolean;
  profile: ChatMemberProfile;
  presence?: ChatMemberPresence | null;
  email?: string | null;
  onClose: () => void;
  onChanged: (profile: ChatMemberProfile) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [statusEmoji, setStatusEmoji] = useState("");
  const [statusText, setStatusText] = useState("");
  const [statusDuration, setStatusDuration] = useState("today");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setDisplayName(profile.display_name || email?.split("@")[0] || "");
    setStatusEmoji(profile.status_emoji || "");
    setStatusText(profile.status_text || "");
    setStatusDuration(profile.status_expires_at ? "today" : "never");
    setError(null);
  }, [email, open, profile]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let statusExpiresAt: string | null = null;
      const now = new Date();
      if ((statusEmoji || statusText.trim()) && statusDuration !== "never") {
        if (statusDuration === "hour") now.setHours(now.getHours() + 1);
        else if (statusDuration === "week") now.setDate(now.getDate() + 7);
        else {
          now.setHours(23, 59, 59, 999);
        }
        statusExpiresAt = now.toISOString();
      }
      const response = await fetch("/api/chat/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          statusEmoji,
          statusText,
          statusExpiresAt,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not update your profile.");
      }
      onChanged(payload.profile as ChatMemberProfile);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update your profile.",
      );
    } finally {
      setBusy(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("avatar", file);
      const response = await fetch("/api/chat/profile", {
        method: "POST",
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not update your photo.");
      }
      onChanged(payload.profile as ChatMemberProfile);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update your photo.",
      );
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/65 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chat-profile-title"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div className="max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl border border-white/10 bg-[#111317] shadow-2xl sm:max-w-md sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
          <div>
            <h2 id="chat-profile-title" className="font-semibold text-white">
              Your chat profile
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Teammates see this in rooms, DMs, and huddles.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-zinc-400 hover:bg-white/[0.06] hover:text-white"
            aria-label="Close profile"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          <div className="flex items-center gap-4">
            <ChatMemberAvatar
              userId={profile.user_id}
              name={displayName || "You"}
              profile={profile}
              presence={presence}
              size={72}
            />
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadAvatar(file);
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 transition hover:bg-white/[0.08] disabled:opacity-50"
              >
                <Camera className="h-4 w-4" />
                Change photo
              </button>
              <p className="mt-1.5 text-[11px] text-zinc-600">
                JPEG, PNG, WebP, or GIF · 3 MB max
              </p>
            </div>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-300">
              Display name
            </span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={80}
              autoComplete="name"
              className="w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2.5 text-sm text-white outline-none transition focus:border-cyan-300/40"
            />
          </label>

          <div>
            <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300">
              <Smile className="h-3.5 w-3.5" />
              Status
            </span>
            <div className="flex gap-2">
              <input
                value={statusEmoji}
                onChange={(event) => setStatusEmoji(event.target.value.slice(0, 24))}
                maxLength={24}
                aria-label="Status emoji"
                placeholder="✨"
                className="w-14 rounded-xl border border-white/10 bg-black/25 px-2 py-2.5 text-center text-lg outline-none focus:border-cyan-300/40"
              />
              <input
                value={statusText}
                onChange={(event) => setStatusText(event.target.value)}
                maxLength={120}
                placeholder="What are you up to?"
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/25 px-3 py-2.5 text-sm outline-none focus:border-cyan-300/40"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {STATUS_PRESETS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setStatusEmoji(emoji)}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg border text-base transition ${
                    statusEmoji === emoji
                      ? "border-cyan-300/40 bg-cyan-300/10"
                      : "border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.06]"
                  }`}
                >
                  {emoji}
                </button>
              ))}
              {(statusEmoji || statusText) && (
                <button
                  type="button"
                  onClick={() => {
                    setStatusEmoji("");
                    setStatusText("");
                  }}
                  className="rounded-lg px-2 text-xs text-zinc-500 hover:text-white"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {(statusEmoji || statusText.trim()) && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-zinc-300">
                Clear status
              </span>
              <select
                value={statusDuration}
                onChange={(event) => setStatusDuration(event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2.5 text-sm outline-none focus:border-cyan-300/40"
              >
                <option value="hour">In one hour</option>
                <option value="today">At the end of today</option>
                <option value="week">In one week</option>
                <option value="never">Don’t clear automatically</option>
              </select>
            </label>
          )}

          {error ? (
            <p className="rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-200">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-white/[0.07] px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl px-4 py-2 text-sm text-zinc-400 hover:bg-white/[0.05] hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !displayName.trim()}
            className="inline-flex min-w-28 items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-sm font-semibold text-[#071014] transition hover:bg-cyan-200 disabled:opacity-45"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
