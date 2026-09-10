export const AGENT_TASK_COMPLETION_PATH = "/api/agents/tasks/complete";

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function requireHttpOrigin(value) {
  const raw = trimmed(value);
  if (!raw) {
    throw new Error("Missing agent task completion origin");
  }
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Agent task completion origin must use HTTP or HTTPS");
  }
  return url.origin;
}

/**
 * Resolve the only callback URL the relay is allowed to use.
 *
 * The web app can be reached through custom-domain, preview, and redirect
 * aliases. Those aliases are transport details and must not break durable
 * worker completion. The relay owns the trusted callback origin, so an absent
 * or mismatched caller URL safely falls back to that configured origin instead
 * of rejecting an otherwise authenticated task handoff.
 */
export function resolveAgentTaskCompletionUrl(value, configuredOrigin) {
  const canonicalOrigin = requireHttpOrigin(configuredOrigin);
  const canonicalUrl = new URL(
    AGENT_TASK_COMPLETION_PATH,
    canonicalOrigin,
  ).toString();
  const raw = trimmed(value);
  if (!raw) {
    return { url: canonicalUrl, usedCanonicalFallback: true };
  }

  try {
    const url = new URL(raw);
    if (
      url.origin !== canonicalOrigin ||
      url.pathname !== AGENT_TASK_COMPLETION_PATH
    ) {
      return { url: canonicalUrl, usedCanonicalFallback: true };
    }
    url.search = "";
    url.hash = "";
    return { url: url.toString(), usedCanonicalFallback: false };
  } catch {
    return { url: canonicalUrl, usedCanonicalFallback: true };
  }
}
