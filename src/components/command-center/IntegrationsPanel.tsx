"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Plus,
  Plug,
  Server,
  Check,
  AlertCircle,
  ChevronRight,
  Activity,
  Globe,
  Terminal,
  Wifi,
  Shield,
  RefreshCw,
  ExternalLink,
  Eye,
  EyeOff,
  Trash2,
  Settings,
  Zap,
  Package,
  ArrowLeft,
  Clock,
  BarChart3,
  FileText,
} from "lucide-react";

type Extension = {
  id: string;
  agent_id?: string;
  slug: string;
  name: string;
  description: string;
  visibility: string;
  runtime_target_default: string;
  status: string;
  active_version_id: string | null;
  created_at: string;
  updated_at: string;
  activeVersion: Record<string, unknown> | null;
  installation: Record<string, unknown> | null;
  connections: Array<Record<string, unknown>>;
};

type Runner = {
  id: string;
  name: string;
  runtime_target: string;
  transport: string;
  status: string;
  endpoint: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

type ViewState =
  | { view: "list" }
  | { view: "create" }
  | { view: "detail"; extension: Extension }
  | { view: "runners" }
  | { view: "create-runner" };

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    installed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    connected: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    online: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    draft: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
    pending: "bg-amber-500/20 text-amber-400 border-amber-500/30",
    offline: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
    disabled: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
    error: "bg-red-500/20 text-red-400 border-red-500/30",
    disconnected: "bg-red-500/20 text-red-400 border-red-500/30",
  };
  return (
    <span
      className={`text-[10px] px-2 py-0.5 rounded-full border ${colors[status] || colors.draft}`}
    >
      {status}
    </span>
  );
}

function RuntimeIcon({ target }: { target: string }) {
  if (target === "customer_runner") return <Server className="w-3.5 h-3.5" />;
  if (target === "device_connector") return <Wifi className="w-3.5 h-3.5" />;
  return <Globe className="w-3.5 h-3.5" />;
}

type ConnectionField = {
  name: string;
  secret: boolean;
};

const CONNECTION_TEMPLATE_RE = /\{\{\s*connection\.([A-Za-z0-9_.-]+)\s*\}\}/g;
const SECRET_CONNECTION_FIELD_RE =
  /(token|secret|password|credential|authorization|bearer|api[_-]?key|private[_-]?key|access[_-]?key)/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isSecretConnectionField(name: string): boolean {
  return SECRET_CONNECTION_FIELD_RE.test(name);
}

function formatConnectionFieldLabel(name: string): string {
  return name.replace(/[_.-]+/g, " ");
}

function connectionFieldPlaceholder(field: ConnectionField, connectionStatus: string | null): string {
  if (field.secret && connectionStatus === "connected") return "Leave blank to keep saved value";
  if (field.secret) return "Paste value here";
  if (/url/i.test(field.name)) return "https://api.example.com";
  return field.name;
}

function collectConnectionFields(value: unknown, fields = new Map<string, ConnectionField>()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(CONNECTION_TEMPLATE_RE)) {
      const name = match[1]?.trim();
      if (!name || fields.has(name)) continue;
      fields.set(name, { name, secret: isSecretConnectionField(name) });
    }
    return fields;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectConnectionFields(item, fields);
    return fields;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectConnectionFields(item, fields);
    }
  }

  return fields;
}

