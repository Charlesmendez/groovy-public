"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings2 } from "lucide-react";
import { getBrandName } from "@/lib/config/appConfig";

export function AppNav({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  const items: Array<{
    href: string;
    label: string;
    shortLabel: string;
    active: boolean;
    icon?: typeof Settings2;
  }> = [
    {
      href: "/dashboard",
      label: "Command Center",
      shortLabel: "Ops",
      active: pathname.startsWith("/dashboard"),
    },
    { href: "/chat", label: "Chat", shortLabel: "Chat", active: pathname.startsWith("/chat") },
    {
      href: "/settings",
      label: "Settings",
      shortLabel: "Settings",
      active: pathname.startsWith("/settings") || pathname.startsWith("/account"),
      icon: Settings2,
    },
  ];
  return (
    <nav
      aria-label={`${getBrandName()} areas`}
      className="flex items-center rounded-lg border border-white/10 bg-black/20 p-0.5"
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
              item.active
                ? "bg-white/10 text-white"
                : "text-zinc-500 hover:text-zinc-200"
            } ${compact ? "px-2" : ""}`}
            aria-label={item.label}
            title={item.label}
          >
            {Icon ? (
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : null}
            <span className={compact && Icon ? "sr-only" : "hidden sm:inline"}>
              {item.label}
            </span>
            <span className={compact && Icon ? "sr-only" : "sm:hidden"}>
              {item.shortLabel}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
