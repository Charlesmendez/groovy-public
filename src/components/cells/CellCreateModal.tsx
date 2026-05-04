"use client";

import { useMemo, useState } from "react";
import {
  Bot,
  Check,
  Loader2,
  Plus,
  Sparkles,
  Target,
  Users,
  X,
} from "lucide-react";
import type { CellAgentOption } from "@/lib/cells/types";

export type CellWorkspaceMemberOption = {
  userId: string;
  email: string | null;
  role: "admin" | "member";
};

type CellCreateModalProps = {
  isOpen: boolean;
  onClose: () => void;
  agents: CellAgentOption[];
  members: CellWorkspaceMemberOption[];
  onCreated: (cellId: string) => void;
};

function sectionCard(title: string, description: string, icon: React.ReactNode, children: React.ReactNode) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 sm:p-5">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-2xl border border-white/10 bg-white/[0.04] flex items-center justify-center text-cyan-300">
          {icon}
        </div>
        <div>
          <div className="text-sm font-medium text-white">{title}</div>
          <div className="text-xs text-zinc-500 mt-1">{description}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

export function CellCreateModal({
  isOpen,
  onClose,
  agents,
  members,
  onCreated,
}: CellCreateModalProps) {
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgentId) || null,
    [agents, selectedAgentId]
  );

  const selectedMembers = useMemo(
    () => members.filter((member) => selectedMemberIds.includes(member.userId)),
    [members, selectedMemberIds]
  );

  const availableAgents = useMemo(
    () => agents.filter((agent) => !agent.assignedCellId || agent.agentId === selectedAgentId),
    [agents, selectedAgentId]
  );

  if (!isOpen) return null;

  const toggleMember = (userId: string) => {
    setSelectedMemberIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const resetAndClose = () => {
    setSelectedAgentId("");
    setSelectedMemberIds([]);
    setName("");
    setObjective("");
    setError(null);
    setSubmitting(false);
    onClose();
  };

  const canSubmit =
    !!selectedAgentId &&
    selectedMemberIds.length > 0 &&
    name.trim().length > 0 &&
    objective.trim().length > 0 &&
    !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/workspaces/cells", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgentId,
          memberUserIds: selectedMemberIds,
          name: name.trim(),
          objective: objective.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.cellId) {
        throw new Error(typeof json?.error === "string" ? json.error : "Failed to create cell");
      }
      onCreated(String(json.cellId));
      resetAndClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create cell");
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120]">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={resetAndClose} />
      <div className="absolute inset-0 overflow-y-auto">
        <div className="min-h-full flex items-center justify-center p-4 sm:p-6">
          <div className="relative w-full max-w-6xl rounded-[28px] border border-white/10 bg-[#0b0b0d] shadow-2xl overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-r from-cyan-500/12 via-emerald-500/8 to-fuchsia-500/12 pointer-events-none" />
            <div className="relative border-b border-white/8 px-5 sm:px-6 py-5 flex items-start justify-between gap-4">
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 text-[11px] uppercase tracking-[0.16em] text-cyan-200">
                  <Sparkles className="w-3.5 h-3.5" />
                  New Cell
                </div>
                <h2 className="text-xl sm:text-2xl font-semibold text-white mt-3">Create a living cell</h2>
                <p className="text-sm text-zinc-400 mt-2 max-w-2xl leading-relaxed">
                  Pick the existing agent, choose the humans orbiting it, and define the objective.
                  Groovy will generate OKRs, signal types, and the performance scorecard automatically.
                </p>
              </div>
              <button
                type="button"
                onClick={resetAndClose}
                className="w-10 h-10 rounded-xl border border-white/10 bg-white/[0.04] text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors flex items-center justify-center shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[1.55fr_0.95fr] gap-0">
              <div className="p-5 sm:p-6 space-y-5">
                {sectionCard(
                  "Select Existing Agent",
                  "The cell wraps an existing Groovy agent. If the agent is not yet shared to the workspace, Groovy will share it automatically.",
                  <Bot className="w-5 h-5" />,
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 max-h-[300px] overflow-y-auto pr-1">
                    {availableAgents.length === 0 && (
                      <div className="col-span-full rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-sm text-zinc-500">
                        No eligible agents found. Create or share an agent first.
                      </div>
                    )}
                    {availableAgents.map((agent) => {
                      const selected = selectedAgentId === agent.agentId;
                      const disabled = !!agent.assignedCellId && agent.agentId !== selectedAgentId;
                      return (
                        <button
                          key={agent.agentId}
                          type="button"
                          disabled={disabled}
                          onClick={() => setSelectedAgentId(agent.agentId)}
                          className={`rounded-2xl border p-4 text-left transition-all ${
                            selected
                              ? "border-cyan-400/50 bg-cyan-500/10 shadow-[0_0_0_1px_rgba(34,211,238,0.15)]"
                              : disabled
                                ? "border-white/6 bg-white/[0.02] opacity-45 cursor-not-allowed"
                                : "border-white/8 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/14"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-white truncate">{agent.name}</div>
                              <div className="text-xs text-zinc-500 mt-1">
                                {agent.ownerEmail || "Unknown owner"}
                              </div>
                            </div>
                            {selected ? (
                              <div className="w-7 h-7 rounded-xl bg-cyan-400/20 text-cyan-200 flex items-center justify-center shrink-0">
                                <Check className="w-4 h-4" />
                              </div>
                            ) : (
                              <div className="w-7 h-7 rounded-xl border border-white/10 bg-black/30 shrink-0" />
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2 mt-3">
                            <span
                              className={`px-2 py-1 rounded-full border text-[10px] ${
                                agent.agentType === "claude-code"
                                  ? "border-cyan-500/25 bg-cyan-500/10 text-cyan-200"
                                  : "border-violet-500/25 bg-violet-500/10 text-violet-200"
                              }`}
                            >
                              {agent.agentType === "claude-code" ? "Claude Code" : "Primary Agent"}
                            </span>
                            <span className="px-2 py-1 rounded-full border border-white/10 bg-white/[0.03] text-[10px] text-zinc-400">
                              {agent.messageCount} msgs
                            </span>
                            <span
                              className={`px-2 py-1 rounded-full border text-[10px] ${
                                agent.shared
                                  ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                                  : "border-amber-500/25 bg-amber-500/10 text-amber-300"
                              }`}
                            >
                              {agent.shared ? "Shared to workspace" : "Private now"}
                            </span>
                          </div>
                          {disabled && (
                            <div className="text-[11px] text-amber-300 mt-3">Already assigned to another cell.</div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

                {sectionCard(
                  "Choose Humans",
                  "A cell can have just one human or a full team. These are the people whose signal and connected artifacts will be tracked.",
                  <Users className="w-5 h-5" />,
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {members.map((member) => {
                        const selected = selectedMemberIds.includes(member.userId);
                        return (
                          <button
                            key={member.userId}
                            type="button"
                            onClick={() => toggleMember(member.userId)}
                            className={`px-3 py-2 rounded-xl border text-left transition-colors ${
                              selected
                                ? "border-cyan-400/45 bg-cyan-500/10 text-cyan-100"
                                : "border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]"
                            }`}
                          >
                            <div className="text-sm">{member.email || member.userId.slice(0, 8)}</div>
                            <div className="text-[10px] mt-1 opacity-75 uppercase tracking-wide">
                              {member.role}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {selectedMembers.length > 0 && (
                      <div className="rounded-2xl border border-white/8 bg-black/30 p-3">
                        <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500 mb-2">
                          Selected Humans
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {selectedMembers.map((member) => (
                            <span
                              key={member.userId}
                              className="px-2.5 py-1.5 rounded-full bg-white/[0.05] border border-white/10 text-xs text-zinc-200"
                            >
                              {member.email || member.userId.slice(0, 8)}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {sectionCard(
                  "Define Objective",
                  "Write the mission in plain English. Groovy will translate this into OKRs, signal taxonomy, and dynamic evaluation logic.",
                  <Target className="w-5 h-5" />,
                  <div className="space-y-3">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Cell name"
                      className="w-full px-4 py-3 rounded-2xl bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/45 transition-colors"
                    />
                    <textarea
                      value={objective}
                      onChange={(e) => setObjective(e.target.value)}
                      placeholder="Example: Book 20 qualified demos this month from inbound leads while keeping response times under 2 hours."
                      rows={6}
                      className="w-full px-4 py-3 rounded-2xl bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/45 transition-colors resize-none"
                    />
                  </div>
                )}
              </div>

              <div className="border-t xl:border-t-0 xl:border-l border-white/8 p-5 sm:p-6 bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.09),_transparent_35%),linear-gradient(180deg,rgba(255,255,255,0.025),rgba(255,255,255,0))]">
                <div className="sticky top-6 space-y-4">
                  <div className="rounded-[24px] border border-white/10 bg-black/35 p-4 sm:p-5">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Blueprint Preview</div>
                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="text-xs text-zinc-500 mb-1">Agent</div>
                        <div className="flex items-center gap-2 text-sm text-white">
                          <Bot className="w-4 h-4 text-cyan-300" />
                          <span>{selectedAgent?.name || "Choose an agent"}</span>
                        </div>
                        {selectedAgent && (
                          <div className="text-xs text-zinc-500 mt-2">
                            {selectedAgent.agentType === "claude-code" ? "Claude Code sub-agent" : "Primary runtime agent"}
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="text-xs text-zinc-500 mb-1">Humans</div>
                        <div className="text-sm text-white">
                          {selectedMembers.length > 0
                            ? `${selectedMembers.length} selected`
                            : "Choose at least one human"}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-zinc-500 mb-1">Objective</div>
                        <div className="text-sm text-zinc-300 leading-relaxed">
                          {objective.trim()
                            ? objective.trim()
                            : "Write the mission. Groovy will generate OKRs, signal types, and efficiency framing from it."}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[24px] border border-cyan-500/15 bg-cyan-500/[0.06] p-4 sm:p-5">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-2xl bg-cyan-400/15 border border-cyan-400/20 text-cyan-200 flex items-center justify-center shrink-0">
                        <Sparkles className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-cyan-100">What Groovy generates for you</div>
                        <div className="text-xs text-cyan-100/75 mt-1 leading-relaxed">
                          OKRs and key results, a custom signal taxonomy, health signal tracking with Upready when connected,
                          and an efficiency model that detects looping vs productive execution.
                        </div>
                      </div>
                    </div>
                  </div>

                  {error && (
                    <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                      {error}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 pt-2">
                    <button
                      type="button"
                      onClick={resetAndClose}
                      className="px-4 py-2.5 rounded-2xl border border-white/10 bg-white/[0.03] text-sm text-zinc-300 hover:bg-white/[0.06] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!canSubmit}
                      onClick={submit}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-cyan-500/15 border border-cyan-400/30 text-sm text-cyan-100 hover:bg-cyan-500/22 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {submitting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Creating Cell...
                        </>
                      ) : (
                        <>
                          <Plus className="w-4 h-4" />
                          Create Cell
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
