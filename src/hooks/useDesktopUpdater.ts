"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDesktopApi,
  isDesktopShell,
  type DesktopUpdateStatus,
} from "@/lib/desktop/shell";
import { desktopUpdateCheckFeedback } from "@/lib/desktop/updateFeedback";

type UseDesktopUpdaterOptions = {
  /**
   * When this value changes to a non-empty string, immediately ask the native
   * shell to check its license-gated update feed. This lets the hosted UI
   * close the gap between a new connector requirement and the native app's
   * background update schedule.
   */
  autoCheckKey?: string | null;
  /** Version the surrounding UI already knows is required. */
  requiredVersion?: string | null;
};

// The hosted UI can be newer than the installed native shell. Keep this
// module-scoped so multiple updater badges do not ask an older shell to install
// the same downloaded update more than once.
let backgroundInstallRequestedVersion: string | null = null;

export function useDesktopUpdater({
  autoCheckKey = null,
  requiredVersion = null,
}: UseDesktopUpdaterOptions = {}) {
  const desktop = isDesktopShell();
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [checkFeedback, setCheckFeedback] = useState<string | null>(null);
  const lastAutoCheckKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    const api = getDesktopApi();
    let cancelled = false;
    const unsubscribe = api.onUpdateStatus((next) => {
      if (!cancelled) {
        setStatus(next);
        if (next.state !== "idle") setCheckFeedback(null);
      }
    });
    void api
      .getUpdateStatus()
      .then((initial) => {
        if (!cancelled) setStatus(initial);
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus({
            state: "error",
            error:
              error instanceof Error
                ? error.message
                : "Could not read the Desktop update status.",
          });
        }
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [desktop]);

  const checkForUpdates = useCallback(async () => {
    if (!desktop) return;
    const api = getDesktopApi();
    setCheckFeedback(null);
    setStatus((current) =>
      current?.state === "ready" || current?.state === "downloading"
        ? current
        : { state: "checking" }
    );
    try {
      await api.checkForUpdates();
      const next = await api.getUpdateStatus();
      setStatus(next);
      setCheckFeedback(
        desktopUpdateCheckFeedback({ requiredVersion, status: next }),
      );
    } catch (error) {
      setStatus({
        state: "error",
        error:
          error instanceof Error
            ? error.message
            : "Groovy Desktop could not check for updates.",
      });
    }
  }, [desktop, requiredVersion]);

  const installUpdate = useCallback(async () => {
    if (!desktop) return;
    try {
      await getDesktopApi().quitAndInstall();
    } catch (error) {
      setStatus((current) => ({
        state: "error",
        version: current?.version,
        error:
          error instanceof Error
            ? error.message
            : "Groovy Desktop could not install the update.",
      }));
    }
  }, [desktop]);

  useEffect(() => {
    if (
      !desktop ||
      !autoCheckKey ||
      autoCheckKey === lastAutoCheckKeyRef.current
    ) {
      return;
    }
    lastAutoCheckKeyRef.current = autoCheckKey;
    void checkForUpdates();
  }, [autoCheckKey, checkForUpdates, desktop]);

  useEffect(() => {
    if (!desktop || status?.state !== "ready") return;

    const version = status.version || "unknown";
    const installWhenBackgrounded = () => {
      if (
        (document.visibilityState !== "hidden" && document.hasFocus()) ||
        backgroundInstallRequestedVersion === version
      ) {
        return;
      }

      backgroundInstallRequestedVersion = version;
      void getDesktopApi()
        .quitAndInstall()
        .catch((error) => {
          if (backgroundInstallRequestedVersion === version) {
            backgroundInstallRequestedVersion = null;
          }
          setStatus({
            state: "error",
            version: status.version,
            error:
              error instanceof Error
                ? error.message
                : "Groovy Desktop could not install the update.",
          });
        });
    };

    document.addEventListener("visibilitychange", installWhenBackgrounded);
    window.addEventListener("blur", installWhenBackgrounded);
    installWhenBackgrounded();
    return () => {
      document.removeEventListener("visibilitychange", installWhenBackgrounded);
      window.removeEventListener("blur", installWhenBackgrounded);
    };
  }, [desktop, status?.state, status?.version]);

  return {
    desktop,
    status,
    checkFeedback,
    checkForUpdates,
    installUpdate,
  };
}
