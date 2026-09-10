"use client";

import { Activity, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";
import { TeamChatClient } from "@/components/chat/TeamChatClient";

// Both workspaces stay mounted so switching tabs preserves their state, but
// shipping both in the entry bundle doubled the JS a cold open must parse
// before anything paints. The one the user did not land on is loaded after
// first paint instead, and stays mounted from then on.
const EmailWorkspace = dynamic(
  () =>
    import("@/components/email/EmailWorkspace").then(
      (mod) => mod.EmailWorkspace,
    ),
  { ssr: false },
);

function chatChannelId(pathname: string): string | undefined {
  const match = pathname.match(/^\/chat\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export function CommunicationWorkspaceShell() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const chatVisible = pathname === "/chat" || pathname.startsWith("/chat/");
  const emailVisible =
    pathname === "/email" || pathname.startsWith("/email/");
  const [emailWarmed, setEmailWarmed] = useState(false);
  // Landing on email mounts it immediately; otherwise it is warmed once the
  // browser is idle and then stays mounted for instant tab switching.
  const emailMounted = emailVisible || emailWarmed;

  useEffect(() => {
    if (emailMounted) return;
    const supportsIdle = typeof window.requestIdleCallback === "function";
    const handle = supportsIdle
      ? window.requestIdleCallback(() => setEmailWarmed(true), {
          timeout: 4_000,
        })
      : window.setTimeout(() => setEmailWarmed(true), 1_200);
    return () => {
      if (supportsIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [emailMounted]);

  return (
    <>
      <Activity mode={chatVisible ? "visible" : "hidden"}>
        <TeamChatClient
          visible={chatVisible}
          initialChannelId={chatChannelId(pathname)}
          initialThreadRootId={searchParams.get("thread") || undefined}
        />
      </Activity>
      {emailMounted ? (
        <Activity mode={emailVisible ? "visible" : "hidden"}>
          <EmailWorkspace visible={emailVisible} />
        </Activity>
      ) : null}
    </>
  );
}
