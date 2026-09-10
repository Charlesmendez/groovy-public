const TEAM_CHAT_LIVE_TEXT_MAX_CHARS = 20_000;
const TEAM_CHAT_LIVE_TOOL_INPUT_MAX_CHARS = 500;
const TEAM_CHAT_LIVE_TOOLS_MAX = 8;
const TEAM_CHAT_LIVE_EVENTS_MAX = 120;
const TEAM_CHAT_LIVE_EVENTS_MAX_CHARS = 20_000;

export type TeamChatAgentLiveTool = {
  name: string;
  input: string;
};

export type TeamChatAgentLiveEvent =
  | {
      seq: number;
      type: "assistant";
      content: string;
    }
  | {
      seq: number;
      type: "tool_use";
      name: string;
      input: string;
    };

export type TeamChatAgentProgress = {
  liveText: string;
  liveTextTruncated: boolean;
  liveTools: TeamChatAgentLiveTool[];
  liveEvents: TeamChatAgentLiveEvent[];
  liveEventCount: number;
  liveEventsTruncated: boolean;
  progressUpdatedAt: string | null;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function redactSecretLikeText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      "[redacted private key]",
    )
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|client[_ -]?secret)\s*([:=])\s*([^\s"',;]{8,})/gi,
      "$1$2 [redacted]",
    )
    .replace(/\bbearer\s+[a-z0-9._~+/-]{16,}/gi, "Bearer [redacted]")
    .replace(/\bsk-(?:ant-|proj-|live-)?[a-zA-Z0-9_-]{16,}\b/g, "[redacted key]")
    .replace(/\bgh[pousr]_[a-zA-Z0-9]{20,}\b/g, "[redacted token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted access key]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted key]")
    .replace(/\bxox[baprs]-[a-zA-Z0-9-]{16,}\b/g, "[redacted token]")
    .replace(/\b(?:sk|rk)_live_[a-zA-Z0-9]{16,}\b/g, "[redacted key]")
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^/\s@]{8,}@/gi,
      "$1:[redacted]@",
    );
}

/**
 * Projects an agent task's internal result metadata into the narrow progress
 * payload that channel participants may see. Billing, relay, connector, and
 * orchestration metadata must never cross this boundary.
 */
export function publicTeamChatAgentProgress(
  resultMeta: Record<string, unknown> | null | undefined,
): TeamChatAgentProgress {
  const meta = resultMeta || {};
  const rawText = redactSecretLikeText(stringValue(meta.live_text));
  const liveTextWasTrimmed =
    rawText.length > TEAM_CHAT_LIVE_TEXT_MAX_CHARS;
  const liveText = liveTextWasTrimmed
    ? rawText.slice(-TEAM_CHAT_LIVE_TEXT_MAX_CHARS)
    : rawText;
  const rawTools = Array.isArray(meta.live_tools) ? meta.live_tools : [];
  const liveTools = rawTools
    .filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && !Array.isArray(item),
    )
    .map((item) => ({
      name: stringValue(item.name).trim().slice(0, 120),
      input: redactSecretLikeText(stringValue(item.input))
        .trim()
        .slice(0, TEAM_CHAT_LIVE_TOOL_INPUT_MAX_CHARS),
    }))
    .filter((item) => item.name)
    .slice(-TEAM_CHAT_LIVE_TOOLS_MAX);
  const rawEvents = Array.isArray(meta.live_events) ? meta.live_events : [];
  let eventContentWasTrimmed = false;
  const parsedEvents = rawEvents
    .filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && !Array.isArray(item),
    )
    .map((item, index): TeamChatAgentLiveEvent | null => {
      const parsedSequence = Number(item.seq);
      const seq =
        Number.isFinite(parsedSequence) && parsedSequence > 0
          ? parsedSequence
          : index + 1;
      if (item.type === "assistant") {
        const redacted = redactSecretLikeText(stringValue(item.content));
        if (!redacted) return null;
        const content =
          redacted.length > TEAM_CHAT_LIVE_EVENTS_MAX_CHARS
            ? redacted.slice(-TEAM_CHAT_LIVE_EVENTS_MAX_CHARS)
            : redacted;
        if (content.length < redacted.length) eventContentWasTrimmed = true;
        return { seq, type: "assistant", content };
      }
      if (item.type === "tool_use") {
        const name = stringValue(item.name).trim().slice(0, 120);
        if (!name) return null;
        const input = redactSecretLikeText(stringValue(item.input))
          .trim()
          .slice(0, TEAM_CHAT_LIVE_TOOL_INPUT_MAX_CHARS);
        return { seq, type: "tool_use", name, input };
      }
      return null;
    })
    .filter((item): item is TeamChatAgentLiveEvent => item !== null);
  const recentEvents = parsedEvents.slice(-TEAM_CHAT_LIVE_EVENTS_MAX);
  let eventChars = recentEvents.reduce(
    (total, event) =>
      total +
      (event.type === "assistant"
        ? event.content.length
        : event.input.length),
    0,
  );
  while (
    recentEvents.length > 1 &&
    eventChars > TEAM_CHAT_LIVE_EVENTS_MAX_CHARS
  ) {
    const removed = recentEvents.shift();
    if (!removed) break;
    eventChars -=
      removed.type === "assistant"
        ? removed.content.length
        : removed.input.length;
  }
  const explicitEventCount = Number(meta.live_event_count);
  const liveEventCount =
    Number.isFinite(explicitEventCount) && explicitEventCount >= 0
      ? explicitEventCount
      : rawEvents.length;

  return {
    liveText,
    liveTextTruncated:
      meta.live_text_truncated === true || liveTextWasTrimmed,
    liveTools,
    liveEvents: recentEvents,
    liveEventCount,
    liveEventsTruncated:
      meta.live_events_truncated === true ||
      eventContentWasTrimmed ||
      recentEvents.length < parsedEvents.length,
    progressUpdatedAt:
      typeof meta.progress_updated_at === "string"
        ? meta.progress_updated_at
        : null,
  };
}
