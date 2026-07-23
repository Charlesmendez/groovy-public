"use client";

/**
 * useOnboardingGate — one-shot /api/user-preferences fetch that gates the
 * harness onboarding overlay and feeds the post-onboarding checklist.
 *
 * Gate semantics: onboarding_completed_at set → onboardingCompleted true →
 * never show onboarding again.
 */

import { useCallback, useEffect, useState } from "react";

export type OnboardingGate = {
  loaded: boolean;
  onboardingCompleted: boolean | null;
  onboardingData: Record<string, unknown>;
  refetch: () => Promise<void>;
};

export function useOnboardingGate(): OnboardingGate {
  const [loaded, setLoaded] = useState(false);
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);
  const [onboardingData, setOnboardingData] = useState<Record<string, unknown>>({});

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/user-preferences", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return;
      setOnboardingCompleted(json?.onboardingCompleted === true);
      setOnboardingData(
        json?.onboardingData && typeof json.onboardingData === "object"
          ? (json.onboardingData as Record<string, unknown>)
          : {}
      );
    } catch {
      // leave gate closed (null) — the dashboard shows nothing extra
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { loaded, onboardingCompleted, onboardingData, refetch };
}
