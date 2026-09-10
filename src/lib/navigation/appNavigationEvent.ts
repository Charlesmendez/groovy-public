// Window event dispatched after an in-app (soft) navigation triggered from
// outside the React tree — for example a service-worker notification tap.
// Screens that encode intent in query params (like the email deep link)
// listen for it because a same-route router.push does not remount them.
export const APP_NAVIGATE_EVENT = "groovy:app-navigate";

export type AppNavigateEventDetail = {
  url: string;
};

export function dispatchAppNavigateEvent(url: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AppNavigateEventDetail>(APP_NAVIGATE_EVENT, {
      detail: { url },
    }),
  );
}
