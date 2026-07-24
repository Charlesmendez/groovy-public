"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import type { AdminLicense, LicenseStatus, LicenseType } from "./types";
import { formatDate, joinCsv, numberOrNull, oneYearFromTodayInput, splitCsv, toDateInput } from "./adminUtils";
import { CustomSelect } from "@/components/ui/CustomSelect";

type CreatedLicense = {
  licenseKey?: string;
  signedLicense?: unknown;
};

const licenseTypes: LicenseType[] = ["personal", "enterprise", "enterprise_reseller"];
const statuses: LicenseStatus[] = ["active", "past_due", "expired", "canceled", "suspended", "terminated"];

export function LicensesAdminPanel() {
  const [licenses, setLicenses] = useState<AdminLicense[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedLicense | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [form, setForm] = useState({
    licenseType: "personal" as LicenseType,
    status: "active" as LicenseStatus,
    organizationName: "",
    customerName: "",
    customerEmail: "",
    userId: "",
    workspaceId: "",
    validUntil: oneYearFromTodayInput(),
    maxDevices: "2",
    maxUsers: "",
    maxAgents: "",
    maxEnvironments: "",
    fallbackAllowed: false,
    resellerBillingEnabled: false,
    tokenConsumptionBillingEnabled: false,
    features: "personal_downloads, personal_updates",
  });

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/licenses", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to load licenses");
      setLicenses(Array.isArray(json.licenses) ? json.licenses : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load licenses");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  const copyText = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1400);
  };

  const createLicense = async () => {
    setSaving(true);
    setError(null);
    setCreated(null);
    try {
      const res = await fetch("/api/admin/licenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseType: form.licenseType,
          status: form.status,
          organizationName: form.organizationName || undefined,
          customerName: form.customerName || undefined,
          customerEmail: form.customerEmail || undefined,
          userId: form.userId || undefined,
          workspaceId: form.workspaceId || undefined,
          validUntil: form.validUntil || undefined,
          maxDevices: numberOrNull(form.maxDevices),
          maxUsers: numberOrNull(form.maxUsers),
          maxAgents: numberOrNull(form.maxAgents),
          maxEnvironments: numberOrNull(form.maxEnvironments),
          fallbackAllowed: form.fallbackAllowed,
          resellerBillingEnabled: form.resellerBillingEnabled,
          tokenConsumptionBillingEnabled: form.tokenConsumptionBillingEnabled,
          features: splitCsv(form.features),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to create license");
      setCreated({ licenseKey: json.licenseKey, signedLicense: json.signedLicense });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create license");
    } finally {
      setSaving(false);
    }
  };

  const updateForm = (patch: Partial<typeof form>) => {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      if (patch.licenseType === "personal") {
        next.maxDevices = next.maxDevices || "2";
        next.features = next.features || "personal_downloads, personal_updates";
        next.resellerBillingEnabled = false;
        next.tokenConsumptionBillingEnabled = false;
      }
      if (patch.licenseType === "enterprise") {
        next.fallbackAllowed = true;
        next.resellerBillingEnabled = false;
        next.tokenConsumptionBillingEnabled = false;
      }
      if (patch.licenseType === "enterprise_reseller") {
        next.fallbackAllowed = true;
        next.features = next.features || "source_access, reseller_billing, customer_usage_reporting";
      }
      return next;
    });
  };

  return (
    <section className="space-y-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Create license</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Use this for manual enterprise accounts, reseller agreements, support overrides, or test
              personal licenses. Stripe still creates normal personal licenses automatically.
            </p>
          </div>
          <ShieldCheck className="h-5 w-5 text-cyan-300" />
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <Select label="Type" value={form.licenseType} onChange={(value) => updateForm({ licenseType: value as LicenseType })} options={licenseTypes} />
          <Select label="Status" value={form.status} onChange={(value) => updateForm({ status: value as LicenseStatus })} options={statuses} />
          <Field label="Valid until" type="date" value={form.validUntil} onChange={(value) => updateForm({ validUntil: value })} />
          <Field label="Organization name" value={form.organizationName} onChange={(value) => updateForm({ organizationName: value })} />
          <Field label="Customer name" value={form.customerName} onChange={(value) => updateForm({ customerName: value })} />
          <Field label="Customer email" type="email" value={form.customerEmail} onChange={(value) => updateForm({ customerEmail: value })} />
          <Field label="User ID" value={form.userId} onChange={(value) => updateForm({ userId: value })} />
          <Field label="Workspace ID" value={form.workspaceId} onChange={(value) => updateForm({ workspaceId: value })} />
          <Field label="Max devices" value={form.maxDevices} onChange={(value) => updateForm({ maxDevices: value })} />
          <Field label="Max users" value={form.maxUsers} onChange={(value) => updateForm({ maxUsers: value })} />
          <Field label="Max agents" value={form.maxAgents} onChange={(value) => updateForm({ maxAgents: value })} />
          <Field label="Max environments" value={form.maxEnvironments} onChange={(value) => updateForm({ maxEnvironments: value })} />
        </div>

        <label className="mt-3 block">
          <span className="text-xs text-zinc-500">Features, comma-separated</span>
          <input
            value={form.features}
            onChange={(e) => updateForm({ features: e.target.value })}
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/50"
          />
        </label>

        <div className="mt-4 flex flex-wrap gap-4 text-sm text-zinc-300">
          <Checkbox label="Fallback rights" checked={form.fallbackAllowed} onChange={(checked) => updateForm({ fallbackAllowed: checked })} />
          <Checkbox label="Reseller billing" checked={form.resellerBillingEnabled} onChange={(checked) => updateForm({ resellerBillingEnabled: checked })} />
          <Checkbox label="Token billing" checked={form.tokenConsumptionBillingEnabled} onChange={(checked) => updateForm({ tokenConsumptionBillingEnabled: checked })} />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={createLicense}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-cyan-300 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create license
          </button>
          {error ? <p className="text-sm text-red-300">{error}</p> : null}
        </div>

        {created ? (
          <div className="mt-5 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4">
            <div className="text-sm font-medium text-emerald-100">License created</div>
            {created.licenseKey ? (
              <div className="mt-3">
                <div className="text-xs text-emerald-100/70">Copy this license key now.</div>
                <button
                  type="button"
                  onClick={() => copyText("license-key", created.licenseKey || "")}
                  className="mt-2 flex w-full items-center justify-between gap-3 rounded-lg bg-black/30 p-3 text-left font-mono text-xs text-cyan-100"
                >
                  <span className="break-all">{created.licenseKey}</span>
                  {copied === "license-key" ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            ) : null}
            {created.signedLicense ? (
              <textarea
                readOnly
                value={JSON.stringify(created.signedLicense, null, 2)}
                className="mt-3 h-36 w-full rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs text-zinc-300"
              />
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Licenses</h2>
            <p className="mt-1 text-sm text-zinc-500">Update status, renewal dates, limits, and reseller flags.</p>
          </div>
          <button type="button" onClick={refresh} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
        {loading ? <p className="mt-5 text-sm text-zinc-500">Loading licenses...</p> : null}
        <div className="mt-5 space-y-3">
          {licenses.map((license) => (
            <LicenseRow key={license.id} license={license} onUpdated={refresh} />
          ))}
          {!loading && licenses.length === 0 ? <p className="text-sm text-zinc-500">No licenses yet.</p> : null}
        </div>
      </div>
    </section>
  );
}

function LicenseRow({ license, onUpdated }: { license: AdminLicense; onUpdated: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<LicenseStatus>(license.status);
  const [validUntil, setValidUntil] = useState(toDateInput(license.valid_until));
  const [features, setFeatures] = useState(joinCsv(license.features));
  const [reseller, setReseller] = useState(Boolean(license.reseller_billing_enabled));
  const [tokenBilling, setTokenBilling] = useState(Boolean(license.token_consumption_billing_enabled));

  const update = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/licenses/${license.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          validUntil,
          features: splitCsv(features),
          resellerBillingEnabled: reseller,
          tokenConsumptionBillingEnabled: tokenBilling,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to update license");
      await onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update license");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-sm font-medium text-white">{license.customer_name || license.customer_email || license.id}</div>
          <div className="mt-1 text-xs text-zinc-500">
            {license.license_type} · {license.status} · valid until {formatDate(license.valid_until)}
          </div>
          <div className="mt-1 break-all text-[11px] text-zinc-600">ID {license.id}</div>
        </div>
        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2 lg:max-w-3xl lg:grid-cols-4">
          <Select label="Status" value={status} onChange={(value) => setStatus(value as LicenseStatus)} options={statuses} />
          <Field label="Valid until" type="date" value={validUntil} onChange={setValidUntil} />
          <Field label="Features" value={features} onChange={setFeatures} />
          <div className="space-y-2">
            <Checkbox label="Reseller" checked={reseller} onChange={setReseller} />
            <Checkbox label="Token billing" checked={tokenBilling} onChange={setTokenBilling} />
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button type="button" onClick={update} disabled={saving} className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-60">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </button>
        {error ? <p className="text-sm text-red-300">{error}</p> : null}
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
    <div className="block">
      <span className="text-xs text-zinc-500">{label}</span>
      <CustomSelect
        ariaLabel={label}
        className="mt-1 w-full"
        size="sm"
        value={value}
        onChange={onChange}
        options={options.map((option) => ({ value: option, label: option }))}
      />
    </div>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-white/20 bg-black accent-cyan-400" />
      <span>{label}</span>
    </label>
  );
}
