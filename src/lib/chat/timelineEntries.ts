type TimelineMessage = {
  id: string;
  created_at: string;
};

type TimelineWorkItem<T> = {
  key: string;
  startedAt: string;
  anchorMessageId?: string | null;
  value: T;
};

export type ChatTimelineEntry<TMessage extends TimelineMessage, TWork> =
  | {
      kind: "message";
      key: string;
      timestamp: string;
      sourceIndex: number;
      message: TMessage;
    }
  | {
      kind: "work";
      key: string;
      timestamp: string;
      sourceIndex: number;
      work: TWork;
    };

function timelineTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function mergeChronologicalChatTimeline<
  TMessage extends TimelineMessage,
  TWork,
>(
  messages: readonly TMessage[],
  workItems: readonly TimelineWorkItem<TWork>[],
): Array<ChatTimelineEntry<TMessage, TWork>> {
  // Work whose true position predates the loaded message window has no
  // representable slot in scrollback; pinning it after the newest message
  // keeps actionable cards (approvals, running-task controls) on screen
  // instead of sorting them above the viewport.
  const oldestLoadedMessageTimestamp = messages.length
    ? timelineTimestamp(messages[0].created_at)
    : null;
  const workSortTimestamp = (startedAt: string): number => {
    const parsed = timelineTimestamp(startedAt);
    return oldestLoadedMessageTimestamp !== null &&
      parsed < oldestLoadedMessageTimestamp
      ? Number.MAX_SAFE_INTEGER
      : parsed;
  };
  const entries: Array<
    ChatTimelineEntry<TMessage, TWork> & {
      stableOrder: number;
      sortTimestamp: number;
    }
  > = [
    ...messages.map((message, sourceIndex) => ({
      kind: "message" as const,
      key: `message:${message.id}`,
      timestamp: message.created_at,
      sourceIndex,
      message,
      stableOrder: sourceIndex * 2,
      sortTimestamp: timelineTimestamp(message.created_at),
    })),
    ...workItems.map((work, sourceIndex) => ({
      kind: "work" as const,
      key: `work:${work.key}`,
      timestamp: work.startedAt,
      sourceIndex,
      work: work.value,
      // When two entries have the exact same timestamp, show the triggering
      // message before the work it started.
      stableOrder: messages.length * 2 + sourceIndex,
      sortTimestamp: workSortTimestamp(work.startedAt),
    })),
  ];

  const sortedEntries = entries
    .sort(
      (left, right) =>
        left.sortTimestamp - right.sortTimestamp ||
        left.stableOrder - right.stableOrder,
    )
    .map((entry) =>
      entry.kind === "message"
        ? {
            kind: entry.kind,
            key: entry.key,
            timestamp: entry.timestamp,
            sourceIndex: entry.sourceIndex,
            message: entry.message,
          }
        : {
            kind: entry.kind,
            key: entry.key,
            timestamp: entry.timestamp,
            sourceIndex: entry.sourceIndex,
            work: entry.work,
          },
    );

  const loadedMessageIds = new Set(messages.map((message) => message.id));
  const anchoredByMessageId = new Map<
    string,
    Array<ChatTimelineEntry<TMessage, TWork>>
  >();
  const unanchored: Array<ChatTimelineEntry<TMessage, TWork>> = [];
  for (const entry of sortedEntries) {
    if (entry.kind !== "work") {
      unanchored.push(entry);
      continue;
    }
    const anchorMessageId =
      workItems[entry.sourceIndex]?.anchorMessageId || null;
    if (!anchorMessageId || !loadedMessageIds.has(anchorMessageId)) {
      unanchored.push(entry);
      continue;
    }
    anchoredByMessageId.set(anchorMessageId, [
      ...(anchoredByMessageId.get(anchorMessageId) || []),
      entry,
    ]);
  }

  if (anchoredByMessageId.size === 0) return unanchored;
  return unanchored.flatMap((entry) =>
    entry.kind === "message"
      ? [entry, ...(anchoredByMessageId.get(entry.message.id) || [])]
      : [entry],
  );
}
