import type { DesktopUpdateStatus } from "@/lib/desktop/shell";

export function desktopUpdateCheckFeedback(args: {
  requiredVersion?: string | null;
  status: DesktopUpdateStatus;
}): string | null {
  if (!args.requiredVersion || args.status.state !== "idle") return null;
  return `Groovy Desktop ${args.requiredVersion} has not reached the updater feed yet. Try again shortly.`;
}
