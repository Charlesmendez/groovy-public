/**
 * Do not hand external users bearer-style internal storage URLs. Public
 * profiles may still describe a generated artifact, but signed internal URLs
 * must be exchanged through an explicit customer-safe delivery tool.
 */
export function filterExternalHarnessOutput(value: string): string {
  return String(value || "").replace(
    /https?:\/\/[^\s)"']+\/storage\/v1\/object\/sign\/[^\s)"']+(?:token=|[?&]token%3D)[^\s)"']+/gi,
    "[private file link omitted]",
  );
}
