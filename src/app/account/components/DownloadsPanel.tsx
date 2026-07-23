"use client";

import { ArrowRight, Check, Download, Laptop, Terminal } from "lucide-react";
import { ArtifactList, ErrorState, LoadingState } from "./common";
import { useDownloadsStatus } from "./useAccountData";
import type { Artifact } from "./types";
import { useConnectorInstallGuide } from "@/lib/connector/installGuide";

export function DownloadsPanel() {
  const { data, loading, error } = useDownloadsStatus();
  const connectorGuide = useConnectorInstallGuide();
  if (loading) return <LoadingState label="Loading downloads..." />;
  if (error === "Unauthorized") return <DownloadAccessPrompt kind="downloads" href="/account/downloads" />;
  if (error) return <ErrorState error={error} />;
  if (!data?.licensed && !data?.hasAccess) {
    return <DownloadAccessPrompt kind="downloads" href="/account/downloads" />;
  }
  if (data.canReceiveUpdates === false) {
    return <p className="mt-6 text-sm text-zinc-400">{data.message || "This license cannot access new downloads."}</p>;
  }
  const downloads = data.downloads || [];
  const desktop = downloads.find((item) => item.platform === "macos-desktop") || null;
  const standalone = downloads.filter(
    (item) => item.platform !== "macos-desktop" && item.platform !== "macos-desktop-zip"
  );

  return (
    <InstallerDownloads
      desktop={desktop}
      standalone={standalone}
      platform={connectorGuide.platform}
    />
  );
}

function InstallerDownloads({
  desktop,
  standalone,
  platform,
}: {
  desktop: Artifact | null;
  standalone: Artifact[];
  platform: "macos" | "windows" | "unknown";
}) {
  if (platform === "windows") {
    const windowsInstaller = standalone.find((item) => item.platform === "windows") || null;
    return (
      <div className="mt-8 space-y-8">
        <section aria-labelledby="windows-download-heading">
          <div className="mb-3 flex items-center gap-2">
            <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">
              Windows
            </span>
            <span className="text-xs text-zinc-500">Groovy Desktop is currently macOS-only</span>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-zinc-300">
                <Terminal className="h-6 w-6" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="windows-download-heading" className="text-lg font-semibold text-white">
                  Groovy Connector for Windows
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-zinc-400">
                  Install the connector, open it from the Start Menu, and enter the pairing code
                  shown in Groovy onboarding.
                </p>
              </div>
              {windowsInstaller?.file_url ? (
                <a
                  href={windowsInstaller.file_url}
                  className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-cyan-400 px-4 text-sm font-semibold text-zinc-950 transition-colors hover:bg-cyan-300"
                >
                  <Download className="h-4 w-4" /> Download installer
                </a>
              ) : (
                <span className="shrink-0 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs font-medium text-amber-200">
                  Release not available yet
                </span>
              )}
            </div>
          </div>
        </section>
        <a
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-300 transition-colors hover:text-cyan-200"
        >
          Return to setup <ArrowRight className="h-3.5 w-3.5" />
        </a>
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-8">
      <section aria-labelledby="recommended-download-heading">
        <div className="mb-3 flex items-center gap-2">
          <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">
            Recommended
          </span>
          <span className="text-xs text-zinc-500">One app includes everything you need</span>
        </div>

        <div className="overflow-hidden rounded-lg border border-cyan-400/25 bg-cyan-400/[0.06]">
          <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
              <Laptop className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="recommended-download-heading" className="text-lg font-semibold text-white">
                Groovy Desktop for macOS
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-zinc-400">
                Includes the Groovy app and the connector that runs agents locally. Do not install
                the standalone connector when you use Groovy Desktop.
              </p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
                <span className="flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-emerald-400" /> Signed and notarized
                </span>
                <span className="flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-emerald-400" /> Connector included
                </span>
                <span>macOS 12+ · Apple Silicon</span>
              </div>
            </div>
            {desktop?.file_url ? (
              <a
                href={desktop.file_url}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-cyan-400 px-4 text-sm font-semibold text-zinc-950 transition-colors hover:bg-cyan-300"
              >
                <Download className="h-4 w-4" />
                Download DMG
              </a>
            ) : (
              <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                <span className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs font-medium text-amber-200">
                  Desktop release coming soon
                </span>
                <a
                  href="#standalone-connector"
                  className="text-xs font-medium text-cyan-300 transition-colors hover:text-cyan-200"
                >
                  Use the standalone connector instead
                </a>
              </div>
            )}
          </div>

          <div className="grid border-t border-white/[0.07] bg-black/20 sm:grid-cols-3">
            {[
              ["1", "Open the DMG"],
              ["2", "Drag Groovy to Applications"],
              ["3", "Open Groovy and sign in"],
            ].map(([number, label], index) => (
              <div
                key={number}
                className={`flex items-center gap-2 px-4 py-3 text-xs text-zinc-400 ${
                  index > 0 ? "border-t border-white/[0.06] sm:border-l sm:border-t-0" : ""
                }`}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-white/[0.06] text-[10px] font-semibold text-zinc-300">
                  {number}
                </span>
                {label}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="standalone-connector"
        aria-labelledby="advanced-download-heading"
        className="scroll-mt-6 border-t border-white/10 pt-6"
      >
        <div className="flex items-start gap-3">
          <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          <div>
            <h2 id="advanced-download-heading" className="text-sm font-medium text-zinc-200">
              Advanced: standalone connector
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              Use this only for a headless machine or when you do not want the Groovy Desktop app.
              It requires manual pairing. It is an alternative to Desktop, not an additional install.
            </p>
          </div>
        </div>

        {standalone.length > 0 ? (
          <ArtifactList items={standalone} kind="download" />
        ) : (
          <p className="mt-4 text-xs text-zinc-600">No standalone installers are available.</p>
        )}

        <a
          href="/dashboard"
          className="mt-5 inline-flex items-center gap-1.5 text-xs font-medium text-cyan-300 transition-colors hover:text-cyan-200"
        >
          Return to setup <ArrowRight className="h-3.5 w-3.5" />
        </a>
      </section>
    </div>
  );
}

export function SourceSnapshotsPanel() {
  const { data, loading, error } = useDownloadsStatus();
  if (loading) return <LoadingState label="Loading source snapshots..." />;
  if (error === "Unauthorized") return <DownloadAccessPrompt kind="source snapshots" href="/account/source" />;
  if (error) return <ErrorState error={error} />;
  if (!data?.licensed) return <DownloadAccessPrompt kind="source snapshots" href="/account/source" />;
  if (data.canReceiveUpdates === false) {
    return <p className="mt-6 text-sm text-zinc-400">{data.message || "This license cannot access source snapshots."}</p>;
  }
  return <ArtifactList items={data.sourceSnapshots || []} kind="source" />;
}

function DownloadAccessPrompt({ kind, href }: { kind: "downloads" | "source snapshots"; href: string }) {
  return (
    <div className="mt-8 rounded-lg border border-cyan-400/20 bg-cyan-400/10 p-5">
      <div className="text-sm font-medium text-cyan-100">Licensed access required</div>
      <p className="mt-2 text-sm leading-relaxed text-zinc-300">
        Current Groovy {kind} are available through the account portal for active paid users.
        Buy Groovy Personal or sign in with the account that owns the license.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <a
          href="/pricing?checkout=personal"
          className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-cyan-300"
        >
          Buy Personal
        </a>
        <a
          href={`/login?next=${encodeURIComponent(href)}`}
          className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
        >
          Sign in
        </a>
      </div>
    </div>
  );
}
