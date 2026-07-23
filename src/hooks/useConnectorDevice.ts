"use client";

/**
 * Consolidated relay/device state for the connector.
 *
 * Extracted from src/app/dashboard/page.tsx (device tracking around lines
 * 1420-1530, 1684-1817, 2028-2152, 4246-4292, 6697-6797) and the smaller
 * dashboard-v2/page.tsx variant (lines 159-298). This hook duplicates the
 * behavior for the new dashboard build; the old page keeps its inline logic.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRelay } from "@/hooks/useRelay";
import {
  MIN_CONNECTOR_VERSION,
  SELF_UPDATE_MIN_CONNECTOR_VERSION,
  isConnectorVersionOutdated,
} from "@/lib/connector/version";

type DeviceCapabilities = {
  claudeCliInstalled?: boolean;
  codexCliInstalled?: boolean;
  managedByDesktop?: boolean;
};

type DeviceHealth = {
  whatsapp?: { status?: string } | null;
};

type OnlineDeviceInfo = {
  deviceId: string;
  version?: string;
  claudeCliInstalled?: boolean;
  codexCliInstalled?: boolean;
  managedByDesktop?: boolean;
  whatsappStatus?: string;
};

export type ConnectorDeviceState = {
  relayStatus: string;
  relayConnected: boolean;
  connectorOnline: boolean;
  activeDeviceId: string | null;
  connectorVersion: string | null;
  capabilities: {
    claudeCliInstalled: boolean | null;
    codexCliInstalled: boolean | null;
    managedByDesktop?: boolean | null;
  };
  health: {
    whatsappStatus: string | null;
  };
  connectorOutdated: boolean;
  supportsInPlaceUpdate: boolean;
  onlineDevices: Array<{ deviceId: string; version?: string }>;
  prefersHostedConnector: boolean;
};

export function useConnectorDevice(): ConnectorDeviceState & {
  relay: ReturnType<typeof useRelay>;
  refresh(): void;
  restartConnector(): void;
  updateConnector(): void;
  setConnectorMode(mode: "local" | "groovy"): Promise<void>;
} {
  const relay = useRelay();

  const [connectorOnline, setConnectorOnline] = useState(false);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const activeDeviceIdRef = useRef<string | null>(null);
  const [connectorVersion, setConnectorVersion] = useState<string | null>(null);
  const [claudeCliInstalled, setClaudeCliInstalled] = useState<boolean | null>(null);
  const [codexCliInstalled, setCodexCliInstalled] = useState<boolean | null>(null);
  const [managedByDesktop, setManagedByDesktop] = useState<boolean | null>(null);
  const [whatsappStatus, setWhatsAppStatus] = useState<string | null>(null);
  const [onlineDevices, setOnlineDevices] = useState<
    Array<{ deviceId: string; version?: string }>
  >([]);
  const [prefersHostedConnector, setPrefersHostedConnector] = useState(false);
  const [hostedPreferredDeviceId, setHostedPreferredDeviceId] = useState<string | null>(null);
  const [preferredConnectorDeviceId, setPreferredConnectorDeviceId] = useState<string | null>(
    null
  );

  const onlineDevicesRef = useRef<Map<string, OnlineDeviceInfo>>(new Map());
  const relayStatusRef = useRef(relay.status);
  const connectorModeTargetDeviceIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeDeviceIdRef.current = activeDeviceId;
  }, [activeDeviceId]);

  useEffect(() => {
    relayStatusRef.current = relay.status;
  }, [relay.status]);

  // Mirrors dashboard/page.tsx pickDesiredActiveDeviceId (~line 1764).
  const pickDesiredActiveDeviceId = useCallback(
    (currentActiveId: string | null): string | null => {
      const onlineIds = Array.from(onlineDevicesRef.current.keys()).sort();
      if (onlineIds.length === 0) return null;

      if (prefersHostedConnector) {
        // Hosted mode: stick to the hosted connector when available.
        if (
          hostedPreferredDeviceId &&
          onlineDevicesRef.current.has(hostedPreferredDeviceId)
        ) {
          return hostedPreferredDeviceId;
        }

        // Fallback to persisted selection if hosted isn't available.
        if (
          preferredConnectorDeviceId &&
          onlineDevicesRef.current.has(preferredConnectorDeviceId)
        ) {
          return preferredConnectorDeviceId;
        }

        // Keep existing active device when still online.
        if (currentActiveId && onlineDevicesRef.current.has(currentActiveId)) {
          return currentActiveId;
        }

        return onlineIds[0] || null;
      }

      // Local mode: respect persisted selection when it's a non-hosted device.
      if (
        preferredConnectorDeviceId &&
        onlineDevicesRef.current.has(preferredConnectorDeviceId) &&
        (!hostedPreferredDeviceId || preferredConnectorDeviceId !== hostedPreferredDeviceId)
      ) {
        return preferredConnectorDeviceId;
      }

      // Local mode: avoid auto-selecting hosted when a local device is online.
      if (hostedPreferredDeviceId) {
        const nonHosted = onlineIds.find((id) => id !== hostedPreferredDeviceId);
        if (nonHosted) return nonHosted;
      }

      // Keep existing active device when still online.
      if (currentActiveId && onlineDevicesRef.current.has(currentActiveId)) {
        return currentActiveId;
      }

      return onlineIds[0] || null;
    },
    [preferredConnectorDeviceId, prefersHostedConnector, hostedPreferredDeviceId]
  );

  const applyDesiredDevice = useCallback(() => {
    const desired = pickDesiredActiveDeviceId(activeDeviceIdRef.current);
    setActiveDeviceId(desired);
    setConnectorOnline(!!desired);
    const desiredDeviceInfo = desired ? onlineDevicesRef.current.get(desired) : null;
    setConnectorVersion(desiredDeviceInfo?.version || null);
    setClaudeCliInstalled(desiredDeviceInfo?.claudeCliInstalled ?? null);
    setCodexCliInstalled(desiredDeviceInfo?.codexCliInstalled ?? null);
    setManagedByDesktop(desiredDeviceInfo?.managedByDesktop ?? null);
    setWhatsAppStatus(desiredDeviceInfo?.whatsappStatus ?? null);
    setOnlineDevices(
      Array.from(onlineDevicesRef.current.values()).map((info) => ({
        deviceId: info.deviceId,
        version: info.version,
      }))
    );
  }, [pickDesiredActiveDeviceId]);

  // Track connector devices from relay events (dashboard/page.tsx ~lines 2028-2072).
  const subscribeToRelay = relay.subscribe;
  useEffect(() => {
    const unsub = subscribeToRelay((msg) => {
      const msgType = (msg as { type?: string }).type;
      if (msgType === "device_online") {
        const deviceId = String((msg as { device_id?: string }).device_id || "");
        const version = String((msg as { version?: string }).version || "0.0.0");
        const capabilities = (msg as { capabilities?: DeviceCapabilities }).capabilities;
        const health = (msg as { health?: DeviceHealth }).health;
        if (deviceId) {
          const prevInfo = onlineDevicesRef.current.get(deviceId) || null;
          onlineDevicesRef.current.set(deviceId, {
            deviceId,
            version,
            claudeCliInstalled:
              capabilities?.claudeCliInstalled ?? prevInfo?.claudeCliInstalled,
            codexCliInstalled:
              capabilities?.codexCliInstalled ?? prevInfo?.codexCliInstalled,
            managedByDesktop:
              capabilities?.managedByDesktop ?? prevInfo?.managedByDesktop,
            whatsappStatus:
              typeof health?.whatsapp?.status === "string"
                ? health.whatsapp.status
                : prevInfo?.whatsappStatus,
          });
        }
        applyDesiredDevice();
      } else if (msgType === "device_offline") {
        const deviceId = String((msg as { device_id?: string }).device_id || "");
        if (deviceId) {
          // Do not fail in-flight tool requests here; long jobs can survive a
          // reconnect and still return by request_id.
          onlineDevicesRef.current.delete(deviceId);
        }
        applyDesiredDevice();
      }
    });
    return unsub;
  }, [subscribeToRelay, applyDesiredDevice]);

  // Re-evaluate active connector after preference/device-id changes
  // (dashboard/page.tsx ~lines 2121-2130).
  useEffect(() => {
    applyDesiredDevice();
  }, [applyDesiredDevice]);

  // If the relay socket is truly gone, we may never receive a `device_offline`
  // event. Do not clear during normal reconnect/check cycles
  // (dashboard/page.tsx ~lines 1686-1701).
  useEffect(() => {
    if (relay.status === "ready") return;
    if (relay.isChecking || relay.status === "connecting") return;

    const timeoutId = window.setTimeout(() => {
      if (relayStatusRef.current === "ready") return;
      onlineDevicesRef.current.clear();
      setConnectorOnline(false);
      setConnectorVersion(null);
      setClaudeCliInstalled(null);
      setCodexCliInstalled(null);
      setManagedByDesktop(null);
      setWhatsAppStatus(null);
      setActiveDeviceId(null);
      setOnlineDevices([]);
    }, 8_000);

    return () => window.clearTimeout(timeoutId);
  }, [relay.isChecking, relay.status]);

  // Load connector mode preference + hosted device id once
  // (dashboard/page.tsx ~lines 4246-4292).
  useEffect(() => {
    (async () => {
      try {
        const prefsRes = await fetch("/api/user-preferences", { cache: "no-store" });
        const prefsJson = await prefsRes.json().catch(() => ({}));
        const connectorMode = prefsJson?.onboardingData?.connectorMode;
        const connectorDeviceIdRaw = prefsJson?.onboardingData?.connectorDeviceId;
        setPreferredConnectorDeviceId(
          typeof connectorDeviceIdRaw === "string" && connectorDeviceIdRaw.trim()
            ? connectorDeviceIdRaw.trim()
            : null
        );
        setPrefersHostedConnector(connectorMode === "groovy");
        // Best-effort: always keep hosted device id (if available) so local mode
        // can avoid auto-selecting hosted connector after refresh.
        try {
          const hmRes = await fetch("/api/hosted-macs/request", { cache: "no-store" });
          const hmJson = await hmRes.json().catch(() => ({}));
          if (hmRes.ok && hmJson?.device?.device_id) {
            setHostedPreferredDeviceId(String(hmJson.device.device_id));
          } else {
            setHostedPreferredDeviceId(null);
          }
        } catch {
          setHostedPreferredDeviceId(null);
        }
      } catch {
        // ignore API errors
      }
    })();
  }, []);

  const persistPreferredConnectorDeviceId = useCallback(async (deviceId: string | null) => {
    setPreferredConnectorDeviceId(deviceId);
    await fetch("/api/user-preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingData: { connectorDeviceId: deviceId } }),
    }).catch(() => {});
  }, []);

  // Mirrors dashboard/page.tsx pinHeartbeatToDeviceIfEnabled (~line 6706).
  const pinHeartbeatToDeviceIfEnabled = useCallback(async (deviceId: string | null) => {
    if (!deviceId) return;
    try {
      const cfgRes = await fetch("/api/heartbeat/config", { cache: "no-store" });
      const cfgJson = await cfgRes.json().catch(() => ({}));
      if (!cfgRes.ok || cfgJson?.enabled !== true) return;
      const delivery =
        cfgJson?.delivery && typeof cfgJson.delivery === "object"
          ? cfgJson.delivery
          : { dashboard: true, whatsapp: true };
      await fetch("/api/heartbeat/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, delivery, deviceId }),
      });
    } catch {
      // best-effort; heartbeat can still be manually rebound from settings
    }
  }, []);

  // Mirrors dashboard/page.tsx handleConnectorModeChanged (~line 6730).
  const handleConnectorModeChanged = useCallback(
    async (next: "local" | "groovy") => {
      if (next === "groovy") {
        setPrefersHostedConnector(true);
        try {
          const hmRes = await fetch("/api/hosted-macs/request", { cache: "no-store" });
          const hmJson = await hmRes.json().catch(() => ({}));
          if (hmRes.ok && hmJson?.device?.device_id) {
            const hostedDeviceId = String(hmJson.device.device_id);
            setHostedPreferredDeviceId(hostedDeviceId);
            connectorModeTargetDeviceIdRef.current = hostedDeviceId;
            await persistPreferredConnectorDeviceId(hostedDeviceId);
          } else {
            setHostedPreferredDeviceId(null);
            connectorModeTargetDeviceIdRef.current = null;
            await persistPreferredConnectorDeviceId(null);
          }
        } catch {
          setHostedPreferredDeviceId(null);
          connectorModeTargetDeviceIdRef.current = null;
          await persistPreferredConnectorDeviceId(null);
        }
        return;
      }
      setPrefersHostedConnector(false);
      const currentHosted = hostedPreferredDeviceId;
      const currentActive = activeDeviceIdRef.current;
      const onlineIds = Array.from(onlineDevicesRef.current.keys());
      const nonHostedOnline =
        onlineIds.find((id) => !currentHosted || id !== currentHosted) || null;
      if (nonHostedOnline) {
        connectorModeTargetDeviceIdRef.current = nonHostedOnline;
        await persistPreferredConnectorDeviceId(nonHostedOnline);
        return;
      }
      if (currentActive && (!currentHosted || currentActive !== currentHosted)) {
        connectorModeTargetDeviceIdRef.current = currentActive;
        await persistPreferredConnectorDeviceId(currentActive);
        return;
      }
      connectorModeTargetDeviceIdRef.current = null;
      await persistPreferredConnectorDeviceId(null);
    },
    [hostedPreferredDeviceId, persistPreferredConnectorDeviceId]
  );

  // Mirrors dashboard/page.tsx persistConnectorModePreference (~line 6773).
  const setConnectorMode = useCallback(
    async (mode: "local" | "groovy") => {
      const res = await fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboardingData: { connectorMode: mode } }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to save connector mode");

      await handleConnectorModeChanged(mode);
      await pinHeartbeatToDeviceIfEnabled(connectorModeTargetDeviceIdRef.current);
      relay.reconnect?.();
    },
    [handleConnectorModeChanged, pinHeartbeatToDeviceIfEnabled, relay]
  );

  const refresh = useCallback(() => {
    relay.reconnect?.();
  }, [relay]);

  const restartConnector = useCallback(() => {
    if (!activeDeviceId) return;
    try {
      relay.send({ type: "connector_restart", device_id: activeDeviceId });
    } catch {
      // ignore
    }
  }, [relay, activeDeviceId]);

  const updateConnector = useCallback(() => {
    if (!activeDeviceId) return;
    try {
      relay.send({ type: "connector_update", device_id: activeDeviceId });
    } catch {
      // ignore
    }
  }, [relay, activeDeviceId]);

  const connectorOutdated =
    connectorOnline && isConnectorVersionOutdated(connectorVersion, MIN_CONNECTOR_VERSION);
  const supportsInPlaceUpdate =
    connectorOnline &&
    !!connectorVersion &&
    !isConnectorVersionOutdated(connectorVersion, SELF_UPDATE_MIN_CONNECTOR_VERSION);

  return {
    relayStatus: relay.status,
    relayConnected: relay.status === "ready",
    connectorOnline,
    activeDeviceId,
    connectorVersion,
    capabilities: {
      claudeCliInstalled,
      codexCliInstalled,
      managedByDesktop,
    },
    health: {
      whatsappStatus,
    },
    connectorOutdated,
    supportsInPlaceUpdate,
    onlineDevices,
    prefersHostedConnector,
    relay,
    refresh,
    restartConnector,
    updateConnector,
    setConnectorMode,
  };
}
