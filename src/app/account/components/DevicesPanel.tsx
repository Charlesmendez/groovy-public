"use client";

import { useMemo, useState } from "react";
import { ErrorState, formatDate, LoadingState } from "./common";
import { useLicenseStatus } from "./useAccountData";

export function DevicesPanel() {
  const { data, loading, error, refresh } = useLicenseStatus();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const activeDevices = useMemo(
    () => (data?.devices || []).filter((device) => !device.deactivated_at),
    [data?.devices]
  );

  async function deactivate(id: string) {
    setPendingId(id);
    setActionError(null);
    try {
      const res = await fetch(`/api/licenses/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error || "Failed to deactivate device");
      }
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to deactivate device");
    } finally {
      setPendingId(null);
    }
  }

  if (loading) return <LoadingState label="Loading devices..." />;
  if (error) return <ErrorState error={error} />;
  if (!data?.licensed) return <p className="mt-6 text-sm text-zinc-400">No active license devices.</p>;
  if (!data.canManageLicense) return <p className="mt-6 text-sm text-zinc-400">Only account admins can manage license devices.</p>;

  return (
    <div className="mt-8 space-y-3">
      {actionError ? <ErrorState error={actionError} /> : null}
      {activeDevices.length === 0 ? (
        <p className="text-sm text-zinc-400">No devices are activated yet.</p>
      ) : (
        activeDevices.map((device) => (
          <div key={device.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
            <div>
              <div className="font-medium text-white">{device.device_name || "Unnamed device"}</div>
              <div className="mt-1 text-xs text-zinc-500">
                {device.platform || "unknown platform"} · app {device.app_version || "unknown"} · last seen {formatDate(device.last_seen_at)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => deactivate(device.id)}
              disabled={pendingId === device.id}
              className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white hover:bg-white/10 disabled:opacity-60"
            >
              {pendingId === device.id ? "Deactivating..." : "Deactivate"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
