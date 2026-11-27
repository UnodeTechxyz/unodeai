import * as fs from 'node:fs/promises';
import type { BeforeCommandEffect, CommandPreparationFailure, StartRefusal } from './CommandExecution';

/**
 * v0.9.101 S4.2: the physical working folder a command was approved for, and the one check every command start runs.
 *
 * The identity is captured BEFORE any approval wait and compared again immediately before the process starts. The
 * pair is `fs.realpath` plus the `dev`/`ino` of `fs.stat(..., { bigint: true })`, as the outward binding and the
 * checkpoint restore already use. A different spelling of the same folder has the same three facts and runs. A
 * deleted and recreated folder, or a junction/symlink retargeted to another folder, changes `ino` or `realpath`
 * and refuses: the old approval is never reused. No new confirmation is ever opened here.
 *
 * Owner-accepted residual risk (2026-10-31, B4): when `dev`/`ino` are unavailable, unstable, `0` or reused, a
 * replacement between this check and the start can go undetected. This module does not try to close that boundary.
 */
export type CwdIdentityResult =
  | { readonly kind: 'physical'; readonly cwd: string; readonly realpath: string; readonly dev: string; readonly ino: string }
  | { readonly kind: 'unavailable'; readonly cwd: string };

export type CwdIdentityComparison = 'same' | 'changed' | 'unavailable';

/** Which host rules apply: Windows folds case in the realpath comparison only. Injectable for tests. */
export interface CwdIdentityAuthority {
  readonly platform?: NodeJS.Platform;
}

/** The existing "working folder changed" outcome (ShellCommandGate, unverified outward binding). */
export const CWD_CHANGED_MESSAGE = 'Command not run: the working folder bound to this approval changed. Review the action in its current folder in a new request; this approval cannot be reused.';

/** A folder that could not be observed when the command was approved, but exists now, was not what was approved. */
export const CWD_APPEARED_MESSAGE = 'Command not run: its working folder did not exist when this action was approved and exists now. Review the action in its current folder in a new request; this approval cannot be reused.';

const DISPOSED: CommandPreparationFailure = { ok: false, reason: 'disposed',
  message: 'Command not run: its approval was withdrawn because the agent was stopped, restarted or removed.' };

/** Never throws. A missing folder, a file, or any `realpath`/`stat` failure is `unavailable`. */
export async function captureCwdIdentity(cwd: string): Promise<CwdIdentityResult> {
  try {
    const realpath = await fs.realpath(cwd);
    const stat = await fs.stat(realpath, { bigint: true });
    if (!stat.isDirectory()) return { kind: 'unavailable', cwd };
    return { kind: 'physical', cwd, realpath, dev: String(stat.dev), ino: String(stat.ino) };
  } catch {
    return { kind: 'unavailable', cwd };
  }
}

/** The realpath as this host compares it. `dev`/`ino` are always compared as exact strings. */
export function comparableRealpath(realpath: string, authority: CwdIdentityAuthority = {}): string {
  return (authority.platform ?? process.platform) === 'win32' ? realpath.toLowerCase() : realpath;
}

/**
 * Re-capture `cwd` (the captured spelling by default) and compare.
 * - captured physical: `same` only when realpath, dev and ino all match; anything else, including a folder that is
 *   now missing, is `changed`.
 * - captured unavailable: a folder that now resolves is `changed` (it appeared after the approval); one that still
 *   does not is `unavailable`, and the command is left to fail with the shell's own error.
 */
export async function sameCwdIdentity(before: CwdIdentityResult, cwd: string = before.cwd,
  authority: CwdIdentityAuthority = {}): Promise<CwdIdentityComparison> {
  const current = await captureCwdIdentity(cwd);
  if (before.kind === 'unavailable') return current.kind === 'unavailable' ? 'unavailable' : 'changed';
  if (current.kind === 'unavailable') return 'changed';
  return comparableRealpath(current.realpath, authority) === comparableRealpath(before.realpath, authority)
    && current.dev === before.dev && current.ino === before.ino ? 'same' : 'changed';
}

/** The refusal for a detected change, in the existing not-run outcome; undefined when the start may proceed. */
export async function cwdIdentityRefusal(before: CwdIdentityResult, authority: CwdIdentityAuthority = {}): Promise<CommandPreparationFailure | undefined> {
  if (await sameCwdIdentity(before, before.cwd, authority) !== 'changed') return undefined;
  return before.kind === 'unavailable'
    ? { ok: false, reason: 'policy-changed', message: CWD_APPEARED_MESSAGE }
    : { ok: false, reason: 'effect-changed', message: CWD_CHANGED_MESSAGE, changed: 'working-folder' };
}

/**
 * The one check an executor runs immediately before the process starts (C2):
 * live authority (policy, trust, scope, lease, Stop) → physical cwd identity → the first gate's original
 * approval/revocation callback → live authority again, because the awaits above can let it change.
 *
 * It never asks a person and never consumes a one-time receipt: `firstGateRevalidate` only re-reads the approval
 * state its gate recorded. A refusal means nothing started.
 */
export function composeCommandStartCheck(firstGateRevalidate: BeforeCommandEffect | undefined, identity: CwdIdentityResult,
  liveAuthority: StartRefusal, signal?: AbortSignal, authority: CwdIdentityAuthority = {}): BeforeCommandEffect {
  const live = () => liveAuthority() ?? (signal?.aborted ? DISPOSED : undefined);
  return async () => {
    const before = live();
    if (before) return before;
    const moved = await cwdIdentityRefusal(identity, authority);
    if (moved) return moved;
    const gate = await firstGateRevalidate?.();
    if (gate) return gate;
    return live();
  };
}
