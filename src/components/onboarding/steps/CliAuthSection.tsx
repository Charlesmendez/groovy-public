"use client";

/**
 * CliAuthSection — install and authenticate either supported coding harness
 * on the connector machine.
 */

import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Terminal } from "lucide-react";
import { useConnectorInstallGuide } from "@/lib/connector/installGuide";

type CliAuthSectionProps = {
  claudeInstalled?: boolean | null;
  codexInstalled?: boolean | null;
  connectorVersion?: string | null;
  codexDetectionUnavailable?: boolean;
  onUpdateConnector?: () => void;
};

function CommandBlock({ command }: { command: string }) {
  return (
    <div className="relative group">
      <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-black/60 border border-white/10 font-mono text-sm text-cyan-300 overflow-x-auto">
        <Terminal className="w-4 h-4 text-zinc-500 shrink-0" />
        <code>{command}</code>
      </div>
      <button
        type="button"
        aria-label={`Copy ${command}`}
        onClick={() => navigator.clipboard.writeText(command)}
        className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 rounded-lg text-xs text-zinc-500 hover:text-white bg-white/5 hover:bg-white/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function InstallState({
  installed,
  unknownLabel,
}: {
  installed?: boolean | null;
  unknownLabel?: string;
}) {
  if (installed === true) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
        <CheckCircle2 className="h-3 w-3" /> Detected
      </span>
    );
  }
  if (installed === false) {
    return (
      <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
        Not installed
      </span>
    );
  }
  if (unknownLabel) {
    return (
      <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
        {unknownLabel}
      </span>
    );
  }
  return null;
}

export function CliAuthSection({
  claudeInstalled,
  codexInstalled,
  connectorVersion,
  codexDetectionUnavailable = false,
  onUpdateConnector,
}: CliAuthSectionProps) {
  const connectorGuide = useConnectorInstallGuide();

  const installCommand =
    connectorGuide.platform === "windows"
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";

  return (
    <div className="bg-zinc-900/80 border border-white/10 rounded-2xl p-6 space-y-5">
      <div>
        <h3 className="text-sm font-medium text-white">Choose your coding harness</h3>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          Worker agents run through Claude Code or Codex CLI on the machine running the connector.
          Install the harnesses you plan to assign to agents. Codex can be your coding harness, but
          Claude Code is still required for Groovy&apos;s local computer-browser tasks.
        </p>
      </div>

      <div className="flex gap-3 rounded-xl border border-orange-500/25 bg-orange-500/10 p-4">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orange-300" />
        <div>
          <p className="text-xs font-medium text-orange-100">Claude Code is required for browser automation</p>
          <p className="mt-1 text-[11px] leading-relaxed text-orange-100/70">
            Groovy&apos;s computer-browser tasks use Claude Code with Playwright on this connector
            machine. If Claude Code is not installed and authenticated, login-required browser work
            such as navigating Schwab will not run—even when the Orchestrator or your coding agents
            use an OpenAI model.
          </p>
        </div>
      </div>

      {codexDetectionUnavailable && (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 sm:flex-row sm:items-center">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" />
          <p className="flex-1 text-xs leading-relaxed text-amber-100/90">
            Connector {connectorVersion ? `v${connectorVersion}` : "version unknown"} cannot report
            whether Codex CLI is installed. Update the connector, then it will detect Codex after
            reconnecting.
          </p>
          {onUpdateConnector && (
            <button
              type="button"
              onClick={onUpdateConnector}
              className="shrink-0 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-400/20"
            >
              Update connector
            </button>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Terminal className="h-4 w-4 text-orange-300" />
            <h3 className="text-sm font-medium text-white">Claude Code</h3>
            <div className="ml-auto"><InstallState installed={claudeInstalled} /></div>
          </div>
          <p className="mb-2 text-xs font-medium text-zinc-300">1. Install</p>
          <CommandBlock command={installCommand} />
          <p className="mb-2 mt-4 text-xs font-medium text-zinc-300">2. Create a headless token</p>
          <CommandBlock command="claude setup-token" />
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            Paste the generated token in Settings → API Keys → Claude CLI so Groovy can run Claude
            Code without an interactive browser login.
          </p>
          <p className="mt-3 rounded-lg border border-orange-500/20 bg-orange-500/[0.07] px-3 py-2 text-[11px] leading-relaxed text-orange-200/80">
            Required for computer-browser tasks. Without Claude Code, Groovy cannot run the local
            Playwright browser operator.
          </p>
          <a
            href="https://code.claude.com/docs/en/overview"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-cyan-300"
          >
            Claude Code documentation <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Terminal className="h-4 w-4 text-emerald-300" />
            <h3 className="text-sm font-medium text-white">Codex CLI</h3>
            <div className="ml-auto">
              <InstallState
                installed={codexInstalled}
                unknownLabel={codexDetectionUnavailable ? "Update required" : undefined}
              />
            </div>
          </div>
          <p className="mb-2 text-xs font-medium text-zinc-300">1. Install</p>
          <CommandBlock command="npm install -g @openai/codex" />
          <p className="mb-2 mt-4 text-xs font-medium text-zinc-300">2. Sign in</p>
          <CommandBlock command="codex login" />
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            Choose ChatGPT sign-in for subscription access, or an OpenAI API key for usage-based
            access. Codex caches the login on this machine, and Groovy reuses it for local runs.
          </p>
          <a
            href="https://developers.openai.com/codex/cli"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-cyan-300"
          >
            Codex CLI documentation <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}
