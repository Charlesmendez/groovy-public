import { DevicesPanel } from "../AccountPortalClient";

export default function AccountDevicesPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <section className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="text-3xl font-semibold">Devices</h1>
        <p className="mt-4 text-zinc-400">
          Personal licenses support two active devices. Deactivate old devices before activating a replacement.
        </p>
        <DevicesPanel />
      </section>
    </main>
  );
}