function getConnectionValue(source: Record<string, unknown>, path: string): unknown {
  if (source[path] !== undefined) return source[path];
  const parts = path.split(".");
  let current: unknown = source;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function assignConnectionValue(target: Record<string, unknown>, path: string, value: string) {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return;
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function parseJsonObjectInput(raw: string, label: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function EmptyState({ onAction, actionLabel, title, description }: {
  onAction: () => void;
  actionLabel: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center mb-4">
        <Package className="w-6 h-6 text-cyan-400" />
      </div>
      <h3 className="text-base font-semibold text-white mb-1">{title}</h3>
      <p className="text-sm text-zinc-500 mb-6 max-w-xs">{description}</p>
      <button
        onClick={onAction}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-sm font-medium hover:bg-cyan-500/20 transition-all"
      >
        <Plus className="w-4 h-4" />
        {actionLabel}
      </button>
    </div>
  );
}

function CreateExtensionForm({ agentId, onCreated, onCancel }: {
  agentId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [runtimeTarget, setRuntimeTarget] = useState("groovy_cloud");
  const [manifest, setManifest] = useState(`{
  "schemaVersion": 1,
  "capabilityTags": [],
  "skillInstructions": "",
  "tools": [
    {
      "slug": "example_action",
      "name": "Example Action",
      "description": "Describe what this tool does",
      "riskLevel": "read",
      "authScope": "end_user",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" }
        },
        "required": ["query"]
      },
      "action": {
        "kind": "http_action",
        "method": "GET",
        "url": "{{connection.base_url}}/api/example",
        "headers": {
          "Authorization": "Bearer {{connection.api_token}}"
        },
        "query": { "q": "{{query}}" }
      }
    }
  ]
}`);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!slug.trim() || !name.trim()) {
      setError("Slug and name are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let parsedManifest;
      try {
        parsedManifest = JSON.parse(manifest);
      } catch {
        setError("Invalid manifest JSON");
        setSaving(false);
        return;
      }
      const res = await fetch("/api/extensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          slug: slug.trim(),
          name: name.trim(),
          description: description.trim(),
          runtimeTargetDefault: runtimeTarget,
          manifest: parsedManifest,
          activate: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create extension");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create extension");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 mb-2">
        <button onClick={onCancel} className="text-zinc-500 hover:text-white transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold text-white">Create Integration</h2>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">Slug</label>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              placeholder="acmeops"
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="AcmeOps"
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none transition-colors"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this integration do?"
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">Runtime Target</label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { value: "groovy_cloud", label: "Cloud API", icon: Globe },
              { value: "customer_runner", label: "CLI Runner", icon: Terminal },
              { value: "device_connector", label: "Local", icon: Wifi },
            ].map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.value}
                  onClick={() => setRuntimeTarget(opt.value)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all ${
                    runtimeTarget === opt.value
                      ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-400"
                      : "border-white/10 bg-white/[0.02] text-zinc-400 hover:border-white/20"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">Manifest (JSON)</label>
          <textarea
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            rows={14}
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs font-mono placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none transition-colors resize-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black text-sm font-semibold shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 transition-all disabled:opacity-50"
        >
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          Create & Activate
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2.5 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-all"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

type TelemetryTab = "overview" | "traces" | "audit" | "usage";

type TelemetryRow = Record<string, unknown>;

type TelemetryOverview = {
  totalTraces: number;
  totalUsage: number;
  recentSuccessCount: number;
  recentErrorCount: number;
  avgDurationMs: number;
  recentTraces: TelemetryRow[];
  recentUsage: TelemetryRow[];
};

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function TelemetryStatusDot({ status }: { status: string }) {
  const color =
    status === "success"
      ? "bg-emerald-400"
      : status === "error"
        ? "bg-red-400"
        : "bg-amber-400";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} />;
}

function TelemetryRowCard({ row, fields }: { row: TelemetryRow; fields: { key: string; label: string }[] }) {
  const [expanded, setExpanded] = useState(false);
  const status = String(row.status || "");
  const toolName = String(row.tool_name || "");
  const createdAt = String(row.created_at || "");
  const durationMs = Number(row.duration_ms) || 0;
  const errorCode = String(row.error_code || "");
  const errorMessage = String(row.error_message || "");

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2.5 flex items-center gap-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <TelemetryStatusDot status={status} />
        <span className="text-xs text-white font-medium truncate flex-1">{toolName}</span>
        {durationMs > 0 && (
          <span className="text-[10px] text-zinc-500 shrink-0">{durationMs}ms</span>
        )}
        {errorCode && (
          <span className="text-[10px] text-red-400 shrink-0">{errorCode}</span>
        )}
        <span className="text-[10px] text-zinc-600 shrink-0">{createdAt ? formatAge(createdAt) : ""}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-1.5 border-t border-white/5 pt-2">
          {errorMessage && (
            <div className="text-[11px] text-red-300 bg-red-500/10 rounded-lg px-2.5 py-1.5">{errorMessage}</div>
          )}
          {fields.map((f) => {
            const val = row[f.key];
            if (val === null || val === undefined || val === "") return null;
            const display =
              typeof val === "object" ? JSON.stringify(val, null, 2) : String(val);
            return (
              <div key={f.key}>
                <div className="text-[10px] text-zinc-500">{f.label}</div>
                <pre className="text-[11px] text-zinc-300 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">{display}</pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ExtensionTelemetry({ extensionId }: { extensionId: string }) {
  const [tab, setTab] = useState<TelemetryTab>("overview");
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState<TelemetryOverview | null>(null);
  const [rows, setRows] = useState<TelemetryRow[]>([]);
  const [total, setTotal] = useState(0);

  const load = useCallback(
    async (kind: TelemetryTab) => {
      if (!extensionId) return;
      setLoading(true);
      try {
        const res = await fetch(
          `/api/extensions/${extensionId}/telemetry?kind=${kind}&limit=50`
        );
        const data = await res.json();
        if (!res.ok) return;
        if (kind === "overview") {
          setOverview(data.overview || null);
          setRows([]);
          setTotal(0);
        } else {
          const listKey = kind === "traces" ? "traces" : kind === "audit" ? "audit" : kind === "usage" ? "usage" : "analytics";
          setRows(data[listKey] || []);
          setTotal(data.total ?? 0);
          setOverview(null);
        }
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    },
    [extensionId]
  );

  useEffect(() => {
    load(tab);
  }, [tab, load]);

  const tabs: { id: TelemetryTab; label: string; icon: typeof Activity }[] = [
    { id: "overview", label: "Overview", icon: BarChart3 },
    { id: "traces", label: "Traces", icon: Activity },
    { id: "audit", label: "Audit", icon: Shield },
    { id: "usage", label: "Usage", icon: Clock },
  ];

  const traceFields = [
    { key: "trace_id", label: "Trace ID" },
    { key: "turn_id", label: "Turn ID" },
    { key: "runtime_target", label: "Runtime" },
    { key: "adapter", label: "Adapter" },
    { key: "request_payload", label: "Request" },
    { key: "response_payload", label: "Response" },
    { key: "metadata", label: "Metadata" },
  ];

  const auditFields = [
    { key: "trace_id", label: "Trace ID" },
    { key: "turn_id", label: "Turn ID" },
    { key: "action", label: "Action" },
    { key: "actor_scope", label: "Actor scope" },
    { key: "approval_state", label: "Approval" },
    { key: "request_preview", label: "Request" },
    { key: "result_preview", label: "Result" },
    { key: "metadata", label: "Metadata" },
  ];

  const usageFields = [
    { key: "trace_id", label: "Trace ID" },
    { key: "turn_id", label: "Turn ID" },
    { key: "runtime_target", label: "Runtime" },
    { key: "auth_scope", label: "Auth scope" },
    { key: "risk_level", label: "Risk level" },
    { key: "approval_state", label: "Approval" },
    { key: "input_bytes", label: "Input bytes" },
    { key: "output_bytes", label: "Output bytes" },
    { key: "metadata", label: "Metadata" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 rounded-xl bg-white/[0.03] border border-white/5 p-1">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${
                tab === t.id
                  ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                  : "text-zinc-500 hover:text-zinc-300 border border-transparent"
              }`}
            >
              <Icon className="w-3 h-3" />
              {t.label}
            </button>
          );
        })}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-8">
          <RefreshCw className="w-4 h-4 text-zinc-500 animate-spin" />
        </div>
      )}

      {!loading && tab === "overview" && overview && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Total calls", value: String(overview.totalUsage) },
              { label: "Total traces", value: String(overview.totalTraces) },
              {
                label: "Recent success",
                value: String(overview.recentSuccessCount),
                color: "text-emerald-400",
              },
              {
                label: "Recent errors",
                value: String(overview.recentErrorCount),
                color: overview.recentErrorCount > 0 ? "text-red-400" : "text-zinc-400",
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="p-3 rounded-xl border border-white/5 bg-white/[0.02] text-center"
              >
                <div className={`text-lg font-semibold ${stat.color || "text-white"}`}>
                  {stat.value}
                </div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{stat.label}</div>
              </div>
            ))}
          </div>

          {overview.avgDurationMs > 0 && (
            <div className="text-xs text-zinc-500">
              Avg duration (recent): <span className="text-zinc-300">{overview.avgDurationMs}ms</span>
            </div>
          )}

          {overview.recentTraces.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Recent traces</h4>
              {overview.recentTraces.map((row, i) => (
                <TelemetryRowCard key={String(row.id || i)} row={row} fields={traceFields.slice(0, 3)} />
              ))}
            </div>
          )}

          {overview.totalTraces === 0 && overview.totalUsage === 0 && (
            <div className="text-center py-8">
              <Activity className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No telemetry data yet</p>
              <p className="text-xs text-zinc-600 mt-1">Data will appear here after Groovy uses this integration.</p>
            </div>
          )}
        </div>
      )}

      {!loading && tab === "traces" && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500">{total} trace{total !== 1 ? "s" : ""}</div>
          {rows.length === 0 ? (
            <p className="text-sm text-zinc-500 text-center py-6">No traces yet</p>
          ) : (
            rows.map((row, i) => (
              <TelemetryRowCard key={String(row.id || i)} row={row} fields={traceFields} />
            ))
          )}
        </div>
      )}

      {!loading && tab === "audit" && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500">{total} event{total !== 1 ? "s" : ""}</div>
          {rows.length === 0 ? (
            <p className="text-sm text-zinc-500 text-center py-6">No audit events yet</p>
          ) : (
            rows.map((row, i) => (
              <TelemetryRowCard key={String(row.id || i)} row={row} fields={auditFields} />
            ))
          )}
        </div>
      )}

      {!loading && tab === "usage" && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500">{total} record{total !== 1 ? "s" : ""}</div>
          {rows.length === 0 ? (
            <p className="text-sm text-zinc-500 text-center py-6">No usage data yet</p>
          ) : (
            rows.map((row, i) => (
              <TelemetryRowCard key={String(row.id || i)} row={row} fields={usageFields} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

type DetailTab = "setup" | "telemetry";

function ExtensionDetail({ extension, onBack, onRefresh }: {
  extension: Extension;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [connectionValues, setConnectionValues] = useState<Record<string, string>>({});
  const [connectConfig, setConnectConfig] = useState("");
  const [connectSecrets, setConnectSecrets] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("setup");

  const isInstalled = !!extension.installation;
  const installStatus = (extension.installation as Record<string, unknown> | null)?.install_status as string | undefined;
  const connectionStatus = extension.connections.length > 0
    ? (extension.connections[0].status as string)
    : null;
  const manifest = (extension.activeVersion as Record<string, unknown> | null)?.manifest as Record<string, unknown> | null;
  const tools = Array.isArray((manifest as Record<string, unknown> | null)?.tools)
    ? (manifest!.tools as Array<Record<string, unknown>>)
    : [];
  const currentConnection = extension.connections[0] || null;
  const connectionFields = useMemo(
    () =>
      Array.from(collectConnectionFields(manifest).values()).sort((a, b) => {
        if (a.secret !== b.secret) return a.secret ? 1 : -1;
        return a.name.localeCompare(b.name);
      }),
    [manifest]
  );
  const hasGeneratedSecretFields = connectionFields.some((field) => field.secret);
  const showAdvancedConnectionJson = connectionFields.length === 0;

  useEffect(() => {
    const config = asRecord(currentConnection?.config);
    setConnectionValues((previous) => {
      const next: Record<string, string> = {};
      for (const field of connectionFields) {
        if (field.secret) {
          next[field.name] = previous[field.name] || "";
          continue;
        }
        const existing = getConnectionValue(config, field.name);
        next[field.name] = existing === undefined || existing === null ? previous[field.name] || "" : String(existing);
      }
      return next;
    });
  }, [connectionFields, currentConnection?.config]);

  const handleInstall = async () => {
    setInstalling(true);
    setError(null);
    try {
      const res = await fetch(`/api/extensions/${extension.id}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to install");
      setSuccess("Installed successfully");
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Install failed");
    } finally {
      setInstalling(false);
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const config = { ...(parseJsonObjectInput(connectConfig, "Config") || {}) };
      const secrets = { ...(parseJsonObjectInput(connectSecrets, "Secrets") || {}) };

      for (const field of connectionFields) {
        const rawValue = connectionValues[field.name] || "";
        const value = rawValue.trim();
        if (field.secret) {
          if (!value) {
            if (connectionStatus === "connected") continue;
            throw new Error(`${field.name} is required`);
          }
          assignConnectionValue(secrets, field.name, value);
          continue;
        }

        if (!value) throw new Error(`${field.name} is required`);
        assignConnectionValue(config, field.name, value);
      }

      const body: Record<string, unknown> = {};
      if (Object.keys(config).length > 0) body.config = config;
      if (Object.keys(secrets).length > 0) body.secrets = secrets;

      const res = await fetch(`/api/extensions/${extension.id}/connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to connect");
      setSuccess("Connection saved");
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 mb-2">
        <button onClick={onBack} className="text-zinc-500 hover:text-white transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-white truncate">{extension.name}</h2>
            <StatusBadge status={extension.status} />
          </div>
          <p className="text-xs text-zinc-500">{extension.slug}</p>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}
      {success && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          <p className="text-sm text-emerald-300">{success}</p>
        </div>
      )}

      {extension.description && (
        <p className="text-sm text-zinc-400">{extension.description}</p>
      )}

      <div className="flex items-center gap-4 text-xs text-zinc-500">
        <span className="flex items-center gap-1">
          <RuntimeIcon target={extension.runtime_target_default} />
          {extension.runtime_target_default.replace("_", " ")}
        </span>
        {tools.length > 0 && (
          <span>{tools.length} tool{tools.length !== 1 ? "s" : ""}</span>
        )}
      </div>

      <div className="flex items-center gap-1 rounded-xl bg-white/[0.03] border border-white/5 p-1">
        <button
          onClick={() => setDetailTab("setup")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${
            detailTab === "setup"
              ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
              : "text-zinc-500 hover:text-zinc-300 border border-transparent"
          }`}
        >
          <Settings className="w-3 h-3" />
          Setup
        </button>
        <button
          onClick={() => setDetailTab("telemetry")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${
            detailTab === "telemetry"
              ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
              : "text-zinc-500 hover:text-zinc-300 border border-transparent"
          }`}
        >
          <Activity className="w-3 h-3" />
          Telemetry
        </button>
      </div>

      {detailTab === "setup" && (
        <>
          <div className="space-y-3">
            <h3 className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Installation</h3>
            {isInstalled ? (
              <div className="p-3 rounded-xl border border-white/10 bg-white/[0.02] flex items-center gap-3">
                <Check className="w-4 h-4 text-emerald-400" />
                <span className="text-sm text-white flex-1">Installed</span>
                <StatusBadge status={installStatus || "installed"} />
              </div>
            ) : (
              <button
                onClick={handleInstall}
                disabled={installing}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-sm font-medium hover:bg-cyan-500/20 transition-all disabled:opacity-50"
              >
                {installing ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                Install Integration
              </button>
            )}
          </div>

          {isInstalled && (
            <div className="space-y-3">
              <h3 className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Connection</h3>
              {connectionStatus && (
                <div className="p-3 rounded-xl border border-white/10 bg-white/[0.02] flex items-center gap-3">
                  <Plug className="w-4 h-4 text-zinc-400" />
                  <span className="text-sm text-white flex-1">Current connection</span>
                  <StatusBadge status={connectionStatus} />
                </div>
              )}
              <div className="space-y-3">
                {connectionFields.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-zinc-500">Connection values</label>
                      {hasGeneratedSecretFields && (
                        <button
                          type="button"
                          onClick={() => setShowSecrets(!showSecrets)}
                          className="text-zinc-600 hover:text-zinc-400"
                          title={showSecrets ? "Hide secrets" : "Show secrets"}
                        >
                          {showSecrets ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                      {connectionFields.map((field) => (
                        <div key={field.name}>
                          <label className="block text-[10px] text-zinc-500 mb-1">
                            {formatConnectionFieldLabel(field.name)}
                            <span className="ml-1 font-mono text-zinc-600">({field.name})</span>
                          </label>
                          <input
                            value={connectionValues[field.name] || ""}
                            onChange={(e) =>
                              setConnectionValues((previous) => ({
                                ...previous,
                                [field.name]: e.target.value,
                              }))
                            }
                            type={field.secret && !showSecrets ? "password" : "text"}
                            placeholder={connectionFieldPlaceholder(field, connectionStatus)}
                            autoComplete="off"
                            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none transition-colors"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {showAdvancedConnectionJson ? (
                  <>
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">Config (JSON)</label>
                      <textarea
                        value={connectConfig}
                        onChange={(e) => setConnectConfig(e.target.value)}
                        placeholder='{"base_url": "https://api.acme.com"}'
                        rows={2}
                        className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs font-mono placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none transition-colors resize-none"
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs text-zinc-500">Secrets (JSON, encrypted)</label>
                        <button
                          type="button"
                          onClick={() => setShowSecrets(!showSecrets)}
                          className="text-zinc-600 hover:text-zinc-400"
                          title={showSecrets ? "Hide secrets" : "Show secrets"}
                        >
                          {showSecrets ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                        </button>
                      </div>
                      <textarea
                        value={connectSecrets}
                        onChange={(e) => setConnectSecrets(e.target.value)}
                        placeholder='{"api_token": "sk-..."}'
                        rows={2}
                        className={`w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs font-mono placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none transition-colors resize-none ${
                          !showSecrets && connectSecrets ? "blur-sm hover:blur-none" : ""
                        }`}
                      />
                    </div>
                  </>
                ) : (
                  <details className="rounded-lg border border-white/10 bg-white/[0.02]">
                    <summary className="cursor-pointer px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200">
                      Advanced JSON
                    </summary>
                    <div className="px-3 pb-3 space-y-2">
                      <div>
                        <label className="block text-xs text-zinc-500 mb-1">Extra config JSON</label>
                        <textarea
                          value={connectConfig}
                          onChange={(e) => setConnectConfig(e.target.value)}
                          placeholder='{"region": "us"}'
                          rows={2}
                          className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs font-mono placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none transition-colors resize-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-zinc-500 mb-1">Extra secrets JSON</label>
                        <textarea
                          value={connectSecrets}
                          onChange={(e) => setConnectSecrets(e.target.value)}
                          placeholder='{"secondary_token": "sk-..."}'
                          rows={2}
                          className={`w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs font-mono placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none transition-colors resize-none ${
                            !showSecrets && connectSecrets ? "blur-sm hover:blur-none" : ""
                          }`}
                        />
                      </div>
                    </div>
                  </details>
                )}
                <button
                  onClick={handleConnect}
                  disabled={connecting}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm hover:bg-white/10 transition-all disabled:opacity-50"
                >
                  {connecting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                  Save Connection
                </button>
              </div>
            </div>
          )}

          {tools.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Tools</h3>
              <div className="space-y-2">
                {tools.map((tool, i) => {
                  const toolSlug = (tool.slug as string) || `tool-${i}`;
                  const riskColors: Record<string, string> = {
                    read: "text-emerald-400",
                    write: "text-amber-400",
                    destructive: "text-red-400",
                    privileged: "text-red-400",
                  };
                  return (
                    <div
                      key={toolSlug}
                      className="p-3 rounded-xl border border-white/5 bg-white/[0.02]"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-white">{tool.name as string}</span>
                        <span className={`text-[10px] ${riskColors[(tool.riskLevel as string) || "read"] || "text-zinc-400"}`}>
                          {(tool.riskLevel as string) || "read"}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-500">{tool.description as string}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {detailTab === "telemetry" && (
        <ExtensionTelemetry extensionId={extension.id} />
      )}
    </div>
  );
}

function CreateRunnerForm({ agentId, onCreated, onCancel }: {
  agentId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim()) { setError("Name is required"); return; }
    if (!endpoint.trim()) { setError("Endpoint URL is required"); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/extensions/runners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          name: name.trim(),
          endpoint: endpoint.trim(),
          authToken: authToken.trim() || undefined,
          status: "pending",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create runner");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create runner");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 mb-2">
        <button onClick={onCancel} className="text-zinc-500 hover:text-white transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold text-white">Register Runner</h2>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">Runner Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="production-east"
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">HTTPS Endpoint</label>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://runner.acme.internal:8443"
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">Auth Token (encrypted)</label>
          <input
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder="Optional bearer token"
            type="password"
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none transition-colors"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black text-sm font-semibold shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 transition-all disabled:opacity-50"
        >
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Server className="w-4 h-4" />}
          Register Runner
        </button>
        <button onClick={onCancel} className="px-4 py-2.5 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-all">
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function IntegrationsPanel({
  isOpen,
  onClose,
  agentId,
}: {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
}) {
  const [viewState, setViewState] = useState<ViewState>({ view: "list" });
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [runners, setRunners] = useState<Runner[]>([]);
  const [loading, setLoading] = useState(false);
  const backdropPointerDownRef = useRef(false);

  const loadExtensions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/extensions");
      const data = await res.json();
      if (res.ok) setExtensions(data.extensions || []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  const loadRunners = useCallback(async () => {
    try {
      const res = await fetch("/api/extensions/runners");
      const data = await res.json();
      if (res.ok) setRunners(data.runners || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadExtensions();
      loadRunners();
    }
  }, [isOpen, loadExtensions, loadRunners]);

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        onPointerDown={(e) => {
          backdropPointerDownRef.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          const startedOnBackdrop = backdropPointerDownRef.current;
          backdropPointerDownRef.current = false;
          if (startedOnBackdrop && e.target === e.currentTarget) onClose();
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.2 }}
          className="w-full max-w-2xl bg-zinc-900 border border-white/10 rounded-2xl max-h-[85vh] flex flex-col overflow-hidden"
          onPointerDown={() => {
            backdropPointerDownRef.current = false;
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                <Plug className="w-4 h-4 text-cyan-400" />
              </div>
              <div>
                <h1 className="text-base font-semibold text-white">Integrations</h1>
                <p className="text-xs text-zinc-500">Manage enterprise extension packs</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {viewState.view === "list" && (
                <>
                  <button
                    onClick={() => setViewState({ view: "runners" })}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-white hover:bg-white/5 transition-all"
                  >
                    <Server className="w-3.5 h-3.5" />
                    Runners
                    {runners.filter(r => r.status === "online").length > 0 && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    )}
                  </button>
                  <button
                    onClick={() => setViewState({ view: "create" })}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/20 transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    New
                  </button>
                </>
              )}
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {viewState.view === "list" && (
              extensions.length === 0 ? (
                <EmptyState
                  onAction={() => setViewState({ view: "create" })}
                  actionLabel="Create Integration"
                  title="No integrations yet"
                  description="Create your first enterprise integration to give Groovy new capabilities."
                />
              ) : (
                <div className="space-y-2">
                  {extensions.map((ext) => (
                    <button
                      key={ext.id}
                      onClick={() => setViewState({ view: "detail", extension: ext })}
                      className="w-full p-4 rounded-xl border border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04] transition-all text-left group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center shrink-0">
                          <Package className="w-4 h-4 text-cyan-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-white truncate">{ext.name}</span>
                            <StatusBadge status={ext.status} />
                            {ext.installation && <StatusBadge status={(ext.installation as Record<string, unknown>).install_status as string || "installed"} />}
                          </div>
                          <p className="text-xs text-zinc-500 truncate">{ext.description || ext.slug}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <RuntimeIcon target={ext.runtime_target_default} />
                          <ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )
            )}

            {viewState.view === "create" && (
              <CreateExtensionForm
                agentId={agentId}
                onCreated={() => { loadExtensions(); setViewState({ view: "list" }); }}
                onCancel={() => setViewState({ view: "list" })}
              />
            )}

            {viewState.view === "detail" && (
              <ExtensionDetail
                extension={viewState.extension}
                onBack={() => { loadExtensions(); setViewState({ view: "list" }); }}
                onRefresh={() => {
                  loadExtensions().then(() => {
                    const updated = extensions.find(e => e.id === viewState.extension.id);
                    if (updated) setViewState({ view: "detail", extension: updated });
                  });
                }}
              />
            )}

            {viewState.view === "runners" && (
              <div className="space-y-4">
                <div className="flex items-center gap-3 mb-2">
                  <button onClick={() => setViewState({ view: "list" })} className="text-zinc-500 hover:text-white transition-colors">
                    <ArrowLeft className="w-5 h-5" />
                  </button>
                  <h2 className="text-lg font-semibold text-white flex-1">Runners</h2>
                  <button
                    onClick={() => setViewState({ view: "create-runner" })}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/20 transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Register
                  </button>
                </div>

                {runners.length === 0 ? (
                  <EmptyState
                    onAction={() => setViewState({ view: "create-runner" })}
                    actionLabel="Register Runner"
                    title="No runners registered"
                    description="Register a customer runner for CLI/on-prem integrations."
                  />
                ) : (
                  <div className="space-y-2">
                    {runners.map((runner) => (
                      <div key={runner.id} className="p-4 rounded-xl border border-white/10 bg-white/[0.02]">
                        <div className="flex items-center gap-3">
                          <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${
                            runner.status === "online"
                              ? "bg-emerald-500/10 border-emerald-500/20"
                              : "bg-white/5 border-white/10"
                          }`}>
                            <Server className={`w-4 h-4 ${runner.status === "online" ? "text-emerald-400" : "text-zinc-400"}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-white">{runner.name}</span>
                              <StatusBadge status={runner.status} />
                            </div>
                            <p className="text-xs text-zinc-500 truncate">
                              {runner.endpoint || runner.transport}
                              {runner.last_seen_at && (
                                <> · Last seen {new Date(runner.last_seen_at).toLocaleString()}</>
                              )}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {viewState.view === "create-runner" && (
              <CreateRunnerForm
                agentId={agentId}
                onCreated={() => { loadRunners(); setViewState({ view: "runners" }); }}
                onCancel={() => setViewState({ view: "runners" })}
              />
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
