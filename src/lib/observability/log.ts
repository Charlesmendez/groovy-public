type LogLevel = "info" | "warn" | "error";

const SENSITIVE_KEY_RE =
  /(authorization|cookie|token|secret|password|private[_-]?key|api[_-]?key|signature)/i;

function redactDeep(value: unknown, keyHint?: string): unknown {
  if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) return "[redacted]";
  if (value == null) return value;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, k);
    }
    return out;
  }

  // bigint/symbol/function/etc
  try {
    return String(value);
  } catch {
    return "[unserializable]";
  }
}

export function safeTextPreview(text: string, maxLen = 160): string {
  const t = String(text || "");
  if (!t) return "";
  const oneLine = t.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}

function baseMeta() {
  return {
    ts: new Date().toISOString(),
    env: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
  };
}

export function logEvent(level: LogLevel, event: string, data?: Record<string, unknown>) {
  const payload = {
    level,
    event,
    ...baseMeta(),
    ...(data ? (redactDeep(data) as Record<string, unknown>) : {}),
  };

  try {
    const line = JSON.stringify(payload);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch (e) {
    // Avoid throwing from logging.
    const fallback = {
      level,
      event,
      ...baseMeta(),
      error: e instanceof Error ? e.message : "log_json_failed",
    };
    const line = JSON.stringify(fallback);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

export function logInfo(event: string, data?: Record<string, unknown>) {
  logEvent("info", event, data);
}

export function logWarn(event: string, data?: Record<string, unknown>) {
  logEvent("warn", event, data);
}

export function logError(event: string, data?: Record<string, unknown>) {
  logEvent("error", event, data);
}

