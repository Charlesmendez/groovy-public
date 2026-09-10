"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { clearChatWorkspaceCaches } from "@/lib/chat/workspaceCache";
import { clearEmailFeedCache } from "@/lib/email/feedCache";
import { dispatchAppNavigateEvent } from "@/lib/navigation/appNavigationEvent";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

/**
 * Registers the service worker at boot (previously it only existed after the
 * user enabled push notifications, so most sessions had no asset caching) and
 * answers its "groovy-open-url" messages with a client-side navigation, which
 * lets a notification tap reuse the running app instead of reloading it.
 */
export function ServiceWorkerBridge() {
  const router = useRouter();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Dev chunks under /_next/static are not content-hashed, so the SW's
    // cache-first handler would serve stale code on every edit.
    if (process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch(() => undefined);

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type !== "groovy-open-url" || typeof data.url !== "string") {
        return;
      }
      let target: URL;
      try {
        target = new URL(data.url, window.location.origin);
      } catch {
        return;
      }
      if (target.origin !== window.location.origin) return;
      // "https://origin//evil.com" parses as same-origin with pathname
      // "//evil.com", which router.push would treat as protocol-relative.
      if (target.pathname.startsWith("//")) return;
      const href = `${target.pathname}${target.search}${target.hash}`;
      // A query-only change on the current route is delivered purely via the
      // navigate event: pushing it would commit deep-link params to the URL
      // after the screen already consumed and stripped them.
      if (target.pathname !== window.location.pathname) {
        router.push(href);
      }
      dispatchAppNavigateEvent(href);
      event.ports[0]?.postMessage({ ok: true });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);

  useEffect(() => {
    // Cached feeds and conversations must not outlive the session, whichever
    // path ends it (sign-out button, admin revocation, expiry).
    const supabase = getSupabaseBrowserClient();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        clearEmailFeedCache();
        clearChatWorkspaceCaches();
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  return null;
}
