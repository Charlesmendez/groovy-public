"use client";

import { ErrorState, Field, formatDate, LoadingState } from "./common";
import type { LicenseEntitlement } from "./types";
import { useLicenseStatus } from "./useAccountData";

function legacyEntitlement(data: ReturnType<typeof useLicenseStatus>["data"]): LicenseEntitlement[] {
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

function planTitle(entitlement: LicenseEntitlement) {
  const payload = entitlement.license?.payload;
  if (payload?.license_type === "personal") return "Groovy Personal";
  if (payload?.license_type === "enterprise_reseller") {
    return `${entitlement.workspaceName || payload.customer_name || "Workspace"} Reseller`;
  }
  if (payload?.license_type === "enterprise") {
    return `${entitlement.workspaceName || payload.customer_name || "Workspace"} Enterprise`;
  }
  return entitlement.workspaceName || payload?.license_type || "Groovy license";
}

function accessLabel(entitlement: LicenseEntitlement) {
  return entitlement.scope === "personal"
    ? "Personal, non-commercial work"
    : "Company workspace access";
}

function LicenseCard({ entitlement }: { entitlement: LicenseEntitlement }) {
  const payload = entitlement.license?.payload;
  if (!payload) return null;

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">{accessLabel(entitlement)}</div>
          <h3 className="mt-2 text-lg font-semibold text-white">{planTitle(entitlement)}</h3>
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-300">
          {payload.status || "unknown"}
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Field label="Plan" value={payload.license_type} />
        <Field label="Valid until" value={formatDate(payload.valid_until)} />
        <Field label="Device limit" value={payload.max_devices ?? "Not limited"} />
        <Field label="User limit" value={payload.max_users ?? "Not limited"} />
        <Field label="Fallback rights" value={payload.fallback_allowed ? "Enabled" : "Not included"} />
        <Field
          label="Reseller token billing"
          value={payload.token_consumption_billing_enabled ? "Enabled" : "Disabled"}
        />
      </div>

      {entitlement.licenseKey ? (
        <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-4">
          <div className="text-xs uppercase tracking-wide text-zinc-500">License key</div>
          <code className="mt-3 block break-all rounded bg-black/30 p-3 text-xs text-cyan-100">
            {entitlement.licenseKey}
          </code>
        </div>
      ) : entitlement.canManageLicense === false ? (
        <p className="mt-4 text-sm text-zinc-500">Workspace admins manage this license key.</p>
      ) : null}

      {payload.features?.length ? (
        <div className="mt-4">
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
    </section>
  );
}

export function LicensePanel() {
  const { data, loading, error } = useLicenseStatus();
  const entitlements = legacyEntitlement(data);

  if (loading) return <LoadingState label="Loading license..." />;
  if (error) return <ErrorState error={error} />;
  if (!data?.licensed || entitlements.length === 0) {
    return (
      <div className="mt-8 rounded-lg border border-white/10 bg-white/[0.03] p-5">
        <div className="text-sm font-medium text-white">No Groovy license is attached yet.</div>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Buy Groovy Personal for individual, non-commercial use, or contact sales for company use,
          source access terms, and enterprise deployment rights.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <a
            href="/pricing"
            className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-cyan-300"
          >
            Buy Groovy Personal
          </a>
          <a
            href="/enterprise"
            className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
          >
            Contact Sales
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/10 p-4 text-sm leading-relaxed text-cyan-50">
        Personal and company access stay separate. Your personal license covers your own
        non-commercial Groovy use, while an enterprise workspace license covers company work,
        team access, source terms, and support under that company agreement.
      </div>

      {entitlements.map((entitlement, index) => (
        <LicenseCard
          key={entitlement.license?.payload?.license_id || entitlement.workspaceId || `license-${index}`}
          entitlement={entitlement}
        />
      ))}
    </div>
  );
}
