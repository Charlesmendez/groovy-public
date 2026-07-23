import Link from "next/link";
import { isSelfHosted } from "@/lib/config/edition";

const cloudSections = [
  ["License", "/account/license"],
  ["Downloads", "/account/downloads"],
  ["Source", "/account/source"],
  ["Devices", "/account/devices"],
  ["Billing", "/account/billing"],
];

export default function AccountPage() {
  const selfHosted = isSelfHosted();
  const sections = selfHosted
    ? cloudSections.filter(([label]) => label !== "License" && label !== "Billing")
    : cloudSections;

  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <section className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="text-4xl font-semibold tracking-tight">Groovy Account</h1>
        <p className="mt-4 text-zinc-400">
          {selfHosted
            ? "Manage source snapshots, downloads, and devices."
            : "Manage your license, source snapshots, downloads, devices, and billing."}
        </p>
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {sections.map(([label, href]) => (
            <Link key={href} href={href} className="rounded-lg border border-white/10 bg-white/[0.03] p-4 hover:bg-white/[0.06]">
              {label}
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
