"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Bell,
  Blocks,
  Bot,
  Braces,
  ChevronRight,
  Hash,
  LayoutGrid,
  Settings2,
  Users,
} from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { WorkspaceSwitcher } from "@/components/workspaces/WorkspaceSwitcher";

const items = [
  {
    href: "/settings",
    label: "Overview",
    description: "Your workspace at a glance",
    exact: true,
    icon: LayoutGrid,
  },
  {
    href: "/settings/channels",
    label: "Channels",
    description: "Minds, prompts, and access",
    icon: Hash,
  },
  {
    href: "/settings/notifications",
    label: "Notifications",
    description: "Channel and DM alerts",
    icon: Bell,
  },
  {
    href: "/settings/minds",
    label: "Minds",
    description: "Identity, models, and policy",
    icon: Bot,
  },
  {
    href: "/settings/skills",
    label: "Skills & Docs",
    description: "Reusable workspace context",
    icon: Blocks,
  },
  {
    href: "/settings/integrations",
    label: "Integrations",
    description: "Data and connected services",
    icon: Settings2,
  },
  {
    href: "/settings/team",
    label: "People & Access",
    description: "Members, guests, and invites",
    icon: Users,
  },
  {
    href: "/settings/api",
    label: "API & Widget",
    description: "Endpoints and embed access",
    icon: Braces,
  },
  {
    href: "/settings/usage",
    label: "Usage",
    description: "Workspace consumption",
    icon: BarChart3,
  },
] as const;

function isItemActive(
  pathname: string,
  item: (typeof items)[number],
): boolean {
  return "exact" in item && item.exact === true
    ? pathname === item.href
    : pathname.startsWith(item.href);
}

export function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const activeItem =
    items.find((item) => isItemActive(pathname, item)) || items[0];

  return (
    <div className="app-scroll-page min-h-0 bg-[#08090b] text-white">
      <WorkspaceSwitcher
        modalOnly
        fallbackName="Workspace"
        switchDestination={pathname}
      />
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#08090b]/95 backdrop-blur-xl">
        <div className="mx-auto flex min-h-16 max-w-[1440px] items-center gap-3 px-4 py-3 sm:px-6">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-400">
            <Settings2 className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">
              Workspace settings
            </h1>
            <p className="hidden truncate text-[11px] text-zinc-500 sm:block">
              Shared by Command Center, Chat, messaging, and published
              endpoints.
            </p>
            <p className="truncate text-[11px] text-zinc-500 sm:hidden">
              {activeItem.label}
            </p>
          </div>
          <WorkspaceSwitcher
            align="right"
            compact
            fallbackName="Workspace"
            switchDestination={pathname}
            showPendingGate={false}
          />
          <AppNav compact />
        </div>
        <div className="border-t border-white/[0.06] px-4 py-2.5 lg:hidden">
          <CustomSelect
            value={activeItem.href}
            onChange={(href) => router.push(href)}
            options={items.map((item) => ({
              value: item.href,
              label: item.label,
              description: item.description,
            }))}
            size="sm"
            ariaLabel="Settings section"
            triggerClassName="bg-white/[0.025]"
          />
        </div>
      </header>

      <div className="mx-auto flex w-full min-w-0 max-w-[1440px] items-start">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-64 shrink-0 border-r border-white/10 px-4 py-6 lg:flex lg:flex-col">
          <div className="px-2 pb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-600">
            Workspace
          </div>
          <nav className="space-y-1" aria-label="Settings sections">
            {items.map((item) => {
              const active = isItemActive(pathname, item);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 transition ${
                    active
                      ? "bg-white/[0.08] text-white"
                      : "text-zinc-500 hover:bg-white/[0.035] hover:text-zinc-200"
                  }`}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      active ? "text-cyan-300" : ""
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{item.label}</span>
                    <span className="mt-0.5 block truncate text-[9px] text-zinc-600">
                      {item.description}
                    </span>
                  </span>
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 transition ${
                      active
                        ? "text-zinc-500"
                        : "text-zinc-700 opacity-0 group-hover:opacity-100"
                    }`}
                  />
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
            <p className="text-[10px] font-medium text-zinc-400">
              One workspace, every surface
            </p>
            <p className="mt-1 text-[9px] leading-relaxed text-zinc-600">
              Channel settings specialize a Mind without weakening its
              workspace permissions.
            </p>
          </div>
        </aside>

        <div className="min-w-0 flex-1 overflow-x-hidden">{children}</div>
      </div>
    </div>
  );
}
