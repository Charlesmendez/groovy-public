"use client";

/**
 * useDesktopAutoPair — inside the Groovy Desktop shell, silently pair the
 * bundled connector with the signed-in Supabase account.
 *
 * Flow:
 *  - Not in the shell → stays 'idle' and does nothing.
 *  - Poll the shell's connector status. If it is already paired to the
 *    current user → 'ready' (polling then stops until retry()/switchAccount()).
 *  - If unpaired → mint a pairing code via POST /api/devices/pairing-code
 *    (cookie auth) and hand it to the shell's pair() → 'ready'.
 *  - If paired to a DIFFERENT user → 'account_mismatch'; switchAccount()
 *    re-pairs with allowAccountSwitch.
 *
 * Only ONE mounted instance runs the pair loop (module-level guard);
 * additional instances passively mirror the connector status. Failures back
 * off exponentially (3s → 6s → 12s → … max 60s) and an unexpired pairing
 * code is reused across retries instead of minting a new one each time.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { getDesktopApi, isDesktopShell } from "@/lib/desktop/shell";

export type DesktopAutoPairState =
  | "idle"
  | "starting"
  | "pairing"
  | "ready"
  | "account_mismatch"
  | "error";

export type DesktopAutoPairResult = {
  state: DesktopAutoPairState;
  error: string | null;
  retry: () => void;
  switchAccount: () => void;
};

const STATUS_POLL_MS = 3000;
const BACKOFF_BASE_MS = 3000;
const BACKOFF_MAX_MS = 60_000;
/** Pairing codes are valid for 10 minutes server-side; reuse for 9. */
const PAIRING_CODE_TTL_MS = 9 * 60_000;

/** Module-level guard: only one hook instance drives the pair loop. */
let activeLoop = false;

/** Module-level pairing-code cache so retries reuse an unexpired code. */
let cachedPairingCode: { code: string; expiresAt: number } | null = null;

async function fetchPairingCode(): Promise<string> {
  if (cachedPairingCode && cachedPairingCode.expiresAt > Date.now()) {
    return cachedPairingCode.code;
  }
  const res = await fetch("/api/devices/pairing-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const json = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
  if (!res.ok || !json?.code) {
    throw new Error(json?.error || `pairing-code request failed (${res.status})`);
  }
  cachedPairingCode = { code: json.code, expiresAt: Date.now() + PAIRING_CODE_TTL_MS };
  return json.code;
}

function clearCachedPairingCode() {
  cachedPairingCode = null;
}

export function useDesktopAutoPair(): DesktopAutoPairResult {
  const [state, setState] = useState<DesktopAutoPairState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pairingRef = useRef(false);

  useEffect(() => {
    if (!isDesktopShell()) return;

    const api = getDesktopApi();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Secondary instances never drive pairing: they stay passive and just
    // mirror the connector status so the UI is still roughly correct.
    if (activeLoop) {
      const mirror = async () => {
        if (cancelled) return;
        try {
          const status = await api.getConnectorStatus();
          if (cancelled) return;
          setState(status.paired ? "ready" : "idle");
        } catch {
          /* stay as-is */
        }
        if (!cancelled) timer = setTimeout(() => void mirror(), STATUS_POLL_MS);
      };
      void mirror();
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    }

    activeLoop = true;
    const supabase = getSupabaseBrowserClient();
    let backoffMs = BACKOFF_BASE_MS;

    const schedule = (delayMs: number) => {
      if (!cancelled) timer = setTimeout(() => void tick(), delayMs);
    };
    const scheduleFailure = () => {
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      schedule(delay);
    };

    /** Returns true when pairing succeeded. */
    const pairNow = async (opts?: { allowAccountSwitch?: boolean }): Promise<boolean> => {
      if (pairingRef.current) return false;
      pairingRef.current = true;
      setState("pairing");
      setError(null);
      try {
        const code = await fetchPairingCode();
        await api.pair(code, opts);
        clearCachedPairingCode();
        if (!cancelled) setState("ready");
        return true;
      } catch (err) {
        if (!cancelled) {
          setState("error");
          setError(err instanceof Error ? err.message : String(err));
        }
        return false;
      } finally {
        pairingRef.current = false;
      }
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (cancelled) return;
        if (!user) {
          // Not signed in yet; keep waiting at the base interval.
          setState((prev) => (prev === "idle" ? "starting" : prev));
          schedule(STATUS_POLL_MS);
          return;
        }

        const status = await api.getConnectorStatus();
        if (cancelled) return;
        if (pairingRef.current) {
          schedule(STATUS_POLL_MS);
          return;
        }

        if (status.paired && status.pairedUserId === user.id) {
          setState("ready");
          setError(null);
          backoffMs = BACKOFF_BASE_MS;
          // Ready: stop polling entirely (retry()/switchAccount() restart it).
          return;
        }
        if (status.paired && status.pairedUserId && status.pairedUserId !== user.id) {
          setState("account_mismatch");
          schedule(STATUS_POLL_MS);
          return;
        }

        const paired = await pairNow();
        if (cancelled) return;
        if (paired) {
          backoffMs = BACKOFF_BASE_MS;
          // Paired: stop polling entirely.
          return;
        }
        scheduleFailure();
      } catch (err) {
        if (cancelled) return;
        setState("error");
        setError(err instanceof Error ? err.message : String(err));
        scheduleFailure();
      }
    };

    setState("starting");
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      activeLoop = false;
    };
    // `attempt` re-runs the whole loop on retry()/switchAccount() failures.
  }, [attempt]);

  const retry = useCallback(() => {
    setError(null);
    setState("starting");
    setAttempt((n) => n + 1);
  }, []);

  const switchAccount = useCallback(() => {
    if (!isDesktopShell()) return;
    const api = getDesktopApi();
    setState("pairing");
    setError(null);
    void (async () => {
      try {
        const code = await fetchPairingCode();
        await api.pair(code, { allowAccountSwitch: true });
        clearCachedPairingCode();
        setState("ready");
      } catch (err) {
        setState("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  return { state, error, retry, switchAccount };
}
