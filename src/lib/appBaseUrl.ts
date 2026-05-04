function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstHeaderValue(value: string): string {
  const first = value.split(",")[0];
  return first ? first.trim() : "";
}

function parseOrigin(value: string): URL | null {
  const input = trimmed(value).replace(/\/+$/, "");
  if (!input) return null;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string): boolean {
  const host = trimmed(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  if (host.endsWith(".local")) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (!host.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  return false;
}

function isLocalOrigin(origin: string | null): boolean {
  const parsed = origin ? parseOrigin(origin) : null;
  return parsed ? isLocalHostname(parsed.hostname) : false;
}

function getRequestOrigin(req: Request): string | null {
  try {
    return new URL(req.url).origin;
  } catch {
    return null;
  }
}

function getForwardedOrigin(req: Request): string | null {
  const proto = firstHeaderValue(trimmed(req.headers.get("x-forwarded-proto") || "")).toLowerCase();
  const host = firstHeaderValue(trimmed(req.headers.get("x-forwarded-host") || ""));
  if ((proto !== "http" && proto !== "https") || !host) return null;
  return parseOrigin(`${proto}://${host}`)?.origin ?? null;
}

function getHostOrigin(req: Request): string | null {
  const host = firstHeaderValue(trimmed(req.headers.get("host") || ""));
  if (!host) return null;
  const forwardedProto = firstHeaderValue(trimmed(req.headers.get("x-forwarded-proto") || "")).toLowerCase();
  const requestOrigin = getRequestOrigin(req);
  const requestProto = requestOrigin ? new URL(requestOrigin).protocol.replace(/:$/, "") : "";
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : requestProto === "http" || requestProto === "https"
        ? requestProto
        : "http";
  return parseOrigin(`${proto}://${host}`)?.origin ?? null;
}

export function resolveAppBaseUrl(req: Request): string | null {
  const requestOrigin = getRequestOrigin(req);
  const forwardedOrigin = getForwardedOrigin(req);
  const hostOrigin = getHostOrigin(req);
  const envOrigin = parseOrigin(process.env.NEXT_PUBLIC_APP_URL || "")?.origin ?? null;
  const hasProxyHints = Boolean(
    trimmed(req.headers.get("x-forwarded-host") || "") ||
      trimmed(req.headers.get("x-forwarded-proto") || "")
  );

  if (isLocalOrigin(requestOrigin)) {
    if (forwardedOrigin && !isLocalOrigin(forwardedOrigin)) return forwardedOrigin;
    if (hostOrigin && !isLocalOrigin(hostOrigin)) return hostOrigin;
    if (hasProxyHints && envOrigin) return envOrigin;
  }

  return requestOrigin || forwardedOrigin || hostOrigin || envOrigin;
}
