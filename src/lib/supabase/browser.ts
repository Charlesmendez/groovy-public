"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

function parseDocumentCookies(): Array<{ name: string; value: string }> {
  if (typeof document === "undefined") return [];
  const raw = document.cookie || "";
  if (!raw.trim()) return [];
  return raw.split(";").map((part) => {
    const idx = part.indexOf("=");
    const name = (idx >= 0 ? part.slice(0, idx) : part).trim();
    const value = (idx >= 0 ? part.slice(idx + 1) : "").trim();
    return { name, value };
  });
}

function setDocumentCookie(params: {
  name: string;
  value: string;
  options?: {
    path?: string;
    domain?: string;
    maxAge?: number;
    expires?: Date;
    secure?: boolean;
    sameSite?: boolean | "lax" | "strict" | "none";
  };
}) {
  if (typeof document === "undefined") return;
  const { name, value, options } = params;
  const parts: string[] = [];
  parts.push(`${name}=${value}`);
  // IMPORTANT:
  // `document.cookie` defaults Path to the current route (e.g. `/dashboard`),
  // which can create duplicate auth cookies scoped to different paths.
  // That leads to "stale session/state until you clear cookies" across routes/devices.
  // Next's server-side cookie store defaults to `Path=/`, so mirror that here.
  parts.push(`Path=${options?.path || "/"}`);
  if (options?.domain) parts.push(`Domain=${options.domain}`);
  if (typeof options?.maxAge === "number") parts.push(`Max-Age=${options.maxAge}`);
  if (options?.expires instanceof Date) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options?.secure) parts.push("Secure");
  // Supabase may pass sameSite as boolean; interpret `true` as Lax.
  const sameSite =
    typeof options?.sameSite === "string"
      ? options.sameSite
      : options?.sameSite === true
        ? "lax"
        : null;
  if (sameSite) {
    parts.push(`SameSite=${sameSite}`);
  }
  document.cookie = parts.join("; ");
}

export function getSupabaseBrowserClient() {
  if (browserClient) return browserClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY"
    );
  }

  // IMPORTANT: our app uses cookie-based auth (SSR). To make Realtime subscriptions
  // work in the browser under RLS, the browser client must read those same cookies.
  browserClient = createBrowserClient(url, anonKey, {
    cookies: {
      getAll() {
        return parseDocumentCookies();
      },
      setAll(cookiesToSet) {
        for (const c of cookiesToSet) {
          setDocumentCookie({ name: c.name, value: c.value, options: c.options });
        }
      },
    },
  });
  return browserClient;
}

