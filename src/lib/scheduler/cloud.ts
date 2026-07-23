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

function validTimezone(value: unknown): string {
  const timezone = typeof value === "string" ? value.trim() : "";
  if (!timezone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return "UTC";
  }
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

function scheduleTimezone(job: CloudScheduledJob): string {
  const options =
    job.task?.options && typeof job.task.options === "object"
      ? (job.task.options as Record<string, unknown>)
      : null;
  return validTimezone(job.schedule?.timezone || options?.timezone);
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
  const timezone = scheduleTimezone(job);
  const type = typeof schedule.type === "string" ? schedule.type : "";
  const lastRun = job.last_run_at ? new Date(job.last_run_at) : null;

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
  if (lastRun && calendarKey(zonedParts(lastRun, timezone)) === calendarKey(current)) {
    return { due: false, timezone, reason: "already_ran" };
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
