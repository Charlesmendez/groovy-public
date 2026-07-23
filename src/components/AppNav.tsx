"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { getBrandName } from "@/lib/config/appConfig";

export function AppNav({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  // Surface switcher only (Command Center | Chat). Settings deliberately
  // lives once — behind the gear in the Command Center header (/settings) —
  // instead of being duplicated here.
  const items = [
    {
      href: "/dashboard",
      label: "Command Center",
      shortLabel: "Ops",
      active: pathname.startsWith("/dashboard"),
    },
    { href: "/chat", label: "Chat", shortLabel: "Chat", active: pathname.startsWith("/chat") },
  ];
  return (
    <nav
      aria-label={`${getBrandName()} areas`}
      className="flex items-center rounded-lg border border-white/10 bg-black/20 p-0.5"
    >
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
            item.active
              ? "bg-white/10 text-white"
              : "text-zinc-500 hover:text-zinc-200"
          } ${compact ? "px-2" : ""}`}
        >
          <span className="hidden sm:inline">{item.label}</span>
          <span className="sm:hidden">{item.shortLabel}</span>
        </Link>
      ))}
    </nav>
  );
}
