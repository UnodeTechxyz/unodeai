#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Rule 17: a command advertised by the public package must have its source in the public drop.
 *
 * v0.9.56 twice had `test:e2e` in package.json while its suite was absent from the allowlisted source
 * repository. The private checkout always passed, which is why this deliberately builds and inspects the
 * drop rather than inspecting the source tree. A script may be excepted only when it is inherently a
 * credentialed/live-maintainer probe; every such exception is named below with its reason.
 *--------------------------------------------------------------------------------------------*/
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve('.');
const PRIVATE_ONLY = new Map([
  ['smoke:claude-readonly', 'requires a maintainer\'s authenticated Claude CLI session and exercises a live provider.'],
  ['smoke:claude-readonly-worktree', 'requires a maintainer\'s authenticated Claude CLI session and writes a disposable live-worktree probe.'],
  ['smoke:claude-readonly-skill', 'requires a maintainer\'s authenticated Claude CLI session and a live skill-plugin probe.'],
  ['smoke:claude-pm-delegation', 'requires a maintainer\'s authenticated Claude CLI session and live delegation.'],
  ['measure:roam-similarity', 'compares this tree against a private pre-rebrand reference checkout the public drop does not and should not contain.'],
  ['probe:cache-ttl', 'is an internal, live endpoint measurement rather than a reproducible package check.'],
  ['probe:codex-appserver', 'is an internal Codex app-server compatibility probe.'],
  ['live:codex', 'starts a live, authenticated Codex turn and is intentionally not part of the public drop.'],
]);
const GENERATED_OUTPUTS = new Map([
  ['out/harness/cli.js', 'src/harness/cli.ts'],
  ['out/harness/tier2Cli.js', 'src/harness/tier2Cli.ts'],
  ['out/harness/abCli.js', 'src/harness/abCli.ts'],
]);
const BIN_PACKAGES = new Map([
  ['eslint', 'eslint'],
  ['vitest', 'vitest'],
  ['vscode-test', '@vscode/test-electron'],
  ['vsce', '@vscode/vsce'],
  ['ovsx', 'ovsx'],
  ['tsc', 'typescript'],
]);

function normalizeReference(candidate) {
  return candidate.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '').replaceAll('\\', '/');
}

/**
 * File-shaped script arguments are public-source dependencies too. `node script.mjs` is only one
 * spelling: `tsc -p test-e2e/tsconfig.json`, `tool --project src/project.json`, and `--out path`
 * are equally impossible to run when their allowlisted source was omitted.
 */
function commandFileReferences(command) {
  const refs = [];
  const pattern = /\bnode(?:\s+--[^\s]+)*\s+([^\s;&|]+)/g;
  let match;
  while ((match = pattern.exec(command))) {
    const candidate = normalizeReference(match[1]);
    if (/^(?:scripts|tools|out|src|test-e2e)[/]/.test(candidate)) {
      refs.push(candidate);
    }
  }
  const pathArgument = /(?:^|\s)(?:-p|--project|--out)(?:\s+|=)("[^"]+"|'[^']+'|[^\s;&|]+)/g;
  while ((match = pathArgument.exec(command))) {
    const candidate = normalizeReference(match[1]);
    if (/^(?:scripts|tools|out|src|test-e2e)[/]/.test(candidate)) {
      refs.push(candidate);
    }
  }
  return [...new Set(refs)];
}

function npmScriptReferences(command) {
  const refs = [];
  const pattern = /\bnpm\s+run(?:-script)?\s+([A-Za-z0-9:_-]+)/g;
  let match;
  while ((match = pattern.exec(command))) {
    refs.push(match[1]);
  }
  return refs;
}

function referencedBins(command) {
  return [...BIN_PACKAGES.keys()].filter((bin) => new RegExp(`(?:^|[;&|\\s])${bin}(?:\\s|$)`).test(command));
}

