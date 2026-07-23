/** Canonical comparison key for connector-reported local workspace paths. */
export function canonicalWorkspacePath(root: string | null | undefined): string {
  const clean = (root || "").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const parts: string[] = [];
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const prefix = clean.startsWith("/") ? "/" : "";
  // Preserve case: connectors can target case-sensitive volumes and hosts.
  // NFC still handles visually identical Unicode path segments.
  return `${prefix}${parts.join("/")}`.normalize("NFC");
}
