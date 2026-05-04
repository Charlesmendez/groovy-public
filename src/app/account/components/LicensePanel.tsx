"use client";

import { ErrorState, Field, formatDate, LoadingState } from "./common";
import { useLicenseStatus } from "./useAccountData";

export function LicensePanel() {
  const { data, loading, error } = useLicenseStatus();
  const payload = data?.license?.payload;

  if (loading) return <LoadingState label="Loading license..." />;
  if (error) return <ErrorState error={error} />;
  if (!data?.licensed || !payload) {
    return <p className="mt-6 text-sm text-zinc-400">No Groovy license is attached to this account yet.</p>;
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Plan" value={payload.license_type} />
        <Field label="Status" value={payload.status} />
        <Field label="Valid until" value={formatDate(payload.valid_until)} />
        <Field label="Device limit" value={payload.max_devices ?? "Not limited"} />
        <Field label="Fallback rights" value={payload.fallback_allowed ? "Enabled" : "Not included"} />
        <Field
          label="Reseller token billing"
          value={payload.token_consumption_billing_enabled ? "Enabled" : "Disabled"}
        />
      </div>

      {data.licenseKey ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <div className="text-xs uppercase tracking-wide text-zinc-500">License key</div>
          <code className="mt-3 block break-all rounded bg-black/30 p-3 text-xs text-cyan-100">
            {data.licenseKey}
          </code>
        </div>
      ) : data.canManageLicense === false ? (
        <p className="text-sm text-zinc-500">Only account admins can view the raw license key.</p>
      ) : null}

      {payload.features?.length ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Features</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {payload.features.map((feature) => (
              <span key={feature} className="rounded bg-white/10 px-2 py-1 text-xs text-zinc-200">
                {feature}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
