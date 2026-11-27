/*---------------------------------------------------------------------------------------------
 *  UnodeAi - which CLI program a session runs, kept with the session (v0.9.97)
 *  A session takes its pin at its first start, and the user's own Start, Restart or configuration edit replaces it.
 *  Every other start of the session (an App Server restart, the restart after a confirmed exit, a start for a message
 *  to a stopped agent, a start an agent or a tool asks for, the first start after a window reload) launches exactly
 *  the pinned program, or nothing. A pin authorises only its own exact identity, and it keeps nothing on disk.
 *--------------------------------------------------------------------------------------------*/

import type { CliRuntimeProvider } from '../backend/cliRuntime';

export type SessionRuntimePin =
  | { pinVersion: 1; mode: 'managed'; provider: 'codex-cli'; storeId: string; storeKey: string; closureDigest: string }
  | { pinVersion: 1; mode: 'external'; provider: CliRuntimeProvider; executable: string; closureDigest: string; version?: string };

/** Who asked for a start: the user's own Start, Restart or configuration edit takes a new pin; every other reuses. */
export type PinMode = 'take' | 'reuse';

export type PinnedStartRefusal =
  /** No managed instance, or another one, is enrolled now. */
  | 'managed-store-replaced'
  /** The user chose the external CLI after this session started. */
  | 'managed-not-selected'
  /** The same instance, but the pinned version is not launchable any more. */
  | 'managed-version-gone'
  /** The program's files are not the ones this session started with. */
  | 'identity-changed'
  | 'pin-unreadable';

export const PINNED_START_REFUSAL_TEXT: Readonly<Record<PinnedStartRefusal, string>> = Object.freeze({
  'managed-store-replaced': 'Managed Codex was reset after this agent started. Start the agent again to use the current Codex program.',
  'managed-not-selected': 'You chose the external Codex CLI after this agent started. UnodeAi does not start managed Codex again for it. Start the agent again to use the external CLI.',
  'managed-version-gone': 'The Codex program this agent used is no longer available. Start the agent again.',
  'identity-changed': 'The program changed while this agent was running. Start the agent again to use it.',
  'pin-unreadable': 'UnodeAi cannot read which program this agent used. Start the agent again.',
});

const DIGEST = /^[0-9a-f]{64}$/;
const STORE_ID = /^[0-9a-f]{32}$/;
const KEY = /^\d{1,4}\.\d{1,4}\.\d{1,6}-win32-x64-[0-9a-f]{16}$/;

/** A saved pin, or why it cannot be used. A managed pin without a store id names no instance: refused as replaced. */
export function parseSessionRuntimePin(value: unknown): { ok: true; pin: SessionRuntimePin } | { ok: false; reason: 'pin-unreadable' | 'managed-store-replaced' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'pin-unreadable' };
  const pin = value as Record<string, unknown>;
  if (pin.pinVersion !== 1) return { ok: false, reason: 'pin-unreadable' };
  if (typeof pin.closureDigest !== 'string' || !DIGEST.test(pin.closureDigest)) return { ok: false, reason: 'pin-unreadable' };
  if (pin.mode === 'managed') {
    if (pin.provider !== 'codex-cli') return { ok: false, reason: 'pin-unreadable' };
    if (pin.storeId === undefined) return { ok: false, reason: 'managed-store-replaced' };
    if (typeof pin.storeId !== 'string' || !STORE_ID.test(pin.storeId)) return { ok: false, reason: 'pin-unreadable' };
    if (typeof pin.storeKey !== 'string' || !KEY.test(pin.storeKey)) return { ok: false, reason: 'pin-unreadable' };
    return { ok: true, pin: { pinVersion: 1, mode: 'managed', provider: 'codex-cli', storeId: pin.storeId, storeKey: pin.storeKey, closureDigest: pin.closureDigest } };
  }
  if (pin.mode === 'external') {
    if (pin.provider !== 'codex-cli' && pin.provider !== 'claude-cli') return { ok: false, reason: 'pin-unreadable' };
    if (typeof pin.executable !== 'string' || pin.executable.length === 0 || pin.executable.length > 4096) return { ok: false, reason: 'pin-unreadable' };
    return { ok: true, pin: { pinVersion: 1, mode: 'external', provider: pin.provider, executable: pin.executable, closureDigest: pin.closureDigest,
      ...(typeof pin.version === 'string' && pin.version.length <= 100 ? { version: pin.version } : {}) } };
  }
  return { ok: false, reason: 'pin-unreadable' };
}

/**
 * The identity key a pin, the model cache and the identity-changed refusal compare: never a path or a digest alone.
 * Managed: the instance, the version and the closure. External: the physical program (without case on Windows) and
 * its closure.
 */
export function runtimeIdentityKey(pin: SessionRuntimePin, platform: NodeJS.Platform = process.platform): string {
  if (pin.mode === 'managed') return `managed|codex-cli|${pin.storeId}|${pin.storeKey}|${pin.closureDigest}`;
  const executable = platform === 'win32' ? pin.executable.toLowerCase() : pin.executable;
  return `external|${pin.provider}|${executable}|${pin.closureDigest}`;
}
