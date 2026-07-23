import { useEffect, useState } from "react";
import { getConnectorInstallGuide } from "./catalog";
import {
  detectConnectorPlatformFromNavigator,
  type ConnectorClientPlatform,
} from "./platform";
import { readConnectorPlatformOverride } from "./override";

export function useConnectorInstallGuide() {
  const [platform, setPlatform] = useState<ConnectorClientPlatform>("unknown");

  useEffect(() => {
    const detectPlatform = () => {
      if (typeof window === "undefined") return;
      const override = readConnectorPlatformOverride();
      setPlatform(
        override === "windows" || override === "macos"
          ? override
          : detectConnectorPlatformFromNavigator(window.navigator)
      );
    };

    detectPlatform();

    // Recompute when platform override changes (other tabs, Settings, etc).
    const onStorage = (e: StorageEvent) => {
      if (e.key === "groovy:connector:platformOverride") detectPlatform();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("groovy:connector:platformOverrideChanged", detectPlatform);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("groovy:connector:platformOverrideChanged", detectPlatform);
    };
  }, []);

  return getConnectorInstallGuide(platform);
}
