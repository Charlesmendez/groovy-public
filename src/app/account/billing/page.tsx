import { BillingPanel } from "../AccountPortalClient";

export default function AccountBillingPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <section className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="text-3xl font-semibold">Billing</h1>
        <p className="mt-4 text-zinc-400">
          Groovy Personal uses a yearly Stripe subscription. Token-consumption billing is disabled unless an enterprise reseller license explicitly enables it.
        </p>
        <BillingPanel />
      </section>
    </main>
  );
}
