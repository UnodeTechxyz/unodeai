#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Build the bundled VSIX twice from clean generated output and require byte identity.
 *
 * This is deliberately a build test, rather than a comparison of two copies of one package:
 * SOURCE_DATE_EPOCH in package-bundle.mjs must make independently-produced ZIP bytes match.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const vsix = join(root, `unodeai-${pkg.version}-bundled.vsix`);
const snapshotDir = mkdtempSync(join(tmpdir(), 'unodeai-vsix-determinism-'));
const first = join(snapshotDir, 'first.vsix');
const second = join(snapshotDir, 'second.vsix');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

function runPackageBundle() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/c', npm, 'run', 'package:bundle'], { cwd: root, stdio: 'inherit' })
    : spawnSync(npm, ['run', 'package:bundle'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`package:bundle failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function cleanGeneratedOutput() {
  // These are fixed, generated paths under the repository. Removing them proves the second package
  // does not accidentally reuse the first artifact or its build output.
  for (const path of [join(root, 'out'), join(root, '.bundle-package'), vsix]) {
    rmSync(path, { recursive: true, force: true });
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

try {
  cleanGeneratedOutput();
  runPackageBundle();
  if (!existsSync(vsix)) { throw new Error(`first package did not produce ${vsix}`); }
  cpSync(vsix, first);

  cleanGeneratedOutput();
  runPackageBundle();
  if (!existsSync(vsix)) { throw new Error(`second package did not produce ${vsix}`); }
  cpSync(vsix, second);

  const firstHash = sha256(first);
  const secondHash = sha256(second);
  const firstBytes = readFileSync(first).byteLength;
  const secondBytes = readFileSync(second).byteLength;

  console.log(`first  : ${firstHash} (${firstBytes} bytes)`);
  console.log(`second : ${secondHash} (${secondBytes} bytes)`);
  if (firstHash !== secondHash || firstBytes !== secondBytes) {
    fail('bundled VSIX is not byte-reproducible; refusing the release artifact.');
  } else {
    console.log('OK: two clean package:bundle runs produced byte-identical VSIX artifacts.');
  }
} finally {
  rmSync(snapshotDir, { recursive: true, force: true });
}
