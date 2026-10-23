/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Attention signal (v0.9.88 §5.11)
 *
 *  One short sound when a prompt starts waiting for the user's decision: when it appears, never when
 *  it is answered, and never when nothing is owed. VS Code-free, so the host decides where it plays.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';

/** What the webview reports for one chime: whether Web Audio actually started playing it. */
export interface AttentionPlaybackResult {
  id: string;
  audioState: string;
  started: boolean;
  surface: string;
}

export interface AttentionSignalDeps {
  /** The `unode.attentionSound` setting, read at each prompt so turning it off takes effect at once. */
  enabled(): boolean;
  /** Ask exactly one chat view to play; returns the container asked, or undefined when none can play. */
  play(attentionId: string): string | undefined;
  /** The host log. A missed sound is logged there once per session and never surfaced. */
  log(message: string): void;
  newAttentionId?(): string;
  /** How long a webview has to report the chime before the miss is logged. */
  resultTimeoutMs?: number;
}

/** Recent prompt keys remembered so a re-render or retry of the same appearance never sounds twice. */
export const ATTENTION_RECENT_KEYS = 256;
/** Chimes still waiting for the webview's report. */
const ATTENTION_PENDING_RESULTS = 32;
const ATTENTION_RESULT_TIMEOUT_MS = 5_000;

/**
 * The one attention entry. `required(key)` is synchronous and fire-and-forget: it never throws, never awaits
 * and never delays a prompt. It plays at most once per key, where a key names one appearance of one prompt.
 * The key stays in the host; only a random opaque id crosses to the webview and comes back in its report.
 */
export class AttentionSignal {
  private readonly recentKeys = new Set<string>();
  private readonly issued = new Map<string, ReturnType<typeof setTimeout>>();
  private missLogged = false;

  constructor(private readonly deps: AttentionSignalDeps) {}

  required(key: string): void {
    try {
      if (!key || !this.deps.enabled() || this.recentKeys.has(key)) {
        return;
      }
      this.recentKeys.add(key);
      if (this.recentKeys.size > ATTENTION_RECENT_KEYS) {
        this.recentKeys.delete(this.recentKeys.values().next().value as string);
      }
      const id = this.deps.newAttentionId?.() ?? randomUUID();
      const surface = this.deps.play(id);
      if (!surface) {
        this.noteMiss('no visible UnodeAi chat view could play it');
        return;
      }
      const timer = setTimeout(() => {
        if (this.issued.delete(id)) {
          this.noteMiss(`the ${surface} chat view did not report playing it`);
        }
      }, this.deps.resultTimeoutMs ?? ATTENTION_RESULT_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
      this.issued.set(id, timer);
      if (this.issued.size > ATTENTION_PENDING_RESULTS) {
        const [oldest, oldestTimer] = this.issued.entries().next().value as [string, ReturnType<typeof setTimeout>];
        clearTimeout(oldestTimer);
        this.issued.delete(oldest);
      }
    } catch (error) {
      try {
        this.noteMiss(`the sound could not be requested (${error instanceof Error ? error.message : String(error)})`);
      } catch {
        /* the prompt must never see an attention failure */
      }
    }
  }

  /** The webview's report. A report for an id this host did not issue, or already settled, is ignored. */
  noteResult(result: AttentionPlaybackResult): void {
    const timer = this.issued.get(result.id);
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    this.issued.delete(result.id);
    if (!result.started) {
      this.noteMiss(`the ${result.surface} chat view reported ${result.audioState}`);
    }
  }

  dispose(): void {
    for (const timer of this.issued.values()) clearTimeout(timer);
    this.issued.clear();
  }

  private noteMiss(detail: string): void {
    if (this.missLogged) return;
    this.missLogged = true;
    this.deps.log(
      `Attention sound did not play: ${detail}. It plays once you have typed or clicked in a visible UnodeAi chat `
      + 'view since it opened. Prompts still appear normally.',
    );
  }
}

let installedSignal: AttentionSignal | undefined;

/** Install (or clear) the host's attention signal. Tests install their own. */
export function installAttentionSignal(signal: AttentionSignal | undefined): void {
  installedSignal = signal;
}

/** Sound once for this prompt appearance, if a signal is installed. Never throws. */
export function requireAttention(key: string): void {
  installedSignal?.required(key);
}

/** A key for a prompt whose every show is a new appearance (it has no coalescing of its own). */
export function attentionAppearance(kind: string): string {
  return `${kind}:${randomUUID()}`;
}

/** Local read scope: agents coalescing in one user-request epoch sound once; the next request may sound again. */
export function localReadAttentionKey(root: string, epoch: number): string {
  return `local-read:${root}:${epoch}`;
}

/**
 * Whose time a blocking prompt's wait is. The host passes one that pauses the turn clock of the agent that raised
 * the prompt; `untimedPrompt` is for a wait that is no single agent's.
 */
export type PromptWait = <T>(wait: () => PromiseLike<T>) => PromiseLike<T>;

/** For a prompt whose wait belongs to no single agent. The reason says where that wait is accounted for instead. */
export function untimedPrompt(_reason: string): PromptWait {
  return (wait) => wait();
}

/**
 * Show a modal that stops work until the user decides, sounding once as it appears. Every blocking modal goes
 * through here (`check:modal-safety` enforces it). `key` names this one appearance; `undefined` means the user
 * opened this dialog themselves, so nothing sounds. `waiting` has no default: work that stops for a person is
 * that person's time, so each prompt says whose turn clock stands still while it is open.
 */
export function blockingPrompt<T>(key: string | undefined, show: () => PromiseLike<T>, waiting: PromptWait): PromiseLike<T> {
  if (key !== undefined) {
    requireAttention(key);
  }
  return waiting(show);
}
