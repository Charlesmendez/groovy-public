import Link from "next/link";
import type { ReactNode } from "react";

const navItems = [
  ["License", "/account/license"],
  ["Downloads", "/account/downloads"],
  ["Source", "/account/source"],
  ["Devices", "/account/devices"],
  ["Billing", "/account/billing"],
];

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-10 overflow-y-auto bg-zinc-950 text-white">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/dashboard" className="text-sm font-semibold text-white hover:text-cyan-200">
            Groovy Account
          </Link>
          <nav className="flex flex-wrap gap-2 text-sm">
            {navItems.map(([label, href]) => (
              <Link
                key={href}
                href={href}
                className="rounded-lg border border-white/10 px-3 py-2 text-zinc-300 hover:bg-white/10 hover:text-white"
              >
                {label}
              </Link>
            ))}
            <Link
              href="/dashboard"
              className="rounded-lg bg-cyan-400 px-3 py-2 font-semibold text-zinc-950 hover:bg-cyan-300"
            >
              Dashboard
            </Link>
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
