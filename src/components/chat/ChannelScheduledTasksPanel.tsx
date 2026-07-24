"use client";

import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  CalendarPlus,
  ChevronRight,
  Clock3,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  SkipForward,
  Sparkles,
  X,
} from "lucide-react";
import {
  formatChannelSchedule,
  type ChannelScheduleAction,
  type ChannelScheduledTask,
} from "@/lib/chat/channelSchedules";

function relativeTime(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7
    ? `${days}d ago`
    : new Date(timestamp).toLocaleDateString([], {
        month: "short",
        day: "numeric",
      });
}

function statusClasses(status: string | null): string {
  if (status === "success") {
    return "border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-300";
  }
  if (status === "error") {
    return "border-red-400/20 bg-red-400/[0.07] text-red-300";
  }
  if (status === "skipped") {
    return "border-amber-400/20 bg-amber-400/[0.07] text-amber-200";
  }
  return "border-white/[0.08] bg-white/[0.025] text-zinc-500";
}

function statusLabel(status: string): string {
  if (status === "success") return "Completed";
  if (status === "error") return "Failed";
  if (status === "skipped") return "Skipped";
  return status;
}

function TaskCard({
  task,
  busy,
  actionsDisabled,
  onAction,
}: {
  task: ChannelScheduledTask;
  busy: boolean;
  actionsDisabled: boolean;
  onAction: (
    taskId: string,
    action: ChannelScheduleAction,
  ) => Promise<void>;
}) {
  const lastRun = relativeTime(task.lastRunAt);
  return (
    <article
      className={`rounded-2xl border p-3.5 transition ${
        task.enabled
          ? "border-white/10 bg-white/[0.025]"
          : "border-white/[0.06] bg-black/15 opacity-75"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${
            task.enabled
              ? "border-cyan-400/20 bg-cyan-400/[0.07] text-cyan-300"
              : "border-white/[0.08] bg-white/[0.025] text-zinc-600"
          }`}
        >
          <Clock3 className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 truncate text-sm font-medium text-zinc-200">
              {task.name}
            </h3>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                task.enabled
                  ? "border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-200"
                  : "border-white/[0.08] text-zinc-600"
              }`}
            >
              {task.enabled ? "Active" : "Paused"}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-500">
            {task.summary}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-white/[0.06] bg-black/15 px-3 py-2.5">
        <p className="text-[11px] font-medium text-zinc-400">
          {formatChannelSchedule(task.schedule)}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-600">
          <span>Connector local time</span>
          {task.targetAgentName ? (
            <>
              <span>·</span>
              <span className="truncate">{task.targetAgentName}</span>
            </>
          ) : null}
          {task.skipNextRun ? (
            <>
              <span>·</span>
              <span className="text-amber-300/80">Next run skipped</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          {task.lastStatus ? (
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] ${statusClasses(
                task.lastStatus,
              )}`}
            >
              {statusLabel(task.lastStatus)}
              {lastRun ? ` · ${lastRun}` : ""}
            </span>
          ) : (
            <span className="text-[10px] text-zinc-700">Not run yet</span>
          )}
        </div>
        {task.canManage ? (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={actionsDisabled}
              onClick={() =>
                void onAction(task.id, task.enabled ? "pause" : "resume")
              }
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 text-[11px] text-zinc-500 transition hover:border-white/15 hover:bg-white/[0.04] hover:text-zinc-200 disabled:opacity-40"
              aria-label={task.enabled ? "Pause task" : "Resume task"}
              title={task.enabled ? "Pause task" : "Resume task"}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : task.enabled ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              <span>{task.enabled ? "Pause" : "Resume"}</span>
            </button>
            <button
              type="button"
              disabled={
                actionsDisabled || !task.enabled || task.skipNextRun
              }
              onClick={() => void onAction(task.id, "skip")}
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 text-[11px] text-zinc-500 transition hover:border-amber-400/20 hover:bg-amber-400/[0.05] hover:text-amber-200 disabled:opacity-35"
              aria-label="Skip next run"
              title="Skip next run"
            >
              <SkipForward className="h-3.5 w-3.5" />
              <span>{task.skipNextRun ? "Skipped" : "Skip next"}</span>
            </button>
          </div>
        ) : (
          <span className="shrink-0 text-[10px] text-zinc-700">View only</span>
        )}
      </div>
    </article>
  );
}

