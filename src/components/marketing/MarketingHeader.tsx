"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Menu, X } from "lucide-react";

export function MarketingHeader() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-[var(--bg-primary)]/80 backdrop-blur-xl border-b border-white/5">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 flex items-center justify-between gap-3">
        <Link href="/" aria-label="Groovy homepage">
          <Image
            src="/Groovy_no_bg.png"
            alt="Groovy"
            width={400}
            height={112}
            className="h-20 sm:h-28 w-auto -my-3 sm:-my-4"
            unoptimized
            priority
          />
        </Link>

        <div className="hidden md:flex items-center gap-2 lg:gap-4">
          <Link
            href="/integrations"
            className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors"
          >
            Integrations
          </Link>
          <Link
            href="/#pricing"
            className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors"
          >
            Pricing
          </Link>
          <Link
            href="/setup"
            className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors"
          >
            Setup
          </Link>
          <Link
            href="/login"
            className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors"
          >
            Sign in
          </Link>
          <Link
            href="/dashboard"
            className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium text-sm shadow-lg shadow-cyan-500/25 hover:shadow-cyan-500/40 transition-all"
          >
            Get Started
          </Link>
        </div>

        <div className="md:hidden flex items-center gap-2">
          <Link
            href="/dashboard"
            className="px-3 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium text-xs shadow-lg shadow-cyan-500/20"
          >
            Start
          </Link>
          <button
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileMenuOpen}
            className="w-10 h-10 rounded-lg border border-white/10 bg-white/[0.03] text-zinc-200 flex items-center justify-center"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <nav className="md:hidden border-t border-white/5 bg-zinc-950/95 backdrop-blur-xl">
          <div className="px-4 py-3 grid grid-cols-2 gap-2">
            {[
              { label: "Integrations", href: "/integrations" },
              { label: "Pricing", href: "/#pricing" },
              { label: "Setup", href: "/setup" },
              { label: "Sign in", href: "/login" },
            ].map((item) => (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className="px-3 py-3 rounded-lg border border-white/10 bg-white/[0.03] text-sm font-medium text-zinc-200 hover:bg-white/[0.06] transition-colors"
              >
                {item.label}
              </Link>
            ))}
          </div>
        </nav>
      )}
    </header>
  );
}
