"use client";

/**
 * OrchestratorRail — the orchestrator's mind, visible.
 *
 * Two tabs:
 *  - Chat: the orchestrator conversation (what you asked, how it responded,
 *    delegation events as they land).
 *  - Tasks: the live agent_tasks feed with inline approve/reject.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CheckCircle2,
  Circle,
  Clock,
  ListTodo,
  Loader2,
  MessageSquare,
  ShieldAlert,
  X,
  XCircle,
} from "lucide-react";
import type { OrchestratorMessage } from "@/hooks/useOrchestrator";
import type { AgentTask, AgentTaskStatus } from "@/hooks/useAgentTasks";
import type { WorkerAgentInfo } from "@/hooks/useWorkerAgents";
import { CustomSelect } from "@/components/ui/CustomSelect";

function StatusIcon({ status }: { status: AgentTaskStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="w-3.5 h-3.5 text-cyan-300 animate-spin" />;
    case "queued":
      return <Clock className="w-3.5 h-3.5 text-zinc-500" />;
    case "awaiting_approval":
      return <ShieldAlert className="w-3.5 h-3.5 text-amber-300" />;
    case "done":
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
    case "failed":
      return <XCircle className="w-3.5 h-3.5 text-red-400" />;
    case "canceled":
      return <Circle className="w-3.5 h-3.5 text-zinc-600" />;
  }
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function OrchestratorRail({
  messages,
  isStreaming,
  streamingContent,
  tasks,
  agents,
  onTaskAction,
  onApprovePlan,
  onUpdatePlan,
  onInvestigatePlan,
}: {
  messages: OrchestratorMessage[];
  isStreaming: boolean;
  streamingContent: string;
  tasks: AgentTask[];
  agents: WorkerAgentInfo[];
  onTaskAction: (taskId: string, action: "approve" | "reject" | "cancel") => void;
  onApprovePlan: (
    taskId: string,
    executeAgent?: string
  ) => Promise<{ ok: boolean; error?: string }>;
  onUpdatePlan: (
    taskId: string,
    plan: string
  ) => Promise<{ ok: boolean; error?: string }>;
  onInvestigatePlan: (input: {
    planningSessionId: string;
    agentName: string;
    objective: string;
  }) => void;
}) {
  const [tab, setTab] = useState<"chat" | "tasks">("chat");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [planExecAgent, setPlanExecAgent] = useState<Record<string, string>>({});
  const [planBusyTaskId, setPlanBusyTaskId] = useState<string | null>(null);
  const [planActionError, setPlanActionError] = useState<Record<string, string>>({});
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [planDraft, setPlanDraft] = useState("");
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const agentNameById = useMemo(
    () => new Map(agents.map((a) => [a.id, a.name])),
    [agents]
  );

  const openCount = useMemo(
    () =>
      tasks.filter((t) => ["queued", "running", "awaiting_approval"].includes(t.status))
        .length,
    [tasks]
  );
  const approvalCount = useMemo(
    () => tasks.filter((t) => t.status === "awaiting_approval").length,
    [tasks]
  );

  // Keep the newest response visible. A persistence refresh replaces optimistic
  // message objects (and their temporary ids) without necessarily changing the
  // array length, so depending on messages.length lets the rail jump back into
  // old history exactly when a stream becomes a saved message.
  useEffect(() => {
    if (tab === "chat") {
      const frame = window.requestAnimationFrame(() => {
        const container = chatScrollRef.current;
        if (container) {
          container.scrollTop = container.scrollHeight;
        } else {
          chatEndRef.current?.scrollIntoView({ block: "end" });
        }
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [messages, streamingContent, tab]);

  // Jump to Tasks when an approval arrives.
  useEffect(() => {
    if (approvalCount > 0) setTab("tasks");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalCount > 0]);

  return (
    <div className="h-full flex flex-col bg-zinc-900/40 border-l border-white/5">
      {/* Tabs */}
      <div className="flex items-center px-2 pt-2 gap-1">
        <button
          onClick={() => setTab("chat")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            tab === "chat" ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Orchestrator
        </button>
        <button
          onClick={() => setTab("tasks")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            tab === "tasks" ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <ListTodo className="w-3.5 h-3.5" />
          Tasks
          {openCount > 0 && (
            <span
              className={`min-w-[16px] h-4 px-1 rounded-full text-[10px] flex items-center justify-center ${
                approvalCount > 0 ? "bg-amber-400 text-black" : "bg-cyan-400/20 text-cyan-300"
              }`}
            >
              {openCount}
            </span>
          )}
        </button>
      </div>

      {tab === "chat" ? (
        <div
          ref={chatScrollRef}
          className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3"
        >
          {messages.length === 0 && !isStreaming ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center px-4">
                <p className="text-xs text-zinc-600 leading-relaxed">
                  The orchestrator plans, delegates to your agents, and reports
                  back here. Ask for anything below.
                </p>
              </div>
            </div>
          ) : (
            messages.map((msg) => {
              const isTaskEvent =
                msg.role === "assistant" &&
                (msg.metadata as { kind?: string } | null | undefined)?.kind === "task_event";
              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`${msg.role === "user" ? "pl-6" : "pr-2"}`}
                >
                  <div
                    className={`rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                      msg.role === "user"
                        ? "bg-cyan-500/10 border border-cyan-500/15 text-white"
                        : isTaskEvent
                          ? "bg-violet-500/5 border border-violet-500/15 text-zinc-300"
                          : "bg-white/5 border border-white/5 text-zinc-300"
                    }`}
                  >
                    {msg.content}
                  </div>
                </motion.div>
              );
            })
          )}
          {isStreaming && (
            <div className="pr-2">
              <div className="rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap bg-white/5 border border-white/5 text-zinc-300">
                {streamingContent || (
                  <span className="inline-flex items-center gap-1.5 text-zinc-500">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    thinking…
                  </span>
                )}
                {streamingContent && (
                  <span className="inline-block w-1.5 h-3.5 bg-cyan-400 ml-0.5 animate-pulse align-text-bottom" />
                )}
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1.5">
          {tasks.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-xs text-zinc-600 text-center px-6 leading-relaxed">
                No tasks yet. Delegate with “@agent do …” or let the
                orchestrator route work for you.
              </p>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {tasks.map((task) => {
                const expanded = expandedTaskId === task.id;
                const meta = (task.result_meta || {}) as {
                  plan_mode?: boolean;
                  consultation_mode?: boolean;
                  planning_round?: number;
                  planning_depth?: string;
                  planning_consultation_count?: number;
                  orchestrator_synthesized?: boolean;
                  planning_session_id?: string;
                  planning_objective?: string;
                  plan_approved_at?: string;
                  plan_filename?: string;
                  plan_execution_agent_name?: string;
                  planning_status?: string;
                };
                const isConsultation = meta.consultation_mode === true;
                const isApprovablePlan =
                  meta.plan_mode === true && task.status === "done" && !meta.plan_approved_at;
                const planningAgent = agents.find((agent) => agent.id === task.agent_id) || null;
                const eligiblePlanAgents = planningAgent
                  ? agents.filter(
                      (agent) =>
                        agent.deviceId === planningAgent.deviceId &&
                        agent.workspaceId === planningAgent.workspaceId
                    )
                  : [];
                const hasExecutorChoice = Object.prototype.hasOwnProperty.call(
                  planExecAgent,
                  task.id
                );
                const selectedExecutorId = hasExecutorChoice
                  ? planExecAgent[task.id]
                  : planningAgent?.id || "";
                const selectedExecutor =
                  eligiblePlanAgents.find((agent) => agent.id === selectedExecutorId) || null;
                return (
                  <motion.div
                    key={task.id}
                    layout
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className={`rounded-xl border transition-colors ${
                      task.status === "awaiting_approval"
                        ? "border-amber-400/25 bg-amber-400/[0.04]"
                        : isConsultation
                          ? "border-violet-400/20 bg-violet-500/[0.035]"
                        : "border-white/5 bg-white/[0.02] hover:bg-white/[0.04]"
                    }`}
                  >
                    <button
                      onClick={() => setExpandedTaskId(expanded ? null : task.id)}
                      className="w-full flex items-start gap-2 px-2.5 py-2 text-left"
                    >
                      <span className="mt-0.5 shrink-0">
                        <StatusIcon status={task.status} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs text-zinc-200 truncate">
                          {task.title || task.prompt}
                        </span>
                        <span className="block text-[10px] text-zinc-600 mt-0.5">
                          {agentNameById.get(task.agent_id) || "agent"} ·{" "}
                          {timeAgo(task.created_at)} ago
                          {task.source !== "orchestrator" ? ` · ${task.source}` : ""}
                        </span>
                      </span>
                    </button>

                    {isConsultation && (
                      <div className="mx-2.5 mb-2 flex items-center gap-1.5 rounded-lg border border-violet-400/10 bg-violet-500/5 px-2 py-1.5 text-[10px] text-violet-200/80">
                        {task.status === "running" || task.status === "queued" ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                        )}
                        <span>
                          {task.status === "running" || task.status === "queued"
                            ? "Exploring repository in read-only mode"
                            : "Repository evidence collected"}
                          {meta.planning_round ? ` · Round ${meta.planning_round}` : ""}
                          {meta.planning_depth ? ` · ${meta.planning_depth}` : ""}
                        </span>
                      </div>
                    )}

                    {task.status === "awaiting_approval" && (
                      <div className="flex gap-1.5 px-2.5 pb-2">
                        <button
                          onClick={() => onTaskAction(task.id, "approve")}
                          className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 text-[11px] font-medium transition-colors"
                        >
                          <Check className="w-3 h-3" /> Approve
                        </button>
                        <button
                          onClick={() => onTaskAction(task.id, "reject")}
                          className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-red-500/10 text-red-300 hover:bg-red-500/20 text-[11px] font-medium transition-colors"
                        >
                          <X className="w-3 h-3" /> Reject
                        </button>
                      </div>
                    )}

                    {/* Plan approval: save to workspace/.claude/plans, pick executor */}
                    {isApprovablePlan && (
                      <div className="px-2.5 pb-2.5 space-y-1.5">
                        <div className="text-[10px] text-violet-300/90">
                          📋 {meta.orchestrator_synthesized
                            ? `Orchestrator plan synthesized from ${meta.planning_consultation_count || 1} repository consultation${(meta.planning_consultation_count || 1) === 1 ? "" : "s"}`
                            : "Plan ready"} — approve to save it to the workspace&apos;s
                          .claude/plans (readable by every agent).
                        </div>
                        <div className="rounded-lg border border-cyan-400/15 bg-cyan-400/5 px-2 py-1.5 text-[10px] leading-relaxed text-cyan-100/80">
                          Choose an agent in this workspace, then <strong>Approve &amp; run</strong>.
                          Groovy saves the plan first and immediately queues its execution. Choose
                          <strong> Save without running</strong> only if you want to execute it later
                          from Plans.
                        </div>
                        <div className="flex gap-1.5">
                          {meta.planning_session_id && (
                            <button
                              type="button"
                              onClick={() => {
                                setTab("chat");
                                onInvestigatePlan({
                                  planningSessionId: meta.planning_session_id!,
                                  agentName: agentNameById.get(task.agent_id) || "selected agent",
                                  objective:
                                    meta.planning_objective || task.title || "this implementation plan",
                                });
                              }}
                              className="flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[10px] font-medium text-zinc-300 hover:bg-white/10"
                            >
                              Investigate more
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              if (editingPlanId === task.id) {
                                setEditingPlanId(null);
                                return;
                              }
                              setEditingPlanId(task.id);
                              setPlanDraft(task.result_text || "");
                            }}
                            className="flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[10px] font-medium text-zinc-300 hover:bg-white/10"
                          >
                            {editingPlanId === task.id ? "Cancel editing" : "Edit plan"}
                          </button>
                        </div>
                        {editingPlanId === task.id && (
                          <div className="space-y-1.5">
                            <textarea
                              value={planDraft}
                              onChange={(event) => setPlanDraft(event.target.value)}
                              rows={10}
                              className="w-full resize-y rounded-lg border border-violet-400/20 bg-black/30 p-2 text-[11px] leading-relaxed text-zinc-200 outline-none focus:border-violet-300/50"
                              aria-label="Edit implementation plan"
                            />
                            <button
                              type="button"
                              disabled={!planDraft.trim() || planBusyTaskId === task.id}
                              onClick={async () => {
                                setPlanBusyTaskId(task.id);
                                const result = await onUpdatePlan(task.id, planDraft);
                                setPlanBusyTaskId(null);
                                if (result.ok) {
                                  setEditingPlanId(null);
                                  setPlanActionError((prev) => ({ ...prev, [task.id]: "" }));
                                } else {
                                  setPlanActionError((prev) => ({
                                    ...prev,
                                    [task.id]: result.error || "Could not update this plan",
                                  }));
                                }
                              }}
                              className="w-full rounded-lg bg-violet-500/20 px-2 py-1.5 text-[10px] font-medium text-violet-100 hover:bg-violet-500/30 disabled:opacity-40"
                            >
                              Save plan edits
                            </button>
                          </div>
                        )}
                        <div className="flex gap-1.5">
                          <CustomSelect
                            value={selectedExecutorId}
                            onChange={(nextValue) =>
                              setPlanExecAgent((prev) => ({
                                ...prev,
                                [task.id]: nextValue,
                              }))
                            }
                            options={[
                              { value: "", label: "Save without running" },
                              ...eligiblePlanAgents.map((agent) => ({
                                value: agent.id,
                                label: `Run with ${agent.name} (${
                                  agent.harness === "codex"
                                    ? "Codex"
                                    : "Claude Code"
                                })`,
                              })),
                            ]}
                            className="min-w-0 flex-1"
                            triggerClassName="border-violet-400/20"
                            ariaLabel="Plan executor"
                            size="xs"
                          />
                          <button
                            disabled={planBusyTaskId === task.id}
                            onClick={async () => {
                              setPlanBusyTaskId(task.id);
                              setPlanActionError((prev) => ({ ...prev, [task.id]: "" }));
                              try {
                                const result = await onApprovePlan(
                                  task.id,
                                  selectedExecutorId || undefined
                                );
                                if (!result.ok) {
                                  setPlanActionError((prev) => ({
                                    ...prev,
                                    [task.id]: result.error || "Could not approve this plan",
                                  }));
                                }
                              } finally {
                                setPlanBusyTaskId(null);
                              }
                            }}
                            className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-violet-500/20 text-violet-200 hover:bg-violet-500/30 text-[11px] font-medium transition-colors disabled:opacity-50"
                          >
                            {planBusyTaskId === task.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Check className="w-3 h-3" />
                            )}
                            {selectedExecutor ? "Approve & run" : "Approve & save"}
                          </button>
                        </div>
                        {eligiblePlanAgents.length === 0 && (
                          <div className="text-[10px] text-amber-200/90">
                            No execution agent is attached to this plan&apos;s workspace. Save the plan,
                            then create or move an agent to that workspace from Plans.
                          </div>
                        )}
                        {planActionError[task.id] && (
                          <div className="rounded-lg border border-amber-400/15 bg-amber-400/5 px-2 py-1.5 text-[10px] leading-relaxed text-amber-200">
                            {planActionError[task.id]}
                          </div>
                        )}
                      </div>
                    )}
                    {meta.plan_mode === true && meta.plan_approved_at && (
                      <div className="px-2.5 pb-2 text-[10px] text-emerald-400/90">
                        ✓ {meta.planning_status === "executing" && meta.plan_execution_agent_name
                          ? `Approved — running with ${meta.plan_execution_agent_name}`
                          : "Approved and saved — open Plans to run it"}
                        {meta.plan_filename ? ` — saved as .claude/plans/${meta.plan_filename}` : ""}
                      </div>
                    )}

                    <AnimatePresence>
                      {expanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="px-2.5 pb-2.5 space-y-2">
                            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">
                              Prompt
                            </div>
                            <div className="text-[11px] text-zinc-400 whitespace-pre-wrap break-words max-h-24 overflow-y-auto rounded-lg bg-black/20 p-2">
                              {task.prompt}
                            </div>
                            {task.result_text && (
                              <>
                                <div className="text-[10px] text-zinc-500 uppercase tracking-wider">
                                  Result
                                </div>
                                <div className="text-[11px] text-zinc-300 whitespace-pre-wrap break-words max-h-40 overflow-y-auto rounded-lg bg-black/20 p-2">
                                  {task.result_text}
                                </div>
                              </>
                            )}
                            {task.error && (
                              <div className="text-[11px] text-red-300/90 rounded-lg bg-red-500/5 border border-red-500/10 p-2">
                                {task.error}
                              </div>
                            )}
                            {(task.status === "queued" ||
                              task.status === "awaiting_approval") && (
                              <button
                                onClick={() => onTaskAction(task.id, "cancel")}
                                className="text-[10px] text-zinc-500 hover:text-red-300 transition-colors"
                              >
                                Cancel task
                              </button>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          )}
        </div>
      )}
    </div>
  );
}
