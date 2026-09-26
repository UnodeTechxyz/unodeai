#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function packageFiles(packageRoot) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name === '.bin') continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error(`Release runner integrity cannot classify ${absolute}.`);
    }
  };
  visit(packageRoot);
  return files;
}

export function hashInstalledPackageTree(packageRoot) {
  const hash = createHash('sha256');
  for (const absolute of packageFiles(packageRoot)) {
    const path = relative(packageRoot, absolute).replaceAll('\\', '/');
    const bytes = readFileSync(absolute);
    hash.update(`file\0${path}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function releaseRunnerIntegrityViolations({ root, expected }) {
  const violations = [];
  if (!expected || typeof expected.package !== 'string' || typeof expected.version !== 'string'
      || !/^[a-f0-9]{64}$/.test(expected.treeSha256 ?? '')) {
    return ['Release runner integrity baseline is missing or malformed.'];
  }
  const packageRoot = join(root, 'node_modules', ...expected.package.split('/'));
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  } catch (error) {
    return [`Release runner package ${expected.package} is unavailable: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (manifest.version !== expected.version) {
    violations.push(`Release runner ${expected.package} is ${String(manifest.version)}, expected ${expected.version}.`);
  }
  const actualHash = hashInstalledPackageTree(packageRoot);
  if (actualHash !== expected.treeSha256) {
    violations.push(
      `Release runner ${expected.package}@${expected.version} has local file changes `
      + `(tree sha256 ${actualHash}, expected ${expected.treeSha256}). Run npm ci before collecting release evidence; `
      + 'evidence from a locally patched dependency tree is invalid.',
    );
  }
  return violations;
}

export function selfTestReleaseRunnerIntegrity() {
  const fixture = mkdtempSync(join(tmpdir(), 'unode-runner-integrity-'));
  try {
    const packageRoot = join(fixture, 'node_modules', 'fixture-runner');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), '{"name":"fixture-runner","version":"1.0.0"}\n', 'utf8');
    writeFileSync(join(packageRoot, 'dist', 'runner.js'), 'export const clean = true;\n', 'utf8');
    const expected = {
      package: 'fixture-runner',
      version: '1.0.0',
      treeSha256: hashInstalledPackageTree(packageRoot),
    };
    if (releaseRunnerIntegrityViolations({ root: fixture, expected }).length !== 0) {
      throw new Error('release runner integrity self-test rejected the clean fixture');
    }
    writeFileSync(join(packageRoot, 'dist', 'runner.js'), 'export const locallyPatched = true;\n', 'utf8');
    const planted = releaseRunnerIntegrityViolations({ root: fixture, expected });
    if (planted.length !== 1 || !planted[0].includes('local file changes')) {
      throw new Error('release runner integrity self-test accepted a planted local dependency edit');
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

export function assertReleaseRunnerIntegrity({ root = scriptRoot, baseline }) {
  const violations = releaseRunnerIntegrityViolations({ root, expected: baseline?.testRunner });
  if (violations.length > 0) {
    throw new Error(`Release runner integrity failed:\n- ${violations.join('\n- ')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseline = JSON.parse(readFileSync(join(scriptRoot, 'scripts', 'release-test-baseline.json'), 'utf8'));
  if (process.argv.includes('--print')) {
    const expected = baseline.testRunner;
    const packageRoot = join(scriptRoot, 'node_modules', ...expected.package.split('/'));
    console.log(`${expected.package}@${JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version} ${hashInstalledPackageTree(packageRoot)}`);
  } else {
    selfTestReleaseRunnerIntegrity();
    assertReleaseRunnerIntegrity({ root: scriptRoot, baseline });
    console.log(`release runner integrity passed (${baseline.testRunner.package}@${baseline.testRunner.version}; planted local edit rejected).`);
  }
}
