export function recipientTrackingRolloutEnabledForUser(
  userId: string,
  configuredUserIds = process.env
    .EMAIL_RECIPIENT_TRACKING_ENABLED_USER_IDS,
  userEmail = "",
  configuredEmails = process.env
    .EMAIL_RECIPIENT_TRACKING_ENABLED_EMAILS,
): boolean {
  const user = userId.trim();
  const email = userEmail.trim().toLowerCase();
  const enabledUserIds = new Set(
    (configuredUserIds || "")
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const enabledEmails = new Set(
    (configuredEmails || "")
      .split(/[\s,]+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return (
    enabledUserIds.has("*") ||
    (Boolean(user) && enabledUserIds.has(user)) ||
    enabledEmails.has("*") ||
    (Boolean(email) && enabledEmails.has(email))
  );
}
