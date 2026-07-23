"use client";

/**
 * ConnectorPairingSection — the standalone-connector pairing-code UX
 * (download → install → generate pairing code → paste in app), i.e. the
 * "local" / web-fallback path of the old connector step.
 *
 * Extracted (behavior-preserving) from WelcomeOnboarding.tsx: instructions
 * block lines 1134-1276, status card lines 1303-1347, plus supporting
 * handlers (platform override effect 199-211, handleRefreshConnector 423-429,
 * generatePairingCode 531-549, copyPairingCode 551-556,
 * setPlatformOverridePreference 558-561).
 */

import { useEffect, useState } from "react";
import { CheckCircle2, Download, Key, Loader2, RefreshCw, WifiOff } from "lucide-react";
import { useConnectorInstallGuide } from "@/lib/connector/installGuide";
import {
  readConnectorPlatformOverride,
  writeConnectorPlatformOverride,
  type ConnectorPlatformOverride,
} from "@/lib/connector/override";
import {
  detectConnectorPlatformFromNavigator,
  type ConnectorClientPlatform,
} from "@/lib/connector/platform";

type ConnectorPairingSectionProps = {
  pairingRebindFromDeviceId?: string | null;
};

export function ConnectorPairingSection({
  pairingRebindFromDeviceId = null,
}: ConnectorPairingSectionProps) {
  const connectorGuide = useConnectorInstallGuide();
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingCopied, setPairingCopied] = useState(false);
  const [platformOverride, setPlatformOverride] = useState<ConnectorPlatformOverride>("auto");
  const [detectedPlatform, setDetectedPlatform] = useState<ConnectorClientPlatform>("unknown");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refreshPlatform = () => {
      setPlatformOverride(readConnectorPlatformOverride());
      setDetectedPlatform(detectConnectorPlatformFromNavigator(window.navigator));
    };
    refreshPlatform();
    const onOverrideChanged = () => refreshPlatform();
    window.addEventListener("groovy:connector:platformOverrideChanged", onOverrideChanged);
    return () => {
      window.removeEventListener("groovy:connector:platformOverrideChanged", onOverrideChanged);
    };
  }, []);

  const generatePairingCode = async () => {
    setPairingLoading(true);
    try {
      const res = await fetch("/api/devices/pairing-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          pairingRebindFromDeviceId ? { rebindFromDeviceId: pairingRebindFromDeviceId } : {}
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to generate code");
      setPairingCode(String(json.code || ""));
    } catch (err) {
      console.error("Failed to generate pairing code:", err);
    } finally {
      setPairingLoading(false);
    }
  };

  const copyPairingCode = async () => {
    if (!pairingCode) return;
    await navigator.clipboard.writeText(pairingCode);
    setPairingCopied(true);
    setTimeout(() => setPairingCopied(false), 1500);
  };

  const setPlatformOverridePreference = (next: ConnectorPlatformOverride) => {
    setPlatformOverride(next);
    writeConnectorPlatformOverride(next);
  };

  return (
    <>
      <div className="rounded-xl border border-white/10 bg-black/30 p-3">
        <div className="text-[11px] text-zinc-400 mb-2">Install guide platform</div>
        <div className="flex flex-wrap gap-2">
          {(["auto", "macos", "windows"] as ConnectorPlatformOverride[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPlatformOverridePreference(p)}
              className={`px-2.5 py-1.5 rounded-lg border text-[11px] transition-all ${
                platformOverride === p
                  ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
                  : "bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10"
              }`}
            >
              {p === "auto" ? "Auto" : p === "macos" ? "macOS" : "Windows"}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-zinc-500 mt-2">
          Detected:{" "}
          <span className="text-zinc-300">
            {detectedPlatform === "unknown"
              ? "unknown"
              : detectedPlatform === "macos"
                ? "macOS"
                : "Windows"}
          </span>
        </div>
      </div>

      {/* Step 1: Download */}
      <div className="flex items-start gap-4">
        <div className="w-8 h-8 rounded-full bg-cyan-500 text-black flex items-center justify-center text-sm font-bold shrink-0">
          1
        </div>
        <div className="flex-1 pt-1">
          <h3 className="text-sm font-medium text-white mb-2">Download the app</h3>
          <a
            href={connectorGuide.downloadUrl}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-cyan-500 text-black font-medium hover:bg-cyan-400 transition-colors text-sm"
          >
            <Download className="w-4 h-4" />
            {connectorGuide.ctaLabel}
          </a>
        </div>
      </div>

      {/* Step 2: Install */}
      <div className="flex items-start gap-4">
        <div className="w-8 h-8 rounded-full bg-zinc-700 text-white flex items-center justify-center text-sm font-bold shrink-0">
          2
        </div>
        <div className="flex-1 pt-1">
          <h3 className="text-sm font-medium text-white mb-1">Install it</h3>
          <p className="text-xs text-zinc-400 leading-relaxed mb-2">
            {connectorGuide.platform === "windows"
              ? "Run the installer, then open Groovy Connector from your Start Menu."
              : "Open the downloaded file and drag the app to your Applications folder. Then open it from Applications."}
          </p>
          {connectorGuide.platform !== "windows" && (
            <div className="text-[11px] text-zinc-500 mb-2">
              After installing, <span className="text-zinc-300">eject “Groovy Connector”</span>{" "}
              from Finder (it’s just the installer disk).
            </div>
          )}
          <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <p className="text-[11px] text-amber-200/80 leading-relaxed">
              {connectorGuide.platform === "windows" ? (
                <>
                  <span className="font-medium">Windows showing SmartScreen?</span> Click More info{" "}
                  then Run anyway.
                </>
              ) : (
                <>
                  <span className="font-medium">Mac showing a warning?</span> Go to System Settings
                  → Privacy &amp; Security, scroll down and click &quot;Open Anyway&quot;.
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Step 3: Generate code FIRST */}
      <div className="flex items-start gap-4">
        <div className="w-8 h-8 rounded-full bg-zinc-700 text-white flex items-center justify-center text-sm font-bold shrink-0">
          3
        </div>
        <div className="flex-1 pt-1">
          <h3 className="text-sm font-medium text-white mb-1">Generate pairing code</h3>
          <p className="text-xs text-zinc-400 leading-relaxed mb-3">
            Generate a code here <span className="text-amber-300">before</span> opening the app.
            You&apos;ll paste it when the app starts.
          </p>

          {!pairingCode ? (
            <button
              type="button"
              onClick={generatePairingCode}
              disabled={pairingLoading}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-500/15 border border-cyan-500/20 text-cyan-200 hover:bg-cyan-500/20 transition-colors text-sm disabled:opacity-50"
            >
              {pairingLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Key className="w-4 h-4" />
                  Generate Pairing Code
                </>
              )}
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-black/40 border border-cyan-500/30">
                <code className="text-lg text-cyan-400 tracking-wider font-mono">{pairingCode}</code>
              </div>
              <button
                type="button"
                onClick={copyPairingCode}
                className="px-3 py-2 rounded-lg text-xs text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 transition-all"
              >
                {pairingCopied ? "Copied!" : "Copy"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Step 4: Open app and paste code */}
      <div className="flex items-start gap-4">
        <div className="w-8 h-8 rounded-full bg-zinc-700 text-white flex items-center justify-center text-sm font-bold shrink-0">
          4
        </div>
        <div className="flex-1 pt-1">
          <h3 className="text-sm font-medium text-white mb-1">Open the app &amp; paste code</h3>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Open <span className="text-white">Groovy Connector</span> and paste the pairing code
            when prompted.
          </p>
        </div>
      </div>
    </>
  );
}

type ConnectorStatusCardProps = {
  connectorOnline: boolean;
  onRefreshConnector: () => void;
};

/** Right-hand "Connected / Not connected" status card of the connector step. */
export function ConnectorStatusCard({
  connectorOnline,
  onRefreshConnector,
}: ConnectorStatusCardProps) {
  const [refreshingConnector, setRefreshingConnector] = useState(false);

  const handleRefreshConnector = async () => {
    setRefreshingConnector(true);
    onRefreshConnector();
    // Wait a bit for the connector status to update
    await new Promise((r) => setTimeout(r, 2000));
    setRefreshingConnector(false);
  };

  return (
    <div
      className={`rounded-2xl p-5 flex flex-col items-center justify-center text-center ${
        connectorOnline
          ? "bg-emerald-500/10 border border-emerald-500/20"
          : "bg-zinc-900/80 border border-white/10"
      }`}
    >
      <div
        className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 ${
          connectorOnline ? "bg-emerald-500/20" : "bg-zinc-800"
        }`}
      >
        {connectorOnline ? (
          <CheckCircle2 className="w-8 h-8 text-emerald-400" />
        ) : (
          <WifiOff className="w-8 h-8 text-zinc-500" />
        )}
      </div>

      <h3 className={`text-lg font-semibold mb-1 ${connectorOnline ? "text-emerald-400" : "text-white"}`}>
        {connectorOnline ? "Connected" : "Not connected"}
      </h3>

      <p className="text-xs text-zinc-500 mb-4">
        {connectorOnline ? "Your connector is online and ready" : "Follow the steps to connect"}
      </p>

      <button
        type="button"
        onClick={handleRefreshConnector}
        disabled={refreshingConnector}
        className={`px-4 py-2 rounded-xl text-sm flex items-center gap-2 transition-all ${
          connectorOnline
            ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
            : "bg-white/5 text-zinc-300 hover:bg-white/10"
        }`}
      >
        <RefreshCw className={`w-4 h-4 ${refreshingConnector ? "animate-spin" : ""}`} />
        {refreshingConnector ? "Checking..." : "Check connection"}
      </button>
    </div>
  );
}
