import { useEffect, useState } from "react";
import { getConnectorInstallGuide } from "./catalog";
import { detectConnectorPlatformFromNavigator } from "./platform";
import { readConnectorPlatformOverride } from "./override";

export function useConnectorInstallGuide() {
  const [, setTick] = useState(0);

  const guide = (() => {
    if (typeof window === "undefined") return getConnectorInstallGuide("unknown");
    const override = readConnectorPlatformOverride();
    const platform =
      override === "windows" || override === "macos"
        ? override
        : detectConnectorPlatformFromNavigator(window.navigator);
    return getConnectorInstallGuide(platform);
  })();

  // Recompute when platform override changes (other tabs, Settings, etc).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === "groovy:connector:platformOverride") setTick((n) => n + 1);
    };
    const onOverride = () => setTick((n) => n + 1);
    window.addEventListener("storage", onStorage);
    window.addEventListener("groovy:connector:platformOverrideChanged", onOverride);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("groovy:connector:platformOverrideChanged", onOverride);
    };
  }, []);

  return guide;
}
