/*---------------------------------------------------------------------------------------------
 * v0.9.96: after Restart Extension Host, VS Code keeps the Workbench editor tab but never hands it to the new
 * host: no serializer call and no message from it reach this host (the native lifecycle probe in the release
 * record). Reload Window and a closed and reopened window still restore the tab through the serializer, and that
 * normal path always wins. A sidebar view is resolved again by VS Code itself.
 *
 * This decides when a Workbench tab is unconnected and offers to replace it. It never closes a tab without the
 * user's answer: a new host cannot see whether the old page holds text typed after its last saved copy.
 *--------------------------------------------------------------------------------------------*/

/**
 * How long a shown Workbench tab may stay unconnected before it counts as unconnected. VS Code calls the serializer
 * of a shown tab within milliseconds of its registration (measured: 2 to 15 ms, also when registration came 3 s
 * late), and a restored panel reports its column correctly within 500 ms.
 */
export const WORKBENCH_CONNECT_DEADLINE_MS = 2_000;

export interface WorkbenchTabCandidate<T> {
  tab: T;
  viewColumn: number;
  /** The tab is its group's active tab, so VS Code would revive it now if it could. */
  activeInGroup: boolean;
}

export interface LiveWorkbenchPlacement {
  /** Undefined when VS Code does not say where the live panel is; then no other tab is judged against it. */
  viewColumn: number | undefined;
  visible: boolean;
}

export type WorkbenchRecoveryQuestion =
  | { kind: 'reopen'; userInitiated: boolean; savedDrafts: boolean }
  | { kind: 'close-extra' }
  | { kind: 'ambiguous' };

export type WorkbenchRecoveryAnswer = 'reopen' | 'close' | undefined;

