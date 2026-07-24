export const CHANNEL_SCHEDULE_ACTIONS = ["pause", "resume", "skip"] as const;
export type ChannelScheduleAction = (typeof CHANNEL_SCHEDULE_ACTIONS)[number];

export type PublicChannelSchedule =
  | { type: "once"; run_at?: string }
  | { type: "daily"; hour?: number; minute?: number }
  | { type: "weekly"; weekday?: number; hour?: number; minute?: number }
  | { type: "interval_minutes"; minutes?: number }
  | { type: "custom" };

export type ChannelScheduledTask = {
  id: string;
  name: string;
  kind: "shell" | "orchestrator";
  summary: string;
  schedule: PublicChannelSchedule;
  enabled: boolean;
  skipNextRun: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  updatedAt: string | null;
  targetAgentName: string | null;
  canManage: boolean;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseTeamChatChannelId(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("team_chat:")) {
    return null;
  }
  const channelId = value.slice("team_chat:".length).trim();
  return UUID_PATTERN.test(channelId) ? channelId : null;
}

export function parseChannelScheduleAction(
  value: unknown,
): ChannelScheduleAction | null {
  return typeof value === "string" &&
    CHANNEL_SCHEDULE_ACTIONS.includes(value as ChannelScheduleAction)
    ? (value as ChannelScheduleAction)
    : null;
}

export function canManageChannelSchedules(args: {
  workspaceRole: unknown;
  channelCreatedBy: string;
  userId: string;
}): boolean {
  return (
    args.workspaceRole === "admin" ||
    args.workspaceRole === "member" ||
    args.channelCreatedBy === args.userId
  );
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

export function publicChannelSchedule(
  schedule: unknown,
): PublicChannelSchedule {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return { type: "custom" };
  }
  const value = schedule as Record<string, unknown>;
  if (value.type === "once") {
    const runAt =
      typeof value.run_at === "string" &&
      value.run_at.length <= 100 &&
      Number.isFinite(Date.parse(value.run_at))
        ? value.run_at
        : undefined;
    return runAt ? { type: "once", run_at: runAt } : { type: "once" };
  }
  if (value.type === "daily") {
    return {
      type: "daily",
      hour: safeInteger(value.hour, 0, 23),
      minute: safeInteger(value.minute, 0, 59),
    };
  }
  if (value.type === "weekly") {
    return {
      type: "weekly",
      weekday: safeInteger(value.weekday, 0, 6),
      hour: safeInteger(value.hour, 0, 23),
      minute: safeInteger(value.minute, 0, 59),
    };
  }
  if (value.type === "interval_minutes") {
    return {
      type: "interval_minutes",
      minutes: safeInteger(value.minutes, 1, 525_600),
    };
  }
  return { type: "custom" };
}

export function formatChannelSchedule(schedule: unknown): string {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return "Schedule unavailable";
  }
  const value = schedule as Record<string, unknown>;
  if (value.type === "once") {
    const runAt =
      typeof value.run_at === "string" ? new Date(value.run_at) : null;
    if (!runAt || Number.isNaN(runAt.getTime())) return "Runs once";
    return `Once · ${runAt.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  const hour =
    typeof value.hour === "number" && Number.isInteger(value.hour)
      ? value.hour
      : null;
  const minute =
    typeof value.minute === "number" && Number.isInteger(value.minute)
      ? value.minute
      : null;
  const time =
    hour !== null && minute !== null
      ? new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
      : null;
  if (value.type === "daily") {
    return time ? `Daily · ${time}` : "Daily";
  }
  if (value.type === "weekly") {
    const weekday =
      typeof value.weekday === "number"
        ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
            value.weekday
          ]
        : null;
    return [weekday ? `Every ${weekday}` : "Weekly", time]
      .filter(Boolean)
      .join(" · ");
  }
  if (value.type === "interval_minutes") {
    const minutes =
      typeof value.minutes === "number" && value.minutes > 0
        ? Math.trunc(value.minutes)
        : null;
    return minutes ? `Every ${minutes} minutes` : "Repeating interval";
  }
  return "Custom schedule";
}

export function channelScheduleSummary(args: {
  kind: unknown;
  task: unknown;
}): string {
  if (args.kind !== "orchestrator") return "Local connector task";
  const task =
    args.task && typeof args.task === "object" && !Array.isArray(args.task)
      ? (args.task as Record<string, unknown>)
      : null;
  const message =
    typeof task?.message === "string"
      ? task.message.replace(/\s+/g, " ").trim()
      : "";
  if (!message) return "Scheduled orchestrator task";
  return message.length > 220
    ? `${message.slice(0, 219).trimEnd()}…`
    : message;
}
