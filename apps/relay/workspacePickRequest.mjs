export const WORKSPACE_PICK_CONNECTOR_TIMEOUT_MS = 190_000;
export const WORKSPACE_PICK_RESULT_REPLAY_TTL_MS = 30_000;

export function detachWorkspacePickBrowser(pending, browserWs, now = Date.now()) {
  if (pending?.type !== "workspace_pick" || pending.browserWs !== browserWs) {
    return false;
  }

  pending.browserWs = null;
  pending.disconnectedAt = now;
  return true;
}

export function deliverOrDeferWorkspacePickResult(pending, payload, send) {
  if (pending?.type !== "workspace_pick") return false;

  const delivered = pending.browserWs ? send(pending.browserWs, payload) === true : false;
  if (delivered) {
    pending.completedPayload = null;
    return true;
  }

  pending.browserWs = null;
  pending.completedPayload = payload;
  return false;
}

export function rebindWorkspacePickBrowser(
  pending,
  { browserWs, browserInstanceId, userId, send },
) {
  if (
    pending?.type !== "workspace_pick" ||
    pending.userId !== userId ||
    !browserInstanceId ||
    pending.browserInstanceId !== browserInstanceId
  ) {
    return { matched: false, delivered: false };
  }

  pending.browserWs = browserWs;
  pending.disconnectedAt = null;
  if (!pending.completedPayload) {
    return { matched: true, delivered: false };
  }

  const delivered = send(browserWs, pending.completedPayload) === true;
  if (delivered) pending.completedPayload = null;
  return { matched: true, delivered };
}
