"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { getBrandName } from "@/lib/config/appConfig";

export function AppNav({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  const items = [
    {
      href: "/dashboard",
      label: "Command Center",
      active: pathname.startsWith("/dashboard"),
    },
    { href: "/chat", label: "Chat", active: pathname.startsWith("/chat") },
    {
      href: "/settings",
      label: "Settings",
      active: pathname.startsWith("/settings"),
    },
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
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
