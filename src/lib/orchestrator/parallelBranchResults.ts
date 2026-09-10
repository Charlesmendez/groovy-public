export type PendingParallelConnectorCall = {
  branchId: string;
  toolCallId: string;
  toolName: string;
};

export type ParallelConnectorResult = {
  branchId: string;
  toolCallId: string;
  toolName: string;
  result: string;
};

export type AcceptedParallelConnectorResult = Omit<
  ParallelConnectorResult,
  "branchId"
>;

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIncoming(
  values: ParallelConnectorResult[] | undefined,
): ParallelConnectorResult[] {
  const normalized: ParallelConnectorResult[] = [];
  for (const raw of values || []) {
    const branchId = trimmed(raw.branchId);
    const toolCallId = trimmed(raw.toolCallId);
    const toolName = trimmed(raw.toolName);
    const result = typeof raw.result === "string" ? raw.result : "";
    if (!branchId || !toolCallId || !toolName) continue;
    normalized.push({ branchId, toolCallId, toolName, result });
  }
  return normalized;
}

export function parallelConnectorCallKey(value: {
  branchId: string;
  toolCallId: string;
}): string {
  return `${value.branchId}\u0000${value.toolCallId}`;
}

export function reconcileParallelConnectorResults<
  TPending extends PendingParallelConnectorCall,
>(args: {
  pending: TPending[];
  incoming?: ParallelConnectorResult[];
}): {
  acceptedByBranch: Map<string, AcceptedParallelConnectorResult[]>;
  remaining: TPending[];
} {
  const pendingByKey = new Map(
    (args.pending || []).map((execute) => [
      parallelConnectorCallKey(execute),
      execute,
    ]),
  );
  const acceptedKeys = new Set<string>();
  const acceptedByBranch = new Map<
    string,
    AcceptedParallelConnectorResult[]
  >();

  for (const incoming of normalizeIncoming(args.incoming)) {
    const key = parallelConnectorCallKey(incoming);
    const expected = pendingByKey.get(key);
    if (
      !expected ||
      expected.toolName !== incoming.toolName ||
      acceptedKeys.has(key)
    ) {
      continue;
    }
    acceptedKeys.add(key);
    const current = acceptedByBranch.get(incoming.branchId) || [];
    current.push({
      toolCallId: incoming.toolCallId,
      toolName: incoming.toolName,
      result: incoming.result,
    });
    acceptedByBranch.set(incoming.branchId, current);
  }

  return {
    acceptedByBranch,
    remaining: (args.pending || []).filter(
      (execute) =>
        !acceptedKeys.has(parallelConnectorCallKey(execute)),
    ),
  };
}
