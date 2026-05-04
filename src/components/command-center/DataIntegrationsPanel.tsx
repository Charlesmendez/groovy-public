"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Plus,
  Check,
  Loader2,
  ExternalLink,
  Trash2,
  RefreshCw,
  BarChart3,
  Globe,
  AlertCircle,
  Copy,
  Code,
  Edit2,
} from "lucide-react";

// Platform icons (logos when available, otherwise colored initials)
const PLATFORM_CONFIG: Record<string, {
  name: string;
  short: string;
  color: string;
  textColor: string;
  borderColor: string;
  logo?: string;
  logoAlt?: string;
}> = {
  google_ads: {
    name: "Google Ads",
    short: "GA",
    color: "bg-blue-500",
    textColor: "text-blue-400",
    borderColor: "border-blue-500/30",
  },
  facebook_ads: {
    name: "Facebook Ads",
    short: "FB",
    color: "bg-blue-600",
    textColor: "text-blue-400",
    borderColor: "border-blue-500/30",
  },
  facebook_leads: {
    name: "Facebook Leads",
    short: "FL",
    color: "bg-blue-600",
    textColor: "text-blue-400",
    borderColor: "border-blue-500/30",
  },
  instagram: {
    name: "Instagram",
    short: "IG",
    color: "bg-pink-500",
    textColor: "text-pink-400",
    borderColor: "border-pink-500/30",
  },
  linkedin_ads: {
    name: "LinkedIn Ads",
    short: "LI",
    color: "bg-sky-600",
    textColor: "text-sky-400",
    borderColor: "border-sky-500/30",
  },
  tiktok: {
    name: "TikTok Ads",
    short: "TT",
    color: "bg-zinc-800",
    textColor: "text-zinc-300",
    borderColor: "border-zinc-500/30",
  },
  gmail: {
    name: "Gmail",
    short: "GM",
    color: "bg-white",
    textColor: "text-red-400",
    borderColor: "border-red-500/30",
    logo: "/gmail.svg",
    logoAlt: "Gmail",
  },
  google_calendar: {
    name: "Google Calendar",
    short: "GC",
    color: "bg-white",
    textColor: "text-blue-400",
    borderColor: "border-blue-500/30",
    logo: "/google-calendar.svg",
    logoAlt: "Google Calendar",
  },
  google_drive: {
    name: "Google Drive",
    short: "GD",
    color: "bg-yellow-500",
    textColor: "text-yellow-400",
    borderColor: "border-yellow-500/30",
  },
  postgres: {
    name: "PostgreSQL",
    short: "PG",
    color: "bg-indigo-500",
    textColor: "text-indigo-400",
    borderColor: "border-indigo-500/30",
  },
  firecrawl: {
    name: "Firecrawl",
    short: "FC",
    color: "bg-orange-500",
    textColor: "text-orange-400",
    borderColor: "border-orange-500/30",
  },
  salesforce: {
    name: "Salesforce",
    short: "SF",
    color: "bg-sky-500",
    textColor: "text-sky-400",
    borderColor: "border-sky-500/30",
  },
  web_pixel: {
    name: "Web Pixel",
    short: "WP",
    color: "bg-emerald-500",
    textColor: "text-emerald-400",
    borderColor: "border-emerald-500/30",
  },
};

// Fallback config for unknown platforms
const DEFAULT_PLATFORM_CONFIG = {
  name: "Unknown",
  short: "??",
  color: "bg-zinc-600",
  textColor: "text-zinc-400",
  borderColor: "border-zinc-500/30",
};

export type PlatformType = 
  | "google_ads"
  | "facebook_ads"
  | "facebook_leads"
  | "instagram"
  | "linkedin_ads"
  | "tiktok"
  | "google_calendar"
  | "google_drive"
  | "postgres"
  | "firecrawl"
  | "salesforce"
  | "gmail"
  | "web_pixel";

// Map internal platform names to Datagran API provider names
const PLATFORM_TO_PROVIDER: Partial<Record<PlatformType, string>> = {
  // Keep empty unless Datagran provider keys diverge from our UI keys.
};

// Get the Datagran provider name for a platform
export function getDatagranProvider(platform: PlatformType): string {
  return PLATFORM_TO_PROVIDER[platform] || platform;
}

function getPlatformConfig(platform: string) {
  return PLATFORM_CONFIG[platform] || DEFAULT_PLATFORM_CONFIG;
}

