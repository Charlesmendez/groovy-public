import * as path from "path";

/**
 * Build the command line for a connector owned by Groovy Desktop.
 *
 * Desktop is the single lifecycle owner, so it must take over any orphaned
 * standalone or pre-update process holding the connector PID lock. Without
 * --kill-others, the managed child exits successfully and Desktop can retry
 * forever while the stale process keeps reporting its old version.
 */
export function buildManagedConnectorArgs(input: {
  connectorDir: string;
  relayUrl: string;
  extraArgs?: string[];
}): string[] {
  return [
    path.join(input.connectorDir, "connector.mjs"),
    "--relay",
    input.relayUrl,
    "--no-autostart",
    "--kill-others",
    ...(input.extraArgs || []),
  ];
}
