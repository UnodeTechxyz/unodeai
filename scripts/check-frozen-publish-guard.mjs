#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Load-bearing release-integrity regression: a deliberately wrong expected hash must prevent an
 * upload before credentials or registry CLIs are consulted.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const fixtureDir = mkdtempSync(join(tmpdir(), 'unode-frozen-publish-guard-'));
const fixture = join(fixtureDir, 'accepted-but-tampered.vsix');
const frozenPublisher = join(root, 'scripts', 'publish-frozen.mjs');
const impossibleHash = '0'.repeat(64);

try {
  writeFileSync(fixture, 'this is intentionally not a valid VSIX; the hash guard runs before upload');
  const result = spawnSync(process.execPath, [
    frozenPublisher,
    '--file', fixture,
    '--sha256', impossibleHash,
    '--registry', 'ovsx',
    '--dry-run',
  ], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.status === 0) {
    throw new Error('planted mismatched hash unexpectedly succeeded.');
  }
  if (!output.includes('SHA-256 MISMATCH') || output.includes('would run:')) {
    throw new Error(`mismatched hash did not fail closed before upload:\n${output}`);
  }
  console.log('OK: planted SHA-256 mismatch was refused before any upload path was reached.');
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
