"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { HARNESS_PROFILE_TEMPLATES } from "@/lib/orchestrator/profileTemplates";

type EndpointProfile = {
  id: string;
  name: string;
  slug: string;
  surface: "internal" | "external";
};

type EndpointKey = {
  id: string;
  kind: "secret" | "publishable";
  request_count: number;
  revoked_at: string | null;
};

type EndpointSummary = EndpointProfile & {
  keys: EndpointKey[];
};

export function ApiEndpointSettings() {
  const [endpoints, setEndpoints] = useState<EndpointSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceRole, setWorkspaceRole] = useState<
    "admin" | "member" | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [profilesRes, workspaceRes] = await Promise.all([
        fetch("/api/harness/profiles", { cache: "no-store" }),
        fetch("/api/workspaces/current", { cache: "no-store" }),
      ]);
      const profilesPayload = await profilesRes.json().catch(() => ({}));
      const workspacePayload = await workspaceRes.json().catch(() => ({}));
      if (!profilesRes.ok) {
        throw new Error(profilesPayload.error || "Could not load Minds");
      }
      if (workspaceRes.ok && typeof workspacePayload?.workspace?.id === "string") {
        setWorkspaceId(workspacePayload.workspace.id);
        setWorkspaceRole(
          workspacePayload.workspace.role === "admin" ? "admin" : "member",
        );
      }
      const externalProfiles = (
        Array.isArray(profilesPayload.profiles)
          ? profilesPayload.profiles
          : []
      ).filter(
        (profile: EndpointProfile) => profile.surface === "external",
      ) as EndpointProfile[];
      const summaries = await Promise.all(
        externalProfiles.map(async (profile) => {
          const keysRes = await fetch(
            `/api/harness/profiles/${profile.id}/keys`,
            { cache: "no-store" },
          );
          const keysPayload = await keysRes.json().catch(() => ({}));
          return {
            ...profile,
            keys: keysRes.ok && Array.isArray(keysPayload.keys)
              ? keysPayload.keys
              : [],
          };
        }),
      );
      setEndpoints(summaries);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load endpoints");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createEndpoint = async () => {
    if (!workspaceId || workspaceRole !== "admin") {
      setError("Workspace administrator access is required");
      return;
    }
    const name = window.prompt("Name this orchestrator endpoint:", "Customer Support");
    if (!name?.trim()) return;
    const template = HARNESS_PROFILE_TEMPLATES.find(
      (candidate) => candidate.key === "support",
    );
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/harness/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(template?.body || {}),
          name: name.trim(),
          workspace_id: workspaceId,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.profile?.id) {
        throw new Error(payload.error || "Could not create endpoint Mind");
      }
      window.location.href = `/settings/minds?profile=${encodeURIComponent(
        payload.profile.id,
      )}`;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create endpoint Mind",
      );
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="text-xl font-semibold">API &amp; Widget</h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            Publish a restricted external Mind. Its endpoint, keys, origin
            allowlist, rate limit, widget snippet, and runnable examples all live
            together.
          </p>
        </div>
        <button
          type="button"
          disabled={busy || workspaceRole !== "admin"}
          onClick={() => void createEndpoint()}
          className="rounded-xl border border-amber-300/30 bg-amber-300/10 px-4 py-2 text-sm text-amber-200 disabled:opacity-50"
          title={
            workspaceRole === "admin"
              ? "Create an external Mind"
              : "Only workspace administrators can publish endpoints"
          }
        >
          {busy ? "Creating…" : "+ Create orchestrator endpoint"}
        </button>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        {[
          ["1", "Create or select an external Mind"],
          ["2", "Grant safe skills, origins, and a rate limit"],
          ["3", "Create a key and copy the example"],
        ].map(([number, label]) => (
          <div
            key={number}
            className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
          >
            <span className="text-xs text-amber-300">{number}</span>
            <p className="mt-1 text-sm text-zinc-300">{label}</p>
          </div>
        ))}
      </div>

      {error ? (
        <div className="mt-5 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <section className="mt-7">
        <h3 className="text-xs font-medium uppercase tracking-widest text-zinc-500">
          Published Minds
        </h3>
        {loading ? (
          <p className="mt-3 text-sm text-zinc-500">Loading endpoints…</p>
        ) : endpoints.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-dashed border-white/10 p-8 text-center">
            <p className="text-sm text-zinc-400">No external endpoints yet.</p>
            <p className="mt-1 text-xs text-zinc-600">
              Create one here, or change any Mind&apos;s surface to External.
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {endpoints.map((endpoint) => {
              const activeKeys = endpoint.keys.filter((key) => !key.revoked_at);
              const requests = endpoint.keys.reduce(
                (sum, key) => sum + Number(key.request_count || 0),
                0,
              );
              const origin =
                typeof window !== "undefined"
                  ? window.location.origin
                  : "https://your-groovy-host.example";
              const url = `${origin}/api/v1/harnesses/${endpoint.slug}/threads`;
              return (
                <div
                  key={endpoint.id}
                  className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h4 className="text-sm font-medium">{endpoint.name}</h4>
                      <code className="mt-2 block truncate text-[11px] text-zinc-500">
                        POST {url}
                      </code>
                    </div>
                    <Link
                      href={`/settings/minds?profile=${encodeURIComponent(
                        endpoint.id,
                      )}`}
                      className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:text-white"
                    >
                      Manage &amp; view examples
                    </Link>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-4 text-[11px] text-zinc-500">
                    <span>{activeKeys.length} active keys</span>
                    <span>{requests} total requests</span>
                    <span>
                      {activeKeys.filter((key) => key.kind === "publishable").length}{" "}
                      widget keys
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
