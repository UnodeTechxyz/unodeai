#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Build the bundled VSIX twice from clean generated output and require byte identity.
 *
 * This is deliberately a build test, rather than a comparison of two copies of one package:
 * SOURCE_DATE_EPOCH in package-bundle.mjs must make independently-produced ZIP bytes match.
 *
 * The package the second build leaves in the repository root is the one that was proved. With
 * `--receipt <path>` its path, hash and size are written down, so that a later step can test that
 * exact file instead of packaging a third time.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const vsix = join(root, `unodeai-${pkg.version}-bundled.vsix`);
const snapshotDir = mkdtempSync(join(tmpdir(), 'unodeai-vsix-determinism-'));
const first = join(snapshotDir, 'first.vsix');
const second = join(snapshotDir, 'second.vsix');
const receiptFlag = process.argv.indexOf('--receipt');
const receiptPath = receiptFlag === -1 ? undefined : process.argv[receiptFlag + 1];

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
  if (receiptFlag !== -1 && !receiptPath) { throw new Error('--receipt needs a path'); }
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
  } else if (sha256(vsix) !== secondHash) {
    fail('the package left in the repository root is not the second build; refusing to name it as the proved artifact.');
  } else {
    console.log('OK: two clean package:bundle runs produced byte-identical VSIX artifacts.');
    console.log(`retained: ${vsix}`);
    if (receiptPath) {
      const receipt = { artifact: vsix, sha256: secondHash, bytes: secondBytes, builds: 2 };
      writeFileSync(resolve(receiptPath), `${JSON.stringify(receipt, null, 2)}\n`);
    }
  }
} finally {
  rmSync(snapshotDir, { recursive: true, force: true });
}
