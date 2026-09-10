export type AgentWorkspaceResolution =
  | { ok: true; rootPath: string }
  | {
      ok: false;
      code: "workspace_unavailable";
      error: string;
    };

export function resolveAgentWorkspaceRoot(args: {
  workspaceId: string | null;
  rootPath: unknown;
  agentDeviceId?: unknown;
  workspaceDeviceId?: unknown;
  lookupFailed?: boolean;
}): AgentWorkspaceResolution {
  if (!args.workspaceId) {
    return { ok: true, rootPath: "" };
  }
  const rootPath =
    typeof args.rootPath === "string" ? args.rootPath.trim() : "";
  const agentDeviceId =
    typeof args.agentDeviceId === "string" ? args.agentDeviceId.trim() : "";
  const workspaceDeviceId =
    typeof args.workspaceDeviceId === "string"
      ? args.workspaceDeviceId.trim()
      : "";
  if (
    args.lookupFailed === true ||
    !rootPath ||
    (agentDeviceId && workspaceDeviceId !== agentDeviceId)
  ) {
    return {
      ok: false,
      code: "workspace_unavailable",
      error:
        "The configured worker workspace is unavailable. Reconnect its folder in agent settings, then retry.",
    };
  }
  return { ok: true, rootPath };
}
