import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner report, v0.9.79 a13: "Shared-memory attestation is disabled until you trust this workspace" appeared in
 * the bottom-right corner, where nobody saw it. The outcome of a dialog or picker the user has just answered
 * belongs where their attention already is.
 *
 * Structural on purpose, and narrow on purpose: no unit test can observe where VS Code draws a message, and this
 * pins only the flow that was reported plus the dialog that shipped two Cancel buttons. The other converted
 * outcome messages are not individually guarded.
 */
const source = readFileSync(resolve(process.cwd(), 'src', 'extension.ts'), 'utf8');

function functionBody(signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`could not locate ${signature}`);
  const ends = ['\nasync function ', '\nfunction ', '\nexport '].map((marker) => source.indexOf(marker, start + signature.length)).filter((i) => i > 0);
  return source.slice(start, Math.min(...ends));
}

describe('outcome notifications appear where the user is looking', () => {
  it('Review Shared Memory reports every outcome, including every refusal, in a modal', () => {
    const body = functionBody('async function reviewSharedMemory(');
    const calls = [...body.matchAll(/window\.show(?:Information|Warning)Message\(([\s\S]*?)\);/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(9);
    for (const args of calls) {
      expect(args, `non-modal outcome: ${args.slice(0, 90)}`).toContain('modal: true');
    }
  });

  it('the cross-provider brief dialog is modal and has exactly one Cancel', () => {
    const body = functionBody('async function approveCoordinatorBriefEgress(');
    expect(body).toContain('modal: true');
    // VS Code adds Cancel to every modal. Passing another one rendered two.
    expect(body).not.toMatch(/'Cancel'/);
  });
});
