import { timingSafeEqual } from "node:crypto";

function safeSecretEquals(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function schedulerCronSecret(): string | null {
  return (
    process.env.SCHEDULER_CRON_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim() ||
    null
  );
}
export function isSchedulerCronAuthorized(req: Request): boolean {
  const header = req.headers.get("authorization")?.trim() || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const provided = match?.[1]?.trim() || "";
  const configured = [
    process.env.SCHEDULER_CRON_SECRET?.trim(),
    process.env.CRON_SECRET?.trim(),
  ].filter((value): value is string => Boolean(value));
  return Boolean(
    provided && configured.some((expected) => safeSecretEquals(provided, expected))
  );
}
