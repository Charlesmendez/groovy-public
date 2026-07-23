export function inferScheduledWhatsAppDeliveryIntent(message: unknown): boolean {
  const normalized = String(message || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;

  // Explicit connector tool instructions are unambiguous delivery intent.
  if (
    normalized.includes("whatsapp_send_text") ||
    normalized.includes("whatsapp_send_media") ||
    normalized.includes("whatsapp_send_default_group") ||
    normalized.includes("whatsapp_resolve_recipient")
  ) {
    return true;
  }

  const hasSendVerb = /\b(send|text|message|deliver|post|notify|share)\b/.test(normalized);
  const hasChatTarget = /\b(group|chat|team|recipient|thread|channel)\b/.test(normalized);
  const mentionsWhatsApp = /\bwhats\s*app\b/.test(normalized);

  // A product/code reference to WhatsApp is not permission to send anything.
  // Require an actual delivery verb or an explicit WhatsApp destination phrase.
  if (mentionsWhatsApp) {
    return (
      hasSendVerb ||
      /\b(?:via|on|to)\s+whats\s*app\b/.test(normalized) ||
      /\bwhats\s*app\s+(?:group|chat|recipient|thread|channel)\b/.test(normalized)
    );
  }

  if (
    normalized.includes("email") ||
    normalized.includes("gmail") ||
    normalized.includes("slack") ||
    normalized.includes("discord") ||
    normalized.includes("telegram") ||
    normalized.includes("twilio") ||
    normalized.includes("sms") ||
    normalized.includes("phone call") ||
    normalized.includes(" call ") ||
    normalized.includes("signal") ||
    normalized.includes("imessage") ||
    normalized.includes("microsoft teams") ||
    normalized.includes("teams")
  ) {
    return false;
  }

  // Preserve the existing default-group shorthand: "send this to the team".
  return hasSendVerb && hasChatTarget;
}
