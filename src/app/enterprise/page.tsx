export default function EnterprisePage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <section className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="text-4xl font-semibold tracking-tight">Groovy Enterprise</h1>
        <p className="mt-4 text-zinc-400">
          Enterprise customers receive commercial licensing, self-hosting rights, source access when included in the agreement, support, and fallback rights to the last paid version.
        </p>
        <p className="mt-3 text-sm text-zinc-500">
          Prefer email? Contact <a className="text-cyan-300 hover:text-cyan-200" href="mailto:sales@gogroovy.ai">sales@gogroovy.ai</a>.
        </p>

        <form action="/api/enterprise/contact" method="post" className="mt-10 grid gap-4 rounded-lg border border-white/10 bg-white/[0.03] p-6">
          <div className="grid gap-4 md:grid-cols-2">
            <input name="name" required placeholder="Name" className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm" />
            <input name="email" required placeholder="Work email" className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm" />
            <input name="company" required placeholder="Company" className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm" />
            <input name="companySize" placeholder="Company size" className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm" />
            <input name="expectedUsers" placeholder="Expected users" className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm" />
            <input name="expectedAgents" placeholder="Expected agents" className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm" />
          </div>
          <textarea name="useCase" placeholder="Use case, deployment preference, compliance needs, source access, reseller interest" rows={6} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm" />
          <button className="w-fit rounded-lg bg-cyan-400 px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-300">
            Contact Sales
          </button>
        </form>
      </section>
    </main>
  );
}
