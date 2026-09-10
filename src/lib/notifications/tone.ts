export const UNIFIED_DESKTOP_NOTIFICATION_TONE_VERSION = "0.24.27";

function numericVersionParts(version: string | null): number[] | null {
  if (!version) return null;
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

export function desktopUsesUnifiedNotificationTone(
  version: string | null,
): boolean {
  const current = numericVersionParts(version);
  const minimum = numericVersionParts(
    UNIFIED_DESKTOP_NOTIFICATION_TONE_VERSION,
  );
  if (!current || !minimum) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] !== minimum[index]) {
      return current[index] > minimum[index];
    }
  }
  return true;
}
