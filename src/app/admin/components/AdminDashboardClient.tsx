"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { Download, KeyRound, MonitorCog, ShieldCheck } from "lucide-react";
import { ArtifactsAdminPanel } from "./ArtifactsAdminPanel";
import { LicensesAdminPanel } from "./LicensesAdminPanel";

type AdminTab = "licenses" | "artifacts";

export function AdminDashboardClient() {
  const [tab, setTab] = useState<AdminTab>("licenses");

  return (
    <main className="app-scroll-page bg-zinc-950 text-white">
      <section className="mx-auto max-w-7xl px-6 py-10">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-500/20 bg-cyan-500/10">
                <ShieldCheck className="h-5 w-5 text-cyan-300" />
              </div>
              <div>
                <h1 className="text-3xl font-semibold tracking-tight">Groovy Admin</h1>
                <p className="mt-1 text-sm text-zinc-500">
                  Licensing, portal downloads, source snapshots, and hosted Mac operations.
                </p>
              </div>
            </div>
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-zinc-500">
              Access is controlled by <code className="rounded bg-white/10 px-1 py-0.5">GROOVY_ADMIN_EMAILS</code>.
              Personal licenses normally come from Stripe webhooks. Use this dashboard for manual
              enterprise/reseller creation, support operations, artifact publishing, and audits.
            </p>
          </div>
          <Link
            href="/admin/hosted-macs"
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 px-4 py-3 text-sm font-semibold text-zinc-200 hover:bg-white/10"
          >
            <MonitorCog className="h-4 w-4" />
            Hosted Macs
          </Link>
        </div>

        <div className="mt-8 flex flex-wrap gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-2">
          <TabButton active={tab === "licenses"} onClick={() => setTab("licenses")} icon={<KeyRound className="h-4 w-4" />}>
            Licenses
          </TabButton>
          <TabButton active={tab === "artifacts"} onClick={() => setTab("artifacts")} icon={<Download className="h-4 w-4" />}>
            Downloads & source
          </TabButton>
        </div>

        <div className="mt-6">
          {tab === "licenses" ? <LicensesAdminPanel /> : <ArtifactsAdminPanel />}
        </div>
      </section>
    </main>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
        active ? "bg-cyan-400 text-zinc-950" : "text-zinc-400 hover:bg-white/10 hover:text-white"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
