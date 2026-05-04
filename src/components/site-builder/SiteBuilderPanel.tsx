"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  ExternalLink,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Rocket,
  X,
} from "lucide-react";

type SiteBuilderPanelProps = {
  /** Tunnel nonce for the dev server. */
  tunnelNonce?: string | null;
  /** Device ID of the connector running the dev server. */
  deviceId?: string | null;
  /** Site slug. */
  slug?: string | null;
  /** Site status. */
  status?: "draft" | "starting" | "dev" | "deploying" | "live" | "error" | string;
  /** Optional error detail shown when status is error. */
  errorMessage?: string | null;
  /** Production URL (when deployed). */
  productionUrl?: string | null;
  /** Port the dev server is running on. */
  devPort?: number | null;
  /** Whether the panel is expanded (full-width). */
  expanded?: boolean;
  /** Callback when the user wants to close the panel. */
  onClose?: () => void;
  /** Callback to toggle expanded/collapsed. */
  onToggleExpand?: () => void;
  /** Callback when user clicks "Deploy". */
  onDeploy?: () => void;
  /** Callback when user clicks "Retry Preview". */
  onRestartPreview?: (slug?: string) => void;
};

export default function SiteBuilderPanel({
  tunnelNonce,
  deviceId,
  slug,
  status,
  errorMessage,
  productionUrl,
  devPort,
  expanded = false,
  onClose,
  onToggleExpand,
  onDeploy,
  onRestartPreview,
}: SiteBuilderPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeCycle, setIframeCycle] = useState(0);
  const [loadedIframeKey, setLoadedIframeKey] = useState<string | null>(null);
  const [failedIframeKey, setFailedIframeKey] = useState<string | null>(null);
  const hasTunnel = Boolean(tunnelNonce && deviceId);

  // Build the local preview URL.
  const iframeSrc = devPort ? `http://localhost:${devPort}` : null;
  const iframeKey = iframeSrc ? `${iframeSrc}::${iframeCycle}` : null;
  const iframeLoading =
    Boolean(iframeKey) && loadedIframeKey !== iframeKey && failedIframeKey !== iframeKey;
  const iframeError = Boolean(iframeKey) && failedIframeKey === iframeKey;

  // Some localhost failures never trigger iframe onError reliably.
  useEffect(() => {
    if (!iframeKey || !iframeLoading) return;
    const timer = window.setTimeout(() => {
      setFailedIframeKey((prev) => prev ?? iframeKey);
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [iframeKey, iframeLoading]);

  const handleRefresh = useCallback(() => {
    const shouldRestartPreview =
      Boolean(onRestartPreview) && (!iframeSrc || status === "error" || iframeError);
    if (shouldRestartPreview) {
      onRestartPreview?.(slug || undefined);
      return;
    }
    setLoadedIframeKey(null);
    setFailedIframeKey(null);
    setIframeCycle((n) => n + 1);
  }, [iframeSrc, onRestartPreview, status, iframeError, slug]);

  const handleOpenExternal = useCallback(() => {
    if (productionUrl) {
      window.open(productionUrl, "_blank");
    } else if (devPort) {
      window.open(`http://localhost:${devPort}`, "_blank");
    }
  }, [productionUrl, devPort]);

  const statusIcon =
    status === "live" ? (
      <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
    ) : status === "starting" ? (
      <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
    ) : status === "deploying" ? (
      <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
    ) : status === "error" ? (
      <AlertCircle className="w-3.5 h-3.5 text-red-400" />
    ) : status === "dev" ? (
      <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
    ) : null;

  const statusText =
    status === "live"
      ? "Live"
      : status === "starting"
        ? "Starting dev server..."
      : status === "deploying"
        ? "Deploying..."
      : status === "error"
        ? "Build Error"
      : status === "dev"
        ? `Dev server :${devPort || "..."}`
      : "Draft";
  const statusPillClass =
    status === "live"
      ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-200"
      : status === "starting"
        ? "bg-cyan-500/15 border border-cyan-500/30 text-cyan-200"
        : status === "deploying"
          ? "bg-amber-500/15 border border-amber-500/30 text-amber-200"
          : status === "error"
            ? "bg-red-500/15 border border-red-500/30 text-red-200"
            : "bg-zinc-700/50 border border-zinc-600/40 text-zinc-300";

  return (
    <div
      className={`flex flex-col bg-zinc-900 border border-zinc-700/50 rounded-xl overflow-hidden shadow-2xl ${
        expanded ? "fixed inset-4 z-50" : "h-full"
      }`}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-zinc-800/80 border-b border-zinc-700/50">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Globe className="w-4 h-4 text-indigo-400 shrink-0" />
          <span className="text-sm font-medium text-zinc-200 truncate">
            {slug || "Site Builder"}
          </span>
          <div
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0 ${statusPillClass}`}
          >
            {statusIcon}
            <span className="text-xs">{statusText}</span>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {(status === "dev" || status === "error") && onDeploy && (
            <button
              onClick={onDeploy}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium whitespace-nowrap text-white bg-indigo-600 hover:bg-indigo-500 rounded-md transition-colors"
            >
              <Rocket className="w-3 h-3" />
              Deploy
            </button>
          )}

          {status === "error" && onRestartPreview && (
            <button
              onClick={() => onRestartPreview?.(slug || undefined)}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium whitespace-nowrap text-zinc-100 bg-zinc-700 hover:bg-zinc-600 rounded-md transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              Retry Preview
            </button>
          )}

          {!(status === "error" && onRestartPreview) && (
            <button
              onClick={handleRefresh}
              className="inline-flex h-8 w-8 items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded-md transition-colors"
              title="Refresh preview"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            onClick={handleOpenExternal}
            className="inline-flex h-8 w-8 items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded-md transition-colors"
            title="Open in new tab"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>

          {onToggleExpand && (
            <button
              onClick={onToggleExpand}
              className="inline-flex h-8 w-8 items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded-md transition-colors"
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>
          )}

          {onClose && (
            <button
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded-md transition-colors"
              title="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 relative bg-white">
        {iframeSrc ? (
          <>
            {iframeLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 z-10">
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
                  <span className="text-sm text-zinc-400">Loading preview...</span>
                </div>
              </div>
            )}
            <iframe
              ref={iframeRef}
              key={iframeKey || iframeSrc}
              src={iframeSrc}
              className="w-full h-full border-0"
              onLoad={() => {
                if (!iframeKey) return;
                setLoadedIframeKey(iframeKey);
                setFailedIframeKey(null);
              }}
              onError={() => {
                if (!iframeKey) return;
                setFailedIframeKey(iframeKey);
              }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              title={`Site preview: ${slug || "site"}`}
            />
          </>
        ) : productionUrl ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 bg-zinc-900 p-6">
            <CheckCircle className="w-10 h-10 text-emerald-400" />
            <div className="text-center">
              <p className="text-zinc-200 font-medium">Site is live!</p>
              <a
                href={productionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-400 hover:text-indigo-300 text-sm underline"
              >
                {productionUrl}
              </a>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 bg-zinc-900 p-6">
            <Globe className="w-8 h-8 text-zinc-600" />
            <p className="text-sm text-zinc-500 text-center">
              {status === "error"
                ? errorMessage || "Failed to start local dev server."
                : status === "starting"
                  ? "Starting local dev server..."
                : status === "deploying"
                  ? "Deploying to Vercel..."
                : hasTunnel
                  ? "Waiting for local dev server to report a preview port..."
                  : "Ask the assistant to build a site to see a live preview here."}
            </p>
            {status === "error" && onRestartPreview && (
              <button
                onClick={() => onRestartPreview?.(slug || undefined)}
                className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-md transition-colors"
              >
                Retry preview
              </button>
            )}
          </div>
        )}

        {iframeError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/90 z-10 gap-3">
            <AlertCircle className="w-8 h-8 text-red-400" />
            <p className="text-sm text-zinc-400">Failed to load preview</p>
            <button
              onClick={handleRefresh}
              className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-md transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {productionUrl && (
        <div className="px-3 py-1.5 bg-zinc-800/80 border-t border-zinc-700/50 flex items-center gap-2">
          <CheckCircle className="w-3 h-3 text-emerald-400 shrink-0" />
          <a
            href={productionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-indigo-400 hover:text-indigo-300 truncate"
          >
            {productionUrl}
          </a>
        </div>
      )}
    </div>
  );
}
