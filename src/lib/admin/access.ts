const fallbackAdminEmails = ["charlesmendez@hotmail.com"];

export function isGroovyAdminEmail(email?: string | null): boolean {
  const envAllowlist = process.env.GROOVY_ADMIN_EMAILS || process.env.HOSTED_MAC_ADMIN_EMAILS || "";
  if (!email) return false;
  const allowlist = envAllowlist.trim()
    ? envAllowlist
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    : fallbackAdminEmails;
  return allowlist
    .map((entry) => entry.trim().toLowerCase())
    .includes(email.toLowerCase());
}
