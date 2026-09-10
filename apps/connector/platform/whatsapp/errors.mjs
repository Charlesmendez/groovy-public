export function isDetachedWhatsAppErrorMessage(message) {
  const raw = typeof message === "string" ? message : String(message || "");
  const lower = raw.trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.includes("bridge_needs_restart") ||
    lower.includes("detached frame") ||
    lower.includes("execution context was destroyed") ||
    lower.includes("target closed") ||
    lower.includes("session closed") ||
    lower.includes("browser has disconnected") ||
    lower.includes("protocol error") ||
    (lower.includes("cannot read properties of undefined") &&
      (lower.includes("'getchat'") ||
        lower.includes("'getchats'") ||
        lower.includes("'sendmessage'") ||
        lower.includes("'findchat'") ||
        lower.includes("'getcontact'") ||
        lower.includes("'modelclass'")))
  );
}
