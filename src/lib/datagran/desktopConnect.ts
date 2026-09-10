import type { DatagranProvider } from "@/lib/datagran/prompts";

const DESKTOP_CONNECT_ORIGINS = [
  "https://gogroovy.ai",
  "https://www.gogroovy.ai",
] as const;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 1_500;
const DESKTOP_BROWSER_OAUTH_PROVIDERS = new Set<DatagranProvider>([
  "facebook_ads",
  "facebook_leads",
  "instagram",
  "google_ads",
  "google_calendar",
  "gmail",
  "linkedin_ads",
  "google_drive",
  "tiktok",
  "salesforce",
]);

type ConnectionSnapshot = {
  agentId: string;
  provider: string;
  connectionId: string;
  updatedAt: string;
};

type DesktopConnectionArgs = {
  provider: DatagranProvider;
  agentId?: string;
  connectionId?: string;
  recipientTracking?: boolean;
  timeoutMs?: number;
};

export function providerUsesDesktopBrowserOAuth(
  provider: DatagranProvider,
): boolean {
  return DESKTOP_BROWSER_OAUTH_PROVIDERS.has(provider);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSnapshots(payload: unknown): ConnectionSnapshot[] {
  const root =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const rows = Array.isArray(root?.connections) ? root.connections : [];
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const agentId = text(row.agentId);
    const provider = text(row.provider);
    if (!agentId || !provider) return [];
    return [
      {
        agentId,
        provider,
        connectionId: text(row.connectionId),
        updatedAt: text(row.updatedAt),
      },
    ];
  });
}

async function loadConnectionSnapshots(): Promise<ConnectionSnapshot[]> {
  const response = await fetch("/api/datagran/connection?health=skip", {
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      text((payload as Record<string, unknown>)?.error) ||
        "Could not check the connection.",
    );
  }
  return normalizeSnapshots(payload);
}

export function desktopDatagranConnectUrl(args: {
  provider: DatagranProvider;
  agentId?: string;
  recipientTracking?: boolean;
  currentOrigin?: string;
}): string {
  const currentOrigin =
    args.currentOrigin ||
    (typeof window === "undefined" ? "" : window.location.origin);
  // Pick the production origin that differs from the shell's app origin.
  // Electron therefore hands the navigation to the user's default browser,
  // where Google OAuth is permitted.
  const externalOrigin =
    DESKTOP_CONNECT_ORIGINS.find((origin) => origin !== currentOrigin) ||
    DESKTOP_CONNECT_ORIGINS[0];
  const url = new URL("/connect/datagran", externalOrigin);
  url.searchParams.set("provider", args.provider);
  if (args.agentId) url.searchParams.set("agentId", args.agentId);
  if (args.recipientTracking) {
    url.searchParams.set("recipientTracking", "1");
  }
  return url.toString();
}

export function completedDesktopConnection(args: {
  provider: string;
  targetAgentId?: string;
  baseline: readonly ConnectionSnapshot[];
  current: readonly ConnectionSnapshot[];
}): ConnectionSnapshot | null {
  if (args.targetAgentId) {
    const before = args.baseline.find(
      (item) => item.agentId === args.targetAgentId,
    );
    const after = args.current.find(
      (item) => item.agentId === args.targetAgentId,
    );
    if (
      after?.connectionId &&
      (after.updatedAt !== before?.updatedAt ||
        after.connectionId !== before?.connectionId)
    ) {
      return after;
    }
    return null;
  }

  const baselineIds = new Set(args.baseline.map((item) => item.agentId));
  return (
    args.current.find(
      (item) =>
        item.provider === args.provider &&
        Boolean(item.connectionId) &&
        !baselineIds.has(item.agentId),
    ) || null
  );
}

export async function connectDatagranInSystemBrowser(
  args: DesktopConnectionArgs,
): Promise<{ agentId: string; connectionId: string }> {
  if (!providerUsesDesktopBrowserOAuth(args.provider)) {
    throw new Error(
      "This integration uses an in-app credential form instead of browser authorization.",
    );
  }
  const baseline = await loadConnectionSnapshots();
  const targetAgentId =
    args.agentId ||
    baseline.find(
      (item) =>
        item.provider === args.provider &&
        item.connectionId === args.connectionId,
    )?.agentId;

  if (args.connectionId && !targetAgentId) {
    throw new Error("The existing integration could not be found.");
  }

  // A cross-origin navigation is more reliable than an async popup request:
  // the Electron shell intercepts it, keeps the app open, and launches the
  // URL in the system browser.
  window.location.assign(
    desktopDatagranConnectUrl({
      provider: args.provider,
      agentId: targetAgentId,
      recipientTracking: args.recipientTracking,
    }),
  );

  const deadline = Date.now() + (args.timeoutMs || DEFAULT_TIMEOUT_MS);
  let lastPollingError = "";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    let current: ConnectionSnapshot[];
    try {
      current = await loadConnectionSnapshots();
      lastPollingError = "";
    } catch (cause) {
      // A brief network interruption should not turn a successful browser
      // authorization into a false Desktop failure.
      lastPollingError =
        cause instanceof Error ? cause.message : "Could not check the connection.";
      continue;
    }
    const completed = completedDesktopConnection({
      provider: args.provider,
      targetAgentId,
      baseline,
      current,
    });
    if (completed) {
      return {
        agentId: completed.agentId,
        connectionId: completed.connectionId,
      };
    }
  }

  throw new Error(
    lastPollingError ||
      "The browser connection did not finish. Complete it in your browser, then try again.",
  );
}
