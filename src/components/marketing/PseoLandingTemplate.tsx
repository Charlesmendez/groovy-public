import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Download,
  Shield,
  Sparkles,
  Zap,
} from "lucide-react";

import { getConnectorInstallGuide } from "@/lib/connector/catalog";
import type { PseoPageRecord, PseoRelatedPageLink } from "@/lib/pseo/types";

import { AllowBodyScroll } from "./AllowBodyScroll";
import { MarketingFooter } from "./MarketingFooter";
import { MarketingHeader } from "./MarketingHeader";

type PseoLandingTemplateProps = {
  page: PseoPageRecord;
  canonicalUrl: string;
  relatedPages: PseoRelatedPageLink[];
};

function clusterLabel(cluster: PseoPageRecord["cluster"]) {
  if (cluster === "alternatives") return "Alternatives";
  if (cluster === "use-cases") return "Use Cases";
  return "Integrations";
}

export function PseoLandingTemplate({
  page,
  canonicalUrl,
  relatedPages,
}: PseoLandingTemplateProps) {
  const macGuide = getConnectorInstallGuide("macos");
  const windowsGuide = getConnectorInstallGuide("windows");

  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Groovy",
    applicationCategory: "BusinessApplication",
    operatingSystem: "macOS, Windows",
    description: page.metaDescription,
    url: canonicalUrl,
  };

  const faqJsonLd =
    page.faq.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: page.faq.map((item) => ({
            "@type": "Question",
            name: item.question,
            acceptedAnswer: {
              "@type": "Answer",
              text: item.answer,
            },
          })),
        }
      : null;

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] relative overflow-x-hidden">
      <AllowBodyScroll />
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
        <section className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 mb-4 px-3 py-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 text-xs font-semibold uppercase tracking-wider text-cyan-300">
            <Sparkles className="w-4 h-4" />
            {clusterLabel(page.cluster)}
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-white leading-[1.02]">
            {page.h1}
          </h1>
          <p className="mt-5 text-lg text-zinc-400 max-w-3xl mx-auto">
            {page.subhead}
          </p>
          <p className="mt-4 text-sm text-zinc-500 max-w-3xl mx-auto">
            {page.intro}
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {[page.primaryKeyword, ...page.secondaryKeywords].slice(0, 7).map((keyword) => (
              <span
                key={keyword}
                className="px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.03] text-xs text-zinc-300"
              >
                {keyword}
              </span>
            ))}
          </div>

          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
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
        </section>

        <section className="max-w-6xl mx-auto mt-20 py-20 border-t border-white/5">
          <div className="text-center mb-10">
            <div className="flex items-center justify-center gap-2 mb-4">
              <Shield className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
                Why Teams Choose Groovy
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white">
              AI automation that actually ships work.
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            {page.proofPoints.map((point) => (
              <article
                key={point}
                className="p-5 rounded-xl border border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04] transition-all"
              >
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" />
                  <p className="text-sm text-zinc-300 leading-relaxed">{point}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="max-w-6xl mx-auto py-20 border-t border-white/5">
          <div className="text-center mb-10">
            <div className="flex items-center justify-center gap-2 mb-4">
              <Zap className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
                What You Can Automate
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white">
              Built for fast execution.
            </h2>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            {page.featureBullets.map((feature) => (
              <article
                key={feature}
                className="p-5 rounded-xl border border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04] transition-all"
              >
                <p className="text-sm text-zinc-300">{feature}</p>
              </article>
            ))}
          </div>
        </section>

        {page.faq.length > 0 && (
          <section className="max-w-4xl mx-auto py-20 border-t border-white/5">
            <div className="text-center mb-10">
              <h2 className="text-3xl sm:text-4xl font-bold text-white">
                Frequently asked questions
              </h2>
            </div>
            <div className="space-y-3">
              {page.faq.map((item) => (
                <details
                  key={item.question}
                  className="group p-5 rounded-xl border border-white/10 bg-white/[0.02] open:bg-white/[0.04]"
                >
                  <summary className="cursor-pointer list-none text-white font-semibold">
                    {item.question}
                  </summary>
                  <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
                    {item.answer}
                  </p>
                </details>
              ))}
            </div>
          </section>
        )}

        {relatedPages.length > 0 && (
          <section className="max-w-6xl mx-auto py-20 border-t border-white/5">
            <div className="text-center mb-10">
              <h2 className="text-3xl font-bold text-white">
                Related guides
              </h2>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {relatedPages.map((related) => (
                <Link
                  key={related.href}
                  href={related.href}
                  className="p-5 rounded-xl border border-white/10 bg-white/[0.02] hover:border-cyan-500/40 hover:bg-white/[0.04] transition-all"
                >
                  <p className="text-xs text-cyan-400 uppercase tracking-widest mb-2">
                    {clusterLabel(related.cluster)}
                  </p>
                  <h3 className="text-base font-semibold text-white">
                    {related.title}
                  </h3>
                  <p className="mt-2 text-xs text-zinc-500">{related.primaryKeyword}</p>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>

      <MarketingFooter />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      )}
    </div>
  );
}
