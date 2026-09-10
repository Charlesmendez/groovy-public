"use client";

import { useCallback, useEffect, useState } from "react";

type Binding = {
  id: string;
  tenant_id: string;
  project_id: string;
  harness_ref: string;
  status: "active" | "paused" | "revoked";
};
type Run = {
  id: string;
  decision_id: string;
  state: string;
  error_code: string | null;
  applied: boolean | null;
  created_at: string;
};
type ConnectionState = {
  bindings: Binding[];
  runs: Run[];
  readiness: { consumer_enabled: boolean; profile_issues: string[] };
};

export function HomeInboxConnection({ profileId }: { profileId: string }) {
  const [data, setData] = useState<ConnectionState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [tenantId, setTenantId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [harnessRef, setHarnessRef] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const base = `/api/harness/profiles/${encodeURIComponent(profileId)}/inbox-bindings`;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(base, { cache: "no-store", signal });
        const payload = await res.json();
        if (signal?.aborted) return;
        setForbidden(res.status === 403);
        if (!res.ok) {
          setData(null);
          throw new Error(
            payload.error?.message || "Could not load Home connection.",
          );
        }
        setData(payload);
        setError("");
      } catch (cause) {
        if (!signal?.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load Home connection.",
          );
      }
    },
    [base],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const mutate = async (
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, string>,
  ) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok)
        throw new Error(
          payload.error?.message || "Could not update connection.",
        );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update connection.",
      );
    } finally {
      // Never retain the credential after a submission, including a failure.
      setProjectKey("");
      setBusy(false);
    }
  };
  const current = data?.bindings.find(
    (binding) => binding.status !== "revoked",
  );
  const issues = data?.readiness.profile_issues || [];
  const inputClass =
    "mt-1 w-full rounded-lg border border-white/15 bg-black/20 px-3 py-2 text-sm text-zinc-100 focus:border-lime-300 focus:outline-none disabled:opacity-50";
  return (
    <details className="mt-6 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <summary className="cursor-pointer text-sm font-medium text-zinc-200">
        Home Inbox{" "}
        <span className="ml-2 text-xs font-normal text-zinc-500">
          Optional · Preview
        </span>
      </summary>
      <p className="mt-3 text-xs leading-relaxed text-zinc-400">
        Inbox owns the flow, cadence and sending. This dedicated Mind returns
        only a client-defined decision. Connect one Home project; existing
        Groovy API and widget access stay separate.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-amber-200/80">
        Use supplied inputs, optional web research, or explicitly granted Home
        data reads (Salesforce first). Enable both Home data tools on this Mind
        and grant operations to a dedicated project key in Home. Other
        CRM/database providers and complete usage receipts remain pending.
        Connecting does not enable scheduling; grant discovery does not verify
        provider health.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-300">
          {error}
        </p>
      )}
      {!forbidden && (
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="mt-3 text-xs text-zinc-300 underline underline-offset-4"
        >
          Refresh connection &amp; saved Mind checks
        </button>
      )}
      {issues.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-amber-200/80">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {current ? (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-white/10 p-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{current.harness_ref}</span>
              <span
                className={
                  current.status === "active"
                    ? "text-lime-300"
                    : "text-zinc-400"
                }
              >
                {current.status}
              </span>
            </div>
            <dl className="mt-3 space-y-2 break-all text-zinc-500">
              <div>
                <dt>Home tenant</dt>
                <dd className="text-zinc-300">{current.tenant_id}</dd>
              </div>
              <div>
                <dt>Project / funnel</dt>
                <dd className="text-zinc-300">{current.project_id}</dd>
              </div>
            </dl>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={
                busy ||
                (current.status === "paused" &&
                  (!data?.readiness.consumer_enabled || issues.length > 0))
              }
              onClick={() =>
                void mutate(`${base}/${current.id}`, "PATCH", {
                  status: current.status === "active" ? "paused" : "active",
                })
              }
              className="rounded-lg border border-white/15 px-3 py-2 text-xs disabled:opacity-40"
            >
              {current.status === "active"
                ? "Pause decisions"
                : "Enable decisions"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Revoke this connection? No further claims or result delivery will run. Existing history is preserved; reconnecting requires a new binding.",
                  )
                )
                  void mutate(`${base}/${current.id}`, "PATCH", {
                    status: "revoked",
                  });
              }}
              className="text-xs text-zinc-400 disabled:opacity-40"
            >
              Revoke connection
            </button>
          </div>
          {!data?.readiness.consumer_enabled && (
            <p className="text-xs text-zinc-500">
              The server consumer is disabled. This connection stays paused
              until deployment readiness is approved.
            </p>
          )}
        </div>
      ) : (
        data &&
        !forbidden && (
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(base, "POST", {
                tenant_id: tenantId.trim(),
                project_id: projectId.trim(),
                harness_ref: harnessRef.trim(),
                home_project_key: projectKey.trim(),
              });
            }}
          >
            <label className="block text-xs text-zinc-400">
              Home tenant ID
              <input
                required
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className={inputClass}
                disabled={busy}
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Home project ID (funnel ID)
              <input
                required
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className={inputClass}
                disabled={busy}
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Harness reference from the Inbox flow
              <input
                required
                pattern="[a-z0-9][a-z0-9_-]{0,119}"
                value={harnessRef}
                onChange={(e) => setHarnessRef(e.target.value)}
                className={inputClass}
                disabled={busy}
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Home project key
              <input
                required
                type="password"
                autoComplete="new-password"
                value={projectKey}
                onChange={(e) => setProjectKey(e.target.value)}
                className={inputClass}
                disabled={busy}
              />
            </label>
            <p className="text-xs text-zinc-500">
              Use a key scoped to this project with Inbox operator access.
              Verification reads the queue only; execution permissions are
              checked again on every claim. The key is encrypted and never shown
              again.
            </p>
            <button
              type="submit"
              disabled={busy || issues.length > 0}
              className="rounded-lg border border-lime-300/30 bg-lime-300/10 px-3 py-2 text-xs text-lime-200 disabled:opacity-40"
            >
              {busy ? "Connecting…" : "Verify & save paused"}
            </button>
          </form>
        )
      )}
      {!!data?.runs.length && (
        <div className="mt-5 border-t border-white/10 pt-3">
          <h3 className="text-xs font-medium text-zinc-300">
            Recent decisions
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            Unknown runs are held, not rerun. Pending receipts retry only the
            saved result. Full trace usage remains in Groovy; unreported usage
            is not zero.
          </p>
          <ul className="mt-3 space-y-3">
            {data.runs.map((run) => (
              <li key={run.id} className="text-xs">
                <div className="flex justify-between gap-3">
                  <span
                    className="truncate text-zinc-400"
                    title={run.decision_id}
                  >
                    {run.decision_id}
                  </span>
                  <span className="shrink-0 text-zinc-200">
                    {run.state === "delivered" && run.applied === false
                      ? "Recorded, not applied"
                      : run.state}
                  </span>
                </div>
                {run.error_code && (
                  <p className="mt-1 text-amber-200/70">
                    {run.error_code.replaceAll("_", " ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}
