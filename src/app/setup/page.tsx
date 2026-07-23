import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  BookOpen,
  Clock,
  Database,
  Download,
  FileSpreadsheet,
  Flame,
  Globe,
  Heart,
  Laptop,
  ListOrdered,
  MessageCircle,
  Settings,
  Terminal,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { getConnectorInstallGuide } from "@/lib/connector/catalog";
import { AllowBodyScroll } from "@/components/marketing/AllowBodyScroll";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { MarketingHeader } from "@/components/marketing/MarketingHeader";
import { getAppUrl, getBrandName } from "@/lib/config/appConfig";

export const metadata: Metadata = {
  title: "Setting Up Groovy | Complete Setup Guide",
  description:
    "A step-by-step guide to setting up Groovy: hosting, WhatsApp, Claude CLI, integrations, scheduled tasks, and more.",
  alternates: { canonical: "/setup" },
  openGraph: {
    title: "Setting Up Groovy | Complete Setup Guide",
    description:
      "A step-by-step guide to setting up Groovy: hosting, WhatsApp, Claude CLI, integrations, scheduled tasks, and more.",
    type: "article",
    url: "/setup",
  },
  twitter: {
    card: "summary_large_image",
    title: "Setting Up Groovy | Complete Setup Guide",
    description:
      "A step-by-step guide to setting up Groovy: hosting, WhatsApp, Claude CLI, integrations, scheduled tasks, and more.",
  },
  robots: { index: true, follow: true },
};

type SetupStep = {
  number: number;
  title: string;
  description: string;
  icon: LucideIcon;
  iconColor: string;
  bgColor: string;
  borderColor: string;
  link?: { url: string; label: string; external?: boolean };
};

