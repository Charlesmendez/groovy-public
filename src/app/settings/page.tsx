import Link from "next/link";

const sections = [
  {
    href: "/settings/minds",
    title: "Minds",
    description:
      "Identity, model, tools, memory, worker roster, skills, Markdown instructions, and data access.",
  },
  {
    href: "/settings/skills",
    title: "Skills & Docs",
    description:
      "The Git-backed workspace library. Connect repositories, create artifacts, and set workspace defaults.",
  },
  {
    href: "/settings/integrations",
    title: "Integrations",
    description:
      "Connect Datagran and custom integrations once, then grant them to Minds and workers.",
  },
  {
    href: "/settings/team",
    title: "People & Access",
    description:
      "Invite full members or channel guests and control private-channel membership.",
  },
  {
    href: "/settings/api",
    title: "API & Widget",
    description:
      "Publish an external Mind, create keys, copy endpoint examples, and inspect request usage.",
  },
  {
    href: "/settings/usage",
    title: "Usage",
    description:
      "Workspace token, tool, worker, integration, and published-endpoint consumption.",
  },
  {
    href: "/account",
    title: "Account & Billing",
    description:
      "Manage your account, plan, license, billing details, and source access.",
  },
  {
    href: "/dashboard",
    title: "Device & Channels",
    description:
      "Return to Command Center to manage connector status, messaging channels, voice, and local device settings.",
  },
];

export default function SettingsOverviewPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="max-w-2xl">
        <h2 className="text-2xl font-semibold">Configure once. Use everywhere.</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Channels choose a Mind. Minds choose capabilities. Workspace settings
          own the shared libraries, connections, people, and usage.
        </p>
      </div>
      <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition hover:border-cyan-400/30 hover:bg-cyan-400/[0.04]"
          >
            <h3 className="text-sm font-medium">{section.title}</h3>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              {section.description}
            </p>
            <div className="mt-4 text-xs text-cyan-300">Open →</div>
          </Link>
        ))}
      </div>
    </main>
  );
}
