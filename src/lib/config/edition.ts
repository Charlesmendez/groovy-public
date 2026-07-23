export type GroovyEdition = "cloud" | "self-hosted";

function normalizeEdition(value: string | undefined): GroovyEdition | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "cloud") return "cloud";
  if (
    normalized === "self-hosted" ||
    normalized === "self_hosted" ||
    normalized === "selfhosted"
  ) {
    return "self-hosted";
  }
  return null;
}

/**
 * Edition is an explicit deployment boundary. Self-hosting must be opted into
 * with GROOVY_EDITION=self-hosted (the supplied Compose stack does this).
 * Failing closed to cloud prevents a missing Stripe variable on a hosted
 * deployment from silently disabling product access controls.
 */
export function getEdition(): GroovyEdition {
  return normalizeEdition(process.env.GROOVY_EDITION) || "cloud";
}

export function isSelfHosted(): boolean {
  return getEdition() === "self-hosted";
}
