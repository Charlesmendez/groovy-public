"use client";

import { useState } from "react";
import { ErrorState, Field, formatDate, LoadingState } from "./common";
import { useLicenseStatus } from "./useAccountData";

export function BillingPanel() {
  const { data, loading, error } = useLicenseStatus();
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  async function openPortal() {
    setPortalLoading(true);
    setPortalError(null);
    try {
      const res = await fetch("/api/licenses/personal/billing-portal", { method: "POST" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.url) throw new Error(json?.error || "Failed to open billing portal");
      window.location.href = json.url;
    } catch (err) {
      setPortalError(err instanceof Error ? err.message : "Failed to open billing portal");
      setPortalLoading(false);
    }
  }

  if (loading) return <LoadingState label="Loading billing state..." />;
  if (error) return <ErrorState error={error} />;

  const payload = data?.license?.payload;
  return (
    <div className="mt-8 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Plan" value={payload?.license_type || "Unlicensed"} />
        <Field label="Status" value={payload?.status || data?.status || "unlicensed"} />
        <Field label="Renewal / valid until" value={formatDate(payload?.valid_until)} />
        <Field label="Token-consumption billing" value={payload?.token_consumption_billing_enabled ? "Enabled" : "Disabled"} />
      </div>
      <button
        type="button"
        onClick={openPortal}
        disabled={portalLoading || !data?.licensed || !data?.canManageLicense}
        className="rounded-lg bg-cyan-400 px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {portalLoading ? "Opening Stripe..." : "Manage Stripe Billing"}
      </button>
      {portalError ? <p className="text-sm text-red-300">{portalError}</p> : null}
      {!data?.canManageLicense ? <p className="text-sm text-zinc-500">Only account admins can manage billing.</p> : null}
      {data?.canManageLicense && payload?.license_type !== "personal" ? (
        <div className="flex flex-wrap gap-3">
          <a
            href="/api/enterprise/usage-report?format=csv"
            className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white hover:bg-white/10"
          >
            Export Enterprise Usage
          </a>
          {payload?.token_consumption_billing_enabled ? (
            <a
              href="/api/reseller/billing/export?format=csv"
              className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white hover:bg-white/10"
            >
              Export Reseller Billing
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
