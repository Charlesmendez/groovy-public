"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  FileText,
  Hash,
  Lock,
  Search,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { MAX_CHANNEL_ORCHESTRATOR_INSTRUCTIONS } from "@/lib/chat/channelConfig";
import {
  GUEST_SAFE_MIND_REQUIREMENT,
  isGuestSafeMind,
} from "@/lib/chat/guestMind";

export type ChannelCreateInput = {
  name: string;
  topic: string;
  visibility: "workspace" | "private";
  profileId: string | null;
  orchestratorMode: "mention" | "always" | "off";
  orchestratorInstructions: string | null;
  userIds: string[];
  agentIds: string[];
  skillArtifactIds: string[];
};

type ProfileOption = {
  id: string;
  name: string;
  is_default: boolean;
  surface: string;
  authorization_stance: string;
  memory_scope: string;
  inherit_workspace_skills: boolean;
  inherit_workspace_integrations: boolean;
};

type AgentOption = {
  id: string;
  name: string;
  harness: string;
  model: string | null;
  deviceOnline: boolean;
};

type PersonOption = {
  user_id: string;
  email?: string | null;
  role?: "admin" | "member" | "guest";
};

export type ChannelSkillOption = {
  id: string;
  artifact_type: "skill" | "instruction_doc";
  name: string;
  description: string;
  relative_path: string;
  targets?: unknown;
};

const STEPS = ["Details", "Participants", "Capabilities"] as const;

function SelectionRow({
  checked,
  disabled,
  icon,
  label,
  meta,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  meta: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`flex w-full touch-manipulation items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
        checked
          ? "border-cyan-400/35 bg-cyan-400/[0.07]"
          : "border-white/10 bg-black/20 hover:border-white/20"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          checked
            ? "bg-cyan-400/15 text-cyan-300"
            : "bg-white/[0.04] text-zinc-500"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-zinc-200">{label}</span>
        <span className="block truncate text-[10px] text-zinc-500">{meta}</span>
      </span>
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
          checked
            ? "border-cyan-300/60 bg-cyan-300 text-black"
            : "border-white/15"
        }`}
        aria-hidden="true"
      >
        {checked ? <Check className="h-3.5 w-3.5" /> : null}
      </span>
    </button>
  );
}

