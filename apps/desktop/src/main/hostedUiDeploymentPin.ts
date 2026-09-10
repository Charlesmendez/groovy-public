export const VERCEL_DEPLOYMENT_PIN_COOKIE = "__vdpl";

export type HostedUiCookieStore = {
  remove(url: string, name: string): Promise<void>;
};

/**
 * Remove Vercel's deployment pin before navigating to the production alias.
 *
 * The pin is useful for a single browser deployment, but a persistent Electron
 * session can retain it after the Desktop shell detects a newer hosted UI. In
 * that case even reloadIgnoringCache() continues loading the old deployment.
 */
export async function clearHostedUiDeploymentPin(
  cookies: HostedUiCookieStore,
  origin: string
): Promise<void> {
  const cookieUrl = new URL("/", origin).toString();
  await cookies.remove(cookieUrl, VERCEL_DEPLOYMENT_PIN_COOKIE);
}
