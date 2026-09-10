"use client";

import { useEffect } from "react";
import { resumePendingEmailSends } from "@/lib/email/sendQueue";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

const RESUME_INTERVAL_MS = 15_000;

export function EmailSendBridge() {
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let disposed = false;
    let userId = "";

    const resume = () => {
      if (
        disposed ||
        !userId ||
        (document.visibilityState === "hidden" && !navigator.onLine)
      ) {
        return;
      }
      void Promise.allSettled(resumePendingEmailSends(userId));
    };
    const start = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (disposed) return;
      userId = user?.id || "";
      resume();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") resume();
    };
    const interval = window.setInterval(resume, RESUME_INTERVAL_MS);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      userId = session?.user?.id || "";
      resume();
    });
    void start();

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      subscription.unsubscribe();
    };
  }, []);

  return null;
}
