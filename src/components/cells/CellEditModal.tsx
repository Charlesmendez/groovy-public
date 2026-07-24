"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw, Save, Target, Trash2, Users, X } from "lucide-react";
import type { CellDetail } from "@/lib/cells/types";
import type { CellWorkspaceMemberOption } from "@/components/cells/CellCreateModal";
import { CustomSelect } from "@/components/ui/CustomSelect";

type CellEditModalProps = {
  isOpen: boolean;
  cell: CellDetail | null;
  members: CellWorkspaceMemberOption[];
  onClose: () => void;
  onSaved: () => void;
};

type EditableKeyResult = {
  id?: string;
  label: string;
  description: string;
  measurementMode: "computed" | "hybrid" | "manual";
  evaluationMethod: string;
  targetValue: string;
  direction: "increase" | "decrease" | "maintain" | "binary";
};

function emptyKeyResult(): EditableKeyResult {
  return {
    label: "",
    description: "",
    measurementMode: "hybrid",
    evaluationMethod: "",
    targetValue: "",
    direction: "increase",
  };
}

export function CellEditModal({ isOpen, cell, members, onClose, onSaved }: CellEditModalProps) {
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [status, setStatus] = useState<"active" | "paused" | "archived">("active");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [keyResults, setKeyResults] = useState<EditableKeyResult[]>([]);
  const [regenerateFramework, setRegenerateFramework] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !cell) return;
    setName(cell.summary.name);
    setObjective(cell.summary.objective);
    setStatus(cell.summary.status);
    setSelectedMemberIds(cell.summary.members.map((member) => member.userId));
    setKeyResults(
      cell.summary.keyResults.length > 0
        ? cell.summary.keyResults.map((kr) => ({
            id: kr.id,
            label: kr.label,
            description: kr.description || "",
            measurementMode: kr.measurementMode,
            evaluationMethod: kr.evaluationMethod || "",
            targetValue: kr.targetValue || "",
            direction: kr.direction,
          }))
        : [emptyKeyResult()]
    );
    setRegenerateFramework(false);
    setError(null);
    setSaving(false);
  }, [isOpen, cell]);

  if (!isOpen || !cell) return null;

  const toggleMember = (userId: string) => {
    setSelectedMemberIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const updateKeyResult = (index: number, patch: Partial<EditableKeyResult>) => {
    setKeyResults((prev) => prev.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  };

  const addKeyResult = () => {
    setKeyResults((prev) => [...prev, emptyKeyResult()]);
  };

  const removeKeyResult = (index: number) => {
    setKeyResults((prev) => (prev.length === 1 ? prev : prev.filter((_, itemIndex) => itemIndex !== index)));
  };

  const submit = async () => {
    if (!name.trim() || !objective.trim() || selectedMemberIds.length === 0) {
      setError("Name, objective, and at least one human are required.");
      return;
    }
    if (!regenerateFramework && keyResults.some((kr) => !kr.label.trim())) {
      setError("Each key result needs a label, or regenerate the blueprint.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/cells/${cell.summary.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          objective: objective.trim(),
          status,
          memberUserIds: selectedMemberIds,
          regenerateFramework,
          keyResults: regenerateFramework
            ? undefined
            : keyResults.map((kr) => ({
                id: kr.id,
                label: kr.label.trim(),
                description: kr.description.trim() || null,
                measurementMode: kr.measurementMode,
                evaluationMethod: kr.evaluationMethod.trim() || null,
                targetValue: kr.targetValue.trim() || null,
                direction: kr.direction,
              })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof json?.error === "string" ? json.error : "Failed to update cell");
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update cell");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120]">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute inset-0 overflow-y-auto">
        <div className="min-h-full flex items-center justify-center p-4 sm:p-6">
          <div className="w-full max-w-5xl rounded-[28px] border border-white/10 bg-[#0b0b0d] shadow-2xl overflow-hidden">
            <div className="border-b border-white/8 px-5 sm:px-6 py-5 flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Edit Cell</div>
                <h2 className="text-2xl font-semibold text-white mt-2">{cell.summary.name}</h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="w-10 h-10 rounded-xl border border-white/10 bg-white/[0.04] text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors flex items-center justify-center shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 sm:p-6 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Cell name"
                  className="w-full px-4 py-3 rounded-2xl bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/45 transition-colors"
                />

                <CustomSelect
                  value={status}
                  onChange={(nextValue) =>
                    setStatus(nextValue as typeof status)
                  }
                  options={[
                    { value: "active", label: "Active" },
                    { value: "paused", label: "Paused" },
                    { value: "archived", label: "Archived" },
                  ]}
                  className="sm:w-36"
                  ariaLabel="Cell status"
                  size="lg"
                />
              </div>

              <textarea
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                rows={6}
                className="w-full px-4 py-3 rounded-2xl bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/45 transition-colors resize-none"
              />

              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                <div className="flex items-center gap-2 text-sm text-white">
                  <Users className="w-4 h-4 text-cyan-300" />
                  Humans in this cell
                </div>
                <div className="flex flex-wrap gap-2 mt-4">
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
              </div>

              <label className="flex items-start gap-3 rounded-2xl border border-cyan-500/15 bg-cyan-500/[0.05] p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={regenerateFramework}
                  onChange={(e) => setRegenerateFramework(e.target.checked)}
                  className="mt-0.5"
                />
                <div>
                  <div className="flex items-center gap-2 text-sm text-cyan-100">
                    <RefreshCw className="w-4 h-4" />
                    Regenerate AI blueprint
                  </div>
                  <div className="text-xs text-cyan-100/70 mt-1 leading-relaxed">
                    Rebuild OKRs and signal taxonomy from the current objective before saving. If you change the
                    objective, Groovy will also refresh the blueprint and replace manual KR edits.
                  </div>
                </div>
              </label>

              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm text-white">
                      <Target className="w-4 h-4 text-cyan-300" />
                      Editable Key Results
                    </div>
                    <div className="text-xs text-zinc-500 mt-1 leading-relaxed">
                      Edit KRs directly when the objective is stable. If you regenerate the blueprint, these manual
                      edits will be replaced.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={addKeyResult}
                    disabled={regenerateFramework}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-white/10 bg-white/[0.03] text-sm text-zinc-200 hover:bg-white/[0.06] disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                    Add KR
                  </button>
                </div>

                <div className={`space-y-4 mt-4 ${regenerateFramework ? "opacity-50" : ""}`}>
                  {keyResults.map((kr, index) => (
                    <div key={kr.id || `kr-${index}`} className="rounded-2xl border border-white/8 bg-black/25 p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                          Key Result {index + 1}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeKeyResult(index)}
                          disabled={regenerateFramework || keyResults.length === 1}
                          className="w-8 h-8 rounded-xl border border-white/10 bg-white/[0.03] text-zinc-400 hover:text-rose-300 hover:bg-rose-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      <input
                        value={kr.label}
                        onChange={(e) => updateKeyResult(index, { label: e.target.value })}
                        disabled={regenerateFramework}
                        placeholder="KR label"
                        className="w-full px-4 py-3 rounded-2xl bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/45 transition-colors disabled:cursor-not-allowed"
                      />

                      <textarea
                        value={kr.description}
                        onChange={(e) => updateKeyResult(index, { description: e.target.value })}
                        disabled={regenerateFramework}
                        rows={2}
                        placeholder="What does this KR represent?"
                        className="w-full px-4 py-3 rounded-2xl bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/45 transition-colors resize-none disabled:cursor-not-allowed"
                      />

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <CustomSelect
                          value={kr.measurementMode}
                          onChange={(nextValue) =>
                            updateKeyResult(index, {
                              measurementMode:
                                nextValue as EditableKeyResult["measurementMode"],
                            })
                          }
                          disabled={regenerateFramework}
                          options={[
                            { value: "computed", label: "Computed" },
                            { value: "hybrid", label: "Hybrid" },
                            { value: "manual", label: "Manual" },
                          ]}
                          ariaLabel={`Key result ${index + 1} measurement mode`}
                          size="lg"
                        />

                        <CustomSelect
                          value={kr.direction}
                          onChange={(nextValue) =>
                            updateKeyResult(index, {
                              direction:
                                nextValue as EditableKeyResult["direction"],
                            })
                          }
                          disabled={regenerateFramework}
                          options={[
                            { value: "increase", label: "Increase" },
                            { value: "decrease", label: "Decrease" },
                            { value: "maintain", label: "Maintain" },
                            { value: "binary", label: "Binary" },
                          ]}
                          ariaLabel={`Key result ${index + 1} direction`}
                          size="lg"
                        />

                        <input
                          value={kr.targetValue}
                          onChange={(e) => updateKeyResult(index, { targetValue: e.target.value })}
                          disabled={regenerateFramework}
                          placeholder="Target value"
                          className="w-full px-4 py-3 rounded-2xl bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/45 transition-colors disabled:cursor-not-allowed"
                        />
                      </div>

                      <textarea
                        value={kr.evaluationMethod}
                        onChange={(e) => updateKeyResult(index, { evaluationMethod: e.target.value })}
                        disabled={regenerateFramework}
                        rows={2}
                        placeholder="How should this KR be evaluated from artifacts?"
                        className="w-full px-4 py-3 rounded-2xl bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-cyan-500/45 transition-colors resize-none disabled:cursor-not-allowed"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {error && (
                <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                  {error}
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2.5 rounded-2xl border border-white/10 bg-white/[0.03] text-sm text-zinc-300 hover:bg-white/[0.06] transition-colors"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={submit}
                  disabled={saving}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl border border-cyan-400/30 bg-cyan-500/12 text-sm text-cyan-100 hover:bg-cyan-500/18 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {saving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4" />
                      Save Changes
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
