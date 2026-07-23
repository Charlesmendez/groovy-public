"use client";

/**
 * Worker grid layout state (harness dashboard).
 *
 * v2 layout model: a pane is just a reference to a worker agent. Persisted to
 * localStorage immediately and mirrored to user_preferences.multiAgentLayout
 * (same key the old multi view used; v1 layouts are migrated by keeping
 * code panes and dropping agent/ai_chat panes).
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type WorkerPane = {
  id: string;
  agentId: string;
};

const STORAGE_KEY = "groovy_harness_grid_v2";
const LEGACY_STORAGE_KEY = "groovy_multi_agent_panes";
const SERVER_LAYOUT_KEY = "multiAgentLayout";
const SERVER_LAYOUT_VERSION = 2;

type PersistedLayoutV2 = {
  version: 2;
  panes: WorkerPane[];
  gridCols: number | null; // null = auto
};

function newPaneId() {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function parseLayout(raw: unknown): PersistedLayoutV2 | null {
  if (!raw || typeof raw !== "object") return null;
  const layout = raw as { version?: unknown; panes?: unknown; gridCols?: unknown };
  if (layout.version !== 2 || !Array.isArray(layout.panes)) return null;
  const panes: WorkerPane[] = [];
  for (const pane of layout.panes) {
    const p = pane as { id?: unknown; agentId?: unknown };
    if (typeof p.agentId === "string" && p.agentId) {
      panes.push({ id: typeof p.id === "string" && p.id ? p.id : newPaneId(), agentId: p.agentId });
    }
  }
  const gridCols =
    typeof layout.gridCols === "number" && layout.gridCols >= 1 && layout.gridCols <= 6
      ? Math.trunc(layout.gridCols)
      : null;
  return { version: 2, panes, gridCols };
}

/** Migrate a v1 multi-agent layout: keep code panes (codeAgentId → agentId). */
function migrateV1(raw: unknown): PersistedLayoutV2 | null {
  if (!Array.isArray(raw)) return null;
  const panes: WorkerPane[] = [];
  for (const pane of raw) {
    const p = pane as { kind?: unknown; codeAgentId?: unknown };
    if (p.kind === "code" && typeof p.codeAgentId === "string" && p.codeAgentId) {
      panes.push({ id: newPaneId(), agentId: p.codeAgentId });
    }
  }
  if (panes.length === 0) return null;
  return { version: 2, panes, gridCols: null };
}

export function useWorkerGrid() {
  const [panes, setPanes] = useState<WorkerPane[]>([]);
  const [gridCols, setGridColsState] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);
  // "stored" = a user-authored layout was found (even an intentionally empty
  // one) — callers must not auto-populate over it. "none" = first run.
  const [hydrationSource, setHydrationSource] = useState<"none" | "stored">("none");
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate: v2 localStorage → server layout → v1 migration.
  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      try {
        const local = window.localStorage.getItem(STORAGE_KEY);
        if (local) {
          const parsed = parseLayout(JSON.parse(local));
          if (parsed) {
            if (!cancelled) {
              setPanes(parsed.panes);
              setGridColsState(parsed.gridCols);
              setHydrationSource("stored");
              setHydrated(true);
            }
            return;
          }
        }
      } catch {
        // fall through
      }

      try {
        const res = await fetch("/api/user-preferences", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        const serverLayout = json?.onboardingData?.[SERVER_LAYOUT_KEY];
        const parsed = parseLayout(serverLayout);
        if (parsed && !cancelled) {
          setPanes(parsed.panes);
          setGridColsState(parsed.gridCols);
          setHydrationSource("stored");
          setHydrated(true);
          return;
        }
      } catch {
        // fall through
      }

      try {
        const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) {
          const migrated = migrateV1(JSON.parse(legacy));
          if (migrated && !cancelled) {
            setPanes(migrated.panes);
            setGridColsState(migrated.gridCols);
            setHydrationSource("stored");
            setHydrated(true);
            return;
          }
        }
      } catch {
        // fall through
      }

      if (!cancelled) setHydrated(true);
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist (debounced server mirror; immediate localStorage).
  const persist = useCallback((nextPanes: WorkerPane[], nextGridCols: number | null) => {
    const layout: PersistedLayoutV2 = {
      version: SERVER_LAYOUT_VERSION,
      panes: nextPanes,
      gridCols: nextGridCols,
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // ignore quota errors
    }
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboardingData: { [SERVER_LAYOUT_KEY]: layout } }),
      }).catch(() => {});
    }, 800);
  }, []);

  const update = useCallback(
    (updater: (prev: WorkerPane[]) => WorkerPane[]) => {
      setPanes((prev) => {
        const next = updater(prev);
        persist(next, gridCols);
        return next;
      });
    },
    [persist, gridCols]
  );

  const addPane = useCallback(
    (agentId: string) => {
      update((prev) =>
        prev.some((p) => p.agentId === agentId)
          ? prev
          : [...prev, { id: newPaneId(), agentId }]
      );
    },
    [update]
  );

  const removePane = useCallback(
    (paneId: string) => {
      update((prev) => prev.filter((p) => p.id !== paneId));
    },
    [update]
  );

  const removeAgentPanes = useCallback(
    (agentId: string) => {
      update((prev) => prev.filter((p) => p.agentId !== agentId));
    },
    [update]
  );

  const movePane = useCallback(
    (paneId: string, direction: -1 | 1) => {
      update((prev) => {
        const index = prev.findIndex((p) => p.id === paneId);
        if (index < 0) return prev;
        const target = index + direction;
        if (target < 0 || target >= prev.length) return prev;
        const next = [...prev];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
    },
    [update]
  );

  const setGridCols = useCallback(
    (cols: number | null) => {
      setGridColsState(cols);
      persist(panes, cols);
    },
    [persist, panes]
  );

  return {
    panes,
    hydrated,
    hydrationSource,
    gridCols,
    setGridCols,
    addPane,
    removePane,
    removeAgentPanes,
    movePane,
  };
}
