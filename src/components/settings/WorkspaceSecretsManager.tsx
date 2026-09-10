"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, Laptop, Loader2, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useConnectorDevice } from "@/hooks/useConnectorDevice";
import { useConnectorExecute } from "@/hooks/useConnectorExecute";

type Secret = { id: string; name: string; key: string; description: string };
type Target = { id: string; name: string };
type Payload = {
  workspaceId: string;
  secrets: Secret[];
  profiles: Array<Target & { surface?: string }>;
  agents: Target[];
  artifacts: Array<Target & { relative_path?: string; metadata?: Record<string, unknown> }>;
  devices: Array<Target & { last_seen?: string | null }>;
  grants: { profiles: Record<string, string[]>; agents: Record<string, string[]>; artifacts: Record<string, string[]> };
  readiness: Array<{ secret_id: string; device_id: string; configured: boolean }>;
};

function Checks({ title, items, selected, onChange }: { title: string; items: Target[]; selected: string[]; onChange(ids: string[]): void }) {
  return <fieldset className="rounded-xl border border-white/10 p-3"><legend className="px-1 text-xs font-medium text-zinc-300">{title}</legend><div className="mt-1 max-h-40 space-y-1 overflow-y-auto">{items.length ? items.map((item) => <label key={item.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-400 hover:bg-white/[0.04]"><input type="checkbox" className="accent-cyan-400" checked={selected.includes(item.id)} onChange={(event) => onChange(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}/><span className="truncate">{item.name}</span></label>) : <p className="px-2 py-2 text-xs text-zinc-600">None available</p>}</div></fieldset>;
}

function suggestedSecretKey(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9]/, "_$&");
}

export function WorkspaceSecretsManager() {
  const device = useConnectorDevice();
  const { connectorExecute } = useConnectorExecute({ relay: device.relay, activeDeviceId: device.activeDeviceId });
  const [data, setData] = useState<Payload | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState(""), [key, setKey] = useState(""), [description, setDescription] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const keyIsValid = /^[A-Z][A-Z0-9_]{1,127}$/.test(key);
  const load = useCallback(async () => { const response = await fetch("/api/workspace-secrets", { cache: "no-store" }); const json = await response.json().catch(() => ({})); if (!response.ok) throw new Error(json.error || "Failed to load secrets"); setData(json); }, []);
  useEffect(() => { load().catch((e) => setError(e instanceof Error ? e.message : String(e))); }, [load]);
  const online = useMemo(
    () => new Set(device.onlineDevices.map((item) => item.deviceId)),
    [device.onlineDevices]
  );
  const readiness = useMemo(() => new Map((data?.readiness || []).map((row) => [`${row.secret_id}:${row.device_id}`, row.configured])), [data]);
  const visibleDevices = useCallback((secretId: string) => {
    if (!data) return [];
    const targets = new Map(data.devices.map((target) => [target.id, target]));
    for (const { deviceId } of device.onlineDevices) {
      if (!targets.has(deviceId)) {
        targets.set(deviceId, { id: deviceId, name: "Current Connector" });
      }
    }
    return Array.from(targets.values())
      .filter((target) => online.has(target.id) || readiness.get(`${secretId}:${target.id}`) === true)
      .sort((left, right) => {
        if (left.id === device.activeDeviceId) return -1;
        if (right.id === device.activeDeviceId) return 1;
        if (online.has(left.id) !== online.has(right.id)) return online.has(left.id) ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }, [data, device.activeDeviceId, device.onlineDevices, online, readiness]);
  const visibleDevicesBySecret = useMemo(
    () => new Map((data?.secrets || []).map((secret) => [secret.id, visibleDevices(secret.id)])),
    [data?.secrets, visibleDevices]
  );
  const updateAssignments = (secretId: string, kind: keyof Payload["grants"], ids: string[]) => setData((prev) => prev ? { ...prev, grants: { ...prev.grants, [kind]: { ...prev.grants[kind], [secretId]: ids } } } : prev);
  async function createSecret() { setBusy("create"); setError(null); try { const response = await fetch("/api/workspace-secrets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, key, description }) }); const json = await response.json().catch(() => ({})); if (!response.ok) throw new Error(json.error || "Failed to create secret"); setData(json); setName(""); setKey(""); setKeyEdited(false); setDescription(""); setNotice("Secret declared. Click Configure to enter its value in the Connector's secure dialog."); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } }
  async function save(secret: Secret) { if (!data) return; setBusy(secret.id); setError(null); try { const response = await fetch(`/api/workspace-secrets/${secret.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileIds: data.grants.profiles[secret.id] || [], agentIds: data.grants.agents[secret.id] || [], artifactIds: data.grants.artifacts[secret.id] || [] }) }); const json = await response.json().catch(() => ({})); if (!response.ok) throw new Error(json.error || "Failed to save assignments"); setNotice(`${secret.name} assignments saved.`); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } }
  async function configure(secret: Secret, targetDeviceId: string) { if (!data) return; setBusy(`${secret.id}:${targetDeviceId}`); setError(null); try { const result = await connectorExecute({ type: "workspace_secret_request", params: { workspace_id: data.workspaceId, secret_id: secret.id, key: secret.key, name: secret.name, reason: secret.description || `Used only by assigned Minds and skills that require ${secret.key}.` }, toolCallId: `secret-${secret.id}-${Date.now()}`, toolName: "workspace_secret_request", agent: "chat" }); if (!result.ok) throw new Error(result.error || "Secret was not configured"); const response = await fetch(`/api/workspace-secrets/${secret.id}/readiness`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: targetDeviceId, configured: true }) }); if (!response.ok) throw new Error("Secret was stored locally, but readiness could not be recorded"); setData((current) => current ? { ...current, readiness: [...current.readiness.filter((row) => row.secret_id !== secret.id || row.device_id !== targetDeviceId), { secret_id: secret.id, device_id: targetDeviceId, configured: true }] } : current); setNotice(`${secret.name} is ready on this Connector.`); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } }
  async function remove(secret: Secret) { if (!confirm(`Delete ${secret.name}? This removes its assignments and the value on the active Connector.`)) return; setBusy(secret.id); try { if (data && device.activeDeviceId) { const result = await connectorExecute({ type: "workspace_secret_delete", params: { workspace_id: data.workspaceId, secret_id: secret.id, key: secret.key }, toolCallId: `secret-delete-${secret.id}-${Date.now()}`, toolName: "workspace_secret_delete", agent: "chat" }); if (!result.ok) throw new Error(result.error || "Could not remove the local secret"); const readinessResponse = await fetch(`/api/workspace-secrets/${secret.id}/readiness`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: device.activeDeviceId, configured: false }) }); if (!readinessResponse.ok) throw new Error("Local value was removed, but readiness could not be updated"); } const response = await fetch(`/api/workspace-secrets/${secret.id}`, { method: "DELETE" }); const json = await response.json().catch(() => ({})); if (!response.ok) throw new Error(json.error || "Failed to delete secret"); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } }
  return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6"><div className="max-w-3xl"><h2 className="text-2xl font-semibold">Workspace secrets</h2><p className="mt-2 text-sm leading-relaxed text-zinc-400">Declare names here, then enter each value in the Connector&apos;s native secure dialog. Values stay encrypted on that device and are never sent through Groovy.</p></div>
    {error && <div className="mt-5 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}{notice && <div className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">{notice}</div>}
    <section className="mt-7 rounded-2xl border border-white/10 bg-white/[0.025] p-5">
      <div className="flex items-center gap-2 text-sm font-medium"><Plus className="h-4 w-4 text-cyan-300"/>Declare a secret</div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">
        Declare its name and variable key here. Do not paste the secret value or URL into these fields; after creation, click <span className="text-zinc-300">Configure</span> to enter the value securely on the Connector.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <label className="min-w-0 text-xs text-zinc-400">
          Display name
          <input
            className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/50"
            placeholder="Hibe API URL"
            value={name}
            onChange={(event) => {
              const nextName = event.target.value;
              setName(nextName);
              if (!keyEdited) setKey(suggestedSecretKey(nextName));
            }}
          />
        </label>
        <label className="min-w-0 text-xs text-zinc-400">
          Variable key <span className="text-zinc-600">(not the value)</span>
          <input
            className={`mt-1.5 w-full rounded-xl border bg-black/20 px-3 py-2 font-mono text-sm text-white outline-none focus:border-cyan-400/50 ${key && !keyIsValid ? "border-amber-400/50" : "border-white/10"}`}
            placeholder="HIBE_API_URL"
            value={key}
            aria-invalid={Boolean(key && !keyIsValid)}
            onChange={(event) => {
              setKeyEdited(true);
              setKey(event.target.value);
            }}
          />
          {key && !keyIsValid ? <span className="mt-1 block text-[11px] leading-relaxed text-amber-300">Use only uppercase letters, numbers, and underscores. Secret values such as URLs are entered after creation.</span> : null}
        </label>
        <label className="min-w-0 text-xs text-zinc-400">
          Description <span className="text-zinc-600">(optional)</span>
          <input className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/50" placeholder="What it enables" value={description} onChange={(e) => setDescription(e.target.value)}/>
        </label>
      </div>
      <button disabled={!name.trim() || !keyIsValid || busy === "create"} onClick={() => void createSecret()} className="mt-3 rounded-xl bg-cyan-400 px-4 py-2 text-xs font-medium text-black disabled:opacity-40">Create secret</button>
    </section>
    <div className="mt-5 space-y-4">{data?.secrets.map((secret) => <section key={secret.id} className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div className="flex gap-3"><div className="rounded-xl bg-cyan-400/10 p-2 text-cyan-300"><KeyRound className="h-5 w-5"/></div><div><h3 className="text-sm font-medium">{secret.name}</h3><code className="mt-1 block text-xs text-zinc-500">{secret.key}</code><p className="mt-1 text-xs text-zinc-500">{secret.description || "No description"}</p></div></div><div className="flex gap-2"><button onClick={() => void save(secret)} disabled={busy === secret.id} aria-busy={busy === secret.id} className="flex min-w-36 items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs hover:bg-white/[0.05] disabled:cursor-wait disabled:opacity-60">{busy === secret.id ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"/> : <Save className="h-3.5 w-3.5"/>}{busy === secret.id ? "Saving…" : "Save assignments"}</button><button onClick={() => void remove(secret)} className="rounded-lg border border-red-500/20 p-2 text-red-300 hover:bg-red-500/10" aria-label={`Delete ${secret.name}`}><Trash2 className="h-4 w-4"/></button></div></div>
      <div className="mt-4 grid gap-3 lg:grid-cols-3"><Checks title="Minds" items={data.profiles} selected={data.grants.profiles[secret.id] || []} onChange={(ids) => updateAssignments(secret.id, "profiles", ids)}/><Checks title="Workers" items={data.agents} selected={data.grants.agents[secret.id] || []} onChange={(ids) => updateAssignments(secret.id, "agents", ids)}/><Checks title="Skills" items={data.artifacts} selected={data.grants.artifacts[secret.id] || []} onChange={(ids) => updateAssignments(secret.id, "artifacts", ids)}/></div>
      <div className="mt-4 rounded-xl border border-white/[0.08] p-3"><div className="flex items-center gap-2 text-xs font-medium text-zinc-300"><Laptop className="h-4 w-4"/>Device readiness</div><div className="mt-2 space-y-2">{(visibleDevicesBySecret.get(secret.id) || []).length ? (visibleDevicesBySecret.get(secret.id) || []).map((target) => { const ready = readiness.get(`${secret.id}:${target.id}`) === true; const isOnline = online.has(target.id); const isActive = device.activeDeviceId === target.id; return <div key={target.id} className="flex items-center justify-between gap-3 rounded-lg bg-black/20 px-3 py-2"><div className="min-w-0"><div className="truncate text-xs text-zinc-300">{target.name}{isActive ? <span className="ml-2 text-[10px] text-cyan-300">Current</span> : null}</div><div className={`text-[10px] ${ready ? "text-emerald-300" : "text-zinc-600"}`}>{ready ? "Configured locally" : "Not configured"} · {isOnline ? "Online" : "Offline"}</div></div><button disabled={!isOnline || !isActive || busy === `${secret.id}:${target.id}`} onClick={() => void configure(secret, target.id)} className="flex shrink-0 items-center gap-1 rounded-lg border border-cyan-400/20 px-3 py-1.5 text-xs text-cyan-200 disabled:opacity-35"><ShieldCheck className="h-3.5 w-3.5"/>{ready ? "Replace" : "Configure"}</button></div>; }) : <div className="rounded-lg bg-black/20 px-3 py-3 text-xs leading-relaxed text-zinc-500">No Connector is online. Open Groovy Desktop to configure this secret. Historical devices that never stored this secret are hidden.</div>}</div></div></section>)}{data && !data.secrets.length && <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-zinc-500">No workspace secrets declared yet.</div>}</div>
  </main>;
}