export type DataConnection = {
  id: string;
  platform: PlatformType;
  name: string;
  accountId?: string;
  connectionId?: string;
  status: "connected" | "error" | "expired";
  statusMessage?: string;
  lastSync?: Date;
};

export type WebPixel = {
  id: string;
  siteId: string;
  siteName: string;
  domain: string;
  status: "active" | "inactive";
  eventsLast7Days?: number;
};

type DataIntegrationsPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  connections: DataConnection[];
  pixels: WebPixel[];
  onConnect: (platform: PlatformType) => Promise<void>;
  onConnectWithId: (platform: PlatformType, connectionId: string, apiKey: string, name: string) => Promise<void>;
  onReconnect: (connectionId: string) => Promise<void>;
  onDisconnect: (connectionId: string) => Promise<void>;
  onRename: (connectionId: string, newName: string) => Promise<void>;
  onRefresh: () => Promise<void>;
};

export function DataIntegrationsPanel({
  isOpen,
  onClose,
  connections,
  pixels,
  onConnect,
  onConnectWithId,
  onReconnect,
  onDisconnect,
  onRename,
  onRefresh,
}: DataIntegrationsPanelProps) {
  const [activeTab, setActiveTab] = useState<"platforms" | "pixels">("platforms");
  const [connecting, setConnecting] = useState<PlatformType | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [savingName, setSavingName] = useState(false);

  // Connection choice modal state
  const [pendingPlatform, setPendingPlatform] = useState<PlatformType | null>(null);
  const [manualConnectionId, setManualConnectionId] = useState("");
  const [manualApiKey, setManualApiKey] = useState("");
  const [manualName, setManualName] = useState("");
  const [savingConnectionId, setSavingConnectionId] = useState(false);

  // Create pixel state
  const [showCreatePixel, setShowCreatePixel] = useState(false);
  const [newPixelName, setNewPixelName] = useState("");
  const [newPixelOrigins, setNewPixelOrigins] = useState("");
  const [creatingPixel, setCreatingPixel] = useState(false);
  const [createdPixel, setCreatedPixel] = useState<{
    id: string;
    name: string;
    writeKey: string;
    allowedOrigins: string[];
  } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showPixelDocs, setShowPixelDocs] = useState(false);

  // Available platforms to connect via Datagran OAuth
  // web_pixel is NOT available via OAuth - it's created in Datagran dashboard
  const OAUTH_PLATFORMS: PlatformType[] = [
    "facebook_ads", "facebook_leads", "instagram", "google_ads",
    "linkedin_ads", "google_drive", "google_calendar", "tiktok", "salesforce", 
    "gmail", "postgres", "firecrawl"
  ];
  // Datagran supports multiple connections/accounts per provider.
  // Keep all providers visible so users can add more accounts.
  const connectedPlatforms = new Set(connections.map((c) => c.platform));
  const availablePlatforms = OAUTH_PLATFORMS;

  // Show the connection choice modal
  const handlePlatformClick = (platform: PlatformType) => {
    setPendingPlatform(platform);
    setManualConnectionId("");
    setError(null);
  };

  // User chose to connect from scratch (OAuth)
  const handleConnectFromScratch = async () => {
    if (!pendingPlatform) return;
    setConnecting(pendingPlatform);
    setError(null);
    try {
      await onConnect(pendingPlatform);
      setPendingPlatform(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setConnecting(null);
    }
  };

  // User chose to use an existing connection ID + API key
  const handleConnectWithExistingId = async () => {
    if (!pendingPlatform || !manualConnectionId.trim() || !manualApiKey.trim() || !manualName.trim()) return;
    setSavingConnectionId(true);
    setError(null);
    try {
      await onConnectWithId(pendingPlatform, manualConnectionId.trim(), manualApiKey.trim(), manualName.trim());
      setPendingPlatform(null);
      setManualConnectionId("");
      setManualApiKey("");
      setManualName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save connection");
    } finally {
      setSavingConnectionId(false);
    }
  };

  const closeConnectionChoice = () => {
    setPendingPlatform(null);
    setManualConnectionId("");
    setManualApiKey("");
    setManualName("");
    setError(null);
  };

  const handleDisconnect = async (connectionId: string) => {
    setDisconnecting(connectionId);
    setError(null);
    try {
      await onDisconnect(connectionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setDisconnecting(null);
    }
  };

  const handleReconnect = async (connectionId: string) => {
    setReconnecting(connectionId);
    setError(null);
    try {
      await onReconnect(connectionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reconnect");
    } finally {
      setReconnecting(null);
    }
  };

  const startEditing = (connection: DataConnection) => {
    setEditingId(connection.id);
    setEditingName(connection.name);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditingName("");
  };

  const handleRename = async () => {
    if (!editingId || !editingName.trim()) return;
    setSavingName(true);
    setError(null);
    try {
      await onRename(editingId, editingName.trim());
      setEditingId(null);
      setEditingName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename");
    } finally {
      setSavingName(false);
    }
  };

  const handleCreatePixel = async () => {
    if (!newPixelName.trim() || !newPixelOrigins.trim()) {
      setError("Please enter a site name and at least one allowed origin");
      return;
    }

    setCreatingPixel(true);
    setError(null);

    try {
      const res = await fetch("/api/datagran/pixel/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newPixelName.trim(),
          allowedOrigins: newPixelOrigins,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create pixel");
      }

      // Show the created pixel with write key
      setCreatedPixel(data.pixel);
      setNewPixelName("");
      setNewPixelOrigins("");
      setShowCreatePixel(false);

      // Refresh to show the new pixel
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create pixel");
    } finally {
      setCreatingPixel(false);
    }
  };

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      setError("Failed to copy to clipboard");
    }
  };

  // Pixel installation documentation (markdown format for AI assistants)
  const getPixelDocsMarkdown = (siteId?: string, writeKey?: string) => `# Web Pixel Installation Guide

## 1. Add the Script to Your Website

Add this script to your website's \`<head>\` tag:

\`\`\`html
<script
  async
  src="https://www.datagran.io/pixel.js"
  data-site-id="${siteId || "YOUR_SITE_ID"}"
  data-write-key="${writeKey || "YOUR_WRITE_KEY"}"
></script>
\`\`\`

The script automatically tracks \`page_view\` events on every page load and SPA navigation.

## 2. Identify Users (Get Emails!)

When a user logs in or signs up, call \`identify()\` to link their anonymous activity to their identity:

\`\`\`javascript
// When user logs in or signs up:
window.dgrPixel?.identify(user.id, user.email);
\`\`\`

**Pro tip:** Always pass the email as the second parameter to see actual user emails in your dashboard.

## 3. Track Custom Events

\`\`\`javascript
// Track sign-in
window.dgrPixel?.track("sign_in");

// Track sign-up with properties
window.dgrPixel?.track("sign_up", { plan: "pro" });

// Track button clicks
window.dgrPixel?.track("click", { button: "pricing_cta" });

// Track any custom event
window.dgrPixel?.track("purchase", { 
  product: "Premium Plan",
  amount: 99.99,
  currency: "USD"
});
\`\`\`

## What Gets Tracked Automatically

- **Page views** - Every page load and SPA navigation
- **Geo data** - Country and city
- **Device info** - Mobile, desktop, tablet
- **Browser** - Chrome, Safari, Firefox, etc.
- **OS** - macOS, Windows, iOS, Android, etc.

## React/Next.js Example

\`\`\`tsx
// components/PixelProvider.tsx
"use client";

import { useEffect } from "react";
import { useUser } from "@/hooks/useUser"; // Your auth hook

declare global {
  interface Window {
    dgrPixel?: {
      identify: (userId: string, email?: string) => void;
      track: (event: string, props?: Record<string, unknown>) => void;
    };
  }
}

export function PixelProvider({ children }: { children: React.ReactNode }) {
  const { user } = useUser();

  useEffect(() => {
    // Identify user when they log in
    if (user?.id && window.dgrPixel) {
      window.dgrPixel.identify(user.id, user.email);
    }
  }, [user]);

  return <>{children}</>;
}

// Usage in layout.tsx:
// <PixelProvider>{children}</PixelProvider>
\`\`\`

## Security Notes

- The \`write_key\` is **public** (client-side) — it can only write events, not read data
- Events are only accepted from your **allowed origins**
- Rate limits: 600 events/minute per site, 120 events/minute per IP

## API Reference (for querying data)

Once installed, you can query your pixel data:

- **GET /api/pixel/stats** - Aggregated analytics (visitors, sessions, top pages, etc.)
- **GET /api/pixel/users** - List identified users with emails
- **GET /api/pixel/events** - Raw event data
- **GET /api/pixel/retention** - Cohort retention analysis
`;

  const pixelDocsMarkdown = getPixelDocsMarkdown(
    createdPixel?.id,
    createdPixel?.writeKey
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-2xl bg-zinc-900 border border-white/10 rounded-2xl overflow-hidden shadow-2xl max-h-[80vh] flex flex-col"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-5 border-b border-white/10 shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                <BarChart3 className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Data Integrations</h2>
                <p className="text-xs text-zinc-500">
                  Connect your marketing platforms
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
              </button>
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-white/10 shrink-0">
            <button
              onClick={() => setActiveTab("platforms")}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === "platforms"
                  ? "text-emerald-400 border-b-2 border-emerald-400"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Platforms ({connections.length})
            </button>
            <button
              onClick={() => setActiveTab("pixels")}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === "pixels"
                  ? "text-emerald-400 border-b-2 border-emerald-400"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Web Pixels ({pixels.length})
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-5">
            {/* Error message */}
            {error && (
              <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                <p className="text-xs text-red-400">{error}</p>
              </div>
            )}

            {activeTab === "platforms" ? (
              <div className="space-y-6">
                {/* Connected platforms */}
                {connections.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-zinc-400 mb-3">
                      Connected
                    </h3>
                    <div className="space-y-2">
                      {connections.map((conn) => {
                        const config = getPlatformConfig(conn.platform);
                        const canReconnect = conn.platform !== "web_pixel";
                        return (
                          <div
                            key={conn.id}
                            className={`p-4 rounded-xl border ${config.borderColor} bg-white/[0.02] flex items-center justify-between`}
                          >
                            <div className="flex items-center gap-3">
                              <div
                                className={`w-10 h-10 rounded-lg ${config.color} flex items-center justify-center text-white text-xs font-bold`}
                              >
                                {config.logo ? (
                                  <img
                                    src={config.logo}
                                    alt={config.logoAlt || config.name}
                                    className="w-6 h-6"
                                  />
                                ) : (
                                  config.short
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  {editingId === conn.id ? (
                                    <div className="flex items-center gap-2 flex-1">
                                      <input
                                        type="text"
                                        value={editingName}
                                        onChange={(e) => setEditingName(e.target.value)}
                                        className="flex-1 px-2 py-1 rounded bg-black/30 border border-white/20 text-sm text-white outline-none focus:border-violet-500/50"
                                        autoFocus
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") handleRename();
                                          if (e.key === "Escape") cancelEditing();
                                        }}
                                      />
                                      <button
                                        onClick={handleRename}
                                        disabled={savingName || !editingName.trim()}
                                        className="p-1 rounded text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50"
                                      >
                                        {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                      </button>
                                      <button
                                        onClick={cancelEditing}
                                        className="p-1 rounded text-zinc-400 hover:bg-white/5"
                                      >
                                        <X className="w-4 h-4" />
                                      </button>
                                    </div>
                                  ) : (
                                    <>
                                      <p className="text-sm font-medium text-white truncate">
                                        {conn.name || config.name}
                                      </p>
                                      <button
                                        onClick={() => startEditing(conn)}
                                        className="p-1 rounded text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
                                        title="Rename"
                                      >
                                        <Edit2 className="w-3 h-3" />
                                      </button>
                                    </>
                                  )}
                                  {editingId !== conn.id && (
                                    conn.status === "connected" ? (
                                      <span className="flex items-center gap-1 text-[10px] text-emerald-400">
                                        <Check className="w-3 h-3" />
                                        Connected
                                      </span>
                                    ) : conn.status === "error" ? (
                                      <span className="flex items-center gap-1 text-[10px] text-red-400">
                                        <AlertCircle className="w-3 h-3" />
                                        Error
                                      </span>
                                    ) : (
                                      <span className="flex items-center gap-1 text-[10px] text-amber-400">
                                        <AlertCircle className="w-3 h-3" />
                                        Needs Reauth
                                      </span>
                                    )
                                  )}
                                </div>
                                {conn.accountId && (
                                  <p className="text-xs text-zinc-500">
                                    ID: {conn.accountId}
                                  </p>
                                )}
                                {conn.lastSync && (
                                  <p className="text-[10px] text-zinc-600">
                                    Connected since: {conn.lastSync.toLocaleString()}
                                  </p>
                                )}
                                {conn.statusMessage && conn.status !== "connected" && (
                                  <p
                                    className={`text-[10px] ${
                                      conn.status === "expired" ? "text-amber-400" : "text-red-400"
                                    }`}
                                  >
                                    {conn.statusMessage}
                                  </p>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              {canReconnect && (
                                <button
                                  onClick={() => handleReconnect(conn.id)}
                                  disabled={reconnecting === conn.id || disconnecting === conn.id || editingId === conn.id}
                                  className="p-2 rounded-lg text-zinc-500 hover:text-sky-400 hover:bg-sky-500/10 transition-all disabled:opacity-50"
                                  title="Reconnect"
                                >
                                  {reconnecting === conn.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <RefreshCw className="w-4 h-4" />
                                  )}
                                </button>
                              )}
                              <button
                                onClick={() => handleDisconnect(conn.id)}
                                disabled={disconnecting === conn.id || reconnecting === conn.id || editingId === conn.id}
                                className="p-2 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-50"
                                title="Disconnect"
                              >
                                {disconnecting === conn.id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Trash2 className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Available platforms */}
                {availablePlatforms.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-zinc-400 mb-3">
                      Available to Connect
                    </h3>
                    <div className="grid grid-cols-2 gap-2">
                      {availablePlatforms.map((platform) => {
                        const config = getPlatformConfig(platform);
                        const alreadyConnected = connectedPlatforms.has(platform);
                        return (
                          <button
                            key={platform}
                            onClick={() => handlePlatformClick(platform)}
                            disabled={connecting !== null}
                            className={`p-4 rounded-xl border border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04] transition-all flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed`}
                          >
                            <div
                              className={`w-10 h-10 rounded-lg ${config.color} flex items-center justify-center text-white text-xs font-bold`}
                            >
                              {connecting === platform ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : config.logo ? (
                                <img
                                  src={config.logo}
                                  alt={config.logoAlt || config.name}
                                  className="w-6 h-6"
                                />
                              ) : (
                                config.short
                              )}
                            </div>
                            <div className="text-left">
                              <p className="text-sm font-medium text-white">
                                {config.name}
                              </p>
                              <p className="text-[10px] text-zinc-500">
                                {alreadyConnected ? "Add another connection" : "Click to connect"}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {connections.length === 0 && availablePlatforms.length === 0 && (
                  <div className="text-center py-8">
                    <BarChart3 className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
                    <p className="text-zinc-500">No platforms available</p>
                  </div>
                )}
              </div>
            ) : (
              /* Pixels tab */
              <div className="space-y-4">
                {/* Created Pixel Success Modal */}
                {createdPixel && (
                  <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10">
                    <div className="flex items-center gap-2 mb-3">
                      <Check className="w-5 h-5 text-emerald-400" />
                      <h4 className="text-sm font-semibold text-emerald-400">
                        Pixel Created Successfully!
                      </h4>
                    </div>
                    <p className="text-xs text-amber-400 mb-3">
                      Important: Save your write_key now — it&apos;s only shown once!
                    </p>

                    {/* Write Key */}
                    <div className="mb-3">
                      <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Write Key</label>
                      <div className="flex items-center gap-2 mt-1">
                        <code className="flex-1 px-3 py-2 rounded-lg bg-black/30 text-emerald-400 text-xs font-mono break-all">
                          {createdPixel.writeKey}
                        </code>
                        <button
                          onClick={() => copyToClipboard(createdPixel.writeKey, "writeKey")}
                          className="p-2 rounded-lg bg-white/5 text-zinc-400 hover:text-white transition-colors"
                        >
                          {copiedField === "writeKey" ? (
                            <Check className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Site ID */}
                    <div className="mb-3">
                      <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Site ID</label>
                      <div className="flex items-center gap-2 mt-1">
                        <code className="flex-1 px-3 py-2 rounded-lg bg-black/30 text-zinc-300 text-xs font-mono">
                          {createdPixel.id}
                        </code>
                        <button
                          onClick={() => copyToClipboard(createdPixel.id, "siteId")}
                          className="p-2 rounded-lg bg-white/5 text-zinc-400 hover:text-white transition-colors"
                        >
                          {copiedField === "siteId" ? (
                            <Check className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Installation Code */}
                    <div className="mb-3">
                      <label className="text-[10px] text-zinc-500 uppercase tracking-wider flex items-center gap-1">
                        <Code className="w-3 h-3" />
                        Installation Code (add to your website&apos;s &lt;head&gt;)
                      </label>
                      <div className="relative mt-1">
                        <pre className="px-3 py-2 rounded-lg bg-black/30 text-zinc-300 text-[10px] font-mono overflow-x-auto">
{`<script
  async
  src="https://www.datagran.io/pixel.js"
  data-site-id="${createdPixel.id}"
  data-write-key="${createdPixel.writeKey}"
></script>`}
                        </pre>
                        <button
                          onClick={() => copyToClipboard(
                            `<script\n  async\n  src="https://www.datagran.io/pixel.js"\n  data-site-id="${createdPixel.id}"\n  data-write-key="${createdPixel.writeKey}"\n></script>`,
                            "script"
                          )}
                          className="absolute top-2 right-2 p-1.5 rounded bg-white/10 text-zinc-400 hover:text-white transition-colors"
                        >
                          {copiedField === "script" ? (
                            <Check className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => copyToClipboard(pixelDocsMarkdown, "docs")}
                        className="flex-1 py-2 rounded-lg bg-white/5 text-zinc-400 text-sm hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center gap-2"
                      >
                        {copiedField === "docs" ? (
                          <>
                            <Check className="w-4 h-4 text-emerald-400" />
                            Docs Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="w-4 h-4" />
                            Copy Install Docs
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => setCreatedPixel(null)}
                        className="flex-1 py-2 rounded-lg bg-emerald-500/20 text-emerald-400 text-sm hover:bg-emerald-500/30 transition-colors"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}

                {/* Documentation Viewer */}
                {showPixelDocs && !createdPixel && (
                  <div className="p-4 rounded-xl border border-white/10 bg-white/[0.02]">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-medium text-white flex items-center gap-2">
                        <Code className="w-4 h-4 text-emerald-400" />
                        Pixel Installation Docs
                      </h4>
                      <div className="flex gap-2">
                        <button
                          onClick={() => copyToClipboard(getPixelDocsMarkdown(), "docs")}
                          className="px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs hover:bg-emerald-500/20 transition-colors flex items-center gap-1"
                        >
                          {copiedField === "docs" ? (
                            <>
                              <Check className="w-3 h-3" />
                              Copied!
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              Copy MD
                            </>
                          )}
                        </button>
                        <button
                          onClick={() => setShowPixelDocs(false)}
                          className="p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <div className="max-h-[300px] overflow-y-auto">
                      <pre className="text-[10px] text-zinc-400 font-mono whitespace-pre-wrap">
                        {getPixelDocsMarkdown()}
                      </pre>
                    </div>
                    <p className="text-[10px] text-zinc-600 mt-2">
                      Tip: Copy and paste this to an AI assistant to help with installation
                    </p>
                  </div>
                )}

                {/* Existing Pixels */}
                {!createdPixel && pixels.length > 0 && (
                  <div className="space-y-2">
                    {pixels.map((pixel) => (
                      <div
                        key={pixel.id}
                        className="p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-emerald-500 flex items-center justify-center text-white">
                            <Globe className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-white">
                                {pixel.siteName}
                              </p>
                              {pixel.status === "active" ? (
                                <span className="flex items-center gap-1 text-[10px] text-emerald-400">
                                  <Check className="w-3 h-3" />
                                  Active
                                </span>
                              ) : (
                                <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                                  Inactive
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-zinc-500">{pixel.domain}</p>
                            {pixel.eventsLast7Days !== undefined && (
                              <p className="text-[10px] text-zinc-600">
                                {pixel.eventsLast7Days.toLocaleString()} events (7d)
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                        <button
                          onClick={() => copyToClipboard(getPixelDocsMarkdown(pixel.siteId), `docs-${pixel.id}`)}
                          className="p-2 rounded-lg text-zinc-500 hover:text-emerald-400 hover:bg-white/10 transition-all"
                          title="Copy install docs"
                        >
                          {copiedField === `docs-${pixel.id}` ? (
                            <Check className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                        <a
                          href={`https://app.datagran.io/pixels/${pixel.siteId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-2 rounded-lg text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
                          title="Open in Datagran"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Create Pixel Form */}
                {!createdPixel && (
                  <div className="mt-4">
                    {showCreatePixel ? (
                      <div className="p-4 rounded-xl border border-white/10 bg-white/[0.02] space-y-3">
                        <h4 className="text-sm font-medium text-white flex items-center gap-2">
                          <Globe className="w-4 h-4 text-emerald-400" />
                          Create New Web Pixel
                        </h4>

                        <div>
                          <label className="text-xs text-zinc-400 mb-1 block">Site Name</label>
                          <input
                            type="text"
                            value={newPixelName}
                            onChange={(e) => setNewPixelName(e.target.value)}
                            placeholder="My Website"
                            className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white placeholder-zinc-600 text-sm outline-none focus:border-emerald-500/50"
                          />
                        </div>

                        <div>
                          <label className="text-xs text-zinc-400 mb-1 block">
                            Allowed Origins (one per line or comma-separated)
                          </label>
                          <textarea
                            value={newPixelOrigins}
                            onChange={(e) => setNewPixelOrigins(e.target.value)}
                            placeholder="https://mywebsite.com&#10;https://www.mywebsite.com"
                            rows={3}
                            className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white placeholder-zinc-600 text-sm outline-none focus:border-emerald-500/50 resize-none font-mono"
                          />
                          <p className="text-[10px] text-zinc-600 mt-1">
                            Events will only be accepted from these domains
                          </p>
                        </div>

                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              setShowCreatePixel(false);
                              setNewPixelName("");
                              setNewPixelOrigins("");
                            }}
                            className="flex-1 py-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors text-sm"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleCreatePixel}
                            disabled={creatingPixel || !newPixelName.trim() || !newPixelOrigins.trim()}
                            className="flex-1 py-2 rounded-lg bg-emerald-500 text-black font-medium text-sm hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                          >
                            {creatingPixel ? (
                              <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Creating...
                              </>
                            ) : (
                              <>
                                <Plus className="w-4 h-4" />
                                Create Pixel
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setShowCreatePixel(true)}
                        className="w-full py-3 rounded-xl border border-dashed border-emerald-500/30 text-emerald-400 text-sm hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-colors flex items-center justify-center gap-2"
                      >
                        <Plus className="w-4 h-4" />
                        Create New Web Pixel
                      </button>
                    )}
                  </div>
                )}

                {/* Empty state when no pixels and not creating */}
                {!createdPixel && pixels.length === 0 && !showCreatePixel && !showPixelDocs && (
                  <div className="text-center py-4">
                    <p className="text-xs text-zinc-600 max-w-sm mx-auto">
                      Web pixels track page views, sign-ups, and custom events.
                      Automatically captures geo, device, and browser data.
                    </p>
                  </div>
                )}

                {/* Documentation Button */}
                {!createdPixel && !showPixelDocs && !showCreatePixel && (
                  <button
                    onClick={() => setShowPixelDocs(true)}
                    className="w-full py-2 rounded-lg border border-white/10 text-zinc-500 text-xs hover:text-white hover:border-white/20 transition-colors flex items-center justify-center gap-2"
                  >
                    <Code className="w-3 h-3" />
                    View Installation Docs (copy for AI)
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Footer with info */}
          <div className="p-4 border-t border-white/10 bg-zinc-900/50 shrink-0">
            <p className="text-[10px] text-zinc-600 text-center">
              Connections are managed via Datagran. Your data stays secure with OAuth authentication.
            </p>
          </div>
        </motion.div>
      </motion.div>

      {/* Connection Choice Modal */}
      {pendingPlatform && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
          onClick={closeConnectionChoice}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-zinc-900 border border-white/10 rounded-2xl w-full max-w-md overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-white/10">
              <div className="flex items-center gap-3">
                {(() => {
                  const config = getPlatformConfig(pendingPlatform);
                  return (
                    <>
                      <div
                        className={`w-10 h-10 rounded-lg ${config.color} flex items-center justify-center text-white text-sm font-bold overflow-hidden`}
                      >
                        {config.logo ? (
                          <img src={config.logo} alt={config.logoAlt || config.name} className="w-6 h-6 object-contain" />
                        ) : (
                          config.short
                        )}
                      </div>
                      <div>
                        <h3 className="text-white font-medium">Connect {config.name}</h3>
                        <p className="text-xs text-zinc-500">Choose how to connect</p>
                      </div>
                    </>
                  );
                })()}
              </div>
              <button
                onClick={closeConnectionChoice}
                className="p-2 hover:bg-white/5 rounded-lg transition-colors"
              >
                <X className="w-4 h-4 text-zinc-500" />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  {error}
                </div>
              )}

              {/* Option 1: Connect from scratch */}
              <button
                onClick={handleConnectFromScratch}
                disabled={connecting !== null || savingConnectionId}
                className="w-full p-4 rounded-xl border border-white/10 bg-white/[0.02] hover:border-emerald-500/30 hover:bg-emerald-500/5 transition-all text-left group disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                    {connecting === pendingPlatform ? (
                      <Loader2 className="w-5 h-5 text-emerald-400 animate-spin" />
                    ) : (
                      <Plus className="w-5 h-5 text-emerald-400" />
                    )}
                  </div>
                  <div>
                    <div className="text-white font-medium group-hover:text-emerald-400 transition-colors">
                      Connect from scratch
                    </div>
                    <div className="text-xs text-zinc-500">
                      Authenticate via OAuth to create a new connection
                    </div>
                  </div>
                </div>
              </button>

              {/* Divider */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-white/10" />
                <span className="text-xs text-zinc-600 uppercase tracking-wider">or</span>
                <div className="flex-1 h-px bg-white/10" />
              </div>

              {/* Option 2: Use existing connection ID + API key */}
              <div className="p-4 rounded-xl border border-white/10 bg-white/[0.02]">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center">
                    <Code className="w-5 h-5 text-violet-400" />
                  </div>
                  <div>
                    <div className="text-white font-medium">Use existing Datagran connection</div>
                    <div className="text-xs text-zinc-500">
                      Already have a connection in your Datagran account
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <input
                    type="text"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    placeholder="Connection name (e.g. My Gmail)"
                    className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white placeholder-zinc-600 text-sm outline-none focus:border-violet-500/50"
                    disabled={connecting !== null || savingConnectionId}
                  />
                  <input
                    type="text"
                    value={manualConnectionId}
                    onChange={(e) => setManualConnectionId(e.target.value)}
                    placeholder="Connection ID"
                    className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white placeholder-zinc-600 text-sm outline-none focus:border-violet-500/50"
                    disabled={connecting !== null || savingConnectionId}
                  />
                  <input
                    type="password"
                    value={manualApiKey}
                    onChange={(e) => setManualApiKey(e.target.value)}
                    placeholder="Datagran API Key"
                    className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white placeholder-zinc-600 text-sm outline-none focus:border-violet-500/50"
                    disabled={connecting !== null || savingConnectionId}
                  />
                  <button
                    onClick={handleConnectWithExistingId}
                    disabled={!manualName.trim() || !manualConnectionId.trim() || !manualApiKey.trim() || connecting !== null || savingConnectionId}
                    className="w-full py-2 rounded-lg bg-violet-500/20 text-violet-300 text-sm font-medium hover:bg-violet-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                  >
                    {savingConnectionId ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                    {savingConnectionId ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Get initials from a name (e.g., "My Google Ads" -> "MG")
function getInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) {
    return words[0].substring(0, 2).toUpperCase();
  }
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

// Export a small badge component to show on the tile (compact mode for collapsed tile)
export function DataConnectionBadges({
  connections,
  maxVisible = 3,
  expanded = false,
}: {
  connections: DataConnection[];
  maxVisible?: number;
  expanded?: boolean;
}) {
  if (connections.length === 0) return null;

  const visible = connections.slice(0, maxVisible);
  const remaining = connections.length - maxVisible;

  // Expanded mode: show full names as pills
  if (expanded) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        {visible.map((conn) => {
          const config = getPlatformConfig(conn.platform);
          return (
            <div
              key={conn.id}
              className={`px-2 py-0.5 rounded-full bg-white/5 border ${config.borderColor} flex items-center gap-1.5`}
            >
              {config.logo ? (
                <img
                  src={config.logo}
                  alt={config.logoAlt || config.name}
                  className="w-3 h-3"
                />
              ) : (
                <div className={`w-2 h-2 rounded-full ${config.color}`} />
              )}
              <span className={`text-[10px] font-medium ${config.textColor}`}>
                {conn.name || config.name}
              </span>
            </div>
          );
        })}
        {remaining > 0 && (
          <div className="px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 text-[10px] font-medium">
            +{remaining} more
          </div>
        )}
      </div>
    );
  }

  // Collapsed mode: small squares with initials from connection name
  return (
    <div className="flex items-center gap-1 mt-2">
      {visible.map((conn) => {
        const config = getPlatformConfig(conn.platform);
        const initials = getInitials(conn.name || config.name);
        return (
          <div
            key={conn.id}
            className={`w-6 h-6 rounded ${config.color} flex items-center justify-center text-white text-[8px] font-bold`}
            title={conn.name || config.name}
          >
            {config.logo ? (
              <img
                src={config.logo}
                alt={config.logoAlt || config.name}
                className="w-4 h-4"
              />
            ) : (
              initials
            )}
          </div>
        );
      })}
      {remaining > 0 && (
        <div className="w-6 h-6 rounded bg-zinc-700 flex items-center justify-center text-zinc-300 text-[10px] font-medium">
          +{remaining}
        </div>
      )}
    </div>
  );
}
