import { isDetachedWhatsAppErrorMessage } from "./errors.mjs";

export function getWhatsAppRecycleCheckIntervalMs(recycleIntervalMs) {
  const intervalMs = Number(recycleIntervalMs);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  return Math.max(30_000, Math.min(60_000, Math.floor(intervalMs)));
}

export function getWhatsAppRecycleRetryCooldownMs(reason, recycleIntervalMs) {
  if (reason === "memory_limit" || reason === "cpu_limit") return 2 * 60_000;
  if (reason === "recovery_retry") return 5 * 60_000;
  const intervalMs = Number(recycleIntervalMs);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 15 * 60_000;
  return Math.min(15 * 60_000, intervalMs);
}

export function shouldCheckWhatsAppRecycle({
  nowMs,
  lastCheckAtMs,
  checkIntervalMs,
  activeBridgeOperations,
}) {
  const now = Number(nowMs);
  const lastCheck = Number(lastCheckAtMs);
  const checkInterval = Number(checkIntervalMs);

  if (!Number.isFinite(now) || !Number.isFinite(checkInterval) || checkInterval <= 0) {
    return false;
  }
  if (Number(activeBridgeOperations) > 0) return false;
  if (!Number.isFinite(lastCheck) || lastCheck <= 0) return true;
  return now - lastCheck >= checkInterval;
}

export function getWhatsAppRecycleDecision({
  nowMs,
  lastRecycleAtMs,
  lastBridgeActivityAtMs,
  recycleIntervalMs,
  recycleIdleMs,
  recycleMaxAgeMs,
  memoryRssBytes,
  memoryLimitBytes,
  cpuPercent = 0,
  cpuLimitPercent = 0,
  consecutiveHighCpuChecks = 0,
  requiredHighCpuChecks = 3,
  activeBridgeOperations,
  ready,
  qrPending,
  authFailure,
  disconnected,
  recoveryPending = false,
}) {
  const now = Number(nowMs);
  const lastRecycle = Number(lastRecycleAtMs);
  const lastActivity = Number(lastBridgeActivityAtMs);
  const interval = Number(recycleIntervalMs);
  const idleThreshold = Number(recycleIdleMs);
  const maxAge = Number(recycleMaxAgeMs);
  const memoryRss = Math.max(0, Number(memoryRssBytes) || 0);
  const memoryLimit = Math.max(0, Number(memoryLimitBytes) || 0);
  const cpu = Math.max(0, Number(cpuPercent) || 0);
  const cpuLimit = Math.max(0, Number(cpuLimitPercent) || 0);
  const highCpuChecks = Math.max(0, Math.trunc(Number(consecutiveHighCpuChecks) || 0));
  const requiredCpuChecks = Math.max(1, Math.trunc(Number(requiredHighCpuChecks) || 3));
  const ageMs = Math.max(0, now - lastRecycle);
  const idleMs = Math.max(0, now - lastActivity);

  if (!Number.isFinite(now) || !Number.isFinite(lastRecycle) || !Number.isFinite(lastActivity)) {
    return { due: false, reason: "invalid_clock", ageMs: 0, idleMs: 0, forced: false };
  }
  if (Number(activeBridgeOperations) > 0) {
    return { due: false, reason: "active_operation", ageMs, idleMs, forced: false };
  }
  if (qrPending) {
    return { due: false, reason: "bridge_not_ready", ageMs, idleMs, forced: false };
  }
  if (!ready && recoveryPending) {
    const permanentAuthFailure =
      Boolean(authFailure) && !isDetachedWhatsAppErrorMessage(authFailure);
    const permanentDisconnect =
      Boolean(disconnected) && !isDetachedWhatsAppErrorMessage(disconnected);
    if (permanentAuthFailure || permanentDisconnect) {
      return { due: false, reason: "bridge_not_ready", ageMs, idleMs, forced: false };
    }
    return {
      due: true,
      reason: "recovery_retry",
      ageMs,
      idleMs,
      forced: true,
    };
  }
  if (authFailure || disconnected) {
    return { due: false, reason: "bridge_not_ready", ageMs, idleMs, forced: false };
  }
  if (!ready) {
    return { due: false, reason: "bridge_not_ready", ageMs, idleMs, forced: false };
  }

  if (memoryLimit > 0 && memoryRss >= memoryLimit) {
    return {
      due: true,
      reason: "memory_limit",
      ageMs,
      idleMs,
      forced: true,
      memoryRssBytes: memoryRss,
      memoryLimitBytes: memoryLimit,
    };
  }

  if (cpuLimit > 0 && cpu >= cpuLimit && highCpuChecks >= requiredCpuChecks) {
    return {
      due: true,
      reason: "cpu_limit",
      ageMs,
      idleMs,
      forced: true,
      cpuPercent: cpu,
      cpuLimitPercent: cpuLimit,
      consecutiveHighCpuChecks: highCpuChecks,
    };
  }

  if (!Number.isFinite(interval) || interval <= 0) {
    return { due: false, reason: "disabled", ageMs, idleMs, forced: false };
  }

  const intervalDue = ageMs >= interval;
  const maxAgeDue = Number.isFinite(maxAge) && maxAge > 0 && ageMs >= maxAge;
  if (!intervalDue && !maxAgeDue) {
    return { due: false, reason: "interval_not_elapsed", ageMs, idleMs, forced: false };
  }
  if (!maxAgeDue && idleMs < Math.max(0, idleThreshold)) {
    return { due: false, reason: "not_idle", ageMs, idleMs, forced: false };
  }

  return {
    due: true,
    reason: maxAgeDue ? "max_age" : "idle_interval",
    ageMs,
    idleMs,
    forced: maxAgeDue,
  };
}

export function getWhatsAppRecycleCircuitDecision({
  nowMs,
  pressureRecycleTimestampsMs = [],
  reason,
  windowMs = 60 * 60_000,
  maxPressureRecycles = 2,
}) {
  const now = Number(nowMs);
  const window = Math.max(60_000, Number(windowMs) || 60 * 60_000);
  const maxRecycles = Math.max(1, Math.trunc(Number(maxPressureRecycles) || 2));
  const recentTimestampsMs = Array.isArray(pressureRecycleTimestampsMs)
    ? pressureRecycleTimestampsMs
        .map(Number)
        .filter((timestamp) => Number.isFinite(timestamp) && timestamp <= now && now - timestamp < window)
        .sort((a, b) => a - b)
    : [];
  const pressureReason = reason === "memory_limit" || reason === "cpu_limit";
  if (!pressureReason || !Number.isFinite(now)) {
    return { open: false, recentTimestampsMs, recordAttempt: false };
  }
  if (recentTimestampsMs.length >= maxRecycles) {
    return {
      open: true,
      reason: "resource_restart_loop",
      recentTimestampsMs,
      recordAttempt: false,
    };
  }
  return {
    open: false,
    recentTimestampsMs: [...recentTimestampsMs, now],
    recordAttempt: true,
  };
}

export function getRssGrowthRateMbPerMin(previousSample, currentSample) {
  const previousAt = Number(previousSample?.atMs);
  const currentAt = Number(currentSample?.atMs);
  const previousRss = Number(previousSample?.rssBytes);
  const currentRss = Number(currentSample?.rssBytes);
  if (
    !Number.isFinite(previousAt) ||
    !Number.isFinite(currentAt) ||
    currentAt <= previousAt ||
    !Number.isFinite(previousRss) ||
    !Number.isFinite(currentRss)
  ) {
    return null;
  }
  return ((currentRss - previousRss) / 1024 / 1024) / ((currentAt - previousAt) / 60_000);
}