const SETUP_STEPS: SetupStep[] = [
  {
    number: 1,
    title: "Choose Your Hosting",
    description:
      "Groovy is very powerful and we recommend you install it on your own computer — but that comes at your own risk. Groovy has the power to control your machine entirely, including deleting files if you give it that task. Cloud edition users can alternatively use a Groovy-hosted Mac, while self-hosted deployments can run on infrastructure they control.",
    icon: Laptop,
    iconColor: "text-cyan-400",
    bgColor: "bg-cyan-500/10",
    borderColor: "border-cyan-500/20",
  },
  {
    number: 2,
    title: "Set Up WhatsApp",
    description:
      "Choose between using your own WhatsApp number or a dedicated Groovy number via Kapso. Using your own number lets you interact with Groovy in group chats. The Kapso option gives you a US-based number.",
    icon: MessageCircle,
    iconColor: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
    borderColor: "border-emerald-500/20",
  },
  {
    number: 3,
    title: "Install Claude CLI",
    description:
      "For coding and computer browsing features, Groovy uses Claude CLI. You must install it for those features to work. We recommend the Max plan at $100/month which gives you the special token. Detailed instructions are provided during onboarding.",
    icon: Terminal,
    iconColor: "text-violet-400",
    bgColor: "bg-violet-500/10",
    borderColor: "border-violet-500/20",
  },
  {
    number: 4,
    title: "Connect Your Provider Keys",
    description:
      "Groovy does not charge a percentage over token usage by default. Connect your own model provider keys so you control your provider account, usage, and billing.",
    icon: Zap,
    iconColor: "text-amber-400",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
  },
  {
    number: 5,
    title: "Connect UpReady",
    description:
      "UpReady tracks your health and readiness so Groovy can factor that into your daily briefings. It's available on iOS only. You can set up the integration in Settings once you complete onboarding.",
    icon: Heart,
    iconColor: "text-rose-400",
    bgColor: "bg-rose-500/10",
    borderColor: "border-rose-500/20",
    link: {
      url: "https://apps.apple.com/us/app/upready-ai-performance-tracker/id6738921753",
      label: "Download UpReady on the App Store",
      external: true,
    },
  },
  {
    number: 6,
    title: "Data Agent & Integrations",
    description:
      "Head to the Data agent and connect your Google Calendar, Gmail, and other integrations — this makes Groovy much more powerful. Also head to the AI chat and create different Chat models. We recommend creating a photo chat with NanoBanana. Think of these agents as specialized sub-agents.",
    icon: Database,
    iconColor: "text-blue-400",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500/20",
  },
  {
    number: 7,
    title: "Explore Settings",
    description:
      "Once onboarded, head to Settings and explore. You can set spending limits to control costs. Heartbeat is enabled by default — it sends you a WhatsApp summary of your life every 2 hours, but only works if you have a connected WhatsApp account.",
    icon: Settings,
    iconColor: "text-teal-400",
    bgColor: "bg-teal-500/10",
    borderColor: "border-teal-500/20",
  },
  {
    number: 8,
    title: "Set Up Web Pixels",
    description:
      "In the Data agent you can connect web pixels for your sites. This is useful because pixel data feeds directly into the Heartbeat, keeping you up to date on your site traffic without checking analytics dashboards.",
    icon: Globe,
    iconColor: "text-cyan-400",
    bgColor: "bg-cyan-500/10",
    borderColor: "border-cyan-500/20",
  },
  {
    number: 9,
    title: "Invite Team Members",
    description:
      "You can invite team members to your account in Settings. This adds them to your workspace and you, as the admin, are responsible for all token consumption across the team.",
    icon: Users,
    iconColor: "text-violet-400",
    bgColor: "bg-violet-500/10",
    borderColor: "border-violet-500/20",
  },
  {
    number: 10,
    title: "Schedule Tasks",
    description:
      "Tell Groovy what to do and when to run it. Scheduled tasks can send results to a WhatsApp group or create files automatically. Great for recurring reports, monitoring, and automations.",
    icon: Clock,
    iconColor: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
    borderColor: "border-emerald-500/20",
  },
  {
    number: 11,
    title: "File & Browser Agents",
    description:
      "Use the Files agent to create Excel spreadsheets, PDFs, or PowerPoint presentations. The Browser agent can visit any site — if you need to log in, tell Groovy and you can store your credentials securely.",
    icon: FileSpreadsheet,
    iconColor: "text-amber-400",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
  },
  {
    number: 12,
    title: "Enable Firecrawl",
    description:
      "The Data agent has a Firecrawl integration for deep research that needs web scraping. Use it for competitive analysis, data gathering, or any task that requires crawling multiple pages.",
    icon: Flame,
    iconColor: "text-rose-400",
    bgColor: "bg-rose-500/10",
    borderColor: "border-rose-500/20",
  },
  {
    number: 13,
    title: "Use Multi-Agent View",
    description:
      "Use the multi-agent view to control your agents in parallel. Groovy can run multiple tasks at a time. Be mindful of running too many scheduled tasks simultaneously — the queue can get full.",
    icon: Bot,
    iconColor: "text-purple-400",
    bgColor: "bg-purple-500/10",
    borderColor: "border-purple-500/20",
  },
];

