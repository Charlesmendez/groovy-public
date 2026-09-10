export type CloudScheduledJob = {
  id: string;
  user_id: string;
  device_id: string;
  kind?: string | null;
  enabled?: boolean | null;
  schedule?: Record<string, unknown> | null;
  task?: Record<string, unknown> | null;
  target_agent_id?: string | null;
  last_run_at?: string | null;
  skip_next_run?: boolean | null;
};

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function normalizeScheduleTimezone(value: unknown): string | null {
  const timezone = typeof value === "string" ? value.trim() : "";
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function withScheduleTimezone(
  value: unknown,
  timezoneValue: unknown,
): { schedule: Record<string, unknown> | null; changed: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { schedule: null, changed: false };
  }
  const schedule = value as Record<string, unknown>;
  if (schedule.type !== "daily" && schedule.type !== "weekly") {
    return { schedule, changed: false };
  }
  if (normalizeScheduleTimezone(schedule.timezone)) {
    return { schedule, changed: false };
  }
  const timezone = normalizeScheduleTimezone(timezoneValue);
  if (!timezone) return { schedule, changed: false };
  return {
    schedule: { ...schedule, timezone },
    changed: true,
  };
}

/**
 * Interval schedules start counting when they are created. Without an anchor,
 * both the local connector and cloud fallback treat a new interval job as
 * immediately due, which can fire a replacement schedule seconds after the
 * user edited it.
 */
export function initialIntervalScheduleAnchor(
  schedule: unknown,
  now = new Date(),
): string | null {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return null;
  }
  const record = schedule as Record<string, unknown>;
  const minutes = Number(record.minutes);
  if (
    record.type !== "interval_minutes" ||
    !Number.isFinite(minutes) ||
    minutes <= 0
  ) {
    return null;
  }
  return now.toISOString();
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  const weekdayName = parts.find((part) => part.type === "weekday")?.value || "Sun";
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    weekday: WEEKDAY_INDEX[weekdayName] ?? 0,
    hour: value("hour"),
    minute: value("minute"),
  };
}

function calendarKey(parts: ZonedParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function scheduleTimezone(job: CloudScheduledJob): string | null {
  const options =
    job.task?.options && typeof job.task.options === "object"
      ? (job.task.options as Record<string, unknown>)
      : null;
  return (
    normalizeScheduleTimezone(job.schedule?.timezone) ||
    normalizeScheduleTimezone(options?.timezone)
  );
}

export function isCloudScheduleDue(
  job: CloudScheduledJob,
  now = new Date()
): { due: boolean; timezone: string; reason?: string } {
  if (job.enabled === false) return { due: false, timezone: "UTC", reason: "disabled" };
  const schedule = job.schedule;
  if (!schedule || typeof schedule !== "object") {
    return { due: false, timezone: "UTC", reason: "missing_schedule" };
  }
  const type = typeof schedule.type === "string" ? schedule.type : "";
  const configuredTimezone = scheduleTimezone(job);
  const timezone = configuredTimezone || "UTC";
  const parsedLastRun = job.last_run_at ? new Date(job.last_run_at) : null;
  const lastRun =
    parsedLastRun && Number.isFinite(parsedLastRun.getTime())
      ? parsedLastRun
      : null;

  if (type === "once") {
    const runAt = new Date(String(schedule.run_at || ""));
    if (!Number.isFinite(runAt.getTime()) || now < runAt) {
      return { due: false, timezone, reason: "not_due" };
    }
    return {
      due: !lastRun || lastRun < runAt,
      timezone,
      reason: lastRun && lastRun >= runAt ? "already_ran" : undefined,
    };
  }

  if (type === "interval_minutes") {
    const minutes = Number(schedule.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { due: false, timezone, reason: "invalid_interval" };
    }
    return {
      due: !lastRun || now.getTime() - lastRun.getTime() >= minutes * 60_000,
      timezone,
      reason: "not_due",
    };
  }

  // Daily and weekly schedules are defined as connector-local wall-clock
  // times. Running a legacy row with no recorded timezone as UTC can reserve
  // the occurrence hours too early and prevent the connector from running it
  // at the time shown to the user. Leave it to the connector until its IANA
  // timezone has been recorded.
  if (!configuredTimezone) {
    const hasTimezoneValue = Boolean(
      (typeof schedule.timezone === "string" && schedule.timezone.trim()) ||
        (typeof job.task?.options === "object" &&
          job.task.options &&
          typeof (job.task.options as Record<string, unknown>).timezone ===
            "string" &&
          String(
            (job.task.options as Record<string, unknown>).timezone,
          ).trim()),
    );
    return {
      due: false,
      timezone,
      reason: hasTimezoneValue ? "invalid_timezone" : "timezone_required",
    };
  }

  const current = zonedParts(now, timezone);
  const hour = Number(schedule.hour);
  const minute = Number(schedule.minute);
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return { due: false, timezone, reason: "invalid_time" };
  }
  const hasReachedTime =
    current.hour > hour || (current.hour === hour && current.minute >= minute);
  if (!hasReachedTime) return { due: false, timezone, reason: "not_due" };
  if (type === "weekly" && current.weekday !== Number(schedule.weekday)) {
    return { due: false, timezone, reason: "not_due" };
  }
  if (type !== "daily" && type !== "weekly") {
    return { due: false, timezone, reason: "unsupported_schedule" };
  }
  if (lastRun) {
    const lastRunLocal = zonedParts(lastRun, timezone);
    const ranThisOccurrence =
      calendarKey(lastRunLocal) === calendarKey(current) &&
      (lastRunLocal.hour > hour ||
        (lastRunLocal.hour === hour && lastRunLocal.minute >= minute));
    if (ranThisOccurrence) {
      return { due: false, timezone, reason: "already_ran" };
    }
  }
  return { due: true, timezone };
}

