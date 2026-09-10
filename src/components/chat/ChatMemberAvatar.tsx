"use client";

import { useMemo, useState } from "react";
import {
  isPresenceOnline,
  memberHue,
  memberInitials,
  type ChatMemberPresence,
  type ChatMemberProfile,
} from "@/lib/chat/social";

export function ChatMemberAvatar({
  userId,
  name,
  profile,
  presence,
  size = 36,
  showPresence = true,
  className = "",
}: {
  userId: string;
  name: string;
  profile?: ChatMemberProfile | null;
  presence?: ChatMemberPresence | null;
  size?: number;
  showPresence?: boolean;
  className?: string;
}) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const hue = useMemo(() => memberHue(userId || name), [name, userId]);
  const initials = useMemo(() => memberInitials(name), [name]);
  const imageUrl = profile?.has_avatar
    ? `/api/chat/profile/avatar/${encodeURIComponent(userId)}?v=${encodeURIComponent(
        profile.updated_at || "",
      )}`
    : null;
  const online = isPresenceOnline(presence);

  const imageFailed = imageUrl === failedImageUrl;

  return (
    <span
      className={`relative inline-flex shrink-0 ${className}`}
      style={{ width: size, height: size }}
      title={name}
    >
      <span
        className="flex h-full w-full items-center justify-center overflow-hidden rounded-full font-semibold uppercase"
        style={{
          fontSize: Math.max(10, size * 0.32),
          color: `hsl(${hue} 82% 86%)`,
          background: `linear-gradient(145deg, hsl(${hue} 48% 28%), hsl(${
            (hue + 28) % 360
          } 54% 18%))`,
          border: `1px solid hsl(${hue} 62% 52% / .42)`,
          boxShadow: `inset 0 1px 0 hsl(${hue} 80% 90% / .08)`,
        }}
      >
        {imageUrl && !imageFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setFailedImageUrl(imageUrl)}
          />
        ) : (
          initials
        )}
      </span>
      {showPresence ? (
        <span
          className={`absolute bottom-0 right-0 rounded-full border-2 ${
            presence?.availability === "dnd"
              ? "bg-rose-400"
              : online
                ? "bg-emerald-400"
                : "bg-zinc-600"
          }`}
          style={{
            width: Math.max(8, size * 0.27),
            height: Math.max(8, size * 0.27),
            borderColor: "var(--bg-secondary)",
          }}
          aria-label={
            presence?.availability === "dnd"
              ? "Do not disturb"
              : online
                ? "Online"
                : "Offline"
          }
        />
      ) : null}
    </span>
  );
}
