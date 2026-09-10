const MAX_ORCHESTRATOR_PROGRESS_EVENTS = 12;

export type OrchestratorProgressEvent = {
  id: number;
  toolName: string;
  agent: string | null;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
};

export type OrchestratorProgress = {
  events: OrchestratorProgressEvent[];
  updatedAt: string | null;
};

export type OrchestratorToolEvent = {
  phase: "start" | "end";
  toolName: string;
  agent?: string;
  success?: boolean;
};

function text(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/[\r\n]+/g, " ").slice(0, maxLength)
    : "";
}

export function publicOrchestratorProgress(
  value: unknown,
): OrchestratorProgress {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const rawEvents = Array.isArray(record.events) ? record.events : [];
  const events = rawEvents
    .filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && !Array.isArray(item),
    )
    .map((item, index): OrchestratorProgressEvent | null => {
      const toolName = text(item.toolName, 120);
      if (!toolName) return null;
      const status =
        item.status === "completed" || item.status === "failed"
          ? item.status
          : "running";
      const parsedId = Number(item.id);
      return {
        id: Number.isFinite(parsedId) && parsedId > 0 ? parsedId : index + 1,
        toolName,
        agent: text(item.agent, 120) || null,
        status,
        startedAt: text(item.startedAt, 40),
        finishedAt: text(item.finishedAt, 40) || null,
      };
    })
    .filter((event): event is OrchestratorProgressEvent => event !== null)
    .slice(-MAX_ORCHESTRATOR_PROGRESS_EVENTS);

  return {
    events,
    updatedAt: text(record.updatedAt, 40) || null,
  };
}

export function appendOrchestratorProgressEvent(
  current: OrchestratorProgress,
  event: OrchestratorToolEvent,
  now = new Date().toISOString(),
): OrchestratorProgress {
  const toolName = text(event.toolName, 120);
  if (!toolName) return current;
  const events = [...current.events];
  let changed = false;

  if (event.phase === "start") {
    const existingOpen = [...events]
      .reverse()
      .find(
        (candidate) =>
          candidate.toolName === toolName && candidate.status === "running",
      );
    if (!existingOpen) {
      events.push({
        id: (events[events.length - 1]?.id || 0) + 1,
        toolName,
        agent: text(event.agent, 120) || null,
        status: "running",
        startedAt: now,
        finishedAt: null,
      });
      changed = true;
    }
  } else {
    let openIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (
        events[index]?.toolName === toolName &&
        events[index]?.status === "running"
      ) {
        openIndex = index;
        break;
      }
    }
    if (openIndex >= 0) {
      events[openIndex] = {
        ...events[openIndex],
        status: event.success === false ? "failed" : "completed",
        finishedAt: now,
      };
      changed = true;
    }
  }

  if (!changed) return current;

  return {
    events: events.slice(-MAX_ORCHESTRATOR_PROGRESS_EVENTS),
    updatedAt: now,
  };
}

export function orchestratorToolLabel(toolName: string): string {
  const normalized = text(toolName, 120)
    .replace(/^mcp__[^_]+__/, "")
    .replace(/^connector_/, "")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "Working";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
