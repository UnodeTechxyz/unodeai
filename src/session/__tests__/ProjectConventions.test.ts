import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { detectConventions, detectProjectMap, buildProjectMapBlock, ProjectConventions, FileReader, DirLister, autoVerifyCommand, resolveVerifyCommand } from '../ProjectConventions';

describe('autoVerifyCommand / resolveVerifyCommand', () => {
  it('prefers test → build → lint from the project scripts, using the package manager', () => {
    expect(autoVerifyCommand({ packageManager: 'npm', scripts: { test: 'jest', build: 'tsc' } })).toBe('npm run test');
    expect(autoVerifyCommand({ packageManager: 'pnpm', scripts: { build: 'tsc', lint: 'eslint .' } })).toBe('pnpm run build');
    expect(autoVerifyCommand({ packageManager: 'yarn', scripts: { lint: 'eslint .' } })).toBe('yarn run lint');
  });
  it('returns empty when there is no runnable script (so the gate stays disabled, never invents tsc)', () => {
    expect(autoVerifyCommand({ packageManager: 'npm', scripts: {} })).toBe('');
    expect(autoVerifyCommand({ packageManager: 'npm', scripts: { start: 'node server.js' } })).toBe('');
  });
  it('resolve honors an explicit setting over auto-detection', () => {
    const info = { packageManager: 'npm', scripts: { test: 'jest' } };
    expect(resolveVerifyCommand('npm run build', info)).toBe('npm run build'); // explicit wins
    expect(resolveVerifyCommand('   ', info)).toBe('npm run test');            // blank → auto-detect
    expect(resolveVerifyCommand(undefined, info)).toBe('npm run test');
  });
});

/** Build a fake reader from a map of basename -> content; missing files throw (like fs). */
function reader(files: Record<string, string>): FileReader {
  return async (filePath: string) => {
    const base = path.basename(filePath);
    if (base in files) return files[base];
    throw new Error('ENOENT');
  };
}

/** Fake directory lister returning fixed top-level subdirectory names. */
function lister(dirs: string[]): DirLister {
  return async () => dirs;
}

describe('detectConventions', () => {
  it('lists scripts + package manager + guidance when package.json has scripts', async () => {
    const out = await detectConventions('/repo', reader({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc -p .' } }),
      'pnpm-lock.yaml': '',
    }));
    expect(out).toMatch(/Package manager: pnpm/);
    expect(out).toMatch(/test: vitest run/);
    expect(out).toMatch(/build: tsc -p \./);
    // A2 behavioral guidance is present.
    expect(out).toMatch(/Do NOT invent commands/i);
    expect(out).toMatch(/infrastructure is broken/i);
  });

  it('defaults to npm when no lockfile, and detects yarn/bun', async () => {
    const base = { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) };
    expect(await detectConventions('/r', reader(base))).toMatch(/Package manager: npm/);
    expect(await detectConventions('/r', reader({ ...base, 'yarn.lock': '' }))).toMatch(/Package manager: yarn/);
    expect(await detectConventions('/r', reader({ ...base, 'bun.lockb': '' }))).toMatch(/Package manager: bun/);
  });

  it('returns empty for no package.json, invalid JSON, or no scripts', async () => {
    expect(await detectConventions('/r', reader({}))).toBe('');
    expect(await detectConventions('/r', reader({ 'package.json': '{not json' }))).toBe('');
    expect(await detectConventions('/r', reader({ 'package.json': JSON.stringify({ name: 'x' }) }))).toBe('');
  });

  it('caps the number of scripts injected', async () => {
    const scripts: Record<string, string> = {};
    for (let i = 0; i < 40; i++) scripts[`s${i}`] = `echo ${i}`;
    const out = await detectConventions('/r', reader({ 'package.json': JSON.stringify({ scripts }) }));
    expect(out).toMatch(/and 15 more/);
  });

  it('ProjectConventions caches the loaded block', async () => {
    const pc = new ProjectConventions('/r', reader({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) }), lister([]));
    expect(pc.get()).toBe('');
    await pc.load();
    expect(pc.get()).toMatch(/test: vitest/);
  });
});

describe('project layout map (A1/A2 structure awareness)', () => {
  it('detects stack (TS + test framework) and lists top-level dirs, skipping noise/dotdirs', async () => {
    const map = await detectProjectMap(
      '/r',
      reader({ 'package.json': JSON.stringify({ devDependencies: { typescript: '^5', vitest: '^4' } }) }),
      lister(['src', 'docs', 'node_modules', '.git', 'out', '.hidden', 'marketplace'])
    );
    expect(map.stack).toEqual(['TypeScript', 'tests: vitest']);
    expect(map.dirs).toEqual(['docs', 'marketplace', 'src']); // sorted, noise + dotdirs removed
  });

  it('detects TypeScript via tsconfig.json when not in deps', async () => {
    const map = await detectProjectMap('/r', reader({ 'tsconfig.json': '{}' }), lister(['src']));
    expect(map.stack).toContain('TypeScript');
  });

  it('buildProjectMapBlock renders stack, dirs, and the no-guess-paths rule', () => {
    const out = buildProjectMapBlock({ stack: ['TypeScript', 'tests: vitest'], dirs: ['src', 'docs'] });
    expect(out).toMatch(/Stack: TypeScript, tests: vitest/);
    expect(out).toMatch(/`src\/`, `docs\/`/);
    expect(out).toMatch(/do NOT invent a new path/i);
    expect(buildProjectMapBlock({ stack: [], dirs: [] })).toBe('');
  });

  it('ProjectConventions.load injects BOTH the command conventions and the layout map', async () => {
    const pc = new ProjectConventions(
      '/r',
      reader({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { typescript: '^5' } }) }),
      lister(['src', 'docs'])
    );
    await pc.load();
    expect(pc.get()).toMatch(/Project conventions/); // command block
    expect(pc.get()).toMatch(/Project layout/);        // layout block
    expect(pc.get()).toMatch(/Stack: TypeScript/);
  });
});
