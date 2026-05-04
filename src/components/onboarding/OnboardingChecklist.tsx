"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Download, ExternalLink, MessageSquare, Smartphone } from "lucide-react";
import { useConnectorInstallGuide } from "@/lib/connector/installGuide";

type Step = {
  id: string;
  title: string;
  description: string;
  done: boolean;
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  extra?: ReactNode;
};

type ConnectorWhatsAppHealth = {
  status?: "healthy" | "degraded" | "recovering" | "disabled" | "unknown";
  reason?: string;
  detail?: string;
};

export function OnboardingChecklist({
  connectorOk,
  connectorOnline,
  connectorWhatsAppHealth,
  chatAgentsCount,
  onOpenConnectorMenu,
  onOpenChatAgentCreate,
  onOpenObsidian,
  onOpenFiles,
}: {
  connectorOk: boolean;
  connectorOnline: boolean;
  connectorWhatsAppHealth?: ConnectorWhatsAppHealth | null;
  chatAgentsCount: number;
  onOpenConnectorMenu: () => void;
  onOpenChatAgentCreate: () => void;
  onOpenObsidian: () => void;
  onOpenFiles: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const connectorGuide = useConnectorInstallGuide();

  useEffect(() => {
    let t: number | null = null;
    try {
      const v = window.localStorage.getItem("groovy:onboarding:dismissed");
      // Avoid synchronous setState-in-effect (eslint rule); schedule async.
      if (v === "1") t = window.setTimeout(() => setDismissed(true), 0);
    } catch {
      // ignore
    }
    return () => {
      if (t) window.clearTimeout(t);
    };
  }, []);

  const steps: Step[] = useMemo(() => {
    // For onboarding, just check if connector is connected
    // (version update is a separate soft nag in Settings, not an onboarding blocker)
    const connectorDone = connectorOk && connectorOnline;
    const chatDone = chatAgentsCount > 0;
    const waStatus = connectorWhatsAppHealth?.status || "unknown";
    const waDetail =
      connectorWhatsAppHealth?.detail ||
      connectorWhatsAppHealth?.reason ||
      "";
    const waStatusText = !connectorDone
      ? "WhatsApp bridge: waiting for connector"
      : waStatus === "healthy"
        ? "WhatsApp bridge: healthy"
        : waStatus === "recovering"
          ? "WhatsApp bridge: recovering..."
          : waStatus === "degraded"
            ? "WhatsApp bridge: degraded"
            : waStatus === "disabled"
              ? "WhatsApp bridge: disabled in connector config"
              : "WhatsApp bridge: status pending";

    return [
      {
        id: "connector",
        title: "Install Groovy Connector + test",
        description:
          "This is what makes Browser / Files / Obsidian (and WhatsApp) run on your machine.",
        done: connectorDone,
        actionLabel: "Open connector setup",
        onAction: onOpenConnectorMenu,
        extra: (
          <div className="text-[11px] text-zinc-500">
            Download:{" "}
            <a className="underline hover:text-zinc-300" href={connectorGuide.downloadUrl}>
              {connectorGuide.downloadFileLabel}
            </a>
          </div>
        ),
      },
      {
        id: "whatsapp",
        title: "Connect WhatsApp (optional, but the magic)",
        description:
          "Start the connector with WhatsApp enabled, then message Groovy from a group.",
        done: connectorOk && connectorOnline,
        actionLabel: "See connector setup",
        onAction: onOpenConnectorMenu,
        extra: (
          <div className="text-[11px] text-zinc-500 space-y-1">
            <div
              className={
                waStatus === "degraded"
                  ? "text-amber-300"
                  : waStatus === "recovering"
                    ? "text-yellow-300"
                    : waStatus === "healthy"
                      ? "text-emerald-300"
                      : "text-zinc-500"
              }
            >
              {waStatusText}
            </div>
            {!!waDetail && (
              <div className="text-zinc-500 truncate">{waDetail}</div>
            )}
            <div>Test in WhatsApp group: <span className="text-zinc-300 font-mono">@orch hello</span></div>
            <div className="text-zinc-600">
              If Groovy says &quot;use @code&quot;, try{" "}
              <span className="font-mono text-zinc-400">@code ls</span>
            </div>
          </div>
        ),
      },
      {
        id: "quickwin",
        title: "Quick win: create your first AI Chat agent",
        description:
          "Make a GPT‑4o chat agent (or NanoBanana) and start chatting right away.",
        done: chatDone,
        actionLabel: "Create AI Chat agent",
        onAction: onOpenChatAgentCreate,
        secondaryLabel: "Open Obsidian setup",
        onSecondary: onOpenObsidian,
        extra: (
          <div className="text-[11px] text-zinc-500">
            You can also create a Files Agent for docs:{" "}
            <button type="button" onClick={onOpenFiles} className="underline hover:text-zinc-300">
              open Files setup
            </button>
          </div>
        ),
      },
    ];
  }, [
    chatAgentsCount,
    connectorOk,
    connectorOnline,
    connectorWhatsAppHealth?.status,
    connectorWhatsAppHealth?.reason,
    connectorWhatsAppHealth?.detail,
    onOpenChatAgentCreate,
    onOpenConnectorMenu,
    onOpenFiles,
    onOpenObsidian,
    connectorGuide.downloadFileLabel,
    connectorGuide.downloadUrl,
  ]);

  const completedCount = steps.filter((s) => s.done).length;
  const waStatus = connectorWhatsAppHealth?.status || "unknown";
  // Once connector + WhatsApp are healthy, don't keep the onboarding checklist
  // pinned just because optional "quick win" items are incomplete.
  const connectorAndWhatsAppHealthy =
    connectorOk && connectorOnline && waStatus === "healthy";
  const show =
    !dismissed &&
    !connectorAndWhatsAppHealthy &&
    completedCount < steps.length;
  if (!show) return null;

  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/40 overflow-hidden">
      <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
            <Check className="w-5 h-5 text-cyan-300" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white">Getting started</div>
            <div className="text-xs text-zinc-500">
              {completedCount}/{steps.length} done — your command center in minutes
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
            title="Toggle"
          >
            <ChevronDown className={`w-5 h-5 transition-transform ${collapsed ? "rotate-180" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => {
              setDismissed(true);
              try {
                window.localStorage.setItem("groovy:onboarding:dismissed", "1");
              } catch {
                // ignore
              }
            }}
            className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 transition-colors text-xs"
          >
            Dismiss
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="p-5 grid md:grid-cols-2 gap-3">
          {steps.map((s) => (
            <div
              key={s.id}
              className={`p-4 rounded-2xl border transition-colors ${
                s.done ? "bg-emerald-500/5 border-emerald-500/15" : "bg-black/30 border-white/10"
              } ${s.id === "quickwin" ? "md:col-span-2" : ""}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-5 h-5 rounded-full flex items-center justify-center border ${
                        s.done ? "bg-emerald-500/20 border-emerald-500/30" : "bg-white/5 border-white/10"
                      }`}
                    >
                      {s.done && <Check className="w-3.5 h-3.5 text-emerald-300" />}
                    </div>
                    <div className="text-sm font-medium text-white">{s.title}</div>
                  </div>
                  <div className="text-xs text-zinc-500 mt-1">{s.description}</div>
                  {s.extra && <div className="mt-2">{s.extra}</div>}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {s.actionLabel && s.onAction && (
                  <button
                    type="button"
                    onClick={s.onAction}
                    className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 transition-colors text-xs"
                  >
                    {s.id === "connector" && <Download className="inline w-3.5 h-3.5 mr-1.5 text-zinc-400" />}
                    {s.id === "whatsapp" && <Smartphone className="inline w-3.5 h-3.5 mr-1.5 text-zinc-400" />}
                    {s.id === "quickwin" && <MessageSquare className="inline w-3.5 h-3.5 mr-1.5 text-zinc-400" />}
                    {s.actionLabel}
                  </button>
                )}
                {s.secondaryLabel && s.onSecondary && (
                  <button
                    type="button"
                    onClick={s.onSecondary}
                    className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 transition-colors text-xs"
                  >
                    {s.secondaryLabel}
                  </button>
                )}
                {s.id === "connector" && (
                  <a
                    href={connectorGuide.downloadUrl}
                    className="px-3 py-2 rounded-xl bg-cyan-500/15 border border-cyan-500/20 text-cyan-200 hover:bg-cyan-500/20 transition-colors text-xs inline-flex items-center gap-2"
                  >
                    {connectorGuide.ctaLabel}
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

