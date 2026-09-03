/*---------------------------------------------------------------------------------------------
 * The host's human approval window and the Claude tool gate's accepted range are two constants in
 * two files that MUST agree. ClaudeHeadlessBackend exports WEB_ACCESS_HUMAN_WINDOW_MS into the gate
 * as UNODE_CLAUDE_TOOL_GATE_TIMEOUT_MS, and the gate's boundedEnv() FALLS BACK (it does not clamp)
 * when the value is out of range — so raising the window past the gate's cap silently reverts the
 * effective window to the gate's 3-minute default, with no error anywhere.
 *
 * That is exactly what happened when UX3-WIN raised the window to 15 minutes against a 10-minute cap.
 * This test ties the two constants together so the coupling cannot break silently again.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WEB_ACCESS_HUMAN_WINDOW_MS } from '../WebAccessPolicy';

/** Read a numeric constant out of the gate script without executing its protocol. */
function gateConstant(name: string): number {
  const source = readFileSync(resolve(process.cwd(), 'src', 'claudeToolGate.cjs'), 'utf8');
  const match = new RegExp(`const ${name} = ([^;]+);`).exec(source);
  if (!match) { throw new Error(`${name} not found in claudeToolGate.cjs`); }
  return eval(match[1]) as number;
}

/** Faithful reproduction of boundedEnv() in claudeToolGate.cjs — note it falls back, never clamps. */
function boundedEnv(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

describe('human approval window ↔ Claude tool gate coupling', () => {
  it('the gate ACCEPTS the host window rather than silently falling back', () => {
    const max = gateConstant('MAX_DECISION_TIMEOUT_MS');
    const fallback = gateConstant('DEFAULT_DECISION_TIMEOUT_MS');
    const effective = boundedEnv(WEB_ACCESS_HUMAN_WINDOW_MS, fallback, 50, max);

    expect(effective).toBe(WEB_ACCESS_HUMAN_WINDOW_MS);
    // Guard the failure mode explicitly: falling back to the default is the silent bug.
    expect(effective).not.toBe(fallback === WEB_ACCESS_HUMAN_WINDOW_MS ? -1 : fallback);
  });

  it('the gate cap leaves headroom above the host window', () => {
    expect(gateConstant('MAX_DECISION_TIMEOUT_MS')).toBeGreaterThanOrEqual(WEB_ACCESS_HUMAN_WINDOW_MS);
  });

  it('the transport liveness clock stays on the seconds scale, independent of the human window', () => {
    // The two-clock model is the v0.9.32 P0. A generous human window must never relax liveness.
    expect(gateConstant('DEFAULT_LIVENESS_TIMEOUT_MS')).toBeLessThanOrEqual(10_000);
    expect(gateConstant('MAX_LIVENESS_TIMEOUT_MS')).toBeLessThanOrEqual(10_000);
  });
});
