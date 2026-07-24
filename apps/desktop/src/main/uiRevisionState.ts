export type HostedUiUpdateState = "idle" | "ready" | "reloading";

export type HostedUiUpdateStatus = {
  state: HostedUiUpdateState;
  revision?: string | null;
};

/**
 * Tracks the revision that is actually loaded separately from a revision that
 * has merely been detected. A detected revision must remain pending until a
 * successful BrowserWindow reload finishes.
 */
export class UiRevisionState {
  private loadedRevision: string | null = null;
  private pendingRevision: string | null = null;
  private reloadingRevision: string | null = null;

  observe(revision: string): HostedUiUpdateStatus {
    const normalized = revision.trim();
    if (!normalized || normalized === "local") return this.getStatus();

    if (!this.loadedRevision) {
      this.loadedRevision = normalized;
      return this.getStatus();
    }

    if (normalized === this.loadedRevision) {
      if (!this.reloadingRevision) this.pendingRevision = null;
      return this.getStatus();
    }

    if (normalized !== this.reloadingRevision) {
      this.pendingRevision = normalized;
    }
    return this.getStatus();
  }

  beginReload(): string | null {
    if (this.reloadingRevision || !this.pendingRevision) return null;
    this.reloadingRevision = this.pendingRevision;
    return this.reloadingRevision;
  }

  completeReload(): string | null {
    const completedRevision = this.reloadingRevision;
    if (!completedRevision) return null;

    this.loadedRevision = completedRevision;
    this.reloadingRevision = null;
    if (this.pendingRevision === completedRevision) {
      this.pendingRevision = null;
    }
    return completedRevision;
  }

  failReload(): HostedUiUpdateStatus {
    this.reloadingRevision = null;
    return this.getStatus();
  }

  getStatus(): HostedUiUpdateStatus {
    if (this.reloadingRevision) {
      return { state: "reloading", revision: this.reloadingRevision };
    }
    if (this.pendingRevision) {
      return { state: "ready", revision: this.pendingRevision };
    }
    return { state: "idle" };
  }
}
