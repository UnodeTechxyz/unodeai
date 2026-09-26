#!/usr/bin/env node
/**
 * `WorkspaceEscapeError` is a terminal control signal, not a general refusal. Keep its construction
 * physically confined to the five path proofs that establish a real configured-workspace escape.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const FILE = join(ROOT, 'src/backend/WorkspaceTools.ts');
const PERMITTED_METHODS = [
  'resolve(p: string)',
  'resolveReadCandidates(p: string)',
  'assertWritablePathInsideSandbox(abs: string, original: string)',
  'assertRealPathInsideSandbox(realPath: string, original: string, root: string = this.commandCwd)',
];
const EXPECTED_CONSTRUCTIONS = 5;

function methodSpans(text) {
  return PERMITTED_METHODS.map((signature) => {
    const start = text.indexOf(`  private ${signature}`) >= 0
      ? text.indexOf(`  private ${signature}`)
      : text.indexOf(`  private async ${signature}`);
    if (start < 0) return undefined;
    const next = text.indexOf('\n  private ', start + 1);
    return { signature, start, end: next < 0 ? text.length : next };
  });
}

export function workspaceEscapeBoundaryViolations(text) {
  const spans = methodSpans(text);
  const violations = spans.flatMap((span, index) => span ? [] : [`missing permitted method ${PERMITTED_METHODS[index]}`]);
  const constructions = [...text.matchAll(/new WorkspaceEscapeError\(/g)].map((match) => match.index ?? -1);
  if (constructions.length !== EXPECTED_CONSTRUCTIONS) {
    violations.push(`expected ${EXPECTED_CONSTRUCTIONS} WorkspaceEscapeError constructions, found ${constructions.length}`);
  }
  for (const at of constructions) {
    if (!spans.some((span) => span && at >= span.start && at < span.end)) {
      violations.push(`WorkspaceEscapeError constructed outside a permitted path-boundary method at offset ${at}`);
    }
  }
  return violations;
}

function selfTest() {
  const outside = workspaceEscapeBoundaryViolations('new WorkspaceEscapeError("bad")');
  if (!outside.some((violation) => violation.includes('outside a permitted'))) {
    throw new Error('workspace escape boundary self-test failed: out-of-bound construction escaped');
  }
}

selfTest();
const violations = workspaceEscapeBoundaryViolations(readFileSync(FILE, 'utf8'));
if (violations.length) {
  throw new Error(`check:workspace-escape-boundary failed:\n- ${violations.join('\n- ')}`);
}
console.log(`check:workspace-escape-boundary passed (${EXPECTED_CONSTRUCTIONS} constructions in path-boundary methods).`);
