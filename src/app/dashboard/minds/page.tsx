"use client";

/**
 * Minds — minimal harness-profile management (Phase 1c).
 * List, create from a template, edit soul/brain/stance/memory, clone,
 * set default, delete. Backed by /api/harness/profiles (RLS-enforced).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { HARNESS_PROFILE_TEMPLATES } from "@/lib/orchestrator/profileTemplates";

type ProfileRow = {
  id: string;
  workspace_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  persona_prompt: string | null;
  purpose: string | null;
  tone: string | null;
  custom_instructions: string | null;
  authorization_stance: "operator" | "restricted";
  model: { provider: "anthropic" | "openai"; model: string; reasoningEffort?: string | null } | null;
  memory_scope: "shared" | "profile";
  surface: "internal" | "external";
  tool_policy: { mode: "all" } | { mode: "allowlist"; tools: string[]; dataSources?: string[] };
  agent_roster: string[] | null;
  widget_config: {
    name?: string;
    greeting?: string;
    primaryColor?: string;
    avatar?: string;
  } | null;
  inherit_workspace_skills: boolean;
  inherit_workspace_integrations: boolean;
  is_default: boolean;
};

type Agent = { id: string; name: string; harness: string };
type ApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  kind: "secret" | "publishable";
  scopes: string[];
  rate_limit_per_minute: number;
  request_count: number;
  allowed_origins: string[];
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
};

type CapabilitySkill = {
  id: string;
  type: "skill" | "instruction_doc";
  name: string;
  description: string;
  relativePath: string;
  granted: boolean;
  inherited: boolean;
};

type CapabilityIntegration = {
  id: string;
  name: string;
  provider: string;
  connected: boolean;
  granted: boolean;
  inherited: boolean;
};

type ProfileCapabilities = {
  inheritWorkspaceSkills: boolean;
  inheritWorkspaceIntegrations: boolean;
  skills: CapabilitySkill[];
  integrations: CapabilityIntegration[];
};

const TOOL_OPTIONS = [
  ["web_search", "Web search"],
  ["remember", "Remember"],
  ["recall", "Recall"],
  ["wiki_search", "Wiki search"],
  ["wiki_read", "Wiki read"],
  ["wiki_file_learning", "Wiki learning"],
  ["files_agent_request", "Files agent"],
  ["data_query", "Approved data sources"],
  ["list_agents", "List agents"],
  ["assign_task", "Assign work"],
  ["consult_agent", "Consult agents"],
  ["schedule_list", "Read schedules"],
  ["schedule_create", "Create schedules"],
] as const;

const EXTERNAL_TOOL_OPTIONS = new Set([
  "web_search",
  "remember",
  "recall",
  "wiki_search",
  "wiki_read",
  "wiki_file_learning",
  "files_agent_request",
  "data_query",
]);

const DATA_SOURCE_OPTIONS = [
  ["google_ads", "Google Ads"],
  ["facebook_ads", "Facebook Ads"],
  ["facebook_leads", "Facebook Leads"],
  ["instagram", "Instagram"],
  ["linkedin_ads", "LinkedIn Ads"],
  ["google_drive", "Google Drive"],
  ["tiktok", "TikTok"],
  ["postgres", "Postgres"],
  ["firecrawl", "Firecrawl"],
  ["salesforce", "Salesforce"],
  ["web_pixel", "Web Pixel"],
  ["google_calendar", "Google Calendar"],
  ["gmail", "Gmail"],
] as const;

const inputCls =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-400/40";
const labelCls = "mb-1 mt-4 block text-[11px] font-medium uppercase tracking-widest text-zinc-500";

export default function MindsPage() {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<ProfileRow>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);
  const [allowedOrigin, setAllowedOrigin] = useState("");
  const [rateLimitPerMinute, setRateLimitPerMinute] = useState(60);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceRole, setWorkspaceRole] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ProfileCapabilities | null>(null);
  const [capabilitiesBusy, setCapabilitiesBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/harness/profiles", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
  }, []);

  useEffect(() => {
    void load();
    void fetch("/api/workspaces/current", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        setWorkspaceId(
          typeof payload?.workspace?.id === "string" ? payload.workspace.id : null,
        );
        setWorkspaceRole(
          typeof payload?.workspace?.role === "string"
            ? payload.workspace.role
            : null,
        );
      });
    void fetch("/api/agents", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { agents: [] }))
      .then((payload) => setAgents(Array.isArray(payload.agents) ? payload.agents : []));
  }, [load]);

  const selected = profiles.find((p) => p.id === selectedId) ?? null;

  const loadKeys = useCallback(async (profileId: string) => {
    const res = await fetch(`/api/harness/profiles/${profileId}/keys`, {
      cache: "no-store",
    });
    const payload = res.ok ? await res.json() : { keys: [] };
    setKeys(Array.isArray(payload.keys) ? payload.keys : []);
  }, []);

  const loadCapabilities = useCallback(async (profileId: string) => {
    setCapabilities(null);
    const res = await fetch(
      `/api/harness/profiles/${profileId}/capabilities`,
      { cache: "no-store" },
    );
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status !== 403 && res.status !== 404) {
        setError(payload?.error || "Could not load Mind capabilities");
      }
      return;
    }
    setCapabilities(payload as ProfileCapabilities);
  }, []);

  const openProfile = (p: ProfileRow) => {
    setSelectedId(p.id);
    setDraft({ ...p });
    setError(null);
    setPlaintextKey(null);
    void loadKeys(p.id);
    void loadCapabilities(p.id);
  };

  useEffect(() => {
    if (selectedId || profiles.length === 0 || typeof window === "undefined") {
      return;
    }
    const requestedId = new URLSearchParams(window.location.search).get("profile");
    if (!requestedId) return;
    const profile = profiles.find((candidate) => candidate.id === requestedId);
    if (!profile) return;
    setSelectedId(profile.id);
    setDraft({ ...profile });
    setPlaintextKey(null);
    void loadKeys(profile.id);
    void loadCapabilities(profile.id);
  }, [loadCapabilities, loadKeys, profiles, selectedId]);

  const call = async (fn: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
        return null;
      }
      await load();
      return res;
    } finally {
      setBusy(false);
    }
  };

  const createFromTemplate = async (tpl: (typeof HARNESS_PROFILE_TEMPLATES)[number]) => {
    const name = window.prompt("Name this mind:", tpl.key === "default" ? "My Mind" : tpl.name);
    if (!name?.trim()) return;
    const res = await call(() =>
      fetch("/api/harness/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...tpl.body,
          name: name.trim(),
          ...(workspaceId && workspaceRole === "admin"
            ? { workspace_id: workspaceId }
            : {}),
        }),
      }),
    );
    if (res) {
      const data = await res.json().catch(() => null);
      if (data?.profile) openProfile(data.profile);
      setShowTemplates(false);
    }
  };

  const save = () =>
    call(() =>
      fetch(`/api/harness/profiles/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      }),
    );

  const clone = (id: string) =>
    call(() => fetch(`/api/harness/profiles/${id}/clone`, { method: "POST" }));

  const remove = async (id: string) => {
    if (!window.confirm("Delete this mind? Conversations keep their history.")) return;
    await call(() => fetch(`/api/harness/profiles/${id}`, { method: "DELETE" }));
    if (selectedId === id) setSelectedId(null);
  };

  const setDefault = (id: string) =>
    call(() =>
      fetch(`/api/harness/profiles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_default: true }),
      }),
    );

  const toggleTool = (toolName: string) => {
    setDraft((current) => {
      const existing =
        current.tool_policy?.mode === "allowlist" ? current.tool_policy.tools : [];
      const dataSources =
        current.tool_policy?.mode === "allowlist"
          ? current.tool_policy.dataSources
          : undefined;
      const tools = existing.includes(toolName)
        ? existing.filter((name) => name !== toolName)
        : [...existing, toolName];
      return {
        ...current,
        tool_policy: {
          mode: "allowlist",
          tools,
          ...(dataSources?.length ? { dataSources } : {}),
        },
      };
    });
  };

  const toggleDataSource = (source: string) => {
    setDraft((current) => {
      const policy =
        current.tool_policy?.mode === "allowlist"
          ? current.tool_policy
          : { mode: "allowlist" as const, tools: ["data_query"] };
      const existing = policy.dataSources || [];
      const dataSources = existing.includes(source)
        ? existing.filter((name) => name !== source)
        : [...existing, source];
      return {
        ...current,
        tool_policy: { ...policy, dataSources },
      };
    });
  };

  const toggleAgent = (agentId: string) => {
    setDraft((current) => {
      const existing = current.agent_roster ?? agents.map((agent) => agent.id);
      return {
        ...current,
        agent_roster: existing.includes(agentId)
          ? existing.filter((id) => id !== agentId)
          : [...existing, agentId],
      };
    });
  };

  const createKey = async (kind: "secret" | "publishable") => {
    if (!selectedId) return;
    if (kind === "publishable" && !allowedOrigin.trim()) {
      setError("Add the website origin that may embed this widget.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/harness/profiles/${selectedId}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          name: kind === "publishable" ? "Widget key" : "API key",
          allowedOrigins:
            kind === "publishable" ? [allowedOrigin.trim()] : [],
          rateLimitPerMinute,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || "Could not create key");
      setPlaintextKey(payload.plaintext);
      await loadKeys(selectedId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create key");
    } finally {
      setBusy(false);
    }
  };

  const saveCapabilities = async () => {
    if (!selectedId || !capabilities) return;
    setCapabilitiesBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/harness/profiles/${selectedId}/capabilities`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inheritWorkspaceSkills: capabilities.inheritWorkspaceSkills,
            inheritWorkspaceIntegrations:
              capabilities.inheritWorkspaceIntegrations,
            skillArtifactIds: capabilities.skills
              .filter((skill) => skill.granted)
              .map((skill) => skill.id),
            integrationIds: capabilities.integrations
              .filter((integration) => integration.granted)
              .map((integration) => integration.id),
          }),
        },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Could not save Mind capabilities");
      }
      setCapabilities(payload as ProfileCapabilities);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save Mind capabilities",
      );
    } finally {
      setCapabilitiesBusy(false);
    }
  };

  const copyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
  };

  const revokeKey = async (keyId: string) => {
    if (!selectedId || !window.confirm("Revoke this key? Existing clients will stop immediately.")) {
      return;
    }
    await fetch(`/api/harness/profiles/${selectedId}/keys/${keyId}`, {
      method: "DELETE",
    });
    await loadKeys(selectedId);
  };

  const endpointBase =
    typeof window !== "undefined" ? window.location.origin : "https://your-groovy-host.example";
  const endpointSlug = selected?.slug || "customer-support";
  const exampleKey =
    plaintextKey?.startsWith("ghk_secret_")
      ? plaintextKey
      : "$GROOVY_API_KEY";
  const threadEndpoint = `${endpointBase}/api/v1/harnesses/${endpointSlug}/threads`;
  const curlExample = `THREAD_ID=$(curl -sS -X POST "${threadEndpoint}" \\
  -H "Authorization: Bearer ${exampleKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"participant":{"externalId":"customer-123","displayName":"Ada"}}' | jq -r '.id')

curl -sS -X POST "${threadEndpoint}/$THREAD_ID/messages" \\
  -H "Authorization: Bearer ${exampleKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"content":"How can you help me?"}'`;
  const javascriptExample = `const base = ${JSON.stringify(threadEndpoint)};
const headers = {
  Authorization: \`Bearer \${process.env.GROOVY_API_KEY}\`,
  "Content-Type": "application/json",
};
const thread = await fetch(base, {
  method: "POST",
  headers,
  body: JSON.stringify({
    participant: { externalId: "customer-123", displayName: "Ada" },
  }),
}).then((response) => response.json());
const reply = await fetch(\`\${base}/\${thread.id}/messages\`, {
  method: "POST",
  headers,
  body: JSON.stringify({ content: "How can you help me?" }),
}).then((response) => response.json());`;
  const pythonExample = `import os, requests

base = ${JSON.stringify(threadEndpoint)}
headers = {
    "Authorization": f"Bearer {os.environ['GROOVY_API_KEY']}",
    "Content-Type": "application/json",
}
thread = requests.post(base, headers=headers, json={
    "participant": {"externalId": "customer-123", "displayName": "Ada"}
}).json()
reply = requests.post(
    f"{base}/{thread['id']}/messages",
    headers=headers,
    json={"content": "How can you help me?"},
).json()`;

  return (
    <div className="app-scroll-page bg-[var(--bg-primary)] text-white">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Minds</h1>
            <p className="mt-1 text-sm text-zinc-400">
              Harness profiles — who your orchestrator is. The engine is shared; the soul is yours.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="text-sm text-zinc-400 hover:text-white">
              ← Dashboard
            </Link>
            <button
              onClick={() => setShowTemplates((v) => !v)}
              className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 py-1.5 text-sm text-cyan-300 hover:bg-cyan-400/20"
            >
              + New mind
            </button>
          </div>
        </div>

        {showTemplates && (
          <div className="mb-6 grid gap-2 sm:grid-cols-3">
            {HARNESS_PROFILE_TEMPLATES.map((tpl) => (
              <button
                key={tpl.key}
                disabled={busy}
                onClick={() => void createFromTemplate(tpl)}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left transition-colors hover:border-cyan-400/40"
              >
                <div className="text-sm font-medium">{tpl.name}</div>
                <div className="mt-1 text-xs leading-relaxed text-zinc-400">{tpl.description}</div>
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="grid gap-6 md:grid-cols-[280px_1fr]">
          <div className="space-y-2">
            {profiles.length === 0 && (
              <div className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-zinc-500">
                No minds yet. Your orchestrator uses the built-in Groovy persona. Create one to
                personalize it — or clone it for a second job like customer support.
              </div>
            )}
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={() => openProfile(p)}
                className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                  selectedId === p.id
                    ? "border-cyan-400/40 bg-cyan-400/5"
                    : "border-white/10 bg-white/5 hover:border-white/20"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  {p.is_default && <span className="text-[10px] text-zinc-500">default</span>}
                  {p.surface === "external" && (
                    <span className="rounded-full border border-amber-400/40 px-1.5 text-[9px] uppercase text-amber-300">
                      external
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-xs text-zinc-500">
                  {p.model ? `${p.model.model}` : "default brain"} ·{" "}
                  {p.authorization_stance === "restricted" ? "restricted" : "operator"} ·{" "}
                  {p.memory_scope === "profile" ? "own memory" : "shared memory"}
                </div>
              </button>
            ))}
          </div>

          {selected ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <label className={labelCls}>Name</label>
              <input
                className={inputCls}
                value={draft.name ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />

              <label className={labelCls}>Soul — persona prompt</label>
              <textarea
                className={`${inputCls} min-h-28 resize-y leading-relaxed`}
                placeholder="Empty = the built-in Groovy persona"
                value={draft.persona_prompt ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, persona_prompt: e.target.value || null }))}
              />
              <p className="mt-1 text-[11px] text-zinc-600">
                This is the only prompt you edit. Tools, memory, and delegation mechanics are the
                shared kernel.
              </p>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Purpose</label>
                  <input
                    className={inputCls}
                    value={draft.purpose ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, purpose: e.target.value || null }))}
                  />
                </div>
                <div>
                  <label className={labelCls}>Tone</label>
                  <input
                    className={inputCls}
                    value={draft.tone ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, tone: e.target.value || null }))}
                  />
                </div>
              </div>

              <label className={labelCls}>Custom instructions</label>
              <textarea
                className={`${inputCls} min-h-20 resize-y leading-relaxed`}
                value={draft.custom_instructions ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, custom_instructions: e.target.value || null }))
                }
              />

              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className={labelCls}>Authorization</label>
                  <select
                    className={inputCls}
                    value={draft.authorization_stance ?? "operator"}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        authorization_stance: e.target.value as "operator" | "restricted",
                      }))
                    }
                  >
                    <option value="operator">Operator — full trust</option>
                    <option value="restricted">Restricted — boundary + approvals</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Memory</label>
                  <select
                    className={inputCls}
                    value={draft.memory_scope ?? "shared"}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, memory_scope: e.target.value as "shared" | "profile" }))
                    }
                  >
                    <option value="shared">Shared workspace memory</option>
                    <option value="profile">Own memory only</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Brain (model id)</label>
                  <input
                    className={inputCls}
                    placeholder="empty = your default"
                    value={draft.model?.model ?? ""}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        model: e.target.value.trim()
                          ? {
                              provider: d.model?.provider ?? "anthropic",
                              model: e.target.value,
                              reasoningEffort: d.model?.reasoningEffort ?? null,
                            }
                          : null,
                      }))
                    }
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Surface</label>
                  <select
                    className={inputCls}
                    value={draft.surface ?? "internal"}
                    onChange={(e) => {
                      const surface = e.target.value as "internal" | "external";
                      setDraft((current) => ({
                        ...current,
                        surface,
                        ...(surface === "external"
                          ? {
                              authorization_stance: "restricted",
                              memory_scope: "profile",
                              tool_policy: {
                                mode: "allowlist",
                                tools:
                                  current.tool_policy?.mode === "allowlist"
                                    ? current.tool_policy.tools.filter((tool) =>
                                        EXTERNAL_TOOL_OPTIONS.has(tool),
                                      )
                                    : [
                                        "web_search",
                                        "files_agent_request",
                                        "remember",
                                        "recall",
                                        "wiki_search",
                                        "wiki_read",
                                        "wiki_file_learning",
                                      ],
                              },
                            }
                          : {}),
                      }));
                    }}
                  >
                    <option value="internal">Internal — teammates/operators</option>
                    <option value="external">External — API and widget</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Model provider</label>
                  <select
                    className={inputCls}
                    value={draft.model?.provider ?? "anthropic"}
                    onChange={(e) =>
                      setDraft((current) => ({
                        ...current,
                        model: current.model
                          ? {
                              ...current.model,
                              provider: e.target.value as "anthropic" | "openai",
                            }
                          : null,
                      }))
                    }
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                  </select>
                </div>
              </div>

              <label className={labelCls}>Tool policy</label>
              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                <label className="flex items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={draft.tool_policy?.mode !== "allowlist"}
                    disabled={draft.surface === "external"}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        tool_policy: event.target.checked
                          ? { mode: "all" }
                          : { mode: "allowlist", tools: [] },
                      }))
                    }
                  />
                  All runtime tools
                  {draft.surface === "external" ? (
                    <span className="text-xs text-amber-300">
                      External profiles are always deny-by-default.
                    </span>
                  ) : null}
                </label>
                {draft.tool_policy?.mode === "allowlist" ? (
                  <div className="mt-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      {TOOL_OPTIONS.filter(
                        ([name]) =>
                          draft.surface !== "external" || EXTERNAL_TOOL_OPTIONS.has(name),
                      ).map(([name, label]) => (
                        <label key={name} className="flex items-center gap-2 text-xs text-zinc-400">
                          <input
                            type="checkbox"
                            checked={
                              draft.tool_policy?.mode === "allowlist" &&
                              draft.tool_policy.tools.includes(name)
                            }
                            onChange={() => toggleTool(name)}
                          />
                          {label}
                          <code className="text-[10px] text-zinc-600">{name}</code>
                        </label>
                      ))}
                    </div>
                    {draft.tool_policy.tools.includes("data_query") ? (
                      <div className="mt-3 border-t border-white/10 pt-3">
                        <div className="mb-2 text-[11px] text-zinc-500">
                          Data sources are deny-by-default. Select each source this mind may query.
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {DATA_SOURCE_OPTIONS.map(([source, label]) => (
                            <label
                              key={source}
                              className="flex items-center gap-2 text-xs text-zinc-400"
                            >
                              <input
                                type="checkbox"
                                checked={
                                  draft.tool_policy?.mode === "allowlist" &&
                                  draft.tool_policy.dataSources?.includes(source) === true
                                }
                                onChange={() => toggleDataSource(source)}
                              />
                              {label}
                              <code className="text-[10px] text-zinc-600">{source}</code>
                            </label>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <label className={labelCls}>Agent roster</label>
              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                <label className="flex items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={draft.agent_roster == null}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        agent_roster: event.target.checked
                          ? null
                          : agents.map((agent) => agent.id),
                      }))
                    }
                  />
                  All worker agents
                </label>
                {draft.agent_roster != null ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {agents.map((agent) => (
                      <label key={agent.id} className="flex items-center gap-2 text-xs text-zinc-400">
                        <input
                          type="checkbox"
                          checked={draft.agent_roster?.includes(agent.id) === true}
                          onChange={() => toggleAgent(agent.id)}
                        />
                        {agent.name}
                        <span className="text-[10px] text-zinc-600">{agent.harness}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="mt-6 rounded-xl border border-violet-400/20 bg-violet-400/[0.04] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-medium text-violet-200">
                      Skills, docs &amp; integrations
                    </h2>
                    <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                      Capabilities are configured once and follow this Mind into
                      Command Center, Chat, messaging, schedules, API threads,
                      and the widget.
                    </p>
                  </div>
                  <Link
                    href="/settings"
                    className="shrink-0 text-xs text-violet-300 hover:text-violet-200"
                  >
                    Open workspace settings
                  </Link>
                </div>

                {!capabilities ? (
                  <p className="mt-4 text-xs text-zinc-500">
                    Loading the shared capability library…
                  </p>
                ) : (
                  <div className="mt-4 space-y-5">
                    <section>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-medium text-zinc-300">
                            Skills &amp; Markdown instructions
                          </div>
                          <div className="text-[11px] text-zinc-600">
                            `SKILL.md` packages and instruction documents from the
                            shared Git-backed library.
                          </div>
                        </div>
                        <label className="flex items-center gap-2 text-[11px] text-zinc-400">
                          <input
                            type="checkbox"
                            checked={capabilities.inheritWorkspaceSkills}
                            disabled={draft.surface === "external"}
                            onChange={(event) =>
                              setCapabilities((current) =>
                                current
                                  ? {
                                      ...current,
                                      inheritWorkspaceSkills:
                                        event.target.checked,
                                    }
                                  : current,
                              )
                            }
                          />
                          {draft.surface === "external"
                            ? "Grant public-safe items explicitly"
                            : "Inherit workspace defaults"}
                        </label>
                      </div>
                      {capabilities.skills.length ? (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          {capabilities.skills.map((skill) => {
                            const inherited =
                              capabilities.inheritWorkspaceSkills &&
                              skill.inherited;
                            return (
                              <label
                                key={skill.id}
                                className="flex items-start gap-2 rounded-lg border border-white/10 bg-black/20 p-2.5 text-xs text-zinc-300"
                                title={
                                  inherited
                                    ? "Disable workspace inheritance to remove this default from the Mind."
                                    : skill.relativePath
                                }
                              >
                                <input
                                  className="mt-0.5"
                                  type="checkbox"
                                  checked={skill.granted || inherited}
                                  disabled={inherited}
                                  onChange={() =>
                                    setCapabilities((current) =>
                                      current
                                        ? {
                                            ...current,
                                            skills: current.skills.map((item) =>
                                              item.id === skill.id
                                                ? {
                                                    ...item,
                                                    granted: !item.granted,
                                                  }
                                                : item,
                                            ),
                                          }
                                        : current,
                                    )
                                  }
                                />
                                <span className="min-w-0">
                                  <span className="block truncate">
                                    {skill.name}
                                  </span>
                                  <span className="block truncate text-[10px] text-zinc-600">
                                    {skill.type === "skill"
                                      ? "Skill"
                                      : "Markdown instructions"}
                                    {inherited ? " · workspace default" : ""}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="mt-2 text-[11px] text-zinc-600">
                          No skills or instruction docs yet. Add them in{" "}
                          <Link
                            href="/settings/skills"
                            className="text-violet-300"
                          >
                            Settings → Skills &amp; Docs
                          </Link>
                          .
                        </p>
                      )}
                    </section>

                    <section className="border-t border-white/10 pt-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-medium text-zinc-300">
                            Datagran &amp; data integrations
                          </div>
                          <div className="text-[11px] text-zinc-600">
                            Connections stay workspace-owned; this grants the Mind
                            access to selected connections.
                            {draft.surface === "external"
                              ? " External Minds never inherit connections: grant only the connections that match the approved data sources above."
                              : ""}
                          </div>
                        </div>
                        <label className="flex items-center gap-2 text-[11px] text-zinc-400">
                          <input
                            type="checkbox"
                            checked={
                              capabilities.inheritWorkspaceIntegrations
                            }
                            disabled={draft.surface === "external"}
                            onChange={(event) =>
                              setCapabilities((current) =>
                                current
                                  ? {
                                      ...current,
                                      inheritWorkspaceIntegrations:
                                        event.target.checked,
                                    }
                                  : current,
                              )
                            }
                          />
                          {draft.surface === "external"
                            ? "Grant connections explicitly"
                            : "Inherit workspace defaults"}
                        </label>
                      </div>
                      {capabilities.integrations.length ? (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          {capabilities.integrations.map((integration) => {
                            const inherited =
                              capabilities.inheritWorkspaceIntegrations &&
                              integration.inherited;
                            return (
                              <label
                                key={integration.id}
                                className="flex items-start gap-2 rounded-lg border border-white/10 bg-black/20 p-2.5 text-xs text-zinc-300"
                                title={
                                  inherited
                                    ? "Disable workspace inheritance to remove this default from the Mind."
                                    : integration.provider
                                }
                              >
                                <input
                                  className="mt-0.5"
                                  type="checkbox"
                                  checked={integration.granted || inherited}
                                  disabled={
                                    inherited || !integration.connected
                                  }
                                  onChange={() =>
                                    setCapabilities((current) =>
                                      current
                                        ? {
                                            ...current,
                                            integrations:
                                              current.integrations.map((item) =>
                                                item.id === integration.id
                                                  ? {
                                                      ...item,
                                                      granted: !item.granted,
                                                    }
                                                  : item,
                                              ),
                                          }
                                        : current,
                                    )
                                  }
                                />
                                <span className="min-w-0">
                                  <span className="block truncate">
                                    {integration.name}
                                  </span>
                                  <span className="block truncate text-[10px] text-zinc-600">
                                    {integration.provider}
                                    {!integration.connected
                                      ? " · reconnect required"
                                      : inherited
                                        ? " · workspace default"
                                        : ""}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="mt-2 text-[11px] text-zinc-600">
                          No data connections yet. Connect Datagran or another
                          provider in{" "}
                          <Link
                            href="/settings/integrations"
                            className="text-violet-300"
                          >
                            Settings → Integrations
                          </Link>
                          .
                        </p>
                      )}
                    </section>

                    <div className="flex justify-end border-t border-white/10 pt-3">
                      <button
                        disabled={capabilitiesBusy}
                        onClick={() => void saveCapabilities()}
                        className="rounded-lg border border-violet-300/30 bg-violet-300/10 px-3 py-1.5 text-xs text-violet-200 disabled:opacity-50"
                      >
                        {capabilitiesBusy
                          ? "Saving capabilities…"
                          : "Save capabilities"}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {draft.surface === "external" ? (
                <div className="mt-6 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-4">
                  <h2 className="text-sm font-medium text-amber-200">API &amp; Widget</h2>
                  <p className="mt-1 text-xs text-zinc-500">
                    This Mind&apos;s endpoint is ready after you save it as
                    external and create a key. Plaintext keys are shown once.
                  </p>
                  <label className={labelCls}>Thread endpoint</label>
                  <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                    <code className="min-w-0 flex-1 truncate text-[11px] text-amber-100">
                      POST {threadEndpoint}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyText(threadEndpoint)}
                      className="text-[11px] text-amber-300"
                    >
                      Copy
                    </button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className={labelCls}>Widget greeting</label>
                      <input
                        className={inputCls}
                        value={draft.widget_config?.greeting ?? ""}
                        onChange={(e) =>
                          setDraft((current) => ({
                            ...current,
                            widget_config: {
                              ...(current.widget_config || {}),
                              greeting: e.target.value,
                            },
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Primary color</label>
                      <input
                        className={inputCls}
                        placeholder="#06b6d4"
                        value={draft.widget_config?.primaryColor ?? ""}
                        onChange={(e) =>
                          setDraft((current) => ({
                            ...current,
                            widget_config: {
                              ...(current.widget_config || {}),
                              primaryColor: e.target.value,
                            },
                          }))
                        }
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
                    <div>
                      <label className={labelCls}>Allowed website origin</label>
                      <input
                        className={inputCls}
                        placeholder="https://support.example.com"
                        value={allowedOrigin}
                        onChange={(e) => setAllowedOrigin(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Requests / minute</label>
                      <input
                        className={inputCls}
                        type="number"
                        min={1}
                        max={10000}
                        value={rateLimitPerMinute}
                        onChange={(event) =>
                          setRateLimitPerMinute(
                            Math.max(
                              1,
                              Math.min(
                                10000,
                                Number(event.target.value) || 60,
                              ),
                            ),
                          )
                        }
                      />
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      disabled={busy}
                      onClick={() => void createKey("publishable")}
                      className="rounded-lg border border-amber-300/30 px-3 py-2 text-xs text-amber-200"
                    >
                      Create widget key
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => void createKey("secret")}
                      className="rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300"
                    >
                      Create secret key
                    </button>
                  </div>
                  {plaintextKey ? (
                    <div className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3">
                      <div className="text-xs font-medium text-emerald-300">
                        Copy this key now — it will not be shown again.
                      </div>
                      <code className="mt-2 block break-all select-all text-xs text-white">
                        {plaintextKey}
                      </code>
                      {plaintextKey.startsWith("ghk_pub_") && selected ? (
                        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-[11px] text-zinc-300">
{`<script
  src="${typeof window !== "undefined" ? window.location.origin : ""}/widget.js"
  data-harness="${selected.slug}"
  data-key="${plaintextKey}">
</script>`}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="mt-3 space-y-2">
                    {keys.map((key) => (
                      <div
                        key={key.id}
                        className="flex items-center gap-3 rounded-lg border border-white/10 px-3 py-2 text-xs"
                      >
                        <span className="font-medium">{key.name}</span>
                        <code className="text-zinc-500">{key.key_prefix}…</code>
                        <span className="text-zinc-500">
                          {key.request_count || 0} requests
                        </span>
                        <span className="text-zinc-600">
                          {key.rate_limit_per_minute || 60}/min
                        </span>
                        {key.last_used_at ? (
                          <span className="hidden text-zinc-600 lg:inline">
                            last used{" "}
                            {new Date(key.last_used_at).toLocaleDateString()}
                          </span>
                        ) : null}
                        {key.revoked_at ? (
                          <span className="ml-auto text-red-300">revoked</span>
                        ) : (
                          <button
                            onClick={() => void revokeKey(key.id)}
                            className="ml-auto text-red-300/80 hover:text-red-300"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-5 border-t border-white/10 pt-4">
                    <div className="text-xs font-medium text-zinc-300">
                      Call this orchestrator
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-600">
                      Create a thread once per end user or conversation, then
                      send messages to that thread. Add{" "}
                      <code>Accept: text/event-stream</code> to stream status and
                      the final message over SSE.
                    </p>
                    <div className="mt-3 space-y-3">
                      {[
                        ["curl", curlExample],
                        ["JavaScript", javascriptExample],
                        ["Python", pythonExample],
                      ].map(([label, code]) => (
                        <div
                          key={label}
                          className="overflow-hidden rounded-lg border border-white/10 bg-black/30"
                        >
                          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
                            <span className="text-[11px] font-medium text-zinc-400">
                              {label}
                            </span>
                            <button
                              type="button"
                              onClick={() => void copyText(code)}
                              className="text-[11px] text-amber-300"
                            >
                              Copy
                            </button>
                          </div>
                          <pre className="max-h-72 overflow-auto whitespace-pre p-3 text-[11px] leading-relaxed text-zinc-300">
                            {code}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="mt-6 flex items-center gap-2 border-t border-white/10 pt-4">
                <button
                  disabled={busy}
                  onClick={() => void save()}
                  className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-300 hover:bg-cyan-400/20 disabled:opacity-40"
                >
                  Save
                </button>
                {!selected.is_default && (
                  <button
                    disabled={busy}
                    onClick={() => void setDefault(selected.id)}
                    className="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300 hover:text-white"
                  >
                    Make default
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() => void clone(selected.id)}
                  className="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300 hover:text-white"
                >
                  Clone
                </button>
                <button
                  disabled={busy}
                  onClick={() => void remove(selected.id)}
                  className="ml-auto rounded-lg px-3 py-2 text-sm text-red-400/80 hover:text-red-400"
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center rounded-2xl border border-dashed border-white/10 p-10 text-sm text-zinc-500">
              Select a mind to edit it — or create one from a template.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
