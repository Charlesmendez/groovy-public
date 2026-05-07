"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCw, Upload } from "lucide-react";
import type { AdminArtifact, ArtifactChannel, ArtifactKind } from "./types";
import { formatDate, splitCsv } from "./adminUtils";

const channels: ArtifactChannel[] = ["stable", "beta", "dev", "enterprise"];

export function ArtifactsAdminPanel() {
  const [downloads, setDownloads] = useState<AdminArtifact[]>([]);
  const [sourceSnapshots, setSourceSnapshots] = useState<AdminArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    kind: "download" as ArtifactKind,
    version: "",
    channel: "stable" as ArtifactChannel,
    platform: "macos",
    fileUrl: "",
    archiveUrl: "",
    storageBucket: "",
    storagePath: "",
    checksum: "",
    releaseNotesUrl: "",
    gitRef: "",
    publicMirrorAfter: "",
    licenseTypeAllowed: "personal, enterprise, enterprise_reseller",
    isActive: true,
  });

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/downloads", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to load artifacts");
      setDownloads(Array.isArray(json.downloads) ? json.downloads : []);
      setSourceSnapshots(Array.isArray(json.sourceSnapshots) ? json.sourceSnapshots : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load artifacts");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  const updateForm = (patch: Partial<typeof form>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const createArtifact = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/downloads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: form.kind,
          version: form.version,
          channel: form.channel,
          platform: form.platform,
          fileUrl: form.fileUrl || undefined,
          archiveUrl: form.archiveUrl || undefined,
          storageBucket: form.storageBucket || undefined,
          storagePath: form.storagePath || undefined,
          checksum: form.checksum || undefined,
          releaseNotesUrl: form.releaseNotesUrl || undefined,
          gitRef: form.gitRef || undefined,
          publicMirrorAfter: form.publicMirrorAfter || undefined,
          licenseTypeAllowed: splitCsv(form.licenseTypeAllowed),
          isActive: form.isActive,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to create artifact");
      updateForm({ version: "", fileUrl: "", archiveUrl: "", storagePath: "", checksum: "", gitRef: "" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create artifact");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Create download or source snapshot</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Add portal-visible installers and source archives. Use Supabase storage references or
              short-lived/signed URLs from your artifact pipeline.
            </p>
          </div>
          <Upload className="h-5 w-5 text-cyan-300" />
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <Select label="Kind" value={form.kind} onChange={(value) => updateForm({ kind: value as ArtifactKind })} options={["download", "source_snapshot"]} />
          <Field label="Version" value={form.version} onChange={(value) => updateForm({ version: value })} />
          <Select label="Channel" value={form.channel} onChange={(value) => updateForm({ channel: value as ArtifactChannel })} options={channels} />
          {form.kind === "download" ? (
            <>
              <Field label="Platform" value={form.platform} onChange={(value) => updateForm({ platform: value })} />
              <Field label="File URL" value={form.fileUrl} onChange={(value) => updateForm({ fileUrl: value })} />
            </>
          ) : (
            <>
              <Field label="Archive URL" value={form.archiveUrl} onChange={(value) => updateForm({ archiveUrl: value })} />
              <Field label="Git ref" value={form.gitRef} onChange={(value) => updateForm({ gitRef: value })} />
              <Field label="Public mirror after" type="date" value={form.publicMirrorAfter} onChange={(value) => updateForm({ publicMirrorAfter: value })} />
            </>
          )}
          <Field label="Storage bucket" value={form.storageBucket} onChange={(value) => updateForm({ storageBucket: value })} />
          <Field label="Storage path" value={form.storagePath} onChange={(value) => updateForm({ storagePath: value })} />
          <Field label="Checksum" value={form.checksum} onChange={(value) => updateForm({ checksum: value })} />
          <Field label="Release notes URL" value={form.releaseNotesUrl} onChange={(value) => updateForm({ releaseNotesUrl: value })} />
          <Field label="Allowed license types" value={form.licenseTypeAllowed} onChange={(value) => updateForm({ licenseTypeAllowed: value })} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-4">
          <label className="inline-flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => updateForm({ isActive: e.target.checked })}
              className="h-4 w-4 rounded border-white/20 bg-black accent-cyan-400"
            />
            Active
          </label>
          <button
            type="button"
            onClick={createArtifact}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-cyan-300 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create artifact
          </button>
          {error ? <p className="text-sm text-red-300">{error}</p> : null}
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Portal artifacts</h2>
            <p className="mt-1 text-sm text-zinc-500">Latest downloads and source snapshots visible to licensed users.</p>
          </div>
          <button type="button" onClick={refresh} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>

        {loading ? <p className="mt-5 text-sm text-zinc-500">Loading artifacts...</p> : null}
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <ArtifactList title="Downloads" items={downloads} urlKey="file_url" />
          <ArtifactList title="Source snapshots" items={sourceSnapshots} urlKey="archive_url" />
        </div>
      </div>
    </section>
  );
}

function ArtifactList({ title, items, urlKey }: { title: string; items: AdminArtifact[]; urlKey: "file_url" | "archive_url" }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-white">
        <Download className="h-4 w-4 text-cyan-300" />
        {title}
      </div>
      <div className="mt-4 space-y-3">
        {items.map((item) => (
          <div key={item.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-white">{item.version}</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {item.channel || "stable"} {item.platform ? `· ${item.platform}` : ""} · {formatDate(item.created_at)}
                </div>
              </div>
              <span className={`rounded-full px-2 py-1 text-[10px] ${item.is_active === false ? "bg-zinc-700 text-zinc-300" : "bg-emerald-500/10 text-emerald-200"}`}>
                {item.is_active === false ? "inactive" : "active"}
              </span>
            </div>
            <div className="mt-2 break-all text-xs text-zinc-600">{item[urlKey] || "No URL"}</div>
            {item.checksum ? <div className="mt-2 break-all font-mono text-[11px] text-zinc-500">{item.checksum}</div> : null}
          </div>
        ))}
        {items.length === 0 ? <p className="text-sm text-zinc-500">No records yet.</p> : null}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="block">
      <span className="text-xs text-zinc-500">{label}</span>
      <input value={value} type={type} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/50" />
    </label>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return (
    <label className="block">
      <span className="text-xs text-zinc-500">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/50">
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}
