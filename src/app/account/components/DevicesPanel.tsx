"use client";

import { useMemo, useState } from "react";
import { ErrorState, formatDate, LoadingState } from "./common";
import type { LicenseEntitlement } from "./types";
import { useLicenseStatus } from "./useAccountData";

function entitlementsFromStatus(data: ReturnType<typeof useLicenseStatus>["data"]): LicenseEntitlement[] {
  if (data?.licenses?.length) return data.licenses;
  if (!data?.license?.payload) return [];
  return [
    {
      licensed: data.licensed,
      scope: data.license.payload.license_type === "personal" ? "personal" : "workspace",
      workspaceId: data.workspaceId,
      license: data.license,
      devices: data.devices || [],
      canManageLicense: data.canManageLicense,
    },
  ];
}

function licenseName(entitlement: LicenseEntitlement) {
  const payload = entitlement.license?.payload;
  if (payload?.license_type === "personal") return "Groovy Personal";
  if (payload?.license_type === "enterprise_reseller") {
    return `${entitlement.workspaceName || payload.customer_name || "Workspace"} Reseller`;
  }
  return `${entitlement.workspaceName || payload?.customer_name || "Workspace"} Enterprise`;
}

export function DevicesPanel() {
  const { data, loading, error, refresh } = useLicenseStatus();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const entitlements = entitlementsFromStatus(data);
  const manageableLicenses = useMemo(
    () =>
      entitlements
        .filter((entitlement) => entitlement.canManageLicense)
        .map((entitlement) => ({
          entitlement,
          activeDevices: (entitlement.devices || []).filter((device) => !device.deactivated_at),
        })),
    [entitlements]
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
  if (manageableLicenses.length === 0) {
    return <p className="mt-6 text-sm text-zinc-400">Only license owners or workspace admins can manage license devices.</p>;
  }

  return (
    <div className="mt-8 space-y-3">
      {actionError ? <ErrorState error={actionError} /> : null}
      {manageableLicenses.every((item) => item.activeDevices.length === 0) ? (
        <p className="text-sm text-zinc-400">No devices are activated yet.</p>
      ) : (
        manageableLicenses.map(({ entitlement, activeDevices }) =>
          activeDevices.length > 0 ? (
            <section key={entitlement.license?.payload?.license_id || entitlement.workspaceId} className="space-y-3">
              <h3 className="text-sm font-medium text-white">{licenseName(entitlement)}</h3>
              {activeDevices.map((device) => (
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
              ))}
            </section>
          ) : null
        )
      )}
      {entitlements.some((entitlement) => !entitlement.canManageLicense) ? (
        <p className="text-sm text-zinc-500">
          Some workspace devices may be hidden because only workspace admins can manage them.
        </p>
      ) : null}
    </div>
  );
}
