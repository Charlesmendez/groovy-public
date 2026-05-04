import { DownloadsPanel } from "../AccountPortalClient";

export default function AccountDownloadsPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <section className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="text-3xl font-semibold">Downloads</h1>
        <p className="mt-4 text-zinc-400">
          Download current Groovy installers while your license is active.
        </p>
        <DownloadsPanel />
      </section>
    </main>
  );
}
