#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Rehearse the human side of the canonical CI release flow without a credential or a publish.
 *
 * A person downloads the Ubuntu-built VSIX, compares its SHA-256 with the value CI recorded, and
 * invokes publish:frozen --dry-run first. This test proves that the existing frozen verifier accepts
 * that preflight without resolving .ovsx-pat / OVSX_PAT / a registry CLI, and still refuses a mismatch.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const fixtureDir = mkdtempSync(join(tmpdir(), 'unode-canonical-artifact-rehearsal-'));
const fixture = join(fixtureDir, 'downloaded-from-ci.vsix');
const frozenPublisher = join(root, 'scripts', 'publish-frozen.mjs');
const fixtureBytes = 'synthetic downloaded VSIX bytes - no archive is needed before hash verification';

function run(expectedHash) {
  return spawnSync(process.execPath, [
    frozenPublisher,
    '--file', fixture,
    '--sha256', expectedHash,
    '--registry', 'ovsx',
    '--dry-run',
  ], {
    // The isolated cwd contains no .ovsx-pat. A successful preflight must not need a credential.
    cwd: fixtureDir,
    encoding: 'utf8',
    env: { ...process.env, OVSX_PAT: '' },
  });
}

try {
  writeFileSync(fixture, fixtureBytes);
  const expected = createHash('sha256').update(fixtureBytes).digest('hex');

  const accepted = run(expected);
  const acceptedOutput = `${accepted.stdout ?? ''}${accepted.stderr ?? ''}`;
  if (accepted.status !== 0
    || !acceptedOutput.includes('dry run: verified only')
    || acceptedOutput.includes('would run:')
    || acceptedOutput.includes('no Open VSX token')) {
    throw new Error(`canonical artifact preflight was not credential-free:\n${acceptedOutput}`);
  }

  const rejected = run('0'.repeat(64));
  const rejectedOutput = `${rejected.stdout ?? ''}${rejected.stderr ?? ''}`;
  if (rejected.status === 0
    || !rejectedOutput.includes('SHA-256 MISMATCH')
    || rejectedOutput.includes('would run:')) {
    throw new Error(`canonical artifact mismatch did not fail closed before any upload path:\n${rejectedOutput}`);
  }

  console.log('OK: a CI-artifact dry run needs no publish credential and a planted mismatch is refused.');
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
