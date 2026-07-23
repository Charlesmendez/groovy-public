"use client";

/**
 * OrchestratorBar — the harness command bar.
 *
 * A floating, keyboard-first input that talks to the orchestrator. Includes
 * the "brain" model picker (which model plans/routes) and an @mention
 * autocomplete over the worker roster so delegation feels native.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ProfileSwitcher } from "@/components/harness/ProfileSwitcher";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronLeft,
  ChevronDown,
  Gauge,
  HeartPulse,
  ImagePlus,
  ListChecks,
  PenLine,
  Square,
  Sparkles,
  X,
} from "lucide-react";
import type { WorkerAgentInfo } from "@/hooks/useWorkerAgents";
import {
  MODEL_CATALOG,
  catalogModelLabel,
  inferProviderForModelId,
  reasoningEffortsForModel,
} from "@/lib/ai/modelCatalog";

export type OrchestratorModelSelection = {
  provider: "anthropic" | "openai" | null;
  model: string | null;
  reasoningEffort: string | null;
};

function modelLabel(selection: OrchestratorModelSelection): string {
  return catalogModelLabel(selection.model);
}

function effortLabel(effort: string | null): string {
  if (!effort) return "Default effort";
  if (effort === "xhigh") return "Extra high";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  none: "Fastest response with no deliberate reasoning budget.",
  low: "Faster and more economical for focused tasks.",
  medium: "Balanced speed and depth for everyday work.",
  high: "More analysis for complex planning and coding.",
  xhigh: "Extended reasoning for difficult, long-running work.",
  max: "Maximum available depth, latency, and token use.",
};

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function isSupportedImage(file: File): boolean {
  if (SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) return true;
  const extension = file.name.toLowerCase().split(".").pop() || "";
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension);
}

export function OrchestratorBar({
  agents,
  isStreaming,
  disabled,
  modelSelection,
  onModelChange,
  onSend,
  onCancel,
}: {
  agents: WorkerAgentInfo[];
  isStreaming: boolean;
  disabled?: boolean;
  modelSelection: OrchestratorModelSelection;
  onModelChange: (selection: OrchestratorModelSelection) => void;
  onSend: (message: string, files?: File[]) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [planFirst, setPlanFirst] = useState(false);
  const [planAgentId, setPlanAgentId] = useState<string>("");
  const [planDepth, setPlanDepth] = useState<"quick" | "standard" | "thorough">("standard");
  const [customModelDraft, setCustomModelDraft] = useState("");
  const [heartbeatModel, setHeartbeatModel] = useState<string | null>(null);
  const [heartbeatLoaded, setHeartbeatLoaded] = useState(false);
  const [menuSection, setMenuSection] = useState<"brain" | "heartbeat">("brain");
  const [modelMenuView, setModelMenuView] = useState<"models" | "effort">("models");
  const [effortTarget, setEffortTarget] = useState<OrchestratorModelSelection | null>(null);
  const [selectedImages, setSelectedImages] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const displayedEffortTarget = effortTarget || modelSelection;
  const imagePreviews = useMemo(
    () => selectedImages.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [selectedImages]
  );

  useEffect(
    () => () => imagePreviews.forEach((preview) => URL.revokeObjectURL(preview.url)),
    [imagePreviews]
  );

  const addImages = useCallback((files: File[]) => {
    const images = files.filter(isSupportedImage);
    if (images.length === 0) return;
    setSelectedImages((current) => [...current, ...images].slice(0, 3));
  }, []);

  const chooseOrchestratorModel = useCallback(
    (provider: "anthropic" | "openai", model: string) => {
      const selection = { provider, model, reasoningEffort: null };
      onModelChange(selection);
      if (reasoningEffortsForModel(model).length > 0) {
        setEffortTarget(selection);
        setModelMenuView("effort");
      } else {
        setShowModelMenu(false);
      }
    },
    [onModelChange]
  );

  const chooseOrchestratorEffort = useCallback(
    (reasoningEffort: string | null) => {
      onModelChange({ ...displayedEffortTarget, reasoningEffort });
      setEffortTarget(null);
      setModelMenuView("models");
      setShowModelMenu(false);
    },
    [displayedEffortTarget, onModelChange]
  );

  const planAgent = useMemo(() => {
    const selected = agents.find((agent) => agent.id === planAgentId);
    return selected || agents.find((agent) => !!agent.workspaceRootPath) || agents[0] || null;
  }, [agents, planAgentId]);

  // Load the heartbeat digest model lazily when the menu opens.
  useEffect(() => {
    if (!showModelMenu || heartbeatLoaded) return;
    fetch("/api/heartbeat/config", { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        setHeartbeatModel(typeof json?.model === "string" && json.model ? json.model : null);
      })
      .catch(() => {})
      .finally(() => setHeartbeatLoaded(true));
  }, [showModelMenu, heartbeatLoaded]);

  const changeHeartbeatModel = useCallback((model: string | null) => {
    setHeartbeatModel(model);
    fetch("/api/heartbeat/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    }).catch(() => {});
  }, []);

  // ⌘K / Ctrl+K focuses the bar from anywhere.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Close model menu on outside click.
  useEffect(() => {
    if (!showModelMenu) return;
    const onClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [showModelMenu]);

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, []);

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return agents
      .filter((a) => !q || a.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [agents, mentionQuery]);

  const updateMentionState = useCallback((text: string, caret: number) => {
    const before = text.slice(0, caret);
    const match = before.match(/(?:^|\s)@([\w-]*)$/);
    setMentionQuery(match ? match[1] : null);
    setMentionIndex(0);
  }, []);

  const insertMention = useCallback(
    (agent: WorkerAgentInfo) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? value.length;
      const before = value.slice(0, caret).replace(/@([\w-]*)$/, "");
      const after = value.slice(caret);
      const mention = `@${agent.name.replace(/\s+/g, "")} `;
      const next = `${before}${mention}${after}`;
      setValue(next);
      setMentionQuery(null);
      requestAnimationFrame(() => {
        el?.focus();
        const pos = (before + mention).length;
        el?.setSelectionRange(pos, pos);
        autoGrow();
      });
    },
    [value, autoGrow]
  );

  const submit = useCallback(() => {
    const message = value.trim();
    if ((!message && selectedImages.length === 0) || isStreaming || disabled) return;
    const planningInstruction = planFirst
      ? `\n\n[Collaborative planning mode: consult the selected worker agent ${JSON.stringify(
          planAgent?.name || "the best matching configured agent"
        )} with consult_agent at ${planDepth} depth so it explores its real workspace in enforced read-only mode. Use its file/symbol/test evidence, ask targeted follow-up consultations only if material gaps remain, then synthesize the final implementation plan yourself and call finalize_plan. Do not make changes or execute the plan until I approve it.]`
      : "";
    onSend(`${message}${planningInstruction}`, selectedImages);
    setValue("");
    setSelectedImages([]);
    if (imageInputRef.current) imageInputRef.current.value = "";
    setMentionQuery(null);
    requestAnimationFrame(autoGrow);
  }, [value, selectedImages, isStreaming, disabled, planFirst, planAgent, planDepth, onSend, autoGrow]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionQuery !== null && mentionMatches.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => (i + 1) % mentionMatches.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          insertMention(mentionMatches[mentionIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionQuery(null);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [mentionQuery, mentionMatches, mentionIndex, insertMention, submit]
  );

  return (
    <div className="relative mx-auto w-full min-w-0 max-w-3xl">
      {/* Mention autocomplete */}
      <AnimatePresence>
        {mentionQuery !== null && mentionMatches.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.12 }}
            className="absolute bottom-full mb-2 left-4 right-4 rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-2xl overflow-hidden z-30"
          >
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 border-b border-white/5">
              Delegate to
            </div>
            {mentionMatches.map((agent, index) => (
              <button
                key={agent.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(agent);
                }}
                onMouseEnter={() => setMentionIndex(index)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                  index === mentionIndex ? "bg-white/10" : "hover:bg-white/5"
                }`}
              >
                <span className="w-6 h-6 rounded-md bg-white/10 flex items-center justify-center text-xs">
                  {agent.emoji || agent.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="text-sm text-white">{agent.name}</span>
                <span
                  className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${
                    agent.harness === "codex"
                      ? "bg-emerald-500/10 text-emerald-300"
                      : "bg-orange-500/10 text-orange-300"
                  }`}
                >
                  {agent.harness === "codex" ? "Codex" : "Claude Code"}
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* The bar */}
      <div
        className={`relative min-w-0 max-w-full rounded-2xl border bg-zinc-900/80 backdrop-blur-xl transition-all duration-200 ${
          focused
            ? "border-cyan-400/40 shadow-[0_0_24px_rgba(0,240,255,0.10)]"
            : "border-white/10 shadow-xl"
        }`}
      >
        {planFirst && (
          <div className="flex min-w-0 items-center gap-2 border-b border-violet-400/10 px-3 py-2">
            <ListChecks className="h-3.5 w-3.5 shrink-0 text-violet-300" />
            <span className="hidden text-[11px] font-medium text-violet-200 sm:inline">Plan with</span>
            <select
              value={planAgent?.id || ""}
              onChange={(event) => setPlanAgentId(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-violet-400/20 bg-violet-500/10 px-2 py-1 text-xs text-violet-100 outline-none focus:border-violet-300/50 sm:max-w-44 sm:flex-none"
              aria-label="Worker agent to explore the repository for this plan"
            >
              {agents.length === 0 && <option value="">No configured agents</option>}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id} className="bg-zinc-900 text-white">
                  {agent.name} · {agent.harness === "codex" ? "Codex" : "Claude"}
                </option>
              ))}
            </select>
            <select
              value={planDepth}
              onChange={(event) =>
                setPlanDepth(event.target.value as "quick" | "standard" | "thorough")
              }
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-zinc-300 outline-none focus:border-violet-300/50"
              aria-label="Repository exploration depth"
            >
              <option value="quick" className="bg-zinc-900">Quick</option>
              <option value="standard" className="bg-zinc-900">Standard</option>
              <option value="thorough" className="bg-zinc-900">Thorough</option>
            </select>
            <span className="hidden min-w-0 truncate text-[10px] text-zinc-500 md:inline">
              {planAgent?.workspaceRootPath || "Choose an agent with a workspace"}
            </span>
            <span className="ml-auto hidden shrink-0 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-medium text-emerald-300 sm:inline">
              Read-only
            </span>
          </div>
        )}
        {imagePreviews.length > 0 && (
          <div className="flex gap-2 overflow-x-auto border-b border-white/5 px-3 py-2 [-webkit-overflow-scrolling:touch] [touch-action:pan-x]">
            {imagePreviews.map(({ file, url }, index) => (
              <div
                key={`${file.name}-${file.lastModified}-${index}`}
                className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-black/30"
                title={file.name}
              >
                <div
                  className="h-full w-full bg-cover bg-center"
                  style={{ backgroundImage: `url(${JSON.stringify(url)})` }}
                />
                <button
                  type="button"
                  onClick={() => setSelectedImages((current) => current.filter((_, i) => i !== index))}
                  className="absolute right-1 top-1 flex h-6 w-6 !min-h-6 items-center justify-center rounded-full bg-black/75 text-white shadow-md"
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 text-[9px] text-zinc-300">
                  {file.name}
                </span>
              </div>
            ))}
            {imagePreviews.length < 3 && (
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/15 text-zinc-500 transition-colors hover:border-cyan-400/30 hover:text-cyan-300"
                aria-label="Add another image"
              >
                <ImagePlus className="h-4 w-4" />
                <span className="text-[9px]">Add</span>
              </button>
            )}
          </div>
        )}
        <div className="flex min-w-0 max-w-full items-end gap-2 px-3 py-2.5">
          {/* Mind / harness profile picker (hidden until profiles exist) */}
          <ProfileSwitcher />
          {/* Brain / model picker */}
          <div className="relative shrink-0" ref={modelMenuRef}>
            <button
              type="button"
              onClick={() => {
                setModelMenuView("models");
                setEffortTarget(null);
                setShowModelMenu((v) => !v);
              }}
              className="flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-white/5 px-0 text-zinc-300 transition-colors hover:bg-white/10 hover:text-white sm:w-auto sm:max-w-[min(18rem,55vw)] sm:justify-start sm:px-2.5"
              title="Orchestrator model — which model plans and routes your tasks"
            >
              <Brain className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
              <span className="hidden truncate text-xs font-medium sm:inline">{modelLabel(modelSelection)}</span>
              {modelSelection.model && (
                <>
                  <span className="hidden h-3 w-px shrink-0 bg-white/10 sm:block" />
                  <span className="hidden shrink-0 text-[11px] font-medium text-cyan-300 sm:inline">
                    {effortLabel(modelSelection.reasoningEffort)}
                  </span>
                </>
              )}
              <ChevronDown className="hidden h-3 w-3 shrink-0 text-zinc-500 sm:block" />
            </button>

            <AnimatePresence>
              {showModelMenu && (
                <motion.div
                  initial={{ opacity: 0, y: 6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 6, scale: 0.98 }}
                  transition={{ duration: 0.12 }}
                  className="absolute bottom-full mb-2 left-0 w-80 rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-2xl overflow-hidden z-30"
                >
                  {/* Section tabs */}
                  <div className="flex items-center gap-1 px-2 pt-2 pb-1.5 border-b border-white/5">
                    <button
                      onClick={() => {
                        setMenuSection("brain");
                        setModelMenuView("models");
                        setEffortTarget(null);
                      }}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                        menuSection === "brain"
                          ? "bg-white/10 text-white"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      <Brain className="w-3 h-3" />
                      Orchestrator
                    </button>
                    <button
                      onClick={() => {
                        setMenuSection("heartbeat");
                        setModelMenuView("models");
                        setEffortTarget(null);
                      }}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                        menuSection === "heartbeat"
                          ? "bg-white/10 text-white"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      <HeartPulse className="w-3 h-3" />
                      Heartbeat
                    </button>
                  </div>

                  <div className="max-h-[420px] overflow-y-auto">
                    {menuSection === "brain" && modelMenuView === "effort" ? (
                      <div>
                        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-3">
                          <button
                            type="button"
                            onClick={() => {
                              setModelMenuView("models");
                              setEffortTarget(null);
                            }}
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-white"
                            aria-label="Back to model selection"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                          <div className="min-w-0">
                            <div className="text-[10px] font-medium uppercase tracking-wider text-cyan-400">
                              Step 2 of 2
                            </div>
                            <div className="truncate text-sm font-medium text-white">
                              Choose effort for {modelLabel(displayedEffortTarget)}
                            </div>
                          </div>
                        </div>

                        <div className="p-2">
                          <button
                            type="button"
                            onClick={() => chooseOrchestratorEffort(null)}
                            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                              !displayedEffortTarget.reasoningEffort
                                ? "bg-cyan-500/10"
                                : "hover:bg-white/5"
                            }`}
                          >
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5 text-zinc-400">
                              <Sparkles className="h-3.5 w-3.5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium text-zinc-200">
                                Model default
                              </span>
                              <span className="block text-[10px] text-zinc-500">
                                Let the provider choose its recommended effort.
                              </span>
                            </span>
                            {!displayedEffortTarget.reasoningEffort && (
                              <Check className="h-4 w-4 shrink-0 text-cyan-400" />
                            )}
                          </button>

                          {reasoningEffortsForModel(displayedEffortTarget.model).map((effort) => {
                            const selected = displayedEffortTarget.reasoningEffort === effort;
                            return (
                              <button
                                type="button"
                                key={effort}
                                onClick={() => chooseOrchestratorEffort(effort)}
                                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                                  selected ? "bg-cyan-500/10" : "hover:bg-white/5"
                                }`}
                              >
                                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                                  selected
                                    ? "bg-cyan-500/15 text-cyan-300"
                                    : "bg-white/5 text-zinc-500"
                                }`}>
                                  <Gauge className="h-3.5 w-3.5" />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block text-sm font-medium text-zinc-200">
                                    {effortLabel(effort)}
                                  </span>
                                  <span className="block text-[10px] leading-4 text-zinc-500">
                                    {EFFORT_DESCRIPTIONS[effort]}
                                  </span>
                                </span>
                                {selected && <Check className="h-4 w-4 shrink-0 text-cyan-400" />}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="px-3 py-2 text-[10px] text-zinc-500">
                          {menuSection === "brain"
                            ? "Choose the model that plans and routes your work."
                            : "Choose the model that writes heartbeat digests."}
                        </div>

                        {menuSection === "brain" && modelSelection.model && (
                          <button
                            type="button"
                            onClick={() => {
                              setEffortTarget(modelSelection);
                              setModelMenuView("effort");
                            }}
                            disabled={reasoningEffortsForModel(modelSelection.model).length === 0}
                            className="mx-2 mb-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.07] px-3 py-2 text-left transition-colors hover:bg-cyan-500/10 disabled:cursor-default"
                          >
                            <Brain className="h-4 w-4 shrink-0 text-cyan-400" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium text-zinc-200">
                                {modelLabel(modelSelection)}
                              </span>
                              <span className="block text-[10px] text-cyan-300">
                                {effortLabel(modelSelection.reasoningEffort)}
                              </span>
                            </span>
                            {reasoningEffortsForModel(modelSelection.model).length > 0 && (
                              <span className="text-[10px] font-medium text-zinc-400">Change effort</span>
                            )}
                          </button>
                        )}

                        <button
                          onClick={() => {
                            if (menuSection === "brain") {
                              onModelChange({ provider: null, model: null, reasoningEffort: null });
                            } else {
                              changeHeartbeatModel(null);
                            }
                            setShowModelMenu(false);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/5"
                        >
                          <Sparkles className="h-3.5 w-3.5 text-zinc-400" />
                          <span className="text-sm text-zinc-200">Auto</span>
                          <span className="text-[10px] text-zinc-500">Groovy default</span>
                          {(menuSection === "brain" ? !modelSelection.model : !heartbeatModel) && (
                            <Check className="ml-auto h-3.5 w-3.5 text-cyan-400" />
                          )}
                        </button>

                        {MODEL_CATALOG.map((group) => (
                          <div key={group.provider}>
                            <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-zinc-500">
                              {group.group}
                            </div>
                            {group.models.map((model) => {
                              const selected =
                                menuSection === "brain"
                                  ? modelSelection.model === model.id
                                  : heartbeatModel === model.id;
                              return (
                                <button
                                  key={model.id}
                                  onClick={() => {
                                    if (menuSection === "brain") {
                                      chooseOrchestratorModel(group.provider, model.id);
                                    } else {
                                      changeHeartbeatModel(model.id);
                                      setShowModelMenu(false);
                                    }
                                  }}
                                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                                    selected ? "bg-white/[0.04]" : "hover:bg-white/5"
                                  }`}
                                >
                                  <span className="text-sm text-zinc-200">{model.label}</span>
                                  {model.hint && (
                                    <span className="text-[10px] text-zinc-500">{model.hint}</span>
                                  )}
                                  {selected && <Check className="ml-auto h-3.5 w-3.5 text-cyan-400" />}
                                </button>
                              );
                            })}
                          </div>
                        ))}

                        <div className="mt-2 border-t border-white/5 px-3 pb-3 pt-2">
                          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
                            Custom model id
                          </div>
                          <div className="flex gap-1.5">
                            <input
                              value={customModelDraft}
                              onChange={(e) => setCustomModelDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key !== "Enter") return;
                                const id = customModelDraft.trim();
                                if (!id) return;
                                if (menuSection === "brain") {
                                  chooseOrchestratorModel(inferProviderForModelId(id), id);
                                } else {
                                  changeHeartbeatModel(id);
                                  setShowModelMenu(false);
                                }
                                setCustomModelDraft("");
                              }}
                              placeholder="e.g. gpt-5.6-sol"
                              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none placeholder-zinc-600 transition-colors focus:border-cyan-400/40"
                            />
                            <button
                              onClick={() => {
                                const id = customModelDraft.trim();
                                if (!id) return;
                                if (menuSection === "brain") {
                                  chooseOrchestratorModel(inferProviderForModelId(id), id);
                                } else {
                                  changeHeartbeatModel(id);
                                  setShowModelMenu(false);
                                }
                                setCustomModelDraft("");
                              }}
                              className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/10"
                            >
                              Use
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Plan-first toggle */}
          <button
            type="button"
            onClick={() => setPlanFirst((v) => !v)}
            className={`shrink-0 flex items-center gap-1.5 h-9 px-2.5 rounded-xl transition-colors ${
              planFirst
                ? "bg-violet-500/15 text-violet-300 border border-violet-400/30"
                : "bg-white/5 text-zinc-500 hover:text-zinc-300 hover:bg-white/10"
            }`}
            title={
              planFirst
                ? "Plan mode ON — agents draft a plan for your approval before making changes"
                : "Plan first — have agents draft a plan for your approval before making changes"
            }
          >
            {planFirst ? (
              <ListChecks className="w-3.5 h-3.5" />
            ) : (
              <PenLine className="w-3.5 h-3.5" />
            )}
            <span className="text-xs font-medium hidden sm:inline">Plan</span>
          </button>

          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={(event) => {
              addImages(Array.from(event.target.files || []));
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            disabled={isStreaming || disabled || selectedImages.length >= 3}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors ${
              selectedImages.length > 0
                ? "bg-cyan-500/15 text-cyan-300"
                : "bg-white/5 text-zinc-500 hover:bg-white/10 hover:text-zinc-300"
            } disabled:cursor-not-allowed disabled:opacity-40`}
            title="Attach images"
            aria-label="Attach images"
          >
            <ImagePlus className="h-4 w-4" />
          </button>

          {/* Input */}
          <textarea
            ref={textareaRef}
            value={value}
            rows={1}
            disabled={disabled}
            placeholder={
              agents.length > 0
                ? "Ask anything, or @agent to delegate…  (⌘K)"
                : "Ask anything…  (⌘K)"
            }
            onChange={(e) => {
              setValue(e.target.value);
              updateMentionState(e.target.value, e.target.selectionStart ?? 0);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.files).filter(isSupportedImage);
              if (images.length > 0) {
                event.preventDefault();
                addImages(images);
              }
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              setTimeout(() => setMentionQuery(null), 120);
            }}
            className="max-h-[168px] min-w-0 flex-1 resize-none overflow-x-hidden bg-transparent py-2 text-sm leading-relaxed text-white outline-none [overflow-wrap:anywhere] placeholder-zinc-500"
          />

          {/* Send / stop */}
          {isStreaming ? (
            <button
              type="button"
              onClick={onCancel}
              className="shrink-0 w-9 h-9 rounded-xl bg-red-500/15 text-red-300 hover:bg-red-500/25 flex items-center justify-center transition-colors"
              title="Stop"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={(!value.trim() && selectedImages.length === 0) || disabled}
              className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-all ${
                (value.trim() || selectedImages.length > 0) && !disabled
                  ? "bg-cyan-400 text-black hover:bg-cyan-300 shadow-[0_0_16px_rgba(0,240,255,0.25)]"
                  : "bg-white/5 text-zinc-600"
              }`}
              title="Send (Enter)"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
