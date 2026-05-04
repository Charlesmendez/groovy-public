/**
 * Datagran Web Pixel utilities
 * Provides type-safe wrappers for the dgrPixel global
 */

declare global {
  interface Window {
    dgrPixel?: {
      identify: (userId: string, email: string) => void;
      track: (event: string, properties?: Record<string, unknown>) => void;
    };
  }
}

/**
 * Identify a user to Datagran pixel
 * Stitches anonymous behavior to their identity
 */
export function identifyUser(userId: string, email: string): void {
  if (typeof window !== "undefined" && window.dgrPixel) {
    window.dgrPixel.identify(userId, email);
  }
}

/**
 * Track an event to Datagran pixel
 */
export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  if (typeof window !== "undefined" && window.dgrPixel) {
    window.dgrPixel.track(event, properties);
  }
}