export function ChannelScheduledTasksPanel({
  channelName,
  tasks,
  loading,
  error,
  migrationPending,
  busyTaskId,
  canCreate,
  onAction,
  onClose,
  onRefresh,
  onCreatePrompt,
}: {
  channelName: string;
  tasks: ChannelScheduledTask[];
  loading: boolean;
  error: string | null;
  migrationPending: boolean;
  busyTaskId: string | null;
  canCreate: boolean;
  onAction: (
    taskId: string,
    action: ChannelScheduleAction,
  ) => Promise<void>;
  onClose: () => void;
  onRefresh: () => void;
  onCreatePrompt: () => void;
}) {
  const activeCount = tasks.filter((task) => task.enabled).length;
  const panelRef = useRef<HTMLElement>(null);
  const [isDrawer, setIsDrawer] = useState(false);

  useEffect(() => {
    const drawerMedia = window.matchMedia("(max-width: 1279px)");
    const focusPanel = () => {
      setIsDrawer(drawerMedia.matches);
      if (!drawerMedia.matches || !panelRef.current) return;
      const closeButton = panelRef.current.querySelector<HTMLButtonElement>(
        "[data-schedule-panel-close]",
      );
      (closeButton || panelRef.current).focus();
    };
    const trapFocus = (event: KeyboardEvent) => {
      if (
        !drawerMedia.matches ||
        event.key !== "Tab" ||
        !panelRef.current
      ) {
        return;
      }
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === panelRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    focusPanel();
    drawerMedia.addEventListener("change", focusPanel);
    document.addEventListener("keydown", trapFocus);
    return () => {
      drawerMedia.removeEventListener("change", focusPanel);
      document.removeEventListener("keydown", trapFocus);
    };
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm xl:hidden"
        aria-label="Close scheduled tasks"
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-50 flex w-[min(23rem,calc(100vw-1rem))] flex-col border-l border-white/10 bg-[#0d0f13] shadow-2xl shadow-black/70 outline-none xl:static xl:z-auto xl:w-[22rem] xl:shrink-0 xl:shadow-none"
        aria-label={`Scheduled tasks for ${channelName}`}
        aria-describedby="channel-scheduled-tasks-context"
        aria-modal={isDrawer || undefined}
        role={isDrawer ? "dialog" : undefined}
      >
        <header className="flex items-start gap-3 border-b border-white/[0.08] px-4 pb-4 pt-[calc(1rem+env(safe-area-inset-top))] xl:pt-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.07] text-cyan-300">
            <CalendarClock className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold">
                Scheduled tasks
              </h2>
              {tasks.length > 0 ? (
                <span className="rounded-full border border-cyan-400/20 bg-cyan-400/[0.06] px-1.5 py-0.5 text-[10px] tabular-nums text-cyan-200">
                  {activeCount} of {tasks.length} active
                </span>
              ) : null}
            </div>
            <p
              id="channel-scheduled-tasks-context"
              className="mt-1 truncate text-[11px] text-zinc-600"
            >
              #{channelName}
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-600 transition hover:bg-white/[0.04] hover:text-zinc-300 disabled:opacity-40"
            aria-label="Refresh scheduled tasks"
            title="Refresh"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </button>
          <button
            data-schedule-panel-close
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-600 transition hover:bg-white/[0.04] hover:text-zinc-300"
            aria-label="Collapse scheduled tasks"
            title="Collapse panel"
          >
            <ChevronRight className="hidden h-4 w-4 xl:block" />
            <X className="h-4 w-4 xl:hidden" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-4">
          {migrationPending ? (
            <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-4 text-xs leading-relaxed text-amber-100">
              Channel schedules are still being activated. Existing scheduler
              jobs continue to run normally.
            </div>
          ) : (
            <>
              {error ? (
                <div
                  role="alert"
                  className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-red-400/20 bg-red-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-red-200"
                >
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={onRefresh}
                    className="shrink-0 font-medium text-red-100 underline decoration-red-300/40 underline-offset-2"
                  >
                    Retry
                  </button>
                </div>
              ) : null}
              {error && tasks.length === 0 ? null : loading &&
                tasks.length === 0 ? (
                <div className="flex min-h-52 items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
                </div>
              ) : tasks.length === 0 ? (
                <div className="flex min-h-[23rem] flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.012] px-5 text-center">
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.025] text-zinc-600">
                    <CalendarPlus className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 text-sm font-medium">
                    Nothing scheduled yet
                  </h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-zinc-600">
                    Ask the channel Mind to run something once or on a recurring
                    cadence. It will appear here for everyone in the channel.
                  </p>
                  {canCreate ? (
                    <button
                      type="button"
                      onClick={onCreatePrompt}
                      className="mt-4 inline-flex items-center gap-2 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.07] px-3.5 py-2.5 text-xs text-cyan-200 transition hover:bg-cyan-400/[0.11]"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Schedule with Groovy
                    </button>
                  ) : (
                    <span className="mt-4 rounded-full border border-white/[0.08] px-2.5 py-1 text-[10px] text-zinc-600">
                      View only
                    </span>
                  )}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {tasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      busy={busyTaskId === task.id}
                      actionsDisabled={busyTaskId !== null}
                      onAction={onAction}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <footer className="border-t border-white/[0.08] p-3.5 pb-[calc(.875rem+env(safe-area-inset-bottom))]">
          {canCreate ? (
            <button
              type="button"
              onClick={onCreatePrompt}
              className="flex w-full items-center justify-between rounded-xl border border-white/[0.08] bg-white/[0.025] px-3.5 py-3 text-left transition hover:border-cyan-400/20 hover:bg-cyan-400/[0.04]"
            >
              <span>
                <span className="block text-xs text-zinc-300">
                  Schedule another task
                </span>
                <span className="mt-0.5 block text-[10px] text-zinc-600">
                  Continue in the channel composer
                </span>
              </span>
              <CalendarPlus className="h-4 w-4 text-cyan-300" />
            </button>
          ) : (
            <p className="px-1 text-[11px] leading-relaxed text-zinc-600">
              Channel guests can follow scheduled work. A workspace member can
              create or change it.
            </p>
          )}
        </footer>
      </aside>
    </>
  );
}
