/**
 * Single source of truth for connector version gating in the web app.
 *
 * MIN_CONNECTOR_VERSION: soft-warn minimum — the dashboard nags (and offers
 * self-update) below this, but tools keep working.
 * SELF_UPDATE_MIN_CONNECTOR_VERSION: oldest version that supports the
 * in-place `connector_update` relay flow.
 */

export const MIN_CONNECTOR_VERSION = "0.24.15";
export const SELF_UPDATE_MIN_CONNECTOR_VERSION = "0.23.1";

/** Parse "v1.2.3-beta.1" → { nums: [1,2,3], prerelease: "beta.1" | null }. */
function parseVersion(version: string): { nums: number[]; prerelease: string | null } {
  const cleaned = version.trim().replace(/^v/i, "");
  const [core, ...rest] = cleaned.split("-");
  return {
    nums: core.split(".").map(Number),
    prerelease: rest.length > 0 ? rest.join("-") : null,
  };
}

/** True when `version` is missing or older than `minVersion` (semver-ish x.y.z). */
export function isConnectorVersionOutdated(
  version: string | null | undefined,
  minVersion: string
): boolean {
  if (!version) return true;
  const v = parseVersion(version);
  const min = parseVersion(minVersion);
  for (let i = 0; i < 3; i++) {
    if ((v.nums[i] || 0) < (min.nums[i] || 0)) return true;
    if ((v.nums[i] || 0) > (min.nums[i] || 0)) return false;
  }
  // Same x.y.z: a prerelease (e.g. -beta.1) is OLDER than the release.
  if (v.prerelease && !min.prerelease) return true;
  return false;
}
