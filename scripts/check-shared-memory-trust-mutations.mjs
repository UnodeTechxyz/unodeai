#!/usr/bin/env node
/* Re-runnable v0.9.79 trust-priority mutation proof. The working tree is never mutated. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve('.');
const SANDBOX = join(process.env.RUNNER_TEMP?.trim() || tmpdir(), `unodeai-memory-mutation-${process.pid}`);
const SOURCE = 'src/session/SharedMemory.ts';
const SUITE = 'src/session/__tests__/SharedMemory.test.ts';
const FILES = [SOURCE, SUITE, 'src/backend/workspacePath.ts', 'src/types.ts', 'vitest.config.ts'];

function copy(relativePath) {
  const target = join(SANDBOX, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(ROOT, relativePath), target);
}

function nodeModules(start) {
  let directory = start;
  for (;;) {
    const candidate = join(directory, 'node_modules');
    if (existsSync(join(candidate, 'vitest'))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Could not locate node_modules with vitest.');
    directory = parent;
  }
}

let lastFailure;

function suitePasses() {
  try {
    const cli = join(nodeModules(ROOT), 'vitest', 'vitest.mjs');
    execFileSync(process.execPath, [cli, 'run', SUITE], {
      cwd: SANDBOX,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --preserve-symlinks --preserve-symlinks-main`.trim() },
    });
    lastFailure = undefined;
    return true;
  } catch (error) {
    lastFailure = error;
    return false;
  }
}

function cleanup() {
  try { rmdirSync(join(SANDBOX, 'node_modules')); } catch { /* absent */ }
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
}

try {
  FILES.forEach(copy);
  symlinkSync(nodeModules(ROOT), join(SANDBOX, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  if (!suitePasses()) {
    const detail = String(lastFailure?.stdout ?? lastFailure?.stderr ?? '').slice(-5_000);
    throw new Error(`Shared-memory mutation baseline is not green.\n${detail}`);
  }
  console.log('shared-memory mutation baseline green');

  const sourcePath = join(SANDBOX, SOURCE);
  const source = readFileSync(sourcePath, 'utf8');
  const trusted = '.filter((note) => attestedDigests.has(note.digest))';
  const untrusted = '.filter((note) => !attestedDigests.has(note.digest))';
  if (!source.includes(trusted) || !source.includes(untrusted)) {
    throw new Error('Mutation anchor missing: selection policy changed without updating this proof.');
  }
  const mutated = source
    .replace(trusted, ".filter((note) => note.kind === 'contract')")
    .replace(untrusted, ".filter((note) => note.kind !== 'contract')");
  writeFileSync(sourcePath, mutated, 'utf8');
  if (suitePasses()) throw new Error('SURVIVED: an agent-selected contract regained trust/admission priority.');
  console.log('killed: agent-selected contract cannot regain trust/admission priority');
} finally {
  cleanup();
}
