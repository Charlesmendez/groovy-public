"use client";

import { useEffect, useState } from "react";

export type EditionState = {
  edition: "cloud" | "self-hosted";
  selfHosted: boolean;
  brandName: string;
  loading: boolean;
};

const INITIAL_EDITION: EditionState = {
  edition: "cloud",
  selfHosted: false,
  brandName: "Groovy",
  loading: true,
};

export function useEdition(): EditionState {
  const [state, setState] = useState<EditionState>(INITIAL_EDITION);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config/edition", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as Partial<EditionState>;
      })
      .then((payload) => {
        if (cancelled) return;
        const selfHosted = payload.selfHosted === true;
        setState({
          edition: selfHosted ? "self-hosted" : "cloud",
          selfHosted,
          brandName:
            typeof payload.brandName === "string" && payload.brandName.trim()
              ? payload.brandName.trim()
              : "Groovy",
          loading: false,
        });
      })
      .catch(() => {
        if (!cancelled) setState((current) => ({ ...current, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
