"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Building2,
  Check,
  ChevronDown,
  Loader2,
  Lock,
  Mail,
  Plus,
  Users,
  X,
} from "lucide-react";

type WorkspaceOption = {
  id: string;
  name: string;
  role: "admin" | "member" | "guest";
  isOwner: boolean;
  isActive: boolean;
};

type PendingInvite = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: "member" | "guest";
  expiresAt: string;
  channels: Array<{ id: string; name: string }>;
};

type WorkspaceDirectory = {
  activeWorkspaceId: string | null;
  workspaces: WorkspaceOption[];
  pendingInvites: PendingInvite[];
};

export function WorkspaceSwitcher({
  fallbackName = "Workspace",
  compact = false,
  switchDestination,
  onWorkspaceChanged,
  modalOnly = false,
  showPendingGate = true,
  align = "left",
}: {
  fallbackName?: string;
  compact?: boolean;
  switchDestination: string;
  onWorkspaceChanged?: (workspace: WorkspaceOption) => void;
  modalOnly?: boolean;
  showPendingGate?: boolean;
  align?: "left" | "right";
}) {
  const [directory, setDirectory] = useState<WorkspaceDirectory | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingGateDismissed, setPendingGateDismissed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/workspaces", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || "Could not load workspaces");
      }
      setDirectory({
        activeWorkspaceId:
          typeof payload.activeWorkspaceId === "string"
            ? payload.activeWorkspaceId
            : null,
        workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
        pendingInvites: Array.isArray(payload.pendingInvites)
          ? payload.pendingInvites
          : [],
      });
      setError(null);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not load workspaces",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        rootRef.current &&
        !rootRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const activeWorkspace =
    directory?.workspaces.find((workspace) => workspace.isActive) || null;
  const pendingInvites = directory?.pendingInvites || [];

  const switchWorkspace = async (workspace: WorkspaceOption) => {
    if (workspace.isActive || busyId) {
      setOpen(false);
      return;
    }
    setBusyId(workspace.id);
    setError(null);
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeWorkspaceId: workspace.id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || "Could not switch workspace");
      }
      onWorkspaceChanged?.(workspace);
      window.location.assign(
        switchDestination.startsWith("/") ? switchDestination : "/dashboard",
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not switch workspace",
      );
      setBusyId(null);
    }
  };

  const acceptInvite = async (invite: PendingInvite) => {
    if (busyId) return;
    setBusyId(invite.id);
    setError(null);
    try {
      const response = await fetch("/api/workspaces/invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteId: invite.id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || "Could not accept invitation");
      }
      window.location.assign("/chat?joined=1");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not accept invitation",
      );
      setBusyId(null);
    }
  };

  const createWorkspace = async () => {
    if (busyId) return;
    setBusyId("create-workspace");
    setError(null);
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ createWorkspace: true }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || "Could not create workspace");
      }
      window.location.assign(
        switchDestination.startsWith("/") ? switchDestination : "/dashboard",
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not create workspace",
      );
      setBusyId(null);
    }
  };

  return (
    <>
      <div ref={rootRef} className="relative min-w-0">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={`group min-w-0 items-center rounded-lg text-left text-[var(--text-primary)] transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/30 ${
            modalOnly ? "sr-only" : "flex"
          } ${
            compact ? "h-8 max-w-48 gap-1.5 px-2" : "w-full gap-2 px-1.5 py-1"
          }`}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Switch workspace"
        >
          {compact ? (
            <Building2 className="h-4 w-4 shrink-0 text-zinc-500 group-hover:text-cyan-300" />
          ) : null}
          <span
            className={`min-w-0 flex-1 truncate font-semibold tracking-normal ${
              compact ? "hidden text-xs lg:block" : "text-sm"
            }`}
          >
            {loading
              ? "Loading workspace…"
              : activeWorkspace?.name || fallbackName}
          </span>
          {pendingInvites.length > 0 ? (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-cyan-400 px-1 text-[10px] font-bold text-zinc-950">
              {pendingInvites.length}
            </span>
          ) : null}
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>

        {open ? (
          <div
            role="menu"
            className={`absolute z-[115] mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/98 p-2 shadow-2xl shadow-black/70 backdrop-blur-xl max-sm:fixed max-sm:left-4 max-sm:right-4 max-sm:top-14 max-sm:mt-0 max-sm:w-auto ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-600">
              Workspaces
            </div>
            <div className="max-h-64 overflow-y-auto">
              {directory?.workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  role="menuitem"
                  disabled={busyId !== null}
                  onClick={() => void switchWorkspace(workspace)}
                  className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left hover:bg-white/[0.06] disabled:opacity-60"
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      workspace.isActive
                        ? "bg-cyan-400/15 text-cyan-300"
                        : "bg-white/[0.05] text-zinc-500"
                    }`}
                  >
                    {busyId === workspace.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Building2 className="h-4 w-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-100">
                      {workspace.name}
                    </span>
                    <span className="block text-[11px] text-zinc-500">
                      {workspace.isOwner
                        ? "Your workspace"
                        : workspace.role === "guest"
                          ? "Channel guest"
                          : "Member"}
                    </span>
                  </span>
                  {workspace.isActive ? (
                    <Check className="h-4 w-4 shrink-0 text-cyan-300" />
                  ) : null}
                </button>
              ))}
            </div>
            {directory &&
            !directory.workspaces.some((workspace) => workspace.isOwner) ? (
              <button
                type="button"
                role="menuitem"
                disabled={busyId !== null}
                onClick={() => void createWorkspace()}
                className="mt-1 flex w-full items-center gap-3 rounded-xl border border-dashed border-white/10 px-2.5 py-2.5 text-left text-zinc-400 hover:border-cyan-400/20 hover:bg-cyan-400/[0.05] hover:text-cyan-200 disabled:opacity-60"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]">
                  {busyId === "create-workspace" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                </span>
                <span>
                  <span className="block text-sm font-medium">
                    Create my workspace
                  </span>
                  <span className="block text-[11px] text-zinc-600">
                    Start your own trial or plan separately
                  </span>
                </span>
              </button>
            ) : null}

            {pendingInvites.length > 0 ? (
              <div className="mt-2 border-t border-white/[0.07] pt-2">
                <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-600">
                  Invitations
                </div>
                {pendingInvites.map((invite) => (
                  <button
                    key={invite.id}
                    type="button"
                    role="menuitem"
                    disabled={busyId !== null}
                    onClick={() => void acceptInvite(invite)}
                    className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left hover:bg-cyan-400/[0.07] disabled:opacity-60"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300">
                      {busyId === invite.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Mail className="h-4 w-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-zinc-100">
                        {invite.workspaceName}
                      </span>
                      <span className="block text-[11px] text-cyan-300">
                        Accept invitation
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            {error ? (
              <div className="m-1 mt-2 rounded-lg border border-red-400/20 bg-red-500/10 px-2.5 py-2 text-xs text-red-200">
                {error}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {showPendingGate &&
      pendingInvites.length > 0 &&
      !pendingGateDismissed ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[#07080b]/90 p-4 backdrop-blur-xl">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-invitation-title"
            className="relative max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-zinc-900 p-6 shadow-2xl shadow-black/70 sm:p-7"
          >
            <button
              type="button"
              onClick={() => setPendingGateDismissed(true)}
              className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/[0.06] hover:text-white"
              aria-label="Use my own workspace for now"
              title="Use my own workspace for now"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
              <Users className="h-6 w-6" />
            </div>
            <h2
              id="workspace-invitation-title"
              className="mt-5 pr-8 text-2xl font-semibold tracking-tight text-white"
            >
              You&apos;ve been invited
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              Join the workspace below with no personal Groovy purchase
              required. You only need your own plan when you want to run your
              own workspace.
            </p>

            <div className="mt-5 space-y-2">
              {pendingInvites.map((invite) => (
                <div
                  key={invite.id}
                  className="rounded-2xl border border-white/[0.08] bg-black/20 p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.05] text-zinc-300">
                      {invite.role === "guest" ? (
                        <Lock className="h-4 w-4" />
                      ) : (
                        <Building2 className="h-4 w-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-white">
                        {invite.workspaceName}
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">
                        {invite.role === "guest"
                          ? `Guest access${
                              invite.channels.length
                                ? ` · ${invite.channels
                                    .map((channel) => `#${channel.name}`)
                                    .join(", ")}`
                                : ""
                            }`
                          : "Workspace member"}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void acceptInvite(invite)}
                    className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-300 disabled:opacity-60"
                  >
                    {busyId === invite.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                    {busyId === invite.id
                      ? "Joining workspace…"
                      : `Join ${invite.workspaceName}`}
                  </button>
                </div>
              ))}
            </div>

            {error ? (
              <div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {error}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setPendingGateDismissed(true)}
              className="mt-3 w-full rounded-xl px-4 py-2.5 text-xs font-medium text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300"
            >
              Use my own workspace for now
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
