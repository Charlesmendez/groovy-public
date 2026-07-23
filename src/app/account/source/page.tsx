import { SourceSnapshotsPanel } from "../AccountPortalClient";

export default function AccountSourcePage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <section className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="text-3xl font-semibold">Source Snapshots</h1>
        <p className="mt-4 text-zinc-400">
          Tagged source releases are visible in the public GitHub mirror. Active
          licensed users can also download packaged snapshots and signed artifacts
          through the portal and CLI.
        </p>
        <SourceSnapshotsPanel />
      </section>
    </main>
  );
}
