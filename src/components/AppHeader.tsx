"use client";

import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  CalendarClock,
  Ellipsis,
  FileText,
  LoaderCircle,
  Plug,
  RefreshCw,
  Settings,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppNav } from "@/components/AppNav";
import { WorkspaceSwitcher } from "@/components/workspaces/WorkspaceSwitcher";
import { useDesktopUpdater } from "@/hooks/useDesktopUpdater";
import { isDesktopShell } from "@/lib/desktop/shell";
import { MIN_CONNECTOR_VERSION } from "@/lib/connector/version";
import { useConnectorInstallGuide } from "@/lib/connector/installGuide";

type HeaderDevice = {
  connectorOnline: boolean;
  relayConnected: boolean;
  connectorVersion: string | null;
  connectorOutdated: boolean;
  supportsInPlaceUpdate: boolean;
  capabilities: {
    managedByDesktop?: boolean | null;
  };
  refresh(): void;
  updateConnector(): void;
};

type HeaderAction = {
  label: string;
  icon: LucideIcon;
  href?: string;
  onClick?: () => void;
};

function HeaderActionControl({
  action,
  menu = false,
  onUsed,
}: {
  action: HeaderAction;
  menu?: boolean;
  onUsed?: () => void;
}) {
  const Icon = action.icon;
  const className = menu
    ? "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
    : "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition hover:bg-white/[0.06] hover:text-white";
  const content = (
    <>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {menu ? <span>{action.label}</span> : <span className="sr-only">{action.label}</span>}
    </>
  );

  if (action.href) {
    return (
      <Link
        href={action.href}
        className={className}
        title={action.label}
        onClick={onUsed}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      className={className}
      title={action.label}
      onClick={() => {
        action.onClick?.();
        onUsed?.();
      }}
    >
      {content}
    </button>
  );
}

export function AppHeader({
  device,
  workspaceName = "Workspace",
  switchDestination,
  onOpenPlans,
  onOpenSchedules,
  onOpenSettings,
  onOpenConnector,
  endControls,
}: {
  device: HeaderDevice;
  workspaceName?: string;
  switchDestination: string;
  onOpenPlans?: () => void;
  onOpenSchedules?: () => void;
  onOpenSettings?: () => void;
  onOpenConnector?: () => void;
  endControls?: ReactNode;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const connectorGuide = useConnectorInstallGuide();
  const desktopManaged =
    device.capabilities.managedByDesktop === true || isDesktopShell();
  const desktopUpdater = useDesktopUpdater({
    autoCheckKey:
      device.connectorOutdated && desktopManaged
        ? `${device.connectorVersion || "unknown"}:${MIN_CONNECTOR_VERSION}`
        : null,
    requiredVersion: device.connectorOutdated
      ? MIN_CONNECTOR_VERSION
      : null,
  });
  const desktopStatus = desktopUpdater.status;

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        moreRef.current &&
        !moreRef.current.contains(event.target as Node)
      ) {
        setMoreOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  const actions: HeaderAction[] = [
    {
      label: "Plans",
      icon: FileText,
      ...(onOpenPlans
        ? { onClick: onOpenPlans }
        : { href: "/dashboard?panel=plans" }),
    },
    {
      label: "Skills & Docs",
      icon: BookOpen,
      href: "/settings/skills",
    },
    {
      label: "Integrations",
      icon: Plug,
      href: "/settings/integrations",
    },
    {
      label: "Schedules",
      icon: CalendarClock,
      ...(onOpenSchedules
        ? { onClick: onOpenSchedules }
        : { href: "/dashboard?panel=schedules" }),
    },
    {
      label: "Usage & cost",
      icon: BarChart3,
      href: "/settings/usage",
    },
    {
      label: "Settings",
      icon: Settings,
      ...(onOpenSettings
        ? { onClick: onOpenSettings }
        : { href: "/dashboard?panel=settings" }),
    },
  ];

  const openConnectorSettings = () => {
    device.refresh();
    if (onOpenConnector) onOpenConnector();
    else window.location.assign("/dashboard?panel=settings&section=connector");
  };

  const desktopUpdateBusy =
    desktopUpdater.desktop &&
    (desktopStatus?.state === "checking" ||
      desktopStatus?.state === "available" ||
      desktopStatus?.state === "downloading");
  const desktopUpdateReady =
    desktopUpdater.desktop && desktopStatus?.state === "ready";
  const desktopUpdateFailed =
    desktopUpdater.desktop &&
    (desktopStatus?.state === "error" || Boolean(desktopUpdater.checkFeedback));
  const showConnectorUpdate =
    device.connectorOutdated &&
    !desktopUpdateBusy &&
    !desktopUpdateReady &&
    !desktopUpdateFailed;

  return (
    <header className="relative z-30 shrink-0 border-b border-white/[0.07] bg-[var(--bg-primary)]/92 backdrop-blur-xl">
      <div className="flex h-[var(--app-header-height)] min-w-0 items-center gap-2 px-3 sm:px-4">
        <Link
          href="/dashboard"
          className="hidden h-9 w-[72px] shrink-0 items-center justify-start rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/30 min-[360px]:flex"
          aria-label="Open Groovy Command Center"
        >
          <Image
            src="/Groovy_no_bg.png"
            alt="Groovy"
            width={140}
            height={40}
            className="h-9 w-auto max-w-[72px] object-contain"
            unoptimized
            priority
          />
        </Link>

        <AppNav />

        <div className="min-w-0 shrink sm:max-w-48">
          <WorkspaceSwitcher
            compact
            fallbackName={workspaceName}
            switchDestination={switchDestination}
            showPendingGate={false}
          />
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={openConnectorSettings}
            className={`hidden h-9 shrink-0 items-center gap-2 rounded-xl border px-2.5 text-xs transition min-[340px]:flex ${
              device.connectorOnline
                ? "border-emerald-400/15 bg-emerald-400/[0.07] text-emerald-300"
                : device.relayConnected
                  ? "border-white/10 bg-white/[0.03] text-zinc-300"
                  : "border-white/[0.07] bg-white/[0.02] text-zinc-500"
            }`}
            aria-label="Open connector settings"
            title={
              device.connectorOnline
                ? `Connector online${
                    device.connectorVersion
                      ? ` · v${device.connectorVersion}`
                      : ""
                  } · Open connector settings`
                : device.relayConnected
                  ? "Connector offline · Open connector settings"
                  : "Relay offline · Open connector settings"
            }
          >
            {device.connectorOnline ? (
              <Wifi className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="hidden whitespace-nowrap min-[1120px]:inline">
              {device.connectorOnline
                ? "Online"
                : device.relayConnected
                  ? "Offline"
                  : "No relay"}
            </span>
          </button>

          {desktopUpdateBusy ? (
            <button
              type="button"
              onClick={() => void desktopUpdater.checkForUpdates()}
              className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 text-xs text-zinc-400"
              title={
                desktopStatus?.state === "checking"
                  ? "Checking for a Groovy update"
                  : `Downloading Groovy${
                      desktopStatus?.version
                        ? ` ${desktopStatus.version}`
                        : ""
                    }`
              }
            >
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              <span className="hidden whitespace-nowrap min-[1280px]:inline">
                {desktopStatus?.state === "checking"
                  ? "Checking…"
                  : `Downloading${
                      typeof desktopStatus.percent === "number"
                        ? ` ${Math.round(desktopStatus.percent)}%`
                        : "…"
                    }`}
              </span>
            </button>
          ) : desktopUpdateReady ? (
            <button
              type="button"
              onClick={() => void desktopUpdater.installUpdate()}
              className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-2.5 text-xs text-cyan-300 transition hover:bg-cyan-400/[0.13]"
              title={`Groovy${
                desktopStatus.version ? ` ${desktopStatus.version}` : ""
              } is ready. Restart to install.`}
            >
              <RefreshCw className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden whitespace-nowrap min-[1180px]:inline">
                Restart to update
              </span>
            </button>
          ) : desktopUpdateFailed ? (
            <button
              type="button"
              onClick={() => void desktopUpdater.checkForUpdates()}
              className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-red-400/20 bg-red-400/[0.06] px-2.5 text-xs text-red-300"
              title={
                desktopUpdater.checkFeedback ||
                (desktopStatus?.state === "error"
                  ? desktopStatus.error
                  : null) ||
                "Desktop update check failed"
              }
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden whitespace-nowrap min-[1280px]:inline">
                {desktopUpdater.checkFeedback ? "Check again" : "Retry update"}
              </span>
            </button>
          ) : null}

          {showConnectorUpdate ? (
            desktopManaged ? (
              <button
                type="button"
                onClick={() => {
                  if (desktopUpdater.desktop) {
                    void desktopUpdater.checkForUpdates();
                  } else {
                    openConnectorSettings();
                  }
                }}
                className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.07] px-2.5 text-xs text-amber-300"
                title="A newer Groovy Desktop version is required"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden whitespace-nowrap min-[1280px]:inline">
                  Update Groovy
                </span>
              </button>
            ) : device.supportsInPlaceUpdate ? (
              <button
                type="button"
                onClick={device.updateConnector}
                className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.07] px-2.5 text-xs text-amber-300"
                title={`Update Connector to v${MIN_CONNECTOR_VERSION}`}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden whitespace-nowrap min-[1280px]:inline">
                  Update Connector
                </span>
              </button>
            ) : (
              <a
                href={connectorGuide.downloadUrl}
                className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.07] px-2.5 text-xs text-amber-300"
                title={`Download Connector v${MIN_CONNECTOR_VERSION}`}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden whitespace-nowrap min-[1280px]:inline">
                  Download update
                </span>
              </a>
            )
          ) : null}

          <div className="hidden items-center min-[1240px]:flex">
            {actions.map((action) => (
              <HeaderActionControl key={action.label} action={action} />
            ))}
          </div>

          <div ref={moreRef} className="relative min-[1240px]:hidden">
            <button
              type="button"
              onClick={() => setMoreOpen((value) => !value)}
              className={`flex h-9 w-9 items-center justify-center rounded-xl transition ${
                moreOpen
                  ? "bg-white/[0.08] text-white"
                  : "text-zinc-500 hover:bg-white/[0.06] hover:text-white"
              }`}
              aria-label="More Groovy actions"
              aria-expanded={moreOpen}
            >
              <Ellipsis className="h-4 w-4" />
            </button>
            {moreOpen ? (
              <div className="absolute right-0 top-11 z-50 w-56 rounded-xl border border-white/10 bg-[#111318] p-1.5 shadow-2xl shadow-black/50">
                {actions.map((action) => (
                  <HeaderActionControl
                    key={action.label}
                    action={action}
                    menu
                    onUsed={() => setMoreOpen(false)}
                  />
                ))}
              </div>
            ) : null}
          </div>

          {endControls ? (
            <div className="ml-0.5 flex shrink-0 items-center">{endControls}</div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