export default function SetupGuidePage() {
  const macGuide = getConnectorInstallGuide("macos");
  const windowsGuide = getConnectorInstallGuide("windows");
  const appUrl = getAppUrl();
  const brandName = getBrandName();

  const howToJsonLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: `Setting Up ${brandName}`,
    description:
      "A step-by-step guide to setting up Groovy AI agent: hosting, WhatsApp, Claude CLI, integrations, and more.",
    totalTime: "PT30M",
    step: SETUP_STEPS.map((s) => ({
      "@type": "HowToStep",
      position: s.number,
      name: s.title,
      text: s.description,
      ...(s.link?.url ? { url: s.link.url } : {}),
    })),
  };

  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: brandName,
    applicationCategory: "BusinessApplication",
    operatingSystem: "macOS, Windows",
    description: "AI Agent Command Center that runs locally on your computer.",
    url: `${appUrl}/setup`,
  };

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] relative overflow-x-hidden">
      <AllowBodyScroll />

      {/* Background effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-cyan-500/10 rounded-full blur-[120px] animate-float" />
        <div
          className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-violet-500/10 rounded-full blur-[120px] animate-float"
          style={{ animationDelay: "-5s" }}
        />
      </div>
      <div className="fixed inset-0 bg-grid opacity-30 pointer-events-none" />

      <MarketingHeader />

      <main className="relative z-10 px-6 pt-40 pb-12">
        {/* Hero */}
        <section className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 mb-4 px-3 py-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 text-xs font-semibold uppercase tracking-wider text-cyan-300">
            <BookOpen className="w-4 h-4" />
            Setup Guide
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-white leading-[1.02]">
            Setting up{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-violet-400">
              Groovy
            </span>
          </h1>
          <p className="mt-5 text-lg text-zinc-400 max-w-3xl mx-auto">
            Everything you need to get Groovy running — from hosting to
            multi-agent workflows. Follow these steps and you&apos;ll be fully
            set up.
          </p>
        </section>

        {/* Steps */}
        <section className="max-w-6xl mx-auto mt-20 py-20 border-t border-white/5">
          <div className="text-center mb-12">
            <div className="flex items-center justify-center gap-2 mb-4">
              <ListOrdered className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
                Step by Step
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white">
              13 steps to get fully set up.
            </h2>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {SETUP_STEPS.map((step) => {
              const Icon = step.icon;
              return (
                <article
                  key={step.number}
                  className="relative p-6 pt-8 rounded-xl border border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04] transition-all group"
                >
                  {/* Step number badge */}
                  <div className="absolute -top-3 -left-3 w-8 h-8 rounded-full bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400 font-bold text-sm">
                    {step.number}
                  </div>

                  <div
                    className={`w-10 h-10 rounded-lg ${step.bgColor} border ${step.borderColor} flex items-center justify-center mb-3 group-hover:scale-110 transition-transform`}
                  >
                    <Icon className={`w-5 h-5 ${step.iconColor}`} />
                  </div>

                  <h3 className="text-base font-semibold text-white mb-2">
                    {step.title}
                  </h3>
                  <p className="text-sm text-zinc-500 leading-relaxed">
                    {step.description}
                  </p>

                  {step.link && (
                    <a
                      href={step.link.url}
                      target={step.link.external ? "_blank" : undefined}
                      rel={
                        step.link.external
                          ? "noopener noreferrer"
                          : undefined
                      }
                      className="mt-3 inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                    >
                      {step.link.label}
                      <ArrowRight className="w-3 h-3" />
                    </a>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        {/* CTA */}
        <section className="max-w-4xl mx-auto py-20 border-t border-white/5 text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Ready to get started?
          </h2>
          <p className="text-lg text-zinc-500 max-w-xl mx-auto mb-10">
            Download the Groovy Connector and begin automating today.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href={macGuide.downloadUrl}
              className="group flex items-center gap-3 px-8 py-4 rounded-2xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-semibold shadow-xl shadow-cyan-500/30 hover:shadow-cyan-500/50 transition-all"
            >
              <Download className="w-5 h-5" />
              Download for macOS
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </a>
            <a
              href={windowsGuide.downloadUrl}
              className="group flex items-center gap-3 px-8 py-4 rounded-2xl glass border border-white/10 text-zinc-300 font-semibold hover:bg-white/5 hover:text-white transition-all"
            >
              <Download className="w-5 h-5" />
              Download for Windows
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/10 text-zinc-400 font-normal ml-1">
                Beta
              </span>
            </a>
          </div>
          <p className="mt-6 text-sm text-zinc-600">
            Already have an account?{" "}
            <Link
              href="/login"
              className="text-cyan-500 hover:text-cyan-400 underline underline-offset-2"
            >
              Sign in
            </Link>
          </p>
        </section>
      </main>

      <MarketingFooter />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(howToJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
      />
    </div>
  );
}
