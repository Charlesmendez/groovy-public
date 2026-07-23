import Link from "next/link";
import { Check, ArrowRight, Code2, KeyRound, Shield, Database } from "lucide-react";
import { AllowBodyScroll } from "@/components/marketing/AllowBodyScroll";
import { BuyPersonalButton } from "./BuyPersonalButton";

const personal = [
  "5-day full-product trial — no credit card required",
  "Personal license",
  "1 user",
  "2 activated devices",
  "Downloads and source snapshots while active",
  "Updates while active",
  "Local or self-hosted personal use",
  "Bring your own provider keys",
];

const enterprise = [
  "Commercial use",
  "Self-hosted deployment",
  "Full source access if included in the agreement",
  "Internal modification rights",
  "SSO, RBAC, audit logs, and enterprise security",
  "Support and annual license terms",
  "Fallback rights to the last paid version",
];

function FeatureList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-3 text-sm text-zinc-300">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export default function PricingPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <AllowBodyScroll />
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="max-w-3xl">
          <h1 className="text-4xl font-semibold tracking-tight">Groovy licensing</h1>
          <p className="mt-4 text-zinc-400">
            Start with five days of full product access, with no credit card required. After the
            trial, choose the license that fits your use. Public source for trust; your own provider keys by default.
            Groovy does not charge a percentage over your token usage unless an authorized
            reseller license explicitly enables customer usage billing.
          </p>
          <Link
            href="/dashboard"
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-cyan-400 px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-300"
          >
            Start free trial
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-4">
          {[
            {
              icon: Code2,
              title: "Source-visible",
              text: "Inspect each tagged release in the public mirror; a license grants the applicable rights to run it.",
            },
            {
              icon: KeyRound,
              title: "Bring your keys",
              text: "Use your own OpenAI, Anthropic, Google, Azure, Bedrock, Groq, Mistral, or other provider account.",
            },
            {
              icon: Shield,
              title: "No token tax",
              text: "Normal personal and enterprise customers are not billed by Groovy as a markup over provider usage.",
            },
            {
              icon: Database,
              title: "Datagran optional",
              text: "Memory and Data Integrations use Datagran when enabled, so teams connect their own Datagran account.",
            },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <section key={item.title} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                <Icon className="h-5 w-5 text-cyan-300" />
                <h2 className="mt-3 text-sm font-semibold text-white">{item.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-zinc-500">{item.text}</p>
              </section>
            );
          })}
        </div>

        <div className="mt-10 grid gap-5 md:grid-cols-2">
          <section className="rounded-lg border border-white/10 bg-white/[0.03] p-6">
            <div className="text-sm text-zinc-400">Groovy Personal</div>
            <div className="mt-3 flex items-end gap-2">
              <span className="text-4xl font-semibold">$49.99</span>
              <span className="pb-1 text-sm text-zinc-500">per year</span>
            </div>
            <p className="mt-4 text-sm text-zinc-400">
              For one individual&apos;s personal, non-commercial use only. Not for companies, employers, clients, teams, organizations, or revenue-generating work.
            </p>
            <div className="mt-6">
              <FeatureList items={personal} />
            </div>
            <BuyPersonalButton />
          </section>

          <section className="rounded-lg border border-white/10 bg-white/[0.03] p-6">
            <div className="text-sm text-zinc-400">Groovy Enterprise</div>
            <div className="mt-3 flex items-end gap-2">
              <span className="text-4xl font-semibold">Contact sales</span>
            </div>
            <p className="mt-4 text-sm text-zinc-400">
              For companies that want to own and operate Groovy inside their own environment. Authorized reseller and partner programs are handled separately.
            </p>
            <div className="mt-6">
              <FeatureList items={enterprise} />
            </div>
            <Link
              href="/enterprise"
              className="mt-7 inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-3 text-sm font-semibold text-white hover:bg-white/10"
            >
              Contact Sales
              <ArrowRight className="h-4 w-4" />
            </Link>
          </section>
        </div>
      </section>
    </main>
  );
}