export function auditPublicScripts({ scripts, packageJson, exists }) {
  const violations = [];
  const visit = (rootName, name, stack = []) => {
    if (PRIVATE_ONLY.has(name) || stack.includes(name)) { return; }
    const command = scripts[name];
    const prefix = [...stack, name].join(' -> ');
    if (typeof command !== 'string') {
      violations.push(`${prefix}: npm script is missing`);
      return;
    }
    for (const file of commandFileReferences(command)) {
      const generatedFrom = GENERATED_OUTPUTS.get(file);
      if (generatedFrom ? !exists(generatedFrom) : !exists(file)) {
        violations.push(`${prefix}: ${file}${generatedFrom ? ` (generated from missing ${generatedFrom})` : ' is missing'}`);
      }
    }
    for (const bin of referencedBins(command)) {
      const dependency = BIN_PACKAGES.get(bin);
      if (!packageJson.dependencies?.[dependency] && !packageJson.devDependencies?.[dependency]) {
        violations.push(`${prefix}: binary ${bin} has no declared package ${dependency}`);
      }
    }
    for (const child of npmScriptReferences(command)) {
      visit(rootName, child, [...stack, name]);
    }
  };
  for (const name of Object.keys(scripts)) {
    if (!PRIVATE_ONLY.has(name)) { visit(name, name); }
  }
  return [...new Set(violations)];
}

function selfTest() {
  const base = { scripts: { good: 'node scripts/good.mjs', bad: 'node scripts/missing.mjs' }, devDependencies: {} };
  const violations = auditPublicScripts({
    scripts: base.scripts,
    packageJson: base,
    exists: (file) => file === 'scripts/good.mjs',
  });
  if (violations.length !== 1 || !violations[0].includes('bad: scripts/missing.mjs')) {
    throw new Error('public-drop script self-test failed: planted omitted script was not rejected');
  }
  const liveOnly = auditPublicScripts({
    scripts: { 'live:codex': 'node scripts/live-codex-turn.cjs' },
    packageJson: { scripts: {} },
    exists: () => false,
  });
  if (liveOnly.length !== 0) {
    throw new Error('public-drop script self-test failed: declared private live command was not exempted');
  }
  const omittedE2e = auditPublicScripts({
    scripts: {
      'test:e2e': 'npm run compile:e2e && vscode-test',
      'compile:e2e': 'tsc -p ./test-e2e/tsconfig.json',
    },
    packageJson: { scripts: {}, devDependencies: { typescript: 'test', '@vscode/test-electron': 'test' } },
    // This is the actual v0.9.56 omission: `test:e2e` remains advertised while its entire source tree
    // disappeared from the public-drop allowlist. Do not replace it with a node-script-only surrogate.
    exists: (file) => !file.startsWith('test-e2e/'),
  });
  if (!omittedE2e.some((entry) => entry.includes('test:e2e -> compile:e2e: test-e2e/tsconfig.json is missing'))) {
    throw new Error('public-drop script self-test failed: an omitted test-e2e directory was accepted');
  }
}

function buildDrop() {
  const drop = mkdtempSync(join(tmpdir(), 'unode-public-drop-scripts-'));
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-public-drop.mjs'), '--out', drop], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`could not build public source drop:\n${result.stderr || result.stdout}`);
  }
  return drop;
}

function main() {
  selfTest();
  const provided = process.argv.indexOf('--drop');
  const drop = provided >= 0 ? resolve(process.argv[provided + 1] ?? '') : buildDrop();
  const ownsDrop = provided < 0;
  try {
    const packageJson = JSON.parse(readFileSync(join(drop, 'package.json'), 'utf8'));
    const violations = auditPublicScripts({
      scripts: packageJson.scripts ?? {},
      packageJson,
      exists: (file) => existsSync(join(drop, file)),
    });
    if (violations.length > 0) {
      throw new Error(
        `check:public-drop-scripts failed; the built drop advertises commands it cannot supply:\n- ${violations.join('\n- ')}`,
      );
    }
    console.log(
      `check:public-drop-scripts passed (${Object.keys(packageJson.scripts ?? {}).length} advertised scripts; `
      + `${PRIVATE_ONLY.size} declared credentialed/live exceptions).`,
    );
  } finally {
    if (ownsDrop) { rmSync(drop, { recursive: true, force: true }); }
  }
}

main();
