const OWNER_ONLY_PROVIDERS = new Set(["gmail"]);

export function canUseWorkspaceIntegration(args: {
  provider: string;
  actorUserId: string;
  ownerUserId: string;
}): boolean {
  const provider = args.provider.trim().toLowerCase();
  if (!OWNER_ONLY_PROVIDERS.has(provider)) return true;
  return (
    Boolean(args.actorUserId.trim()) &&
    args.actorUserId.trim() === args.ownerUserId.trim()
  );
}

export function privateIntegrationDenial(provider: string): string {
  const label = provider.trim().toLowerCase() === "gmail" ? "Gmail" : "This data source";
  return `${label} is private to its owner. Workspace membership does not grant mailbox access.`;
}
