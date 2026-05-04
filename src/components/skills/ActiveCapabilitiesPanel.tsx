"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, CheckCircle2, Loader2, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";

type Target = "flow" | "claude" | "codex";

type Artifact = {
  id: string;
  repository_id: string;
  artifact_type: "skill" | "instruction_doc";
  name: string;
  slug: string;
  relative_path: string;
  exact_filename?: string | null;
  risk_flags?: string[];
};

type Assignment = {
  artifact_id: string;
  agent_id?: string | null;
  target: "all" | Target;
  scope?: "workspace" | "agent";
  enabled: boolean;
};

type SkillsState = {
  artifacts: Artifact[];
  assignments: Assignment[];
};

type ActiveCapability = {
  artifact: Artifact;
  scopeLabels: string[];
};

function matchesTarget(assignment: Assignment, target: Target) {
  return assignment.target === "all" || assignment.target === target;
}

function targetLabel(target: Assignment["target"]) {
  if (target === "all") return "all targets";
  if (target === "flow") return "Flow";
  if (target === "claude") return "Claude";
  return "Codex";
}

function assignmentScopeLabel(assignment: Assignment) {
  if (assignment.agent_id) return "This agent";
  return assignment.target === "all" ? "All agents" : `All ${targetLabel(assignment.target)} agents`;
}

export function ActiveCapabilitiesPanel({
  agentId,
  target,
  deviceId,
  autoPreflight = false,
}: {
  agentId?: string | null;
  target: Target;
  deviceId?: string | null;
  autoPreflight?: boolean;
}) {
  const [state, setState] = useState<SkillsState | null>(null);
  const [loading, setLoading] = useState(false);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preflightRanRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/workspaces/skills", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load capabilities");
      setState(json as SkillsState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load capabilities");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeCapabilities = useMemo<ActiveCapability[]>(() => {
    const allArtifacts = state?.artifacts || [];
    const artifactById = new Map(allArtifacts.map((artifact) => [artifact.id, artifact]));
    const capabilityByArtifactId = new Map<string, ActiveCapability>();

    for (const assignment of state?.assignments || []) {
      if (!assignment.enabled || !matchesTarget(assignment, target)) continue;
      if (assignment.agent_id && (!agentId || assignment.agent_id !== agentId)) continue;

      const artifact = artifactById.get(assignment.artifact_id);
      if (!artifact) continue;

      const existing = capabilityByArtifactId.get(artifact.id) || {
        artifact,
        scopeLabels: [],
      };
      const scopeLabel = assignmentScopeLabel(assignment);
      if (!existing.scopeLabels.includes(scopeLabel)) existing.scopeLabels.push(scopeLabel);
      capabilityByArtifactId.set(artifact.id, existing);
    }

    return Array.from(capabilityByArtifactId.values()).sort((a, b) => {
      const aAgentScoped = a.scopeLabels.includes("This agent");
      const bAgentScoped = b.scopeLabels.includes("This agent");
      if (aAgentScoped !== bAgentScoped) return aAgentScoped ? -1 : 1;
      return a.artifact.name.localeCompare(b.artifact.name);
    });
  }, [agentId, state?.artifacts, state?.assignments, target]);
  const activeCount = activeCapabilities.length;

  const runPreflight = useCallback(async () => {
    if (!deviceId) return;
    setPreflightLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/workspaces/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "preflight",
          deviceId,
          agentId: agentId || null,
          target,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) throw new Error(json.error || "Preflight failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preflight failed");
    } finally {
      setPreflightLoading(false);
    }
  }, [agentId, deviceId, load, target]);

  useEffect(() => {
    if (!autoPreflight || preflightRanRef.current || !deviceId || activeCount === 0) return;
    preflightRanRef.current = true;
    void runPreflight();
  }, [activeCount, autoPreflight, deviceId, runPreflight]);

  if (!state && loading) return null;
  if (!loading && activeCount === 0 && !error) return null;

  return (
    <div className="border-b border-white/10 bg-zinc-950/70 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
            {error && activeCount === 0
              ? "Capabilities unavailable"
              : activeCount === 1
                ? "1 active capability"
                : `${activeCount} active capabilities`}
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {activeCapabilities.slice(0, 6).map(({ artifact, scopeLabels }) => (
              <span
                key={artifact.id}
                title={`${artifact.name} (${scopeLabels.join(", ")}) · ${artifact.relative_path}`}
                className="inline-flex max-w-[240px] items-center gap-1 truncate rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-300"
              >
                {artifact.artifact_type === "skill" ? (
                  <Sparkles className="h-3 w-3 shrink-0 text-emerald-300" />
                ) : (
                  <BookOpen className="h-3 w-3 shrink-0 text-amber-300" />
                )}
                <span className="truncate">{artifact.name}</span>
                <span className="shrink-0 rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-[10px] text-zinc-500">
                  {scopeLabels.join(" + ")}
                </span>
              </span>
            ))}
            {activeCount > 6 && (
              <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-500">
                +{activeCount - 6}
              </span>
            )}
            {preflightLoading && (
              <span className="inline-flex items-center gap-1 rounded-md border border-cyan-400/20 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200">
                <Loader2 className="h-3 w-3 animate-spin" />
                Syncing
              </span>
            )}
            {!preflightLoading && deviceId && activeCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/20 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
                <CheckCircle2 className="h-3 w-3" />
                Local
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {deviceId && activeCount > 0 && (
            <button
              type="button"
              onClick={() => void runPreflight()}
              disabled={preflightLoading}
              className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/10 hover:text-cyan-300 disabled:opacity-50"
              title="Resync assigned capabilities"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${preflightLoading ? "animate-spin" : ""}`} />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              window.location.href = "/dashboard/skills";
            }}
            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-zinc-300 transition hover:bg-white/10"
          >
            Manage
          </button>
        </div>
      </div>
      {error && <div className="mt-2 text-[11px] text-amber-300">{error}</div>}
    </div>
  );
}
