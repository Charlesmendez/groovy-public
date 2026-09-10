function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workerNamePattern(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join("\\s+");
}

export function explicitlyRequestsWorker(args: {
  message: string;
  workerNames: string[];
}): boolean {
  const message = String(args.message || "");
  return args.workerNames.some((rawName) => {
    const name = workerNamePattern(String(rawName || ""));
    if (!name) return false;
    return (
      new RegExp(`@${name}\\b`, "i").test(message) ||
      new RegExp(
        `\\b(?:ask|tell|have|assign|delegate|send)(?:\\s+this)?\\s+(?:to\\s+)?@?${name}\\b`,
        "i",
      ).test(message) ||
      new RegExp(`^\\s*@?${name}\\s*[:,]`, "i").test(message)
    );
  });
}

/**
 * Short evidence-gathering work belongs to the Mind's local CLI. Repository
 * edits and explicit worker assignments continue through the worker harness.
 */
export function shouldUseDirectLocalCliForDiagnostic(args: {
  message: string;
  workerNames?: string[];
}): boolean {
  const message = String(args.message || "").trim();
  if (!message || message.length > 1_500) return false;
  if (
    explicitlyRequestsWorker({
      message,
      workerNames: args.workerNames || [],
    })
  ) {
    return false;
  }

  const requestsMutation =
    /\b(?:fix|implement|modify|edit|refactor|create|write|add|remove|delete|deploy|redeploy|rollback|install|upgrade|migrate|rewrite|ship|release)\b/i.test(
      message,
    );
  const requestsBroadReview =
    /\b(?:comprehensive|entire\s+(?:repo|repository|codebase)|full\s+code\s+review|multi-file|architecture\s+review)\b/i.test(
      message,
    );
  if (requestsMutation || requestsBroadReview) return false;

  const hasDiagnosticIntent =
    /\b(?:check|inspect|look\s+up|show|retrieve|get|find|verify|diagnose|investigate|trace|explain|why|reason)\b/i.test(
      message,
    );
  const hasCliEvidenceTarget =
    /\b(?:logs?|status|failure|failed|failing|errors?|deployment|build|commit|branch|authentication|auth|permissions?|version|configuration|config|process|service|health|network|dns|cli)\b/i.test(
      message,
    );

  return hasDiagnosticIntent && hasCliEvidenceTarget;
}
