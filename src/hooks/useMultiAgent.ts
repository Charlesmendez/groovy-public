"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  useOrchestrator,
  type OrchestratorMessage,
  type AgentActivity,
  type ToolCall,
  type ConnectorExecuteCallback,
  type BrowserTaskCallback,
  restorePersistedActivities,
} from "./useOrchestrator";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  inferCodeAgentResultModel,
  recordCodeAgentUsageBestEffort,
  type CodeAgentBillingContext,
} from "@/lib/claude/codeAgentUsage";
import { extractDiffs, parseDiffBlock, type ParsedDiff } from "@/components/code/DiffCard";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaneKind = "agent" | "ai_chat" | "code";

export type PaneState = {
  id: string;
  kind: PaneKind;
  sessionId: string | null;
  chatAgentId?: string | null;
  chatAgentName?: string | null;
  codeAgentId?: string | null;
  codeAgentName?: string | null;
  messages: OrchestratorMessage[];
  isStreaming: boolean;
  streamingContent: string;
  agentActivities: AgentActivity[];
  currentToolCalls: ToolCall[];
  error: string | null;
  isLoadingMessages: boolean;
};

export type HandshakeState = {
  handshakeId: string;
  partnerPaneId: string;
  partnerSessionId: string;
  partnerName: string;
  status: "active" | "collaborating" | "waiting" | "closed";
  statusDetail?: string | null;
  createdAt: string;
};

export type ViewMode = "single" | "multi";

export type AddPaneOptions = {
  sessionId?: string | null;
  kind?: PaneKind;
  chatAgentId?: string | null;
  chatAgentName?: string | null;
  codeAgentId?: string | null;
  codeAgentName?: string | null;
};

type PersistedPane = {
  id: string;
  sessionId: string | null;
  kind: PaneKind;
  chatAgentId: string | null;
  chatAgentName: string | null;
  codeAgentId: string | null;
  codeAgentName: string | null;
};

const STORAGE_KEY = "groovy_multi_agent_panes";
const VIEW_MODE_KEY = "groovy_agent_view_mode";
const GRID_COLS_KEY = "groovy_agent_grid_cols";
const SERVER_LAYOUT_VERSION = 1;
const SERVER_LAYOUT_KEY = "multiAgentLayout";
const AUTO_HANDSHAKE_TRACE_TTL_MS = 5 * 60_000;
const AUTO_HANDSHAKE_WINDOW_MS = 120_000;
const AUTO_HANDSHAKE_MAX_PER_WINDOW = 8;
const AUTO_HANDSHAKE_STREAM_WAIT_MAX_MS = 45_000;
const AUTO_HANDSHAKE_RETRY_MAX_MS = 2 * 60_000;
const AUTO_HANDSHAKE_JOB_TIMEOUT_MS = 3 * 60_000;
const AUTO_HANDSHAKE_CODE_CONNECTOR_TIMEOUT_MS = 3 * 60_000;
const AUTO_HANDSHAKE_CODE_JOB_TIMEOUT_MS = AUTO_HANDSHAKE_CODE_CONNECTOR_TIMEOUT_MS + 10_000;

function newPaneId() {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function paneLabelForHandshake(pane: Pick<PaneState, "kind" | "chatAgentName" | "codeAgentName">): string {
  if (pane.kind === "code") {
    return pane.codeAgentName?.trim() || "Code Agent";
  }
  if (pane.kind === "ai_chat") {
    return pane.chatAgentName?.trim() || "AI Chat Agent";
  }
  return "Agent";
}

function handshakeSessionTitleForPane(pane: Pick<PaneState, "kind" | "chatAgentName" | "codeAgentName">): string {
  return `${paneLabelForHandshake(pane)} Session`;
}

function buildCodeHandshakePrompt(params: {
  message: string;
  selfName: string;
  partnerName: string;
  incoming: boolean;
}): string {
  const selfName = params.selfName.trim() || "this Code agent";
  const partnerName = params.partnerName.trim() || "the connected partner agent";
  const contextLines = params.incoming
    ? [
        `This prompt was sent to you by "${partnerName}" through the active Groovy multi-view handshake.`,
        `Treat the message below as delegated user work for "${selfName}" and execute it in your configured workspace now.`,
        "For coding tasks, inspect the repository, edit the needed files, and run focused verification when practical.",
        `Respond as "${selfName}" with the concrete result. Your response will be delivered back to "${partnerName}" through the handshake channel.`,
      ]
    : [
        `You are connected to "${partnerName}" through the active Groovy multi-view handshake.`,
        `If the user asks you to collaborate with "${partnerName}", prepare a partner-ready handoff that includes the actual task, constraints, and expected outcome.`,
      ];

  return [
    "[GROOVY HANDSHAKE CONTEXT]",
    `You are currently acting as "${selfName}".`,
    `Your connected partner agent is "${partnerName}".`,
    ...contextLines,
    `Identity rules: "${partnerName}" is your partner, not your identity. Do not claim to be "${partnerName}".`,
    "[END GROOVY HANDSHAKE CONTEXT]",
    "",
    params.message,
  ].join("\n");
}

function stringifyCodeRunResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "undefined") return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseCodeRunDiffs(rawDiffs: unknown): ParsedDiff[] {
  if (!Array.isArray(rawDiffs)) return [];

  return rawDiffs
    .map((diff) => {
      if (diff && typeof diff === "object" && !Array.isArray(diff)) {
        const row = diff as Partial<ParsedDiff>;
        if (typeof row.content === "string" && row.content.trim()) {
          const parsed = parseDiffBlock(row.content);
          return {
            filename:
              typeof row.filename === "string" && row.filename.trim()
                ? row.filename
                : parsed.filename,
            content: row.content,
            additions: typeof row.additions === "number" ? row.additions : parsed.additions,
            deletions: typeof row.deletions === "number" ? row.deletions : parsed.deletions,
          } satisfies ParsedDiff;
        }
      }
      const content = typeof diff === "string" ? diff.trim() : "";
      return content ? parseDiffBlock(content) : null;
    })
    .filter((diff): diff is ParsedDiff => !!diff);
}

function buildCodeRunDisplayMessage(codeResult: { result?: unknown; error?: unknown; diffs?: unknown }) {
  const rawResult = stringifyCodeRunResult(codeResult.result).trim();
  const errorText =
    typeof codeResult.error === "string" && codeResult.error.trim()
      ? codeResult.error.trim()
      : "";
  const rawDiffs = parseCodeRunDiffs(codeResult.diffs);
  const composedContent = errorText
    ? rawResult
      ? `${rawResult}\n\nError: ${errorText}`
      : `Error: ${errorText}`
    : rawResult || (rawDiffs.length > 0 ? "Completed. See file changes below." : "Completed.");
  const { cleanContent, diffs: textDiffs } = extractDiffs(composedContent);

  return {
    content: cleanContent || composedContent,
    diffs: rawDiffs.length > 0 ? rawDiffs : textDiffs,
  };
}

function removeHandshakeForPane(
  map: Map<string, HandshakeState>,
  paneId: string
): Map<string, HandshakeState> {
  const current = map.get(paneId);
  if (!current) return map;
  const next = new Map(map);
  next.delete(paneId);
  const partner = next.get(current.partnerPaneId);
  if (partner && partner.handshakeId === current.handshakeId) {
    next.delete(current.partnerPaneId);
  }
  return next;
}

function isPaneKind(value: unknown): value is PaneKind {
  return value === "agent" || value === "ai_chat" || value === "code";
}

function normalizeGridCols(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(7, Math.floor(n)));
}

function parsePersistedPanes(input: unknown): PersistedPane[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  return input
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      if (typeof row.id !== "string" || row.id.length === 0) return null;
      return {
        id: row.id,
        sessionId: typeof row.sessionId === "string" ? row.sessionId : null,
        kind: isPaneKind(row.kind) ? row.kind : "agent",
        chatAgentId: typeof row.chatAgentId === "string" ? row.chatAgentId : null,
        chatAgentName: typeof row.chatAgentName === "string" ? row.chatAgentName : null,
        codeAgentId: typeof row.codeAgentId === "string" ? row.codeAgentId : null,
        codeAgentName: typeof row.codeAgentName === "string" ? row.codeAgentName : null,
      } satisfies PersistedPane;
    })
    .filter((row): row is PersistedPane => !!row);
}

function serializeLayoutSnapshot(params: {
  panes: PersistedPane[];
  viewMode: ViewMode;
  gridCols: number;
}) {
  return JSON.stringify({
    version: SERVER_LAYOUT_VERSION,
    panes: params.panes,
    viewMode: params.viewMode,
    gridCols: params.gridCols,
  });
}

function parseServerLayout(raw: unknown): {
  panes: PersistedPane[];
  viewMode: ViewMode;
  gridCols: number;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const hasRecognizedShape =
    obj.version === SERVER_LAYOUT_VERSION ||
    Array.isArray(obj.panes) ||
    obj.viewMode === "single" ||
    obj.viewMode === "multi" ||
    typeof obj.gridCols !== "undefined";
  if (!hasRecognizedShape) return null;
  return {
    panes: parsePersistedPanes(obj.panes),
    viewMode: obj.viewMode === "multi" ? "multi" : "single",
    gridCols: normalizeGridCols(obj.gridCols),
  };
}

function loadPersistedPanes(): PersistedPane[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsePersistedPanes(parsed);
    }
  } catch {
    // ignore
  }
  return [];
}

function persistPanes(panes: PersistedPane[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(panes));
  } catch {
    // ignore
  }
}

