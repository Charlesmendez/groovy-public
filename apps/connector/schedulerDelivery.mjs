export function shouldPostScheduledWhatsAppStatus({
  statusPostingEnabled,
  kind,
  hasWhatsAppSender,
  isHeartbeat,
  didSendWhatsApp,
  explicitlyRequiresWhatsAppDelivery,
}) {
  return Boolean(
    statusPostingEnabled &&
      kind === "orchestrator" &&
      hasWhatsAppSender &&
      !isHeartbeat &&
      !didSendWhatsApp &&
      explicitlyRequiresWhatsAppDelivery
  );
}

export function shouldDeferScheduledWhatsAppJob({
  requiresWhatsApp,
  runtimeConfigured,
  bridgeReady,
}) {
  return Boolean(requiresWhatsApp && runtimeConfigured && !bridgeReady);
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJsonValue(value[key])])
    );
  }
  return value;
}

export function getScheduleSyncFingerprint(jobs) {
  const normalized = Array.isArray(jobs)
    ? jobs
        .filter((job) => job && typeof job === "object")
        .slice()
        .sort((left, right) => String(left.id || "").localeCompare(String(right.id || "")))
        .map(stableJsonValue)
    : [];
  return JSON.stringify(normalized);
}
