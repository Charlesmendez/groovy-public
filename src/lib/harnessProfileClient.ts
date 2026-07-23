// Client-side "active harness profile" selection for the dashboard command
// bar. Kept in localStorage so the choice survives reloads; useOrchestrator
// reads it at send time and the server makes it sticky on the session.

const KEY = "groovy.activeProfileId";
export const BUILT_IN_PROFILE_ID = "__default__";
export const PROFILE_CHANGED_EVENT = "groovy:profile-changed";

export function getActiveProfileId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setActiveProfileId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
    window.dispatchEvent(new Event(PROFILE_CHANGED_EVENT));
  } catch {
    // ignore storage failures (private mode etc.)
  }
}
