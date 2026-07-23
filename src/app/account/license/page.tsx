import { LicensePanel } from "../AccountPortalClient";
import { notFound } from "next/navigation";
import { isSelfHosted } from "@/lib/config/edition";

export default function AccountLicensePage() {
  if (isSelfHosted()) notFound();
  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <section className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="text-3xl font-semibold">License</h1>
        <p className="mt-4 text-zinc-400">
          View your Groovy license, renewal date, features, and activation permissions.
        </p>
        <LicensePanel />
      </section>
    </main>
  );
}
