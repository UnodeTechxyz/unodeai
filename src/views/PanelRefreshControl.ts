/** Coalesce a burst of UI refresh requests (for example, a write plus its fs.watch echo). */
export class CoalescedPanelRefresh {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly refresh: () => void,
    private readonly delayMs = 125,
  ) {}

  request(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, this.delayMs);
  }
}

/** Prevent a background refresh from replacing Builder HTML after the user has begun editing it. */
export class AgentBuilderFormRefreshGate {
  private revision = 0;
  private dirty = false;

  get isDirty(): boolean {
    return this.dirty;
  }

  get currentRevision(): number {
    return this.revision;
  }

  markDirty(): void {
    this.dirty = true;
    this.revision += 1;
  }

  canReplaceHtml(startRevision: number): boolean {
    return !this.dirty && this.revision === startRevision;
  }

  markRendered(): void {
    this.dirty = false;
  }
}
