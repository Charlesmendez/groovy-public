export function isDifferentChatCalendarDate(
  previousTimestamp: string | null | undefined,
  currentTimestamp: string,
): boolean {
  const current = new Date(currentTimestamp);
  if (Number.isNaN(current.getTime())) return false;
  if (!previousTimestamp) return true;
  const previous = new Date(previousTimestamp);
  if (Number.isNaN(previous.getTime())) return true;
  return previous.toDateString() !== current.toDateString();
}

export function formatChatCalendarDate(
  timestamp: string,
  now = new Date(),
): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";

  const calendarDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const dayDifference = Math.round(
    (calendarDay(now).getTime() - calendarDay(date).getTime()) / 86_400_000,
  );
  if (dayDifference === 0) return "Today";
  if (dayDifference === 1) return "Yesterday";

  return date.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear()
      ? {}
      : { year: "numeric" as const }),
  });
}
