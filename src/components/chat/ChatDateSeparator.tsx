import { formatChatCalendarDate } from "@/lib/chat/messageDates";

export function ChatDateSeparator({
  timestamp,
  compact = false,
}: {
  timestamp: string;
  compact?: boolean;
}) {
  const label = formatChatCalendarDate(timestamp);
  if (!label) return null;
  return (
    <div
      className={`flex items-center gap-3 ${
        compact ? "pb-1 pt-3" : "pb-2 pt-4"
      }`}
      role="separator"
      aria-label={label}
    >
      <span className="h-px flex-1 bg-white/[0.07]" />
      <time
        dateTime={timestamp}
        className="shrink-0 rounded-full border border-white/[0.08] bg-[#111318] px-2.5 py-1 text-[9px] font-medium text-zinc-500"
      >
        {label}
      </time>
      <span className="h-px flex-1 bg-white/[0.07]" />
    </div>
  );
}
