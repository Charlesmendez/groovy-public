"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppNav } from "@/components/AppNav";

const items = [
  { href: "/settings", label: "Overview", exact: true },
  { href: "/settings/minds", label: "Minds" },
  { href: "/settings/skills", label: "Skills & Docs" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/team", label: "People & Access" },
  { href: "/settings/api", label: "API & Widget" },
  { href: "/settings/usage", label: "Usage" },
];

export function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="min-h-screen bg-[#08090b] text-white">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#08090b]/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div>
            <h1 className="text-sm font-semibold">Workspace settings</h1>
            <p className="text-[11px] text-zinc-500">
              One configuration shared by Command Center, Chat, messaging, and
              published endpoints.
            </p>
          </div>
          <AppNav compact />
        </div>
        <nav
          aria-label="Settings sections"
          className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 sm:px-6"
        >
          {items.map((item) => {
            const active = item.exact
              ? pathname === item.href
              : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs transition ${
                  active
                    ? "bg-white/10 text-white"
                    : "text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      {children}
    </div>
  );
}
