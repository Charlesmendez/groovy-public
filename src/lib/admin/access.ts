export function isGroovyAdminEmail(email?: string | null): boolean {
  const allowlist = process.env.GROOVY_ADMIN_EMAILS || process.env.HOSTED_MAC_ADMIN_EMAILS || "";
  if (!email || !allowlist.trim()) return false;
  return allowlist
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}