export interface WorkbenchRecoveryPort<T> {
  /** Exactly the UnodeAi Workbench tabs, by their native view type. No other tab is ever a candidate. */
  candidates(): WorkbenchTabCandidate<T>[];
  /** The Workbench panel attached to this host, if there is one. */
  live(): LiveWorkbenchPlacement | undefined;
  /** The window is closing, the bound workspace root was invalidated, or the chat view is disposed. */
  blocked(): boolean;
  /** Whether the draft copy holds text a rebuilt Workbench would restore. */
  savedDrafts(): boolean;
  ask(question: WorkbenchRecoveryQuestion): PromiseLike<WorkbenchRecoveryAnswer>;
  /** Open a live Workbench in this column, then close the old tab. Resolves false when the old tab stayed open. */
  reopen(tab: T, viewColumn: number): PromiseLike<boolean>;
  close(tab: T): PromiseLike<boolean>;
  /** Open or reveal the Workbench the ordinary way. */
  open(): void;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export class WorkbenchRecovery<T> {
  private armed = false;
  private cancelled = false;
  private opening = false;
  private timer: unknown;
  /** Each shown tab not attached to this host, with the time it was first seen so. */
  private readonly unattachedSince = new Map<T, number>();
  /** Tabs the user was already asked about. Only an explicit open asks again. */
  private readonly asked = new Set<T>();
  /** The question this host raised by itself, if one is open. */
  private operation: Promise<void> | undefined;
  /** The question an explicit open raised. It may run beside the first: every action checks again first. */
  private userOperation: Promise<void> | undefined;

  constructor(private readonly port: WorkbenchRecoveryPort<T>) {}

  /** The serializer is registered. From here a shown tab that stays unattached past the deadline is unconnected. */
  start(): void {
    if (this.cancelled) return;
    this.armed = true;
    this.evaluate();
  }

  /** A tab opened, closed, moved or changed activity, or a Workbench attached or changed its view state. */
  changed(): void {
    if (this.armed) this.evaluate();
  }

  /** The window is closing or the bound root changed: nothing more is asked, and an open question does nothing. */
  cancel(): void {
    this.cancelled = true;
    this.armed = false;
    this.clearTimer();
    this.unattachedSince.clear();
  }

  /** Settles when the recovery under way, if any, has finished. */
  settled(): Promise<void> {
    return Promise.all([this.operation, this.userOperation]).then(() => undefined);
  }

  /**
   * The user asked for the Workbench and none is attached. True when recovery takes the request: a shown tab is
   * not attached, so a new panel beside it would be a second Workbench with the old page still looking live.
   */
  interceptOpen(): boolean {
    if (!this.armed || this.cancelled || this.opening || this.port.blocked() || this.port.live()) return false;
    if (this.userOperation) return true;
    const current = this.unattachedVisible();
    if (current.length === 0) return false;
    this.userOperation = (async () => {
      // A normal restore of a tab shown only just now may still be on its way; it gets the whole deadline.
      const now = this.port.now();
      const wait = Math.max(0, ...current.map((candidate) =>
        (this.unattachedSince.get(candidate.tab) ?? now) + WORKBENCH_CONNECT_DEADLINE_MS - now));
      if (wait > 0) await new Promise<void>((resolve) => { this.port.setTimer(resolve, wait); });
      if (this.cancelled || this.port.blocked()) return;
      const due = this.port.live() ? [] : this.unattachedVisible();
      if (due.length === 0) {
        this.openOrdinarily();
        return;
      }
      await this.resolve(due, true);
    })().catch(() => undefined).finally(() => {
      this.userOperation = undefined;
      this.evaluate();
    });
    return true;
  }

  private evaluate(): void {
    this.clearTimer();
    if (!this.armed || this.cancelled || this.port.blocked()) return;
    const now = this.port.now();
    const current = this.unattachedVisible();
    for (const tab of [...this.unattachedSince.keys()]) {
      if (!current.some((candidate) => candidate.tab === tab)) this.unattachedSince.delete(tab);
    }
    let next: number | undefined;
    const due: WorkbenchTabCandidate<T>[] = [];
    for (const candidate of current) {
      const since = this.unattachedSince.get(candidate.tab) ?? now;
      this.unattachedSince.set(candidate.tab, since);
      const remaining = since + WORKBENCH_CONNECT_DEADLINE_MS - now;
      if (remaining > 0) next = Math.min(next ?? remaining, remaining);
      else if (!this.asked.has(candidate.tab)) due.push(candidate);
    }
    if (next !== undefined) {
      this.timer = this.port.setTimer(() => {
        this.timer = undefined;
        this.evaluate();
      }, next);
    }
    if (due.length > 0 && !this.operation && !this.userOperation) this.run(this.resolve(due, false));
  }

  /**
   * Shown Workbench tabs this host has no panel for. A tab in the live panel's own group is never one: VS Code
   * reports where a panel is, not which tab it is, so that tab could be the live one.
   */
  private unattachedVisible(): WorkbenchTabCandidate<T>[] {
    const live = this.port.live();
    if (live && live.viewColumn === undefined) return [];
    return this.port.candidates().filter((candidate) => candidate.activeInGroup
      && (!live || live.viewColumn !== candidate.viewColumn));
  }

  private async resolve(due: WorkbenchTabCandidate<T>[], userInitiated: boolean): Promise<void> {
    for (const candidate of due) this.asked.add(candidate.tab);
    if (due.length > 1) {
      // Which tab to replace is not ours to guess.
      await this.port.ask({ kind: 'ambiguous' });
      return;
    }
    const [target] = due;
    const replacing = !this.port.live();
    const answer = await this.port.ask(replacing
      ? { kind: 'reopen', userInitiated, savedDrafts: this.port.savedDrafts() }
      : { kind: 'close-extra' });
    // Anything may have changed while the question was open. Everything is checked again right before acting.
    if (this.cancelled || this.port.blocked()) return;
    const now = this.port.candidates().find((candidate) => candidate.tab === target.tab);
    if (!now) return;
    const live = this.port.live();
    if (replacing) {
      // A normal restore that attached meanwhile wins, and the old tab is left alone.
      if (answer !== 'reopen' || live) return;
      this.opening = true;
      try {
        await this.port.reopen(target.tab, now.viewColumn);
      } finally {
        this.opening = false;
      }
      return;
    }
    if (answer !== 'close' || !live || live.viewColumn === undefined || live.viewColumn === now.viewColumn) return;
    await this.port.close(target.tab);
  }

  private openOrdinarily(): void {
    this.opening = true;
    try {
      this.port.open();
    } finally {
      this.opening = false;
    }
  }

  private run(work: Promise<void>): void {
    this.operation = work.catch(() => undefined).finally(() => {
      this.operation = undefined;
      this.evaluate();
    });
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.port.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}
