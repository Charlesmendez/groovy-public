export function isWhatsAppBatteryProtectionStop(source, reason) {
  const sourceKey = String(source || "").trim();
  const errorReason = String(reason || "").trim();
  return (
    sourceKey === "resource_circuit_open" ||
    sourceKey === "compatible_browser_not_found" ||
    sourceKey === "supported_browser_not_found" ||
    sourceKey === "profile_rotation_failed" ||
    errorReason.includes("resource_circuit_open") ||
    errorReason.includes("compatible_browser_not_found") ||
    errorReason.includes("supported_browser_not_found") ||
    errorReason.includes("profile_rotation_failed")
  );
}

export function shouldCountWhatsAppFailureTowardAutoRestart({
  schedulerScoped,
  source,
  reason,
}) {
  return !schedulerScoped && !isWhatsAppBatteryProtectionStop(source, reason);
}
