"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { FileText, Loader2, Play, ShieldCheck, Square, Trash2, X } from "lucide-react";

type ManagedDomain = {
  id?: string;
  domain?: string;
  verified?: boolean;
};

type ManagedSite = {
  id: string;
  slug: string;
  name?: string;
  status?: string;
  latest_deployment_url?: string | null;
  generated_site_domains?: ManagedDomain[];
};

type SiteSelection = {
  slug?: string | null;
  status?: string | null;
  productionUrl?: string | null;
};

type PagesManagerModalProps = {
  isOpen: boolean;
  onClose: () => void;
  activeSlug?: string | null;
  onUseInPanel?: (selection: SiteSelection) => void;
  onStartPreview?: (slug?: string) => void;
  onStopPreview?: (slug?: string) => void;
};

export default function PagesManagerModal({
  isOpen,
  onClose,
  activeSlug,
  onUseInPanel,
  onStartPreview,
  onStopPreview,
}: PagesManagerModalProps) {
  const [sites, setSites] = useState<ManagedSite[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [sitesError, setSitesError] = useState<string | null>(null);
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [domainDraftBySiteId, setDomainDraftBySiteId] = useState<Record<string, string>>({});

  const loadSites = useCallback(async () => {
    setSitesLoading(true);
    setSitesError(null);
    try {
      const res = await fetch(`/api/sites/list?ts=${Date.now()}`, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; sites?: unknown[]; error?: string }
        | null;
      if (!res.ok || !json?.ok) {
        const msg =
          typeof json?.error === "string" && json.error.trim()
            ? json.error.trim()
            : "Failed to load sites";
        setSitesError(msg);
        setSites([]);
        return;
      }
      const parsed = (Array.isArray(json.sites) ? json.sites : [])
        .map((row) => {
          if (!row || typeof row !== "object") return null;
          const r = row as Record<string, unknown>;
          const id = typeof r.id === "string" ? r.id : "";
          const siteSlug = typeof r.slug === "string" ? r.slug : "";
          if (!id || !siteSlug) return null;
          return {
            id,
            slug: siteSlug,
            name: typeof r.name === "string" ? r.name : undefined,
            status: typeof r.status === "string" ? r.status : undefined,
            latest_deployment_url:
              typeof r.latest_deployment_url === "string" ? r.latest_deployment_url : null,
            generated_site_domains: Array.isArray(r.generated_site_domains)
              ? (r.generated_site_domains as ManagedDomain[])
              : [],
          } as ManagedSite;
        })
        .filter((v): v is ManagedSite => Boolean(v));
      setSites(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load sites";
      setSitesError(msg);
      setSites([]);
    } finally {
      setSitesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void loadSites();
  }, [isOpen, loadSites]);

  const handleAttachDomain = useCallback(
    async (site: ManagedSite) => {
      const raw = (domainDraftBySiteId[site.id] || "").trim().toLowerCase();
      if (!raw) {
        setActionMessage("Enter a domain first.");
        return;
      }
      const busyKey = `attach:${site.id}`;
      setActionBusyKey(busyKey);
      setActionMessage(null);
      try {
        const res = await fetch("/api/sites/attach-domain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            siteId: site.id,
            slug: site.slug,
            domain: raw,
          }),
        });
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; error?: string; instructions?: string[]; domain?: string }
          | null;
        if (!res.ok || !json?.ok) {
          const msg =
            typeof json?.error === "string" && json.error.trim()
              ? json.error.trim()
              : `Failed to attach ${raw}`;
          setActionMessage(msg);
          return;
        }
        const instructions = Array.isArray(json.instructions) ? json.instructions : [];
        setActionMessage(
          instructions.length > 0
            ? `Domain attached: ${json.domain || raw}. Add DNS records and verify.`
            : `Domain attached: ${json.domain || raw}.`
        );
        setDomainDraftBySiteId((prev) => ({ ...prev, [site.id]: "" }));
        await loadSites();
      } catch (err) {
        const msg = err instanceof Error ? err.message : `Failed to attach ${raw}`;
        setActionMessage(msg);
      } finally {
        setActionBusyKey((prev) => (prev === busyKey ? null : prev));
      }
    },
    [domainDraftBySiteId, loadSites]
  );

  const handleVerifyDomain = useCallback(
    async (site: ManagedSite, domainOverride?: string) => {
      const typed = (domainDraftBySiteId[site.id] || "").trim().toLowerCase();
      const firstKnownDomain =
        domainOverride ||
        (Array.isArray(site.generated_site_domains)
          ? site.generated_site_domains.find((d) => typeof d.domain === "string" && d.domain)?.domain
          : undefined);
      const targetDomain = typed || firstKnownDomain || "";
      if (!targetDomain) {
        setActionMessage("No domain to verify for this site.");
        return;
      }
      const busyKey = `verify:${site.id}:${targetDomain}`;
      setActionBusyKey(busyKey);
      setActionMessage(null);
      try {
        const res = await fetch("/api/sites/verify-domain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            siteId: site.id,
            slug: site.slug,
            domain: targetDomain,
          }),
        });
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; error?: string; message?: string; verified?: boolean; domain?: string }
          | null;
        if (!res.ok) {
          const msg =
            typeof json?.error === "string" && json.error.trim()
              ? json.error.trim()
              : `Failed to verify ${targetDomain}`;
          setActionMessage(msg);
          return;
        }
        setActionMessage(
          typeof json?.message === "string" && json.message.trim()
            ? json.message.trim()
            : json?.verified
              ? `Domain verified: ${json?.domain || targetDomain}`
              : `Domain not verified yet: ${json?.domain || targetDomain}`
        );
        await loadSites();
      } catch (err) {
        const msg = err instanceof Error ? err.message : `Failed to verify ${targetDomain}`;
        setActionMessage(msg);
      } finally {
        setActionBusyKey((prev) => (prev === busyKey ? null : prev));
      }
    },
    [domainDraftBySiteId, loadSites]
  );

  const handleDeleteSite = useCallback(
    async (site: ManagedSite) => {
      if (!window.confirm(`Delete "${site.slug}" permanently? This cannot be undone.`)) return;
      const busyKey = `delete:${site.id}`;
      setActionBusyKey(busyKey);
      setActionMessage(null);
      try {
        const res = await fetch("/api/sites/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId: site.id }),
        });
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; error?: string; deleted?: string }
          | null;
        if (!res.ok || !json?.ok) {
          const msg =
            typeof json?.error === "string" && json.error.trim()
              ? json.error.trim()
              : `Failed to delete ${site.slug}`;
          setActionMessage(msg);
          return;
        }
        setActionMessage(`Deleted site: ${json.deleted || site.slug}`);
        if (activeSlug && activeSlug === site.slug) {
          onUseInPanel?.({ slug: null, status: "draft", productionUrl: null });
        }
        await loadSites();
      } catch (err) {
        const msg = err instanceof Error ? err.message : `Failed to delete ${site.slug}`;
        setActionMessage(msg);
      } finally {
        setActionBusyKey((prev) => (prev === busyKey ? null : prev));
      }
    },
    [activeSlug, loadSites, onUseInPanel]
  );

  const handleUnpublishSite = useCallback(
    async (site: ManagedSite) => {
      const busyKey = `unpublish:${site.id}`;
      setActionBusyKey(busyKey);
      setActionMessage(null);
      try {
        const res = await fetch("/api/sites/unpublish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId: site.id }),
        });
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; error?: string; message?: string }
          | null;
        if (!res.ok || !json?.ok) {
          const msg =
            typeof json?.error === "string" && json.error.trim()
              ? json.error.trim()
              : `Failed to unpublish ${site.slug}`;
          setActionMessage(msg);
          return;
        }
        setActionMessage(
          typeof json?.message === "string" && json.message.trim()
            ? json.message.trim()
            : `Site unpublished: ${site.slug}`
        );
        if (activeSlug && activeSlug === site.slug) {
          onUseInPanel?.({ slug: site.slug, status: "draft", productionUrl: null });
        }
        await loadSites();
      } catch (err) {
        const msg = err instanceof Error ? err.message : `Failed to unpublish ${site.slug}`;
        setActionMessage(msg);
      } finally {
        setActionBusyKey((prev) => (prev === busyKey ? null : prev));
      }
    },
    [activeSlug, loadSites, onUseInPanel]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-3xl h-[80vh] bg-zinc-900 border border-white/10 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
      >
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center">
              <FileText className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Pages Settings</h2>
              <p className="text-xs text-zinc-500">Manage all generated pages</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                void loadSites();
              }}
              disabled={sitesLoading}
              className="px-3 py-1.5 text-xs rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {sitesLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {sitesLoading ? "Refreshing..." : "Refresh"}
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {(sitesError || actionMessage) && (
          <div className="px-4 py-2 border-b border-white/10 text-xs">
            {sitesError ? (
              <span className="text-red-400">{sitesError}</span>
            ) : (
              <span className="text-zinc-300">{actionMessage}</span>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-zinc-900">
          {sitesLoading && sites.length === 0 ? (
            <div className="h-full min-h-[120px] flex items-center justify-center text-sm text-zinc-400">
              Loading sites...
            </div>
          ) : sites.length === 0 ? (
            <div className="h-full min-h-[120px] flex items-center justify-center text-sm text-zinc-500">
              No sites found yet.
            </div>
          ) : (
            sites.map((site) => {
              const domains = Array.isArray(site.generated_site_domains) ? site.generated_site_domains : [];
              const selected = Boolean(activeSlug && site.slug === activeSlug);
              const draftDomain = domainDraftBySiteId[site.id] || "";
              const anyBusy = Boolean(actionBusyKey);

              return (
                <div
                  key={site.id}
                  className={`rounded-lg border ${
                    selected ? "border-indigo-500/50" : "border-zinc-800"
                  } bg-zinc-950 p-3 space-y-3`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-zinc-100 truncate">{site.slug}</div>
                      <div className="text-xs text-zinc-400">
                        {site.status || "draft"}
                        {site.latest_deployment_url ? " · live URL available" : ""}
                      </div>
                    </div>
                    {site.latest_deployment_url && (
                      <a
                        href={site.latest_deployment_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-indigo-400 hover:text-indigo-300 shrink-0"
                      >
                        Open live
                      </a>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => {
                        onUseInPanel?.({
                          slug: site.slug,
                          status: site.status || "draft",
                          productionUrl: site.latest_deployment_url || null,
                        });
                        onClose();
                      }}
                      className="px-2 py-1 text-xs rounded-md bg-zinc-800 hover:bg-zinc-700"
                    >
                      Use in panel
                    </button>
                    <button
                      onClick={() => {
                        onUseInPanel?.({
                          slug: site.slug,
                          status: site.status || "draft",
                          productionUrl: site.latest_deployment_url || null,
                        });
                        onStartPreview?.(site.slug);
                        onClose();
                      }}
                      disabled={anyBusy}
                      className="px-2 py-1 text-xs rounded-md bg-emerald-700/30 text-emerald-300 hover:bg-emerald-700/40 disabled:opacity-60 inline-flex items-center gap-1"
                    >
                      <Play className="w-3 h-3" />
                      Start preview
                    </button>
                    <button
                      onClick={() => onStopPreview?.(site.slug)}
                      disabled={anyBusy}
                      className="px-2 py-1 text-xs rounded-md bg-amber-700/30 text-amber-300 hover:bg-amber-700/40 disabled:opacity-60 inline-flex items-center gap-1"
                    >
                      <Square className="w-3 h-3" />
                      Stop preview
                    </button>
                    <button
                      onClick={() => {
                        void handleUnpublishSite(site);
                      }}
                      disabled={anyBusy}
                      className="px-2 py-1 text-xs rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60"
                    >
                      Unpublish
                    </button>
                    <button
                      onClick={() => {
                        void handleDeleteSite(site);
                      }}
                      disabled={anyBusy}
                      className="px-2 py-1 text-xs rounded-md bg-red-900/30 text-red-300 hover:bg-red-900/40 disabled:opacity-60 inline-flex items-center gap-1"
                    >
                      <Trash2 className="w-3 h-3" />
                      Delete
                    </button>
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs text-zinc-400">Domains</div>
                    {domains.length === 0 ? (
                      <div className="text-xs text-zinc-500">No domains attached.</div>
                    ) : (
                      <div className="space-y-1">
                        {domains.map((d) => {
                          const domainName =
                            typeof d?.domain === "string" && d.domain.trim() ? d.domain.trim() : "";
                          if (!domainName) return null;
                          const verified = d?.verified === true;
                          return (
                            <div
                              key={`${site.id}:${domainName}`}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <div className="truncate text-zinc-300">
                                {domainName}
                                {verified ? (
                                  <span className="ml-2 text-emerald-400 inline-flex items-center gap-1">
                                    <ShieldCheck className="w-3 h-3" />
                                    verified
                                  </span>
                                ) : (
                                  <span className="ml-2 text-amber-400">pending</span>
                                )}
                              </div>
                              {!verified && (
                                <button
                                  onClick={() => {
                                    void handleVerifyDomain(site, domainName);
                                  }}
                                  disabled={anyBusy}
                                  className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60"
                                >
                                  Verify
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <input
                        value={draftDomain}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDomainDraftBySiteId((prev) => ({ ...prev, [site.id]: v }));
                        }}
                        placeholder="yourdomain.com"
                        className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500"
                      />
                      <button
                        onClick={() => {
                          void handleAttachDomain(site);
                        }}
                        disabled={anyBusy}
                        className="px-2 py-1.5 text-xs rounded-md bg-indigo-700/40 text-indigo-200 hover:bg-indigo-700/50 disabled:opacity-60"
                      >
                        Attach
                      </button>
                      <button
                        onClick={() => {
                          void handleVerifyDomain(site);
                        }}
                        disabled={anyBusy}
                        className="px-2 py-1.5 text-xs rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60"
                      >
                        Verify
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </motion.div>
    </div>
  );
}
