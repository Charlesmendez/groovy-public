"use client";

/**
 * HarnessChecklist — collapsible post-onboarding checklist card shown on the
 * harness dashboard when onboarding is complete but setup items are missing.
 *
 * Live data (connector/agents/tasks) comes in as props from the dashboard's
 * existing hooks to avoid duplicate relay connections; preferences arrive via
 * useOnboardingGate's onboardingData. Dismissal persists to
 * onboardingData.harnessChecklistDismissed.
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronDown,
  Circle,
  ListChecks,
  X,
} from "lucide-react";

type ChecklistItem = {
  id: string;
  label: string;
  done: boolean;
  actionLabel?: string;
  onAction?: () => void;
  href?: string;
  hint?: string;
};

type HarnessChecklistProps = {
  onboardingData: Record<string, unknown>;
  connectorOnline: boolean;
  agentsCount: number;
  tasksCount: number;
  onAddAgent: () => void;
};

export function HarnessChecklist({
  onboardingData,
  connectorOnline,
  agentsCount,
  tasksCount,
  onAddAgent,
}: HarnessChecklistProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  const dismissed = locallyDismissed || onboardingData.harnessChecklistDismissed === true;

  // Orchestrator model: explicit selection on the runtime agent OR the
  // onboarding flag (picking "Auto" stores model=null but sets the flag).
  const flagModelSet = onboardingData.orchestratorModelSet === true;
  const [fetchedModelSet, setFetchedModelSet] = useState<boolean | null>(null);
  const [localModelSet, setLocalModelSet] = useState(false);
  useEffect(() => {
    if (flagModelSet) return;
    let cancelled = false;
    fetch("/api/orchestrator/model", { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled) setFetchedModelSet(json?.model != null);
      })
      .catch(() => {
        if (!cancelled) setFetchedModelSet(null);
      });
    return () => {
      cancelled = true;
    };
  }, [flagModelSet]);
  const modelSet = flagModelSet || localModelSet || fetchedModelSet === true;

  const markModelSet = () => {
    setLocalModelSet(true);
    fetch("/api/user-preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingData: { orchestratorModelSet: true } }),
    }).catch(() => {});
  };

  const dismiss = () => {
    setLocallyDismissed(true);
    fetch("/api/user-preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingData: { harnessChecklistDismissed: true } }),
    }).catch(() => {});
  };

  const whatsappConnected =
    typeof onboardingData.whatsappMode === "string" && onboardingData.whatsappMode !== "skip";

  const items: ChecklistItem[] = useMemo(
    () => [
      {
        id: "connector",
        label: "Connector online",
        done: connectorOnline,
        actionLabel: "Get it",
        href: "/account/downloads",
      },
      {
        id: "model",
        label: "Orchestrator model set",
        done: modelSet,
        actionLabel: "Keep Auto",
        onAction: markModelSet,
        hint: "Or pick one in the command bar below",
      },
      {
        id: "agent",
        label: "First agent created",
        done: agentsCount > 0,
        actionLabel: "Add agent",
        onAction: onAddAgent,
      },
      {
        id: "task",
        label: "First task run",
        done: tasksCount > 0,
        hint: "Ask the orchestrator, or @mention an agent",
      },
      {
        id: "whatsapp",
        label: "WhatsApp connected",
        done: whatsappConnected,
        actionLabel: "Set up",
        href: "/dashboard?settings=1",
      },
    ],
    [connectorOnline, modelSet, agentsCount, tasksCount, whatsappConnected, onAddAgent]
  );

  const doneCount = items.filter((i) => i.done).length;
  const allDone = doneCount === items.length;

  if (dismissed || allDone) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="fixed bottom-24 left-4 z-30 w-[300px] overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 shadow-2xl shadow-black/40 backdrop-blur-xl"
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex flex-1 items-center gap-2.5 text-left"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10">
            <ListChecks className="h-3.5 w-3.5 text-cyan-300" />
          </span>
          <span className="flex-1">
            <span className="block text-sm font-medium text-white">Finish setup</span>
            <span className="block text-[11px] text-zinc-500">
              {doneCount} of {items.length} complete
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 text-zinc-500 transition-transform ${collapsed ? "" : "rotate-180"}`}
          />
        </button>
        <button
          type="button"
          onClick={dismiss}
          title="Dismiss checklist"
          className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-white/10 hover:text-zinc-300"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-0.5 w-full bg-zinc-800">
        <motion.div
          className="h-full bg-gradient-to-r from-cyan-500 to-violet-500"
          initial={false}
          animate={{ width: `${(doneCount / items.length) * 100}%` }}
          transition={{ duration: 0.4 }}
        />
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <ul className="space-y-0.5 p-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-white/[0.03]"
                >
                  {item.done ? (
                    <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
                      <Check className="h-3 w-3 text-emerald-400" />
                    </span>
                  ) : (
                    <Circle className="h-[18px] w-[18px] shrink-0 text-zinc-700" />
                  )}
                  <span className="flex-1 min-w-0">
                    <span
                      className={`block truncate text-xs ${
                        item.done ? "text-zinc-500 line-through decoration-zinc-700" : "text-zinc-200"
                      }`}
                    >
                      {item.label}
                    </span>
                    {!item.done && item.hint && (
                      <span className="block truncate text-[10px] text-zinc-600">{item.hint}</span>
                    )}
                  </span>
                  {!item.done &&
                    (item.onAction ? (
                      <button
                        type="button"
                        onClick={item.onAction}
                        className="shrink-0 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-[10px] font-medium text-cyan-200 transition-all hover:bg-cyan-500/20"
                      >
                        {item.actionLabel}
                      </button>
                    ) : item.href ? (
                      <a
                        href={item.href}
                        className="shrink-0 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-[10px] font-medium text-cyan-200 transition-all hover:bg-cyan-500/20"
                      >
                        {item.actionLabel}
                      </a>
                    ) : null)}
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