function loadViewMode(): ViewMode {
  if (typeof window === "undefined") return "single";
  try {
    const raw = localStorage.getItem(VIEW_MODE_KEY);
    if (raw === "multi") return "multi";
  } catch {
    // ignore
  }
  return "single";
}

function persistViewMode(mode: ViewMode) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // ignore
  }
}

function loadGridCols(): number {
  if (typeof window === "undefined") return 3;
  try {
    const raw = localStorage.getItem(GRID_COLS_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (n >= 1 && n <= 7) return n;
    }
  } catch {
    // ignore
  }
  return 3;
}

function persistGridCols(cols: number) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(GRID_COLS_KEY, String(cols));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type UseMultiAgentOptions = {
  onConnectorExecute?: ConnectorExecuteCallback;
  onBrowserTask?: BrowserTaskCallback;
  onOpenCodeSession?: (agentId: string, name?: string) => void;
};

export function useMultiAgent(options?: UseMultiAgentOptions) {
  const connectorExecute = options?.onConnectorExecute;
  // Primary orchestrator: owns session list, realtime subs, and acts as the
  // "single view" orchestrator when viewMode === "single".
  const orchestrator = useOrchestrator({
    onConnectorExecute: options?.onConnectorExecute,
    onBrowserTask: options?.onBrowserTask,
    onOpenCodeSession: options?.onOpenCodeSession,
  });

  // Load persisted handshake turn limit from user preferences (best-effort).
  const handshakeMaxTurnsRef = useRef(AUTO_HANDSHAKE_MAX_PER_WINDOW);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/user-preferences", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        const v = json?.onboardingData?.handshakeMaxTurnsPerWindow;
        if (typeof v === "number" && Number.isFinite(v) && v >= 2) {
          handshakeMaxTurnsRef.current = Math.max(2, Math.min(20, Math.trunc(v)));
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // View mode
  const [viewMode, setViewModeState] = useState<ViewMode>(() => loadViewMode());
  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeState(mode);
    persistViewMode(mode);
  }, []);

  // Grid columns (1-7)
  const [gridCols, setGridColsState] = useState<number>(() => loadGridCols());
  const setGridCols = useCallback((cols: number) => {
    const clamped = Math.max(1, Math.min(7, cols));
    setGridColsState(clamped);
    persistGridCols(clamped);
  }, []);

  // Pane layout (for multi mode)
  const [panes, setPanesState] = useState<PaneState[]>([]);
  const panesInitialized = useRef(false);
  const initialSavedPaneCountRef = useRef<number | null>(null);
  const autoBootstrappedPaneRef = useRef(false);
  const [serverPrefsLoaded, setServerPrefsLoaded] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastServerSyncedLayoutRef = useRef<string>("");

  // Per-pane message cache: Map<sessionId, { messages, activities }>
  const paneCacheRef = useRef<Map<string, {
    messages: OrchestratorMessage[];
    agentActivities: AgentActivity[];
  }>>(new Map());
  // One-time hydration attempts per persisted pane-session pair after reload.
  const hydrationAttemptedRef = useRef<Set<string>>(new Set());

  // In-flight sessions: prevents double-sending to same session
  const inflightRef = useRef<Set<string>>(new Set());
  const paneSessionMapRef = useRef<Map<string, string[]>>(new Map());
  const sessionTitleByIdRef = useRef<Map<string, string>>(new Map());
  const paneReloadTimersRef = useRef<Map<string, number>>(new Map());
  const deferredSessionReloadsRef = useRef<Set<string>>(new Set());
  const autoHandledHandshakeTraceRef = useRef<Map<string, number>>(new Map());
  const autoHandshakeBudgetRef = useRef<Map<string, { windowStartMs: number; count: number }>>(new Map());
  const pendingAutoHandshakeRunsRef = useRef<
    Array<{
      sessionId: string;
      traceId: string;
      handshakeId: string;
      fromSessionId: string;
      toSessionId: string;
      content: string;
      enqueuedAtMs: number;
      attempts: number;
    }>
  >([]);
  // Tracks jobs currently being processed by the auto-handshake worker.
  // Queue length alone is not enough because jobs are shifted before execution.
  const inFlightAutoHandshakeRunsRef = useRef<Set<string>>(new Set());
  const autoHandshakeWorkerRunningRef = useRef(false);
  const [autoHandshakeTick, setAutoHandshakeTick] = useState(0);
  // Handshake map (paneId -> handshake metadata)
  const [handshakes, setHandshakes] = useState<Map<string, HandshakeState>>(new Map());

  const resolveHandshakePaneId = useCallback(
    (sessionId: string, handshakeId?: string, fromSessionId?: string): string | null => {
      const paneIds = paneSessionMapRef.current.get(sessionId) || [];
      if (paneIds.length === 0) return null;
      if (handshakeId) {
        const exact = paneIds.find((id) => {
          const hs = handshakes.get(id);
          if (!hs) return false;
          if (hs.handshakeId !== handshakeId) return false;
          if (fromSessionId && hs.partnerSessionId !== fromSessionId) return false;
          return true;
        });
        if (exact) return exact;
        // When direction is known, never fall back to a looser match.
        // Loose matching can route auto-handshake work to the wrong pane.
        if (fromSessionId) return null;
        const byHandshakeOnly = paneIds.find((id) => {
          const hs = handshakes.get(id);
          return !!hs && hs.handshakeId === handshakeId;
        });
        if (byHandshakeOnly) return byHandshakeOnly;
      }
      const anyHandshakePane = paneIds.find((id) => {
        const hs = handshakes.get(id);
        if (!hs) return false;
        if (fromSessionId) {
          return hs.partnerSessionId === fromSessionId;
        }
        return true;
      });
      if (anyHandshakePane) return anyHandshakePane;
      return fromSessionId ? null : paneIds[0] || null;
    },
    [handshakes]
  );

  const setHandshakePairStatus = useCallback(
    (
      paneId: string,
      selfStatus: HandshakeState["status"],
      partnerStatus: HandshakeState["status"],
      selfDetail?: string | null,
      partnerDetail?: string | null
    ) => {
      const current = handshakes.get(paneId);
      if (!current) return;
      const partner = handshakes.get(current.partnerPaneId);
      if (!partner || partner.handshakeId !== current.handshakeId) return;
      const selfBusy = selfStatus === "waiting" || selfStatus === "collaborating";
      const partnerBusy = partnerStatus === "waiting" || partnerStatus === "collaborating";
      const partnerPaneId = current.partnerPaneId;
      setHandshakes((prev) => {
        const nextCurrent = prev.get(paneId);
        if (!nextCurrent) return prev;
        const nextPartner = prev.get(nextCurrent.partnerPaneId);
        if (!nextPartner || nextPartner.handshakeId !== nextCurrent.handshakeId) return prev;

        const next = new Map(prev);
        next.set(paneId, {
          ...nextCurrent,
          status: selfStatus,
          statusDetail:
            typeof selfDetail === "undefined" ? nextCurrent.statusDetail : selfDetail,
        });
        next.set(nextCurrent.partnerPaneId, {
          ...nextPartner,
          status: partnerStatus,
          statusDetail:
            typeof partnerDetail === "undefined" ? nextPartner.statusDetail : partnerDetail,
        });
        return next;
      });

      // Keep pane loaders aligned with handshake status, even when the pane is not
      // the currently selected orchestrator session.
      setPanesState((prev) =>
        prev.map((p) => {
          if (p.id === paneId) {
            return {
              ...p,
              isStreaming: selfBusy,
              streamingContent: "",
            };
          }
          if (p.id === partnerPaneId) {
            return {
              ...p,
              isStreaming: partnerBusy,
              streamingContent: "",
            };
          }
          return p;
        })
      );
    },
    [handshakes]
  );

  const enqueueAutoHandshakeJob = useCallback(
    (input: {
      toSessionId: string;
      traceId: string;
      handshakeId: string;
      fromSessionId: string;
      content: string;
    }) => {
      const sid = input.toSessionId.trim();
      const traceId = input.traceId.trim();
      const handshakeId = input.handshakeId.trim();
      const fromSessionId = input.fromSessionId.trim();
      const content = input.content.trim();
      if (!sid || !traceId || !handshakeId || !content) return false;

      const nowMs = Date.now();
      for (const [id, ts] of autoHandledHandshakeTraceRef.current.entries()) {
        if (nowMs - ts > AUTO_HANDSHAKE_TRACE_TTL_MS) {
          autoHandledHandshakeTraceRef.current.delete(id);
        }
      }

      if (autoHandledHandshakeTraceRef.current.has(traceId)) return false;
      autoHandledHandshakeTraceRef.current.set(traceId, nowMs);

      const budgetKey = `${sid}:${handshakeId}`;
      const currentBudget = autoHandshakeBudgetRef.current.get(budgetKey);
      if (
        currentBudget &&
        nowMs - currentBudget.windowStartMs <= AUTO_HANDSHAKE_WINDOW_MS &&
        currentBudget.count >= handshakeMaxTurnsRef.current
      ) {
        return false;
      }

      const nextBudget =
        !currentBudget ||
        nowMs - currentBudget.windowStartMs > AUTO_HANDSHAKE_WINDOW_MS
          ? { windowStartMs: nowMs, count: 1 }
          : {
              windowStartMs: currentBudget.windowStartMs,
              count: currentBudget.count + 1,
            };
      autoHandshakeBudgetRef.current.set(budgetKey, nextBudget);
      pendingAutoHandshakeRunsRef.current.push({
        sessionId: sid,
        traceId,
        handshakeId,
        fromSessionId,
        toSessionId: sid,
        content,
        enqueuedAtMs: nowMs,
        attempts: 0,
      });
      const paneId = resolveHandshakePaneId(sid, handshakeId, fromSessionId);
      if (paneId) {
        setHandshakePairStatus(
          paneId,
          "waiting",
          "waiting",
          "Handshake message received. Queued for auto-reply...",
          "Waiting for partner auto-reply..."
        );
      }
      setAutoHandshakeTick((v) => v + 1);
      return true;
    },
    [resolveHandshakePaneId, setHandshakePairStatus]
  );

  const createPaneState = useCallback((id: string, options?: AddPaneOptions): PaneState => {
    const kind = options?.kind || "agent";
    const sessionId = kind === "code" ? null : options?.sessionId ?? null;
    return {
      id,
      kind,
      sessionId,
      chatAgentId: options?.chatAgentId ?? null,
      chatAgentName: options?.chatAgentName ?? null,
      codeAgentId: options?.codeAgentId ?? null,
      codeAgentName: options?.codeAgentName ?? null,
      messages: [],
      isStreaming: false,
      streamingContent: "",
      agentActivities: [],
      currentToolCalls: [],
      error: null,
      isLoadingMessages: false,
    };
  }, []);

  const toPersistedPanes = useCallback((rows: PaneState[]): PersistedPane[] => {
    return rows.map((p) => ({
      id: p.id,
      sessionId: p.sessionId,
      kind: p.kind,
      chatAgentId: p.chatAgentId || null,
      chatAgentName: p.chatAgentName || null,
      codeAgentId: p.codeAgentId || null,
      codeAgentName: p.codeAgentName || null,
    }));
  }, []);

  // Initialize panes from localStorage (once)
  useEffect(() => {
    if (panesInitialized.current) return;
    panesInitialized.current = true;
    const saved = loadPersistedPanes();
    initialSavedPaneCountRef.current = saved.length;
    if (saved.length > 0) {
      setPanesState(
        saved.map((s) =>
          createPaneState(s.id, {
            sessionId: s.sessionId,
            kind: s.kind,
            chatAgentId: s.chatAgentId,
            chatAgentName: s.chatAgentName,
            codeAgentId: s.codeAgentId,
            codeAgentName: s.codeAgentName,
          })
        )
      );
    }
  }, [createPaneState]);

  // Hydrate layout from server so pane layout is shared across domains/devices.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/user-preferences", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as
          | { onboardingData?: Record<string, unknown> }
          | null;
        const onboardingData =
          json && json.onboardingData && typeof json.onboardingData === "object"
            ? json.onboardingData
            : null;
        const layoutRaw = onboardingData ? onboardingData[SERVER_LAYOUT_KEY] : null;
        const layout = parseServerLayout(layoutRaw);
        if (!layout || cancelled) return;

        // If server has no panes but local already has panes, keep local and sync up.
        const localPaneCount = initialSavedPaneCountRef.current || 0;
        if (layout.panes.length > 0 || localPaneCount === 0) {
          setPanesState(
            layout.panes.map((p) =>
              createPaneState(p.id, {
                sessionId: p.sessionId,
                kind: p.kind,
                chatAgentId: p.chatAgentId,
                chatAgentName: p.chatAgentName,
                codeAgentId: p.codeAgentId,
                codeAgentName: p.codeAgentName,
              })
            )
          );
          initialSavedPaneCountRef.current = layout.panes.length;
        }
        setViewModeState(layout.viewMode);
        setGridColsState(layout.gridCols);
        persistViewMode(layout.viewMode);
        persistGridCols(layout.gridCols);
        lastServerSyncedLayoutRef.current = serializeLayoutSnapshot({
          panes: layout.panes,
          viewMode: layout.viewMode,
          gridCols: layout.gridCols,
        });
      } catch {
        // ignore; localStorage fallback stays active
      } finally {
        if (!cancelled) setServerPrefsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [createPaneState]);

  // Fresh browser storage (common in production domains) can have viewMode=multi
  // but no persisted panes yet, which makes the grid look empty. Bootstrap once.
  useEffect(() => {
    if (autoBootstrappedPaneRef.current) return;
    if (!panesInitialized.current) return;
    if (initialSavedPaneCountRef.current === null) return;
    if (initialSavedPaneCountRef.current > 0) {
      autoBootstrappedPaneRef.current = true;
      return;
    }
    if (viewMode !== "multi") return;
    if (panes.length > 0) {
      autoBootstrappedPaneRef.current = true;
      return;
    }
    autoBootstrappedPaneRef.current = true;
    const initialSessionId = orchestrator.currentSessionId || null;
    const paneId = newPaneId();
    setPanesState([createPaneState(paneId, { kind: "agent", sessionId: initialSessionId })]);
  }, [viewMode, panes.length, orchestrator.currentSessionId, createPaneState]);

  // Persist pane layout when it changes
  useEffect(() => {
    if (!panesInitialized.current) return;
    persistPanes(toPersistedPanes(panes));
  }, [panes, toPersistedPanes]);

  // Persist pane layout to server (debounced, layout-only diffing).
  useEffect(() => {
    if (!panesInitialized.current || !serverPrefsLoaded) return;
    const paneLayout = toPersistedPanes(panes);
    const snapshot = serializeLayoutSnapshot({ panes: paneLayout, viewMode, gridCols });
    if (snapshot === lastServerSyncedLayoutRef.current) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const response = await fetch("/api/user-preferences", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            onboardingData: {
              [SERVER_LAYOUT_KEY]: {
                version: SERVER_LAYOUT_VERSION,
                panes: paneLayout,
                viewMode,
                gridCols,
                updatedAt: new Date().toISOString(),
              },
            },
          }),
        });
        if (response.ok) {
          lastServerSyncedLayoutRef.current = snapshot;
        }
      } catch {
        // ignore transient failures; next layout change retries
      }
    }, 500);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [panes, viewMode, gridCols, serverPrefsLoaded, toPersistedPanes]);

  // Load messages for a pane when its sessionId changes
  const loadPaneMessages = useCallback(async (paneId: string, sessionId: string) => {
    setPanesState((prev) =>
      prev.map((p) =>
        p.id === paneId ? { ...p, isLoadingMessages: true, error: null } : p
      )
    );
    try {
      const res = await fetch(`/api/orchestrator/agents/${sessionId}?ts=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const msgs: OrchestratorMessage[] = (data.messages || []).map(
        (m: { id: string; role: string; content: string; created_at: string; metadata?: unknown }) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: new Date(m.created_at),
          metadata: m.metadata as OrchestratorMessage["metadata"],
        })
      );

      // Build activities from loaded data if available
      const activities: AgentActivity[] = restorePersistedActivities(
        data.activities || [],
        { sessionId: sessionId || undefined }
      );

      paneCacheRef.current.set(sessionId, { messages: msgs, agentActivities: activities });

      setPanesState((prev) =>
        prev.map((p) =>
          p.id === paneId && p.sessionId === sessionId
            ? { ...p, messages: msgs, agentActivities: activities, isLoadingMessages: false }
            : p
        )
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Failed to load";
      setPanesState((prev) =>
        prev.map((p) =>
          p.id === paneId ? { ...p, error: errMsg, isLoadingMessages: false } : p
        )
      );
    }
  }, []);

  // Hydrate persisted pane sessions on reload so users don't have to reselect manually.
  useEffect(() => {
    if (!panesInitialized.current || panes.length === 0) return;
    for (const pane of panes) {
      if (!pane.sessionId) continue;
      // Already has content (or is currently loading) => nothing to hydrate.
      if (pane.messages.length > 0 || pane.agentActivities.length > 0 || pane.isLoadingMessages) continue;

      const key = `${pane.id}:${pane.sessionId}`;
      if (hydrationAttemptedRef.current.has(key)) continue;
      hydrationAttemptedRef.current.add(key);

      const cached = paneCacheRef.current.get(pane.sessionId);
      if (cached) {
        setPanesState((prev) =>
          prev.map((p) =>
            p.id === pane.id && p.sessionId === pane.sessionId
              ? { ...p, messages: cached.messages, agentActivities: cached.agentActivities }
              : p
          )
        );
        continue;
      }

      void loadPaneMessages(pane.id, pane.sessionId);
    }
  }, [panes, loadPaneMessages]);

  // Keep a live map of sessionId -> paneIds for realtime refresh targeting.
  useEffect(() => {
    const next = new Map<string, string[]>();
    for (const pane of panes) {
      if (!pane.sessionId) continue;
      const existing = next.get(pane.sessionId);
      if (existing) {
        existing.push(pane.id);
      } else {
        next.set(pane.sessionId, [pane.id]);
      }
    }
    paneSessionMapRef.current = next;
  }, [panes]);

  // Targeted pane cleanup: remove panes only when this client explicitly deletes
  // a session from single-view controls. Avoid broad "missing from list" pruning
  // because list windows can omit older sessions and would wipe panes on reload.
  useEffect(() => {
    const handleSessionDeleted = (evt: Event) => {
      const custom = evt as CustomEvent<{ sessionId?: string }>;
      const deletedSessionId =
        typeof custom.detail?.sessionId === "string" ? custom.detail.sessionId.trim() : "";
      if (!deletedSessionId) return;

      setPanesState((prev) => {
        const stalePaneIds = prev
          .filter((pane) => pane.kind !== "code" && pane.sessionId === deletedSessionId)
          .map((pane) => pane.id);
        if (stalePaneIds.length === 0) return prev;
        const stalePaneSet = new Set(stalePaneIds);
        setHandshakes((existing) => {
          let next = existing;
          for (const paneId of stalePaneSet) {
            next = removeHandshakeForPane(next, paneId);
          }
          return next;
        });
        return prev.filter((pane) => !stalePaneSet.has(pane.id));
      });
    };

    if (typeof window !== "undefined") {
      window.addEventListener("groovy:session-deleted", handleSessionDeleted as EventListener);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("groovy:session-deleted", handleSessionDeleted as EventListener);
      }
    };
  }, []);

  // Keep session title lookup available without forcing handshake rehydrate reruns.
  useEffect(() => {
    const next = new Map<string, string>();
    for (const session of orchestrator.sessions) {
      if (!session || typeof session.id !== "string" || !session.id.trim()) continue;
      const title =
        typeof session.title === "string" && session.title.trim()
          ? session.title.trim()
          : "Untitled";
      next.set(session.id.trim(), title);
    }
    sessionTitleByIdRef.current = next;
  }, [orchestrator.sessions]);

  const paneSessionIdsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const pane of panes) {
      if (pane.sessionId) ids.add(pane.sessionId);
    }
    return Array.from(ids).sort().join(",");
  }, [panes]);

  // Rehydrate handshake UI state after reload using active backend handshakes.
  useEffect(() => {
    const sessionIds = paneSessionIdsKey
      ? paneSessionIdsKey.split(",").filter((v) => v.length > 0)
      : [];
    if (sessionIds.length === 0) {
      setHandshakes((prev) => (prev.size > 0 ? new Map<string, HandshakeState>() : prev));
      return;
    }

    const sessionIdSet = new Set(sessionIds);
    const paneBySessionId = new Map<string, string>();
    for (const [sessionId, paneIds] of paneSessionMapRef.current.entries()) {
      if (!sessionIdSet.has(sessionId) || !Array.isArray(paneIds) || paneIds.length === 0) continue;
      paneBySessionId.set(sessionId, paneIds[0]);
    }

    const supabase = getSupabaseBrowserClient();
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("handshake_sessions")
        .select("id,pane_a_session_id,pane_b_session_id,created_at,status")
        .eq("status", "active")
        .order("created_at", { ascending: false });
      if (cancelled || error || !Array.isArray(data)) return;

      const reconstructed = new Map<string, HandshakeState>();
      for (const row of data) {
        const paneASessionId =
          typeof row.pane_a_session_id === "string" ? row.pane_a_session_id.trim() : "";
        const paneBSessionId =
          typeof row.pane_b_session_id === "string" ? row.pane_b_session_id.trim() : "";
        if (!paneASessionId || !paneBSessionId) continue;
        if (!sessionIdSet.has(paneASessionId) || !sessionIdSet.has(paneBSessionId)) continue;

        const paneAId = paneBySessionId.get(paneASessionId);
        const paneBId = paneBySessionId.get(paneBSessionId);
        if (!paneAId || !paneBId || paneAId === paneBId) continue;
        if (reconstructed.has(paneAId) || reconstructed.has(paneBId)) continue;

        const handshakeId = typeof row.id === "string" ? row.id.trim() : "";
        if (!handshakeId) continue;
        const createdAt =
          typeof row.created_at === "string" && row.created_at.trim()
            ? row.created_at.trim()
            : new Date().toISOString();

        reconstructed.set(paneAId, {
          handshakeId,
          partnerPaneId: paneBId,
          partnerSessionId: paneBSessionId,
          partnerName: sessionTitleByIdRef.current.get(paneBSessionId) || "Agent",
          status: "active",
          statusDetail: null,
          createdAt,
        });
        reconstructed.set(paneBId, {
          handshakeId,
          partnerPaneId: paneAId,
          partnerSessionId: paneASessionId,
          partnerName: sessionTitleByIdRef.current.get(paneASessionId) || "Agent",
          status: "active",
          statusDetail: null,
          createdAt,
        });
      }

      setHandshakes((prev) => {
        if (reconstructed.size === 0 && prev.size === 0) return prev;
        const next = new Map<string, HandshakeState>();
        for (const [paneId, hs] of reconstructed.entries()) {
          const existing = prev.get(paneId);
          if (existing && existing.handshakeId === hs.handshakeId) {
            next.set(paneId, {
              ...hs,
              status: existing.status,
              statusDetail: existing.statusDetail ?? null,
            });
          } else {
            next.set(paneId, hs);
          }
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [paneSessionIdsKey]);

  // Realtime refresh for ALL pane sessions (not only orchestrator.currentSessionId).
  // This keeps partner panes updated when handshake_send writes into their session.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    const paneReloadTimers = paneReloadTimersRef.current;
    const sessionIds = paneSessionIdsKey
      ? paneSessionIdsKey.split(",").filter((v) => v.length > 0)
      : [];
    if (sessionIds.length === 0) return;

    const channels: Array<ReturnType<typeof supabase.channel>> = [];

    for (const sid of sessionIds) {
      const channel = supabase
        .channel(`multi_agent_messages:${sid}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "orchestrator_messages",
            filter: `session_id=eq.${sid}`,
          },
          (payload) => {
            const row =
              payload &&
              typeof payload === "object" &&
              (payload as { new?: unknown }).new &&
              typeof (payload as { new?: unknown }).new === "object"
                ? ((payload as { new: Record<string, unknown> }).new as Record<string, unknown>)
                : null;

            const role =
              row && typeof row.role === "string" ? row.role.trim().toLowerCase() : "";
            const traceId =
              row && typeof row.trace_id === "string" ? row.trace_id.trim() : "";
            const content =
              row && typeof row.content === "string" ? row.content.trim() : "";
            const metadata =
              row && row.metadata && typeof row.metadata === "object"
                ? (row.metadata as Record<string, unknown>)
                : null;
            const handshakeMeta =
              metadata &&
              metadata.handshake &&
              typeof metadata.handshake === "object"
                ? (metadata.handshake as Record<string, unknown>)
                : null;
            const handshakeIdFromTrace =
              traceId.startsWith("handshake:") && traceId.split(":").length >= 3
                ? traceId.split(":")[1]
                : "";
            const handshakeId =
              (handshakeMeta &&
              typeof handshakeMeta.handshakeId === "string" &&
              handshakeMeta.handshakeId.trim()
                ? handshakeMeta.handshakeId.trim()
                : handshakeIdFromTrace) || "";
            const fromSessionId =
              (handshakeMeta &&
              typeof handshakeMeta.fromSessionId === "string" &&
              handshakeMeta.fromSessionId.trim()
                ? handshakeMeta.fromSessionId.trim()
                : "") || "";
            const toSessionId =
              (handshakeMeta &&
              typeof handshakeMeta.toSessionId === "string" &&
              handshakeMeta.toSessionId.trim()
                ? handshakeMeta.toSessionId.trim()
                : sid) || sid;

            if (role === "user" && handshakeId && traceId && content && toSessionId === sid) {
              enqueueAutoHandshakeJob({
                toSessionId: sid,
                traceId,
                handshakeId,
                fromSessionId,
                content,
              });
            }

            // Avoid clobbering in-flight stream for the active orchestrator session.
            if (orchestrator.currentSessionId === sid && orchestrator.isStreaming) {
              deferredSessionReloadsRef.current.add(sid);
              return;
            }

            const existingTimer = paneReloadTimers.get(sid);
            if (typeof existingTimer === "number") {
              window.clearTimeout(existingTimer);
            }
            const timerId = window.setTimeout(() => {
              paneReloadTimers.delete(sid);
              const paneIds = paneSessionMapRef.current.get(sid) || [];
              for (const paneId of paneIds) {
                void loadPaneMessages(paneId, sid);
              }
            }, 200);
            paneReloadTimers.set(sid, timerId);
          }
        )
        .subscribe();
      channels.push(channel);
    }

    return () => {
      for (const ch of channels) supabase.removeChannel(ch);
      for (const sid of sessionIds) {
        const timer = paneReloadTimers.get(sid);
        if (typeof timer === "number") {
          window.clearTimeout(timer);
          paneReloadTimers.delete(sid);
        }
      }
    };
  }, [
    paneSessionIdsKey,
    loadPaneMessages,
    orchestrator.currentSessionId,
    orchestrator.isStreaming,
    enqueueAutoHandshakeJob,
  ]);

  // Code panels send handoffs outside the orchestrator send path. Realtime should
  // still wake the partner, but dispatching a same-window event makes code-to-code
  // handoffs deterministic when the realtime insert event is delayed or missed.
  useEffect(() => {
    const handleLocalHandshakeSend = (event: Event) => {
      const detail =
        event instanceof CustomEvent &&
        event.detail &&
        typeof event.detail === "object"
          ? (event.detail as Record<string, unknown>)
          : null;
      if (!detail) return;

      const handshakeId =
        typeof detail.handshakeId === "string" ? detail.handshakeId.trim() : "";
      const traceId =
        typeof detail.traceId === "string" ? detail.traceId.trim() : "";
      const fromSessionId =
        typeof detail.fromSessionId === "string" ? detail.fromSessionId.trim() : "";
      const toSessionId =
        typeof detail.toSessionId === "string" ? detail.toSessionId.trim() : "";
      const content =
        typeof detail.content === "string" ? detail.content.trim() : "";
      if (!handshakeId || !traceId || !toSessionId || !content) return;

      enqueueAutoHandshakeJob({
        toSessionId,
        traceId,
        handshakeId,
        fromSessionId,
        content,
      });

      for (const paneId of paneSessionMapRef.current.get(toSessionId) || []) {
        void loadPaneMessages(paneId, toSessionId);
      }
      if (fromSessionId) {
        for (const paneId of paneSessionMapRef.current.get(fromSessionId) || []) {
          void loadPaneMessages(paneId, fromSessionId);
        }
      }
    };

    window.addEventListener(
      "groovy:handshake-message-sent",
      handleLocalHandshakeSend as EventListener
    );
    return () => {
      window.removeEventListener(
        "groovy:handshake-message-sent",
        handleLocalHandshakeSend as EventListener
      );
    };
  }, [enqueueAutoHandshakeJob, loadPaneMessages]);

  // Flush any session reloads deferred while the orchestrator was streaming.
  useEffect(() => {
    if (orchestrator.isStreaming) return;
    if (deferredSessionReloadsRef.current.size === 0) return;
    const pending = Array.from(deferredSessionReloadsRef.current);
    deferredSessionReloadsRef.current.clear();
    for (const sid of pending) {
      const paneIds = paneSessionMapRef.current.get(sid) || [];
      for (const paneId of paneIds) {
        void loadPaneMessages(paneId, sid);
      }
    }
  }, [orchestrator.isStreaming, loadPaneMessages, paneSessionIdsKey]);

  // Add a pane
  const addPane = useCallback((options?: AddPaneOptions) => {
    const id = newPaneId();
    const pane = createPaneState(id, options);
    setPanesState((prev) => [...prev, pane]);
    if (pane.sessionId) {
      loadPaneMessages(id, pane.sessionId);
    }
    return id;
  }, [createPaneState, loadPaneMessages]);

  // Remove a pane
  const removePane = useCallback((paneId: string) => {
    setHandshakes((prev) => removeHandshakeForPane(prev, paneId));
    setPanesState((prev) => {
      const filtered = prev.filter((p) => p.id !== paneId);
      return filtered;
    });
  }, []);

  // Set which session a pane shows
  const setPaneSession = useCallback((paneId: string, sessionId: string | null) => {
    const currentPane = panes.find((p) => p.id === paneId);
    if (currentPane && currentPane.sessionId !== sessionId) {
      setHandshakes((prev) => removeHandshakeForPane(prev, paneId));
    }
    setPanesState((prev) =>
      prev.map((p) =>
        p.id === paneId
          ? {
              ...p,
              sessionId,
              messages: [],
              agentActivities: [],
              isStreaming: false,
              streamingContent: "",
              currentToolCalls: [],
              error: null,
            }
          : p
      )
    );
    if (sessionId) {
      loadPaneMessages(paneId, sessionId);
    }
  }, [loadPaneMessages, panes]);

  const setPaneKind = useCallback((paneId: string, kind: PaneKind) => {
    const currentPane = panes.find((p) => p.id === paneId);
    if (currentPane && currentPane.kind !== kind) {
      setHandshakes((prev) => removeHandshakeForPane(prev, paneId));
    }
    setPanesState((prev) =>
      prev.map((p) => {
        if (p.id !== paneId) return p;
        if (p.kind === kind) return p;

        if (kind === "code") {
          return {
            ...p,
            kind,
            sessionId: null,
            messages: [],
            agentActivities: [],
            isStreaming: false,
            streamingContent: "",
            currentToolCalls: [],
            error: null,
            isLoadingMessages: false,
          };
        }

        return {
          ...p,
          kind,
          messages: [],
          agentActivities: [],
          isStreaming: false,
          streamingContent: "",
          currentToolCalls: [],
          error: null,
          isLoadingMessages: false,
        };
      })
    );
  }, [panes]);

  const setPaneChatAgent = useCallback(
    (paneId: string, chatAgentId: string | null, chatAgentName?: string | null) => {
      setPanesState((prev) =>
        prev.map((p) =>
          p.id === paneId
            ? {
                ...p,
                chatAgentId,
                chatAgentName: chatAgentName ?? null,
              }
            : p
        )
      );
    },
    []
  );

  const setPaneCodeAgent = useCallback(
    (paneId: string, codeAgentId: string | null, codeAgentName?: string | null) => {
      setPanesState((prev) =>
        prev.map((p) =>
          p.id === paneId
            ? {
                ...p,
                codeAgentId,
                codeAgentName: codeAgentName ?? null,
              }
            : p
        )
      );
    },
    []
  );

  // Send message from a specific pane (uses the primary orchestrator's sendMessage
  // but scopes results back to the pane)
  const sendPaneMessage = useCallback(
    async (
      paneId: string,
      message: string,
      sendOptions?: {
        memoryEnabled?: boolean;
        deviceId?: string;
        obsidianVaultPath?: string;
        files?: File[];
        chatSessionId?: string;
        suppressUserMessage?: boolean;
        suppressMemoryStore?: boolean;
        suppressPreferenceMemory?: boolean;
        messageMetadata?: Record<string, unknown>;
        sessionIdOverride?: string;
        historyOverride?: Array<{
          role: "user" | "assistant";
          content: string;
          metadata?: OrchestratorMessage["metadata"];
        }>;
      }
    ) => {
      const pane = panes.find((p) => p.id === paneId);
      if (!pane) return { ok: false, error: "Pane not found" };
      const handshake = handshakes.get(paneId) || null;
      if (pane.kind === "code" && !handshake) {
        return { ok: false, error: "Code sub-agent panes use the built-in Code panel input" };
      }

      const explicitSessionId =
        typeof sendOptions?.sessionIdOverride === "string" &&
        sendOptions.sessionIdOverride.trim()
          ? sendOptions.sessionIdOverride.trim()
          : null;
      let sessionId = explicitSessionId || pane.sessionId;
      let messageToSend = message;
      let resolvedSendOptions: {
        memoryEnabled?: boolean;
        deviceId?: string;
        obsidianVaultPath?: string;
        files?: File[];
        chatSessionId?: string;
        suppressUserMessage?: boolean;
        suppressMemoryStore?: boolean;
        suppressPreferenceMemory?: boolean;
        messageMetadata?: Record<string, unknown>;
        sessionIdOverride?: string;
        historyOverride?: Array<{
          role: "user" | "assistant";
          content: string;
          metadata?: OrchestratorMessage["metadata"];
        }>;
        chatAgentId?: string;
        chatAgentName?: string;
        handshakeId?: string;
        handshakePartnerSessionId?: string;
        handshakePartnerName?: string;
        handshakeSelfName?: string;
      } = { ...sendOptions };

      // If pane has no session, create one
      if (!sessionId) {
        const firstWords = message.split(" ").slice(0, 5).join(" ");
        const title = firstWords + (message.length > 30 ? "..." : "");
        sessionId = await orchestrator.createSession(title);
        if (!sessionId) return { ok: false, error: "Failed to create session" };
        setPanesState((prev) =>
          prev.map((p) => (p.id === paneId ? { ...p, sessionId } : p))
        );
      }

      // Prevent double-sending to same session
      if (inflightRef.current.has(sessionId)) {
        return { ok: false, error: "Session is already processing a request" };
      }

      // Code pane handshake messages must run through the selected Code agent,
      // not the orchestrator chat path.
      if (pane.kind === "code" && handshake) {
        if (!pane.codeAgentId) {
          return { ok: false, error: "Select a Code sub-agent first" };
        }
        if (!connectorExecute) {
          return { ok: false, error: "Connector is required to message a Code sub-agent" };
        }

        inflightRef.current.add(sessionId);
        let shouldRefreshCodePanel = false;

        // Show "collaborating" on code pane and "waiting" spinner on sender pane.
        setHandshakePairStatus(
          paneId,
          "collaborating",
          "waiting",
          "Code sub-agent is working...",
          "Waiting for Code agent response..."
        );
        // Make the sender pane show a streaming/loading state so the user
        // knows something is happening.
        const partnerPaneId = handshake.partnerPaneId;
        setPanesState((prev) =>
          prev.map((p) =>
            p.id === partnerPaneId
              ? { ...p, isStreaming: true, streamingContent: "" }
              : p
          )
        );

        try {
          const userFacingPrompt = String(messageToSend || "").trim();
          if (!userFacingPrompt) return { ok: false, error: "Message content is required" };
          const isIncomingHandshakeTurn =
            resolvedSendOptions.messageMetadata?.handshake_auto_trigger === true ||
            resolvedSendOptions.messageMetadata?.handshake_id === handshake.handshakeId;
          const selfName = paneLabelForHandshake({
            kind: pane.kind,
            chatAgentName: pane.chatAgentName ?? null,
            codeAgentName: pane.codeAgentName ?? null,
          });
          const prompt = buildCodeHandshakePrompt({
            message: userFacingPrompt,
            selfName,
            partnerName: handshake.partnerName,
            incoming: isIncomingHandshakeTurn,
          });

          const supabase = getSupabaseBrowserClient();
          const {
            data: { user },
          } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
          const currentUserId =
            user && typeof user.id === "string" && user.id.trim() ? user.id.trim() : null;

          let priorClaudeSessionId: string | undefined;
          if (currentUserId) {
            const { data: threadRow } = await supabase
              .from("claude_code_cli_threads")
              .select("claude_session_id")
              .eq("user_id", currentUserId)
              .eq("claude_code_agent_id", pane.codeAgentId)
              .maybeSingle();
            priorClaudeSessionId =
              typeof threadRow?.claude_session_id === "string" &&
              threadRow.claude_session_id.trim()
                ? threadRow.claude_session_id.trim()
                : undefined;
          }

          if (currentUserId) {
            const { error: userInsertError } = await supabase.from("claude_code_cli_messages").insert({
              user_id: currentUserId,
              claude_code_agent_id: pane.codeAgentId,
              role: "user",
              content: userFacingPrompt,
            });
            if (!userInsertError) shouldRefreshCodePanel = true;
          }

          const prepRes = await fetch("/api/claude-cli", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: pane.codeAgentId,
              prompt,
              timeoutMs: AUTO_HANDSHAKE_CODE_CONNECTOR_TIMEOUT_MS,
              ...(priorClaudeSessionId ? { sessionId: priorClaudeSessionId } : {}),
            }),
          });
          const prepJson = (await prepRes.json().catch(() => null)) as
            | {
                ok?: boolean;
                error?: string;
                payload?: Record<string, unknown>;
                billing?: CodeAgentBillingContext;
              }
            | null;
          if (!prepRes.ok || !prepJson?.ok || !prepJson?.payload) {
            return {
              ok: false,
              error:
                typeof prepJson?.error === "string" && prepJson.error.trim()
                  ? prepJson.error.trim()
                  : "Failed to prepare Code sub-agent request",
            };
          }

          const payload = prepJson.payload;
          const connectorType =
            typeof payload.type === "string" && payload.type.trim()
              ? payload.type.trim()
              : "claude_run";
          const connectorParams: Record<string, unknown> = {
            ...payload,
            // The handshake runner persists the assistant row below. The relay
            // also persists normal claude_run results for recovery, so disable
            // that here to avoid duplicate Code-panel messages.
            persist_result: false,
          };
          delete connectorParams.type;
          delete connectorParams.request_id;
          delete connectorParams.device_id;

          const codeResult = await connectorExecute({
            type: connectorType,
            params: connectorParams,
            toolCallId: `handshake-code-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            toolName: "code_cli_run",
            agent: "code",
            sessionId,
          });

          const requestId =
            typeof payload.request_id === "string" && payload.request_id.trim()
              ? payload.request_id.trim()
              : "";
          if (requestId && codeResult) {
            await recordCodeAgentUsageBestEffort({
              agentId: pane.codeAgentId,
              requestId,
              billing: prepJson.billing || null,
              result: {
                ok: codeResult.ok === true,
                request_id: requestId,
                model: typeof codeResult.model === "string" ? codeResult.model : undefined,
                session_id:
                  typeof codeResult.session_id === "string" ? codeResult.session_id : null,
                duration_ms:
                  typeof codeResult.duration_ms === "number" ? codeResult.duration_ms : undefined,
                usage: codeResult.usage,
                input_tokens:
                  typeof codeResult.input_tokens === "number" ? codeResult.input_tokens : undefined,
                output_tokens:
                  typeof codeResult.output_tokens === "number" ? codeResult.output_tokens : undefined,
                total_tokens:
                  typeof codeResult.total_tokens === "number" ? codeResult.total_tokens : undefined,
                total_cost_usd:
                  typeof codeResult.total_cost_usd === "number" ? codeResult.total_cost_usd : undefined,
                cost_usd: typeof codeResult.cost_usd === "number" ? codeResult.cost_usd : undefined,
              },
            });
          }

          const nextClaudeSessionId =
            typeof codeResult?.session_id === "string" && codeResult.session_id.trim()
              ? codeResult.session_id.trim()
              : undefined;
          if (currentUserId && nextClaudeSessionId) {
            await supabase.from("claude_code_cli_threads").upsert(
              {
                user_id: currentUserId,
                claude_code_agent_id: pane.codeAgentId,
                claude_session_id: nextClaudeSessionId,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "user_id,claude_code_agent_id" }
            );
          }
          const assistantDisplay = buildCodeRunDisplayMessage({
            result: codeResult?.result,
            error: codeResult?.error,
            diffs: codeResult?.diffs,
          });
          const costUsd = Number(codeResult?.cost_usd);
          const durationMs = Number(codeResult?.duration_ms);
          const model = inferCodeAgentResultModel({
            model: typeof codeResult?.model === "string" ? codeResult.model : null,
            billing: prepJson.billing || null,
          });
          if (currentUserId) {
            const { error: assistantInsertError } = await supabase.from("claude_code_cli_messages").insert({
              user_id: currentUserId,
              claude_code_agent_id: pane.codeAgentId,
              role: "assistant",
              content: assistantDisplay.content,
              diffs: assistantDisplay.diffs.length > 0 ? assistantDisplay.diffs : null,
              model,
              cost_usd: Number.isFinite(costUsd) ? costUsd : null,
              duration_ms: Number.isFinite(durationMs) ? Math.floor(durationMs) : null,
            });
            if (!assistantInsertError) shouldRefreshCodePanel = true;
          }

          if (!codeResult?.ok) {
            return {
              ok: false,
              error:
                typeof codeResult?.error === "string" && codeResult.error.trim()
                  ? codeResult.error.trim()
                  : "Code sub-agent execution failed",
            };
          }
          const assistantText = assistantDisplay.content;
          const responseMetadata =
            resolvedSendOptions.messageMetadata &&
            typeof resolvedSendOptions.messageMetadata === "object"
              ? resolvedSendOptions.messageMetadata
              : undefined;

          // Persist response in the code pane's orchestrator session.
          await fetch("/api/orchestrator/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId,
              role: "assistant",
              content: assistantText,
              metadata: {
                ...(responseMetadata || {}),
                code_handshake_direct_mirror: true,
              },
            }),
          }).catch(() => {});

          // Directly mirror response back to the sender/partner pane session.
          // Don't rely on the realtime auto-mirror — it's too fragile across
          // streaming/reload races.
          const partnerSessionId = handshake.partnerSessionId;
          const fromTitle =
            sessionTitleByIdRef.current.get(sessionId) || "Code Agent";
          const toTitle =
            sessionTitleByIdRef.current.get(partnerSessionId) ||
            handshake.partnerName ||
            "Agent";
          const directMirrorTraceId = `code-hs-mirror:${handshake.handshakeId}:${Date.now()}`;
          await fetch("/api/orchestrator/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: partnerSessionId,
              role: "assistant",
              content: assistantText,
              traceId: directMirrorTraceId,
              metadata: {
                code_handshake_direct_mirror: true,
                handshake: {
                  handshakeId: handshake.handshakeId,
                  fromSessionId: sessionId,
                  toSessionId: partnerSessionId,
                  fromSessionTitle: fromTitle,
                  toSessionTitle: toTitle,
                  direction: "incoming",
                  uiOnly: true,
                },
              },
            }),
          }).catch(() => {});

          // Refresh sender/partner pane so mirrored response appears immediately.
          const partnerPaneIds =
            paneSessionMapRef.current.get(partnerSessionId) || [];
          for (const ppId of partnerPaneIds) {
            void loadPaneMessages(ppId, partnerSessionId);
          }

          return { ok: true };
        } finally {
          inflightRef.current.delete(sessionId);
          // Clear sender pane streaming indicator.
          const partnerPaneIdFinal = handshake.partnerPaneId;
          setPanesState((prev) =>
            prev.map((p) =>
              p.id === partnerPaneIdFinal
                ? { ...p, isStreaming: false, streamingContent: "" }
                : p
            )
          );
          const hsId = handshake.handshakeId;
          window.setTimeout(() => {
            const hasPending = pendingAutoHandshakeRunsRef.current.some(
              (job) => job.handshakeId === hsId
            );
            const hasInFlight = inFlightAutoHandshakeRunsRef.current.has(hsId);
            if (!hasPending && !hasInFlight) {
              setHandshakePairStatus(paneId, "active", "active", null, null);
            }
          }, 300);
          if (shouldRefreshCodePanel && typeof window !== "undefined" && pane.codeAgentId) {
            window.dispatchEvent(
              new CustomEvent("groovy:claude-cli-refresh", {
                detail: { agentId: pane.codeAgentId },
              })
            );
          }
        }
      }

      // AI Chat pane: force routing to selected AI sub-agent.
      if (pane.kind === "ai_chat") {
        if (!pane.chatAgentId) {
          return { ok: false, error: "Select an AI chat sub-agent first" };
        }
        const hasChatMention = /(^|\s)@(chat|ai)(?=$|\s|[:(])/i.test(messageToSend);
        if (!hasChatMention) {
          messageToSend = `@chat ${messageToSend}`;
        }
        resolvedSendOptions = {
          ...resolvedSendOptions,
          chatAgentId: pane.chatAgentId,
          chatAgentName: pane.chatAgentName || undefined,
        };
      }

      if (handshake) {
        const selfName =
          (sessionId &&
            orchestrator.sessions.find((s) => s.id === sessionId)?.title?.trim()) ||
          "This Agent";
        resolvedSendOptions = {
          ...resolvedSendOptions,
          handshakeId: handshake.handshakeId,
          handshakePartnerSessionId: handshake.partnerSessionId,
          handshakePartnerName: handshake.partnerName,
          handshakeSelfName: selfName,
        };
        setHandshakePairStatus(
          paneId,
          "collaborating",
          "waiting",
          `Working with ${handshake.partnerName}...`,
          `Waiting for ${pane.sessionId ? "partner request" : "partner"}...`
        );
      }

      inflightRef.current.add(sessionId);
      const suppressMemoryStore =
        typeof resolvedSendOptions.suppressMemoryStore === "boolean"
          ? resolvedSendOptions.suppressMemoryStore
          : true;
      const suppressPreferenceMemory =
        typeof resolvedSendOptions.suppressPreferenceMemory === "boolean"
          ? resolvedSendOptions.suppressPreferenceMemory
          : true;
      resolvedSendOptions = {
        ...resolvedSendOptions,
        suppressMemoryStore,
        suppressPreferenceMemory,
        sessionIdOverride: sessionId,
        historyOverride: (
          explicitSessionId && pane.sessionId !== explicitSessionId
            ? paneCacheRef.current.get(explicitSessionId)?.messages || []
            : pane.messages
        ).map((m) => ({
          role: m.role,
          content: m.content,
          metadata: m.metadata,
        })),
      };

      // Switch the primary orchestrator to this session and send
      // If we are switching sessions, manually inject the pane's current state into the orchestrator
      // so that new messages append to the correct history, rather than mixing with the previous session.
      // This avoids the need for a network fetch (skipLoad: true) while ensuring state consistency.
      if (sessionId !== orchestrator.currentSessionId) {
        orchestrator.injectSessionState(sessionId, pane.messages, pane.agentActivities);
      } else {
        orchestrator.selectSession(sessionId, { skipLoad: true });
      }

      // Small delay to let useEffect load session (the orchestrator loads messages on selectSession)
      await new Promise((r) => setTimeout(r, 100));

      try {
        const result = await orchestrator.sendMessage(messageToSend, resolvedSendOptions);
        return result;
      } finally {
        inflightRef.current.delete(sessionId);
        // Re-sync this pane from server after each send completes. This prevents
        // occasional optimistic-message loss when handshake side-effects and
        // realtime reloads arrive out of order.
        if (sessionId) {
          void loadPaneMessages(paneId, sessionId);
        }
        if (handshake) {
          const hsId = handshake.handshakeId;
          window.setTimeout(() => {
            const hasPending = pendingAutoHandshakeRunsRef.current.some(
              (job) => job.handshakeId === hsId
            );
            const hasInFlight = inFlightAutoHandshakeRunsRef.current.has(hsId);
            if (!hasPending && !hasInFlight) {
              setHandshakePairStatus(paneId, "active", "active", null, null);
            }
          }, 300);
        }
      }
    },
    [panes, orchestrator, handshakes, setHandshakePairStatus, loadPaneMessages, connectorExecute]
  );

  // Background worker: auto-run partner pane when a handshake message arrives.
  useEffect(() => {
    if (autoHandshakeWorkerRunningRef.current) return;
    if (pendingAutoHandshakeRunsRef.current.length === 0) return;
    autoHandshakeWorkerRunningRef.current = true;

    const run = async () => {
      try {
        while (pendingAutoHandshakeRunsRef.current.length > 0) {
          const job = pendingAutoHandshakeRunsRef.current[0];
          if (!job) {
            pendingAutoHandshakeRunsRef.current.shift();
            continue;
          }
          const paneId = resolveHandshakePaneId(
            job.sessionId,
            job.handshakeId,
            job.fromSessionId
          );
          if (!paneId) {
            pendingAutoHandshakeRunsRef.current.shift();
            continue;
          }

          const targetPane = panes.find((p) => p.id === paneId);
          const isCodePane = targetPane?.kind === "code";
          const targetSessionId =
            targetPane && typeof targetPane.sessionId === "string"
              ? targetPane.sessionId.trim()
              : "";

          // Guard against stale pane/session mapping. Running a job on the wrong
          // pane can duplicate/mix conversations across tiles.
          if (!targetPane || (!isCodePane && targetSessionId !== job.sessionId)) {
            pendingAutoHandshakeRunsRef.current.shift();
            if (Date.now() - job.enqueuedAtMs < AUTO_HANDSHAKE_RETRY_MAX_MS) {
              pendingAutoHandshakeRunsRef.current.push({
                ...job,
                attempts: job.attempts + 1,
              });
            }
            continue;
          }

          // Code pane jobs bypass the orchestrator entirely, so they can run
          // even while the orchestrator is streaming on a different pane.
          if (!isCodePane && orchestrator.isStreaming) {
            const blockedMs = Date.now() - job.enqueuedAtMs;
            if (blockedMs < AUTO_HANDSHAKE_STREAM_WAIT_MAX_MS) break;
          }

          pendingAutoHandshakeRunsRef.current.shift();
          inFlightAutoHandshakeRunsRef.current.add(job.handshakeId);
          try {

            setHandshakePairStatus(
              paneId,
              "collaborating",
              "waiting",
              "Auto-replying to handshake message...",
              "Partner is preparing a response..."
            );

            const result = await (async () => {
              const timeoutMs = isCodePane
                ? AUTO_HANDSHAKE_CODE_JOB_TIMEOUT_MS
                : AUTO_HANDSHAKE_JOB_TIMEOUT_MS;
              let timeoutId: ReturnType<typeof setTimeout> | null = null;
              const timeoutPromise = new Promise<{ ok: false; error: string }>((resolve) => {
                timeoutId = setTimeout(() => {
                  resolve({
                    ok: false,
                    error: `Handshake auto-reply timed out (${Math.round(
                      timeoutMs / 1000
                    )}s)`,
                  });
                }, timeoutMs);
              });
              try {
                const raced = await Promise.race([
                  sendPaneMessage(paneId, job.content, {
                    suppressUserMessage: true,
                    sessionIdOverride: job.sessionId,
                    messageMetadata: {
                      handshake_auto_trigger: true,
                      handshake_source_trace_id: job.traceId,
                      handshake_id: job.handshakeId,
                      handshake_from_session_id: job.fromSessionId,
                      handshake_to_session_id: job.toSessionId,
                    },
                  }),
                  timeoutPromise,
                ]);
                return raced as Awaited<ReturnType<typeof sendPaneMessage>>;
              } finally {
                if (timeoutId) {
                  clearTimeout(timeoutId);
                }
              }
            })();
            const resultError =
              typeof result?.error === "string" ? result.error.toLowerCase() : "";
            const retryableBusyError =
              resultError.includes("already processing") ||
              resultError.includes("busy streaming");
            if (
              !result?.ok &&
              retryableBusyError &&
              Date.now() - job.enqueuedAtMs < AUTO_HANDSHAKE_RETRY_MAX_MS
            ) {
              pendingAutoHandshakeRunsRef.current.unshift({
                ...job,
                attempts: job.attempts + 1,
              });
              break;
            }

            // On success or failure, refresh both sides of the handshake.
            const sourcePaneIds =
              paneSessionMapRef.current.get(job.fromSessionId) || [];
            for (const sourcePaneId of sourcePaneIds) {
              void loadPaneMessages(sourcePaneId, job.fromSessionId);
            }
            void loadPaneMessages(paneId, job.sessionId);

            // Deterministic mirror for non-code auto-handshake replies.
            // This avoids realtime-based pane resolution races that can duplicate
            // or cross-post messages.
            if (result?.ok && !isCodePane) {
              try {
                let latestAssistant:
                  | {
                      id?: unknown;
                      role?: unknown;
                      content?: unknown;
                      traceId?: unknown;
                      metadata?: unknown;
                    }
                  | undefined;

                // Persisting the assistant message can lag slightly behind stream completion.
                // Poll briefly so source-pane mirroring stays reliable.
                for (let attempt = 0; attempt < 4; attempt++) {
                  const mirrorFetch = await fetch(
                    `/api/orchestrator/agents/${encodeURIComponent(job.sessionId)}?ts=${Date.now()}`,
                    { cache: "no-store" }
                  );
                  const mirrorJson = (await mirrorFetch.json().catch(() => null)) as
                    | {
                        messages?: Array<{
                          id?: unknown;
                          role?: unknown;
                          content?: unknown;
                          traceId?: unknown;
                          metadata?: unknown;
                        }>;
                      }
                    | null;
                  const sessionMessages = Array.isArray(mirrorJson?.messages)
                    ? mirrorJson.messages
                    : [];
                  // Try exact metadata match first, then fall back to latest
                  // assistant message (server may not propagate all metadata fields).
                  const reversed = [...sessionMessages].reverse();
                  latestAssistant = reversed.find((m) => {
                    const r =
                      typeof m?.role === "string" ? m.role.trim().toLowerCase() : "";
                    const text =
                      typeof m?.content === "string" ? m.content.trim() : "";
                    const md =
                      m?.metadata && typeof m.metadata === "object"
                        ? (m.metadata as Record<string, unknown>)
                        : null;
                    return (
                      r === "assistant" &&
                      text.length > 0 &&
                      !!md &&
                      md.handshake_auto_trigger === true &&
                      md.handshake_source_trace_id === job.traceId &&
                      md.handshake_id === job.handshakeId &&
                      md.code_handshake_direct_mirror !== true
                    );
                  });
                  if (!latestAssistant) {
                    latestAssistant = reversed.find((m) => {
                      const r =
                        typeof m?.role === "string" ? m.role.trim().toLowerCase() : "";
                      const text =
                        typeof m?.content === "string" ? m.content.trim() : "";
                      const hsMeta =
                        m?.metadata && typeof m.metadata === "object"
                          ? (m.metadata as Record<string, unknown>)
                          : null;
                      return (
                        r === "assistant" &&
                        text.length > 0 &&
                        !hsMeta?.handshake &&
                        hsMeta?.code_handshake_direct_mirror !== true
                      );
                    });
                  }
                  if (latestAssistant) break;
                  if (attempt < 3) {
                    await new Promise((resolve) => window.setTimeout(resolve, 250));
                  }
                }
                const mirroredContent =
                  latestAssistant && typeof latestAssistant.content === "string"
                    ? latestAssistant.content.trim()
                    : "";
                if (mirroredContent) {
                  const assistantTrace =
                    latestAssistant && typeof latestAssistant.traceId === "string"
                      ? latestAssistant.traceId.trim()
                      : "";
                  const sourceTrace =
                    assistantTrace ||
                    (latestAssistant && typeof latestAssistant.id === "string"
                      ? `assistant:${latestAssistant.id.trim()}`
                      : `assistant:${job.handshakeId}:${job.traceId}`);
                  const fromSessionTitle =
                    sessionTitleByIdRef.current.get(job.sessionId) || "Agent";
                  const toSessionTitle =
                    sessionTitleByIdRef.current.get(job.fromSessionId) || "Agent";
                  await fetch("/api/orchestrator/messages", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      sessionId: job.fromSessionId,
                      role: "assistant",
                      content: mirroredContent,
                      traceId: `hs-mirror:${sourceTrace}`,
                      metadata: {
                        handshake: {
                          handshakeId: job.handshakeId,
                          fromSessionId: job.sessionId,
                          toSessionId: job.fromSessionId,
                          fromSessionTitle,
                          toSessionTitle,
                          sourceTraceId: sourceTrace,
                          direction: "incoming",
                          uiOnly: true,
                        },
                      },
                    }),
                  }).catch(() => {});
                  for (const sourcePaneId of sourcePaneIds) {
                    void loadPaneMessages(sourcePaneId, job.fromSessionId);
                  }
                }
              } catch {
                // best-effort mirror
              }
            }

            if (!result?.ok) {
              const errText =
                typeof result?.error === "string" && result.error.trim()
                  ? result.error.trim()
                  : "Unable to complete the handshake request.";
              await fetch("/api/orchestrator/messages", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  sessionId: job.sessionId,
                  role: "assistant",
                  content: `Handshake auto-reply failed: ${errText}`,
                  metadata: {
                    handshake_auto_trigger: true,
                    handshake_source_trace_id: job.traceId,
                    handshake_id: job.handshakeId,
                    handshake_from_session_id: job.fromSessionId,
                    handshake_to_session_id: job.toSessionId,
                    handshake_auto_error: true,
                  },
                }),
              }).catch(() => {});
              void loadPaneMessages(paneId, job.sessionId);
            }
            setHandshakePairStatus(paneId, "active", "active", null, null);
          } finally {
            inFlightAutoHandshakeRunsRef.current.delete(job.handshakeId);
          }
        }
      } finally {
        autoHandshakeWorkerRunningRef.current = false;
        if (pendingAutoHandshakeRunsRef.current.length > 0) {
          window.setTimeout(() => setAutoHandshakeTick((v) => v + 1), 250);
        }
      }
    };

    void run();
  }, [
    autoHandshakeTick,
    orchestrator.isStreaming,
    sendPaneMessage,
    loadPaneMessages,
    resolveHandshakePaneId,
    setHandshakePairStatus,
    panes,
    handshakes,
  ]);

  const connectHandshake = useCallback(
    (paneAId: string, paneBId: string) => {
      if (!paneAId || !paneBId || paneAId === paneBId) {
        return;
      }
      if (handshakes.has(paneAId) || handshakes.has(paneBId)) return;

      const paneA = panes.find((p) => p.id === paneAId);
      const paneB = panes.find((p) => p.id === paneBId);
      if (!paneA || !paneB) {
        return;
      }
      void (async () => {
        try {
          const ensurePaneSessionId = async (pane: PaneState): Promise<string | null> => {
            if (pane.sessionId) return pane.sessionId;
            const created = await orchestrator.createSession(
              handshakeSessionTitleForPane({
                kind: pane.kind,
                chatAgentName: pane.chatAgentName ?? null,
                codeAgentName: pane.codeAgentName ?? null,
              })
            );
            if (!created) return null;
            setPanesState((prev) =>
              prev.map((p) =>
                p.id === pane.id
                  ? {
                      ...p,
                      sessionId: created,
                    }
                  : p
              )
            );
            return created;
          };

          const paneASessionId = await ensurePaneSessionId(paneA);
          const paneBSessionId = await ensurePaneSessionId(paneB);
          if (!paneASessionId || !paneBSessionId || paneASessionId === paneBSessionId) {
            return;
          }

          const sessionTitleById = new Map(
            orchestrator.sessions.map((session) => [
              session.id,
              typeof session.title === "string" && session.title.trim()
                ? session.title.trim()
                : "Untitled",
            ])
          );
          const paneAName =
            sessionTitleById.get(paneASessionId) ||
            paneLabelForHandshake({
              kind: paneA.kind,
              chatAgentName: paneA.chatAgentName ?? null,
              codeAgentName: paneA.codeAgentName ?? null,
            });
          const paneBName =
            sessionTitleById.get(paneBSessionId) ||
            paneLabelForHandshake({
              kind: paneB.kind,
              chatAgentName: paneB.chatAgentName ?? null,
              codeAgentName: paneB.codeAgentName ?? null,
            });

          const response = await fetch("/api/handshake", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              paneASessionId,
              paneBSessionId,
            }),
          });
          if (!response.ok) {
            return;
          }
          const data = (await response.json().catch(() => null)) as
            | { handshakeId?: unknown; createdAt?: unknown }
            | null;
          const handshakeId =
            typeof data?.handshakeId === "string" && data.handshakeId.trim()
              ? data.handshakeId.trim()
              : null;
          if (!handshakeId) return;
          const createdAt =
            typeof data?.createdAt === "string" && data.createdAt.trim()
              ? data.createdAt.trim()
              : new Date().toISOString();

          setHandshakes((prev) => {
            if (prev.has(paneAId) || prev.has(paneBId)) {
              return prev;
            }
            const next = new Map(prev);
            next.set(paneAId, {
              handshakeId,
              partnerPaneId: paneBId,
              partnerSessionId: paneBSessionId,
              partnerName: paneBName,
              status: "active",
              createdAt,
            });
            next.set(paneBId, {
              handshakeId,
              partnerPaneId: paneAId,
              partnerSessionId: paneASessionId,
              partnerName: paneAName,
              status: "active",
              createdAt,
            });
            return next;
          });
        } catch {
          // Ignore network/transient errors; user can retry handshake drag.
        }
      })();
    },
    [panes, orchestrator, handshakes]
  );

  const disconnectHandshake = useCallback(async (paneId: string) => {
    const existing = handshakes.get(paneId);
    if (!existing) return;
    setHandshakes((prev) => removeHandshakeForPane(prev, paneId));
    try {
      await fetch(`/api/handshake/${encodeURIComponent(existing.handshakeId)}`, {
        method: "DELETE",
      });
    } catch {
      // Keep UI disconnected even if backend cleanup fails.
    }
  }, [handshakes]);

  // Sync orchestrator streaming state to the matching pane.
  // ONLY applies while the orchestrator is actively streaming. Once streaming ends,
  // pane state is owned by loadPaneMessages (DB source of truth). This prevents the
  // sync effect from overwriting fresh DB data with stale orchestrator state after
  // session switches (the root cause of cross-pane message duplication).
  useEffect(() => {
    if (!orchestrator.isStreaming) return;
    if (!orchestrator.currentSessionId) return;
    const sid = orchestrator.currentSessionId;

    setPanesState((prev) => {
      const matches = prev.filter((p) => p.sessionId === sid && p.kind !== "code");
      if (matches.length === 0) return prev;

      let changed = false;
      const updated = prev.map((pane) => {
        if (pane.sessionId !== sid || pane.kind === "code") return pane;
        if (
          pane.messages === orchestrator.messages &&
          pane.isStreaming === true &&
          pane.streamingContent === orchestrator.streamingContent &&
          pane.agentActivities === orchestrator.agentActivities &&
          pane.currentToolCalls === orchestrator.currentToolCalls
        ) {
          return pane;
        }
        changed = true;
        return {
          ...pane,
          messages: orchestrator.messages,
          isStreaming: true,
          streamingContent: orchestrator.streamingContent,
          agentActivities: orchestrator.agentActivities,
          currentToolCalls: orchestrator.currentToolCalls,
          error: orchestrator.error,
        };
      });
      return changed ? updated : prev;
    });
  }, [
    orchestrator.currentSessionId,
    orchestrator.messages,
    orchestrator.isStreaming,
    orchestrator.streamingContent,
    orchestrator.agentActivities,
    orchestrator.currentToolCalls,
    orchestrator.error,
  ]);

  // When orchestrator stops streaming, clear the streaming flag on the pane it was
  // streaming for (but do NOT touch messages — loadPaneMessages owns that).
  useEffect(() => {
    if (orchestrator.isStreaming) return;
    if (!orchestrator.currentSessionId) return;
    const sid = orchestrator.currentSessionId;
    setPanesState((prev) => {
      let changed = false;
      const updated = prev.map((pane) => {
        if (pane.sessionId !== sid || pane.kind === "code") return pane;
        const hs = handshakes.get(pane.id) || null;
        const handshakeBusy = !!hs && (hs.status === "waiting" || hs.status === "collaborating");
        if (handshakeBusy) return pane;
        if (!pane.isStreaming) return pane;
        changed = true;
        return { ...pane, isStreaming: false, streamingContent: "" };
      });
      return changed ? updated : prev;
    });
  }, [orchestrator.isStreaming, orchestrator.currentSessionId, handshakes]);

  // Reorder panes
  const reorderPanes = useCallback((newOrder: string[]) => {
    setPanesState((prev) => {
      const map = new Map(prev.map((p) => [p.id, p]));
      return newOrder.map((id) => map.get(id)!).filter(Boolean);
    });
  }, []);

  return {
    // View mode
    viewMode,
    setViewMode,
    gridCols,
    setGridCols,

    // Primary orchestrator (for single view)
    orchestrator,

    // Multi-pane state
    panes,
    handshakes,
    addPane,
    removePane,
    setPaneSession,
    setPaneKind,
    setPaneChatAgent,
    setPaneCodeAgent,
    connectHandshake,
    disconnectHandshake,
    sendPaneMessage,
    reorderPanes,
    loadPaneMessages,

    // Shared
    sessions: orchestrator.sessions,
    createSession: orchestrator.createSession,
    deleteSession: orchestrator.deleteSession,
    renameSession: orchestrator.renameSession,
  };
}
