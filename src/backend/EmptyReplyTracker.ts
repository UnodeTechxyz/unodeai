/*---------------------------------------------------------------------------------------------
 *  UnodeAi - empty-reply classification (v0.9.90 Smart compaction design, §7)
 *
 *  One shared, pure record of what each provider attempt of a turn delivered. An attempt that completed
 *  successfully with no visible text, no tool call and no approval or consent interaction is empty. One
 *  unchanged retry is allowed per turn, and only for such an attempt, so a retry can never repeat observed
 *  work. The backends feed it protocol events; nothing reclassifies a turn from its final text.
 *--------------------------------------------------------------------------------------------*/

import type { EmptyReplyAttempt, TurnResponseOutcome } from './AgentBackend';

/** The facts a backend knows when one attempt completes. */
export type EmptyReplyAttemptEnd = Omit<EmptyReplyAttempt, 'attempt' | 'gateway'>;

export class EmptyReplyTracker {
  private readonly empties: EmptyReplyAttempt[] = [];
  private attemptText = false;
  private attemptActivity = false;
  private turnActivity = false;
  private lastAttemptVisible = false;
  private lastAttemptEmpty = false;
  private retried = false;

  constructor(private readonly gateway: string) {}

  /** A new provider attempt starts. */
  beginAttempt(): void {
    this.attemptText = false;
    this.attemptActivity = false;
  }

  /** Assistant text the user can see; whitespace and hidden reasoning are not visible. */
  noteText(text: string | undefined): void {
    if (text && text.trim()) this.attemptText = true;
  }

  /** A tool call, a native tool item, or an approval or consent interaction: work that a retry could repeat. */
  noteActivity(): void {
    this.attemptActivity = true;
    this.turnActivity = true;
  }

  /** The attempt completed successfully. Returns whether it was empty. */
  endAttempt(end: EmptyReplyAttemptEnd): boolean {
    this.lastAttemptVisible = this.attemptText;
    this.lastAttemptEmpty = !this.attemptText && !this.attemptActivity;
    if (this.lastAttemptEmpty) {
      this.empties.push({ attempt: this.empties.length + 1, gateway: this.gateway, ...definedFields(end) });
    }
    return this.lastAttemptEmpty;
  }

  /** Whether the attempt that just ended may be sent once more, unchanged. Claims the turn's one retry. */
  takeRetry(): boolean {
    if (this.retried || !this.lastAttemptEmpty) return false;
    this.retried = true;
    return true;
  }

  /** The delivery outcome of a turn that completed; errors and stops are the backend's to report. */
  outcome(): TurnResponseOutcome {
    if (this.lastAttemptVisible) return { kind: 'reply' };
    if (this.turnActivity) return { kind: 'tool-only' };
    if (this.empties.length > 0) return { kind: 'empty-reply', attempts: this.empties.map((attempt) => ({ ...attempt })) };
    return { kind: 'reply' };
  }
}

function definedFields(end: EmptyReplyAttemptEnd): EmptyReplyAttemptEnd {
  return Object.fromEntries(Object.entries(end).filter(([, value]) => value !== undefined)) as EmptyReplyAttemptEnd;
}