export function ChannelCreateModal({
  profiles,
  agents,
  people,
  skills,
  currentUserId,
  canAssignAgents,
  onClose,
  onCreate,
}: {
  profiles: ProfileOption[];
  agents: AgentOption[];
  people: PersonOption[];
  skills: ChannelSkillOption[];
  currentUserId: string;
  canAssignAgents: boolean;
  onClose: () => void;
  onCreate: (input: ChannelCreateInput) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<"workspace" | "private">(
    "workspace",
  );
  const [profileId, setProfileId] = useState(
    profiles.find((profile) => profile.is_default)?.id || "",
  );
  const [orchestratorMode, setOrchestratorMode] = useState<
    "mention" | "always" | "off"
  >("mention");
  const [orchestratorInstructions, setOrchestratorInstructions] = useState("");
  const [userIds, setUserIds] = useState<string[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [skillArtifactIds, setSkillArtifactIds] = useState<string[]>([]);
  const [participantQuery, setParticipantQuery] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewportFrame, setViewportFrame] = useState<{
    height: number;
    top: number;
  } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      nameRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";

    const viewport = window.visualViewport;
    const syncViewport = () => {
      setViewportFrame(
        viewport
          ? {
              height: viewport.height,
              top: viewport.offsetTop,
            }
          : null,
      );
    };
    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);

    return () => {
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const teammates = useMemo(
    () => people.filter((person) => person.user_id !== currentUserId),
    [currentUserId, people],
  );
  const normalizedParticipantQuery = participantQuery.trim().toLowerCase();
  const visiblePeople = teammates.filter((person) =>
    [person.email, person.role].some((value) =>
      String(value || "")
        .toLowerCase()
        .includes(normalizedParticipantQuery),
    ),
  );
  const visibleAgents = canAssignAgents
    ? agents.filter((agent) =>
        [agent.name, agent.harness, agent.model].some((value) =>
          String(value || "")
            .toLowerCase()
            .includes(normalizedParticipantQuery),
        ),
      )
    : [];
  const normalizedSkillQuery = skillQuery.trim().toLowerCase();
  const visibleSkills = skills.filter((skill) =>
    [skill.name, skill.description, skill.relative_path, skill.artifact_type].some(
      (value) => value.toLowerCase().includes(normalizedSkillQuery),
    ),
  );
  const selectedGuests = teammates.filter(
    (person) => person.role === "guest" && userIds.includes(person.user_id),
  );
  const selectedProfile =
    profiles.find((profile) => profile.id === profileId) || null;
  const guestMindRequired =
    selectedGuests.length > 0 && orchestratorMode !== "off";
  const selectedProfileIsGuestSafe = isGuestSafeMind(selectedProfile);

  const toggle = (
    id: string,
    setter: React.Dispatch<React.SetStateAction<string[]>>,
  ) => {
    setter((current) =>
      current.includes(id)
        ? current.filter((candidate) => candidate !== id)
        : [...current, id],
    );
    setError(null);
  };

  const goForward = () => {
    if (step === 0 && !name.trim()) {
      setError("Give the channel a name before continuing.");
      nameRef.current?.focus();
      return;
    }
    setError(null);
    setStep((current) => Math.min(STEPS.length - 1, current + 1));
  };

  const submit = async () => {
    if (!name.trim() || busy) return;
    if (guestMindRequired && !selectedProfileIsGuestSafe) {
      setStep(0);
      setError(
        `${GUEST_SAFE_MIND_REQUIREMENT} Choose a guest-ready Mind or set attention to Humans only.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        topic: topic.trim(),
        visibility,
        profileId: profileId || null,
        orchestratorMode,
        orchestratorInstructions: orchestratorInstructions.trim() || null,
        userIds,
        agentIds,
        skillArtifactIds:
          selectedGuests.length > 0 ? [] : skillArtifactIds,
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create channel.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-x-0 top-0 z-[60] flex h-[100dvh] items-end justify-center overflow-hidden bg-black/75 backdrop-blur-sm sm:items-center sm:p-4"
      style={
        viewportFrame
          ? {
              height: viewportFrame.height,
              top: viewportFrame.top,
            }
          : undefined
      }
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-channel-title"
        className="animate-slide-up flex max-h-[calc(100%-0.5rem)] min-h-0 w-full max-w-full flex-col overflow-hidden overscroll-contain rounded-t-2xl border border-white/10 bg-[#0c0d11] shadow-2xl sm:animate-none sm:max-h-[92dvh] sm:max-w-2xl sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 border-b border-white/10 px-5 pb-4 pt-5 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="create-channel-title" className="text-lg font-semibold">
                Create a channel
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                Build the room, invite the right collaborators, and give its
                Mind only the capabilities it needs.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-white disabled:opacity-40"
              aria-label="Close channel creation"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-2" aria-label="Creation steps">
            {STEPS.map((label, index) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  if (index === 0 || name.trim()) {
                    setError(null);
                    setStep(index);
                  }
                }}
                className="min-w-0 text-left"
                aria-current={step === index ? "step" : undefined}
              >
                <span
                  className={`block h-1 rounded-full ${
                    index <= step ? "bg-cyan-300" : "bg-white/10"
                  }`}
                />
                <span
                  className={`mt-1.5 block truncate text-[10px] uppercase tracking-wider ${
                    step === index ? "text-zinc-200" : "text-zinc-600"
                  }`}
                >
                  {index + 1}. {label}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-5 py-5 [-webkit-overflow-scrolling:touch] sm:px-6">
          {step === 0 ? (
            <div className="space-y-5">
              <div>
                <label
                  htmlFor="channel-create-name"
                  className="mb-1.5 block text-[11px] font-medium uppercase tracking-widest text-zinc-500"
                >
                  Channel name
                </label>
                <div className="flex items-center rounded-xl border border-white/10 bg-black/30 px-3 focus-within:border-cyan-400/40 focus-within:ring-2 focus-within:ring-cyan-400/10">
                  <Hash className="h-4 w-4 shrink-0 text-zinc-600" />
                  <input
                    ref={nameRef}
                    id="channel-create-name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        goForward();
                      }
                    }}
                    maxLength={100}
                    placeholder="launch-room"
                    className="min-w-0 flex-1 bg-transparent px-2 py-3 text-sm outline-none placeholder:text-zinc-600"
                    disabled={busy}
                  />
                </div>
              </div>
              <div>
                <label
                  htmlFor="channel-create-topic"
                  className="mb-1.5 block text-[11px] font-medium uppercase tracking-widest text-zinc-500"
                >
                  Purpose <span className="normal-case tracking-normal">(optional)</span>
                </label>
                <textarea
                  id="channel-create-topic"
                  rows={2}
                  maxLength={500}
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  placeholder="What work belongs in this room?"
                  className="w-full resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm outline-none placeholder:text-zinc-600 focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/10"
                  disabled={busy}
                />
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-widest text-zinc-500">
                  Visibility
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {[
                    {
                      id: "workspace" as const,
                      icon: <Users className="h-4 w-4" />,
                      label: "Workspace",
                      detail: "All full members can discover and join.",
                    },
                    {
                      id: "private" as const,
                      icon: <Lock className="h-4 w-4" />,
                      label: "Private",
                      detail: "Only invited members can open the room.",
                    },
                  ].map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setVisibility(option.id)}
                      className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                        visibility === option.id
                          ? "border-cyan-400/35 bg-cyan-400/[0.07]"
                          : "border-white/10 bg-black/20 hover:border-white/20"
                      }`}
                    >
                      <span
                        className={
                          visibility === option.id
                            ? "text-cyan-300"
                            : "text-zinc-500"
                        }
                      >
                        {option.icon}
                      </span>
                      <span>
                        <span className="block text-sm text-zinc-200">
                          {option.label}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-relaxed text-zinc-500">
                          {option.detail}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-widest text-zinc-500">
                    Mind
                  </div>
                  <CustomSelect
                    value={profileId}
                    onChange={setProfileId}
                    options={[
                      {
                        value: "",
                        label: "Groovy default",
                        description: guestMindRequired
                          ? "Unavailable while guests can talk to the Mind"
                          : "Workspace default",
                        disabled: guestMindRequired,
                      },
                      ...profiles.map((profile) => ({
                        value: profile.id,
                        label: profile.name,
                        description: isGuestSafeMind(profile)
                          ? "Guest-ready · External · Restricted"
                          : guestMindRequired
                            ? "Internal Mind · not available with guests"
                            : profile.is_default
                              ? "Workspace default"
                              : "Workspace Mind",
                        disabled:
                          guestMindRequired && !isGuestSafeMind(profile),
                      })),
                    ]}
                    ariaLabel="Channel Mind"
                    disabled={busy}
                  />
                </div>
                <div>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-widest text-zinc-500">
                    Mind attention
                  </div>
                  <CustomSelect
                    value={orchestratorMode}
                    onChange={(nextValue) =>
                      setOrchestratorMode(
                        nextValue === "always" || nextValue === "off"
                          ? nextValue
                          : "mention",
                      )
                    }
                    options={[
                      {
                        value: "mention",
                        label: "@mention only",
                        description: "Responds when summoned",
                      },
                      {
                        value: "always",
                        label: "Always listening",
                        description: "Responds to every message",
                      },
                      {
                        value: "off",
                        label: "Humans only",
                        description: "No Mind replies",
                      },
                    ]}
                    ariaLabel="Mind attention"
                    disabled={busy}
                  />
                </div>
              </div>
              {guestMindRequired && !selectedProfileIsGuestSafe ? (
                <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs leading-relaxed text-amber-100">
                  {GUEST_SAFE_MIND_REQUIREMENT} Choose a Mind labeled
                  Guest-ready, or create/configure one in Settings → Minds. If
                  this person is a trusted teammate who needs internal tools,
                  invite them as a workspace Member instead.
                </div>
              ) : null}
              <div>
                <div className="flex items-end justify-between gap-3">
                  <label
                    htmlFor="channel-create-instructions"
                    className="block text-[11px] font-medium uppercase tracking-widest text-zinc-500"
                  >
                    Channel instructions{" "}
                    <span className="normal-case tracking-normal">
                      (optional)
                    </span>
                  </label>
                  <span className="text-[9px] tabular-nums text-zinc-600">
                    {orchestratorInstructions.length.toLocaleString()} /{" "}
                    {MAX_CHANNEL_ORCHESTRATOR_INSTRUCTIONS.toLocaleString()}
                  </span>
                </div>
                <textarea
                  id="channel-create-instructions"
                  rows={4}
                  maxLength={MAX_CHANNEL_ORCHESTRATOR_INSTRUCTIONS}
                  value={orchestratorInstructions}
                  onChange={(event) =>
                    setOrchestratorInstructions(event.target.value)
                  }
                  placeholder="How should the Mind work in this channel? For example: begin with a short status, call out blockers, and ask before changing production."
                  className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm leading-relaxed outline-none placeholder:text-zinc-600 focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/10"
                  disabled={busy}
                />
                <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">
                  This operating brief shapes channel behavior but cannot grant
                  tools or override the selected Mind’s permissions.
                </p>
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-medium text-zinc-200">
                    Add people and agents
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    You are included automatically. Private rooms remain hidden
                    from everyone else.
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-zinc-500">
                  {userIds.length + agentIds.length} selected
                </span>
              </div>
              <div className="relative mt-4">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
                <input
                  type="search"
                  value={participantQuery}
                  onChange={(event) => setParticipantQuery(event.target.value)}
                  placeholder="Search people and agents"
                  className="w-full rounded-xl border border-white/10 bg-black/30 py-2.5 pl-9 pr-3 text-sm outline-none placeholder:text-zinc-600 focus:border-cyan-400/40"
                />
              </div>
              <div className="mt-5 text-[10px] font-medium uppercase tracking-widest text-zinc-600">
                People
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {visiblePeople.map((person) => (
                  <SelectionRow
                    key={person.user_id}
                    checked={userIds.includes(person.user_id)}
                    onChange={() => toggle(person.user_id, setUserIds)}
                    icon={<Users className="h-4 w-4" />}
                    label={person.email || "Workspace member"}
                    meta={
                      person.role === "guest"
                        ? "Channel guest"
                        : person.role === "admin"
                          ? "Workspace admin"
                          : "Workspace member"
                    }
                  />
                ))}
                {visiblePeople.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-white/10 px-3 py-5 text-center text-xs text-zinc-600 sm:col-span-2">
                    No people match this search. You can invite someone from the
                    People section after creating the room.
                  </p>
                ) : null}
              </div>
              <div className="mt-6 text-[10px] font-medium uppercase tracking-widest text-zinc-600">
                Agents
              </div>
              {selectedGuests.length > 0 && canAssignAgents ? (
                <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-100/75">
                  Guests are selected. Adding an agent authorizes it to act on
                  guest messages and return its results in this channel.
                </p>
              ) : null}
              {canAssignAgents ? (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {visibleAgents.map((agent) => (
                    <SelectionRow
                      key={agent.id}
                      checked={agentIds.includes(agent.id)}
                      onChange={() => toggle(agent.id, setAgentIds)}
                      icon={<Bot className="h-4 w-4" />}
                      label={agent.name}
                      meta={`${agent.harness}${agent.model ? ` · ${agent.model}` : ""}${
                        agent.deviceOnline ? " · online" : " · offline"
                      }`}
                    />
                  ))}
                  {visibleAgents.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-white/10 px-3 py-5 text-center text-xs text-zinc-600 sm:col-span-2">
                      No agents match this search.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-3 text-xs leading-relaxed text-zinc-500">
                  Only workspace admins can assign agents to channels. An
                  admin can add them later from the @ menu or Channel Settings.
                </p>
              )}
            </div>
          ) : null}

          {step === 2 ? (
            <div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-medium text-zinc-200">
                    Channel capabilities
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    These skills and instruction documents are added only for
                    this channel. The selected Mind keeps its shared defaults.
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-zinc-500">
                  {skillArtifactIds.length} selected
                </span>
              </div>
              {selectedGuests.length > 0 ? (
                <div className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs leading-relaxed text-amber-100">
                  This room includes {selectedGuests.length} channel{" "}
                  {selectedGuests.length === 1 ? "guest" : "guests"}. For
                  safety, channel skills stay unavailable while any guest is a
                  participant.
                </div>
              ) : null}
              <div className="relative mt-4">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
                <input
                  type="search"
                  value={skillQuery}
                  onChange={(event) => setSkillQuery(event.target.value)}
                  placeholder="Search skills and instructions"
                  className="w-full rounded-xl border border-white/10 bg-black/30 py-2.5 pl-9 pr-3 text-sm outline-none placeholder:text-zinc-600 focus:border-cyan-400/40"
                />
              </div>
              <div className="mt-4 grid gap-2">
                {visibleSkills.map((skill) => (
                  <SelectionRow
                    key={skill.id}
                    checked={skillArtifactIds.includes(skill.id)}
                    disabled={selectedGuests.length > 0}
                    onChange={() => toggle(skill.id, setSkillArtifactIds)}
                    icon={
                      skill.artifact_type === "skill" ? (
                        <Sparkles className="h-4 w-4" />
                      ) : (
                        <FileText className="h-4 w-4" />
                      )
                    }
                    label={skill.name}
                    meta={
                      skill.description ||
                      (skill.artifact_type === "skill"
                        ? "Skill"
                        : "Instruction document")
                    }
                  />
                ))}
                {visibleSkills.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center">
                    <Sparkles className="mx-auto h-5 w-5 text-zinc-700" />
                    <p className="mt-2 text-xs text-zinc-600">
                      {skills.length === 0
                        ? "No Team Chat skills are available yet. Add them in Settings → Skills."
                        : "No capabilities match this search."}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="mt-5 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-200">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/10 bg-black/20 px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">
          <button
            type="button"
            onClick={() => {
              if (step === 0) onClose();
              else {
                setError(null);
                setStep((current) => current - 1);
              }
            }}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:bg-white/5 hover:text-white disabled:opacity-40"
          >
            {step === 0 ? "Cancel" : "Back"}
          </button>
          <div className="flex items-center gap-2">
            {step < STEPS.length - 1 ? (
              <>
                {step > 0 ? (
                  <button
                    type="button"
                    onClick={() => setStep(STEPS.length - 1)}
                    className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-white"
                  >
                    Skip
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={goForward}
                  className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-200"
                >
                  Continue
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || !name.trim()}
                className="rounded-lg border border-cyan-300/40 bg-cyan-300 px-4 py-2 text-sm font-semibold text-black disabled:opacity-40"
              >
                {busy ? "Creating…" : "Create channel"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
