"use client";

import { useState } from "react";
import { ErrorState, Field, formatDate, LoadingState } from "./common";
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
      licenseKey: data.licenseKey,
      devices: data.devices || [],
      canManageLicense: data.canManageLicense,
    },
  ];
}

function entitlementName(entitlement: LicenseEntitlement) {
  const payload = entitlement.license?.payload;
  if (payload?.license_type === "personal") return "Groovy Personal";
  return entitlement.workspaceName || payload?.customer_name || "Enterprise workspace";
}

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

  const entitlements = entitlementsFromStatus(data);
  const personal = entitlements.find((entry) => entry.license?.payload?.license_type === "personal");
  const enterprise = entitlements.filter((entry) => entry.license?.payload?.license_type !== "personal");

  return (
    <div className="mt-8 space-y-4">
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm leading-relaxed text-zinc-300">
        Personal billing and enterprise billing are independent. You can keep a personal Groovy
        subscription for your own non-commercial work even if your company later invites you into an
        enterprise workspace.
      </div>

      {!data?.licensed || entitlements.length === 0 ? (
        <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/10 p-4">
          <div className="text-sm font-medium text-cyan-100">Start with Groovy Personal</div>
          <p className="mt-1 text-sm text-zinc-300">
            Personal licenses are $49.99 per year and are managed through Stripe. Company use
            requires an enterprise license.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <a
              href="/pricing"
              className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-cyan-300"
            >
              Buy Personal
            </a>
            <a
              href="/enterprise"
              className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
            >
              Contact Sales
            </a>
          </div>
        </div>
      ) : null}

      {personal?.license?.payload ? (
        <section className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Personal subscription</div>
          <h3 className="mt-2 text-lg font-semibold text-white">{entitlementName(personal)}</h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Status" value={personal.license.payload.status} />
            <Field label="Renewal / valid until" value={formatDate(personal.license.payload.valid_until)} />
          </div>
          <button
            type="button"
            onClick={openPortal}
            disabled={portalLoading || !personal.canManageLicense}
            className="mt-4 rounded-lg bg-cyan-400 px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {portalLoading ? "Opening Stripe..." : "Manage or cancel Stripe billing"}
          </button>
          {!personal.canManageLicense ? (
            <p className="mt-3 text-sm text-zinc-500">Only the personal license owner can manage this subscription.</p>
          ) : null}
        </section>
      ) : data?.licensed ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-400">
          You do not have a personal subscription attached to this account. Company access below is
          managed separately by the workspace owner or Groovy sales.
        </div>
      ) : null}

      {enterprise.map((entry) => {
        const payload = entry.license?.payload;
        if (!payload) return null;
        return (
          <section key={payload.license_id || entry.workspaceId} className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Enterprise agreement</div>
            <h3 className="mt-2 text-lg font-semibold text-white">{entitlementName(entry)}</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Plan" value={payload.license_type} />
              <Field label="Status" value={payload.status} />
              <Field label="Renewal / valid until" value={formatDate(payload.valid_until)} />
              <Field label="Token-consumption billing" value={payload.token_consumption_billing_enabled ? "Enabled" : "Disabled"} />
            </div>
            <p className="mt-4 text-sm text-zinc-400">
              Enterprise billing is handled by the Groovy agreement for this workspace. Contact
              sales@gogroovy.ai for renewals, invoices, reseller authorization, or contract changes.
            </p>
            {entry.canManageLicense ? (
              <div className="mt-4 flex flex-wrap gap-3">
                <a
                  href="/api/enterprise/usage-report?format=csv"
                  className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white hover:bg-white/10"
                >
                  Export enterprise usage
                </a>
                {payload.token_consumption_billing_enabled ? (
                  <a
                    href="/api/reseller/billing/export?format=csv"
                    className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white hover:bg-white/10"
                  >
                    Export reseller billing
                  </a>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-sm text-zinc-500">Workspace admins manage this enterprise license.</p>
            )}
          </section>
        );
      })}

      {portalError ? <p className="text-sm text-red-300">{portalError}</p> : null}
    </div>
  );
}
