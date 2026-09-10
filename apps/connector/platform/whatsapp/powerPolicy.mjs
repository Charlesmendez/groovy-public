import { getWhatsAppRecycleCheckIntervalMs } from "./recycle.mjs";

function parseSwitch(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on", "enabled"].includes(raw)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(raw)) return false;
  return null;
}

export function resolveInboundPollIntervalMs(value) {
  const intervalMs = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(intervalMs)) {
    if (intervalMs <= 0) return 0;
    return Math.max(30_000, Math.min(15 * 60_000, intervalMs));
  }
  return 60_000;
}

export function resolveWhatsAppImageBlocking({ option, envValue } = {}) {
  if (typeof option === "boolean") return option;
  return parseSwitch(envValue) === true;
}

export function resolveWhatsAppResourceMonitorPolicy({
  recycleIntervalMs,
  memoryLimitBytes,
  cpuLimitPercent,
} = {}) {
  const timeBasedRecycleEnabled = Number(recycleIntervalMs) > 0;
  const resourceGuardsEnabled =
    Number(memoryLimitBytes) > 0 || Number(cpuLimitPercent) > 0;
  const enabled = timeBasedRecycleEnabled || resourceGuardsEnabled;
  const checkIntervalMs = !enabled
    ? 0
    : timeBasedRecycleEnabled
      ? getWhatsAppRecycleCheckIntervalMs(recycleIntervalMs)
      : 60_000;
  return {
    enabled,
    timeBasedRecycleEnabled,
    resourceGuardsEnabled,
    checkIntervalMs,
  };
}