const CONNECTOR_INTENT =
  /\b(whats\s*app|browser automation|computer use|terminal|shell command|claude code|codex cli|obsidian|local filesystem|local file|connector tool|send media)\b/i;

export function cloudScheduledJobEligibility(
  job: CloudScheduledJob
): { eligible: boolean; reason?: string } {
  if (job.kind && job.kind !== "orchestrator") {
    return { eligible: false, reason: "job_kind_requires_connector" };
  }
  if (job.target_agent_id) {
    return { eligible: false, reason: "worker_agent_requires_connector" };
  }
  const task = job.task || {};
  const options =
    task.options && typeof task.options === "object"
      ? (task.options as Record<string, unknown>)
      : {};
  const delivery =
    task.delivery && typeof task.delivery === "object"
      ? (task.delivery as Record<string, unknown>)
      : {};
  if (
    options.requires_connector === true ||
    options.cloud_scheduler === false ||
    options.execution_mode === "connector"
  ) {
    return { eligible: false, reason: "task_requires_connector" };
  }
  if (
    delivery.whatsapp === true ||
    options.requires_whatsapp_delivery === true ||
    options.whatsapp_chat_id ||
    options.whatsapp_recipient_query
  ) {
    return { eligible: false, reason: "whatsapp_delivery_requires_connector" };
  }
  if (task.type === "heartbeat_v1" && delivery.whatsapp !== false) {
    return {
      eligible: false,
      reason: "heartbeat_requires_explicit_non_whatsapp_delivery",
    };
  }
  const message = typeof task.message === "string" ? task.message : "";
  if (CONNECTOR_INTENT.test(message)) {
    return { eligible: false, reason: "message_requests_connector_capability" };
  }
  return { eligible: true };
}

const SAFE_CLOUD_RETRY_ERRORS = new Set([
  "Unauthorized",
  "scheduler_dispatch_http_401",
  "scheduled_channel_busy",
  "scheduled_channel_resolution_failed",
]);

/**
 * These failures happen before the scheduled model/tool run starts, so a
 * later cloud tick can safely retry the same occurrence without duplicating
 * side effects.
 */
export function isSafeCloudScheduleRetry(error: unknown): boolean {
  return (
    typeof error === "string" &&
    SAFE_CLOUD_RETRY_ERRORS.has(error.trim())
  );
}
