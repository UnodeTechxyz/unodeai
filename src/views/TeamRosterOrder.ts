// Workspace-local Team panel presentation order.
export const TEAM_ROSTER_ORDER_KEY = 'unode.teamPanel.presentationOrder.v1';
const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((id, index) => id === right[index]);
export function isRosterPermutation(value: unknown, live: readonly string[]): value is string[] {
  return Array.isArray(value) && value.length === live.length && new Set(value).size === live.length && value.every(id => typeof id === 'string' && live.includes(id));
}
/** Workspace presentation only: callers supply fresh live ids, never mutable SessionManager/config objects. */
export class TeamRosterOrder {
  private order: string[];
  private membership?: string;
  private settled = false;
  private queue: Promise<unknown> = Promise.resolve();
  revision = 0;
  constructor(saved: unknown, private readonly save: (ids: string[]) => PromiseLike<void>, private readonly live: () => string[],
    private readonly redraw: () => void, private readonly failed: () => void) {
    this.order = Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === 'string'))] : [];
  }
  project(ids: readonly string[]): string[] {
    return [...this.order.filter(id => ids.includes(id)), ...ids.filter(id => !this.order.includes(id))];
  }
  /** Only after restore has finished: partial startup rosters must not erase later restored ids. */
  rosterSettled(): void {
    this.settled = true;
    // A failed/empty startup restore must not erase a saved preference before its members can load.
    if (!this.live().length) { this.membership = JSON.stringify([]); return; }
    this.membership = undefined; this.observe();
  }
  observe(): void {
    const ids = this.live(); const membership = JSON.stringify([...ids].sort()); if (membership === this.membership) return;
    this.membership = membership; this.revision++;
    if (!this.settled) return;
    const projected = this.project(ids); if (same(projected, this.order)) return;
    this.order = projected;
    void this.enqueue(async () => {
      if (!same(projected, this.order)) return;
      try { await this.save([...projected]); } catch { this.failed(); }
    });
  }
  reorder(ids: unknown, revision: unknown): Promise<boolean> {
    const submitted = Array.isArray(ids) ? [...ids] : ids;
    return this.enqueue(async () => {
      this.observe();
      if (!this.settled || revision !== this.revision || !isRosterPermutation(submitted, this.live())) { this.redraw(); return false; }
      const previous = [...this.order];
      try {
        await this.save([...submitted]); this.observe();
        if (revision !== this.revision || !isRosterPermutation(submitted, this.live())) {
          // A member arrived/left during the write. Restore the previous relative order, append/prune live ids.
          this.order = previous; const current = this.project(this.live()); this.order = current;
          await this.save([...current]); this.redraw(); return false;
        }
        this.order = [...submitted]; this.redraw(); return true;
      } catch {
        this.order = previous; this.order = this.project(this.live());
        try { await this.save([...this.order]); } catch { /* Keep the previous visible order even if storage is unavailable. */ }
        this.failed(); this.redraw(); return false;
      }
    });
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const job = this.queue.then(run, run); this.queue = job.catch(() => undefined); return job;
  }
  async idle(): Promise<void> { await this.queue; }
}
