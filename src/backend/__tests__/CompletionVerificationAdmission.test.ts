import { lstatSync, mkdtempSync, mkdirSync, promises as fs, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { admitCompletionVerification, readVerificationManifest, verificationScript, VERIFICATION_MANIFEST_LIMIT } from '../CompletionVerificationAdmission';
import { resolveCompletionVerificationPolicy } from '../CompletionVerificationPolicy';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(path.join(tmpdir(), 'unode-verification-admission-')); dirs.push(dir); return dir; };
const resolve = (completionVerification: unknown, skills: string[] = []) => resolveCompletionVerificationPolicy({
  workspaceId: 'workspace-A', agentSkills: skills, completionVerification, readLegacyGlobalCommand: () => undefined,
});
const io = (scripts: Record<string, string> = { test: 'test', lint: 'lint' }, manager = 'npm') => ({
  manifest: vi.fn(async () => ({ kind: 'read' as const, scripts })),
  packageManager: vi.fn(async () => manager),
});

describe('completion command applicability is narrow and never an execution grant', () => {
  it.each([
    ['npm test', 'test'], ['npm run lint', 'lint'], ['pnpm run type-check', 'type-check'], ['yarn run ci:unit', 'ci:unit'],
    ['npm test -- --watch', undefined], ['npm run lint && echo done', undefined], ['npm run "test"', undefined],
    ['pnpm test', undefined], ['yarn test', undefined], ['bun run test', undefined], ['npx vitest', undefined],
    ['npm run ../test', undefined], ['npm run ' + 'a'.repeat(81), undefined], ['npm  run test', undefined],
  ])('recognizes only an entire exact supported command: %s', (command, expected) => {
    expect(verificationScript(command)).toBe(expected);
  });

  it('disabled and invalid resolve without manifest or manager reads', async () => {
    const readers = io();
    expect((await admitCompletionVerification(resolve({ mode: 'disabled' }), '/unused', readers)).kind).toBe('disabled');
    expect((await admitCompletionVerification(resolve({ mode: 'Auto' }), '/unused', readers)).kind).toBe('configuration-invalid');
    expect(readers.manifest).not.toHaveBeenCalled();
    expect(readers.packageManager).not.toHaveBeenCalled();
  });

  it.each(['npm test', 'npm run test', 'pnpm run test', 'yarn run test'])('preflights %s at the exact execution cwd', async command => {
    const readers = io();
    expect(await admitCompletionVerification(resolve({ mode: 'command', command }), '/actual/worktree', readers))
      .toMatchObject({ kind: 'ready', command, applicability: 'recognized', effective: { source: 'team-document' } });
    expect(readers.manifest).toHaveBeenCalledWith('/actual/worktree');
    expect(readers.packageManager).not.toHaveBeenCalled();
  });

  it('npm test never relies on an implicit script or a prototype property', async () => {
    for (const scripts of [{}, Object.create({ test: 'not own' })]) {
      expect(await admitCompletionVerification(resolve({ mode: 'command', command: 'npm test' }), '/cwd', io(scripts)))
        .toMatchObject({ kind: 'not-applicable', reason: 'script-missing' });
    }
  });

  it('unchecked commands neither invent manifest evidence nor get blocked solely for being unrecognized', async () => {
    const readers = io();
    const command = 'npm test -- --watch';
    expect(await admitCompletionVerification(resolve({ mode: 'command', command }), '/cwd', readers))
      .toMatchObject({ kind: 'ready', command, applicability: 'unchecked' });
    expect(readers.manifest).not.toHaveBeenCalled();
  });

  it.each(['manifest-missing', 'manifest-unreadable'] as const)('keeps %s out of execution for auto and exact scripts', async kind => {
    for (const policy of [{ mode: 'auto' }, { mode: 'command', command: 'npm test' }]) {
      expect(await admitCompletionVerification(resolve(policy), '/cwd', { ...io(), manifest: async () => ({ kind }) }))
        .toMatchObject({ kind: 'not-applicable', reason: kind });
    }
  });

  it.each(['test', 'typecheck', 'type-check', 'check', 'build', 'lint'])('preserves auto script priority starting with %s', async first => {
    const order = ['test', 'typecheck', 'type-check', 'check', 'build', 'lint'];
    const scripts = Object.fromEntries(order.slice(order.indexOf(first)).map(name => [name, name]));
    expect(await admitCompletionVerification(resolve({ mode: 'auto' }), '/cwd', io(scripts, 'pnpm')))
      .toMatchObject({ kind: 'ready', command: `pnpm run ${first}`, applicability: 'recognized' });
  });

  it('auto with no usable script is not-applicable, while bun is explicitly unchecked', async () => {
    expect(await admitCompletionVerification(resolve({ mode: 'auto' }), '/cwd', io({})))
      .toMatchObject({ kind: 'not-applicable', reason: 'no-auto-check' });
    expect(await admitCompletionVerification(resolve({ mode: 'auto' }), '/cwd', io({ test: 'test' }, 'bun')))
      .toMatchObject({ kind: 'ready', command: 'bun run test', applicability: 'unchecked' });
  });
});

describe('bounded regular manifest and existing manager detection over real files', () => {
  it('missing does not create anything, and relative cwd is not read', async () => {
    expect(await readVerificationManifest(folder())).toEqual({ kind: 'manifest-missing' });
    expect(await readVerificationManifest('.')).toEqual({ kind: 'manifest-unreadable' });
  });
  it.each(['[]', 'null', '{', '"string"'])('rejects malformed/non-object manifest %s', async content => {
    const dir = folder(); writeFileSync(path.join(dir, 'package.json'), content);
    expect(await readVerificationManifest(dir)).toEqual({ kind: 'manifest-unreadable' });
  });
  it('rejects a directory at package.json', async () => {
    const dir = folder(); mkdirSync(path.join(dir, 'package.json'));
    expect(await readVerificationManifest(dir)).toEqual({ kind: 'manifest-unreadable' });
  });
  it('rejects a manifest file link without following its target', async context => {
    const dir = folder();
    const target = path.join(dir, 'source.json');
    writeFileSync(target, '{"scripts":{"test":"yes"}}');
    try { symlinkSync(target, path.join(dir, 'package.json'), 'file'); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return context.skip();
      throw error;
    }
    expect(lstatSync(path.join(dir, 'package.json')).isSymbolicLink()).toBe(true);
    expect(await readVerificationManifest(dir)).toEqual({ kind: 'manifest-unreadable' });
  });
  it('refuses link metadata before opening, even when following the name would read a valid file', async () => {
    const dir = folder(); const file = path.join(dir, 'package.json');
    writeFileSync(file, '{"scripts":{"test":"yes"}}');
    expect(await readVerificationManifest(dir)).toMatchObject({ kind: 'read', scripts: { test: 'yes' } });
    // Model lstat's link metadata independently of OS symlink privilege/O_NOFOLLOW. stat still sees the valid
    // regular target, so replacing lstat with stat must fail this test even on Linux and restricted Windows.
    const metadata = await fs.lstat(file);
    const lstat = vi.spyOn(fs, 'lstat').mockResolvedValue(Object.assign(metadata, {
      isFile: () => false, isSymbolicLink: () => true,
    }));
    const open = vi.spyOn(fs, 'open');
    try {
      expect(await readVerificationManifest(dir)).toEqual({ kind: 'manifest-unreadable' });
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore(); lstat.mockRestore();
    }
  });
  it('enforces the exact 1 MiB boundary', async () => {
    const dir = folder(); const file = path.join(dir, 'package.json');
    const base = '{"scripts":{"test":"run"}}';
    writeFileSync(file, base + ' '.repeat(VERIFICATION_MANIFEST_LIMIT - Buffer.byteLength(base)));
    expect(await readVerificationManifest(dir)).toMatchObject({ kind: 'read', scripts: { test: 'run' } });
    writeFileSync(file, base + ' '.repeat(VERIFICATION_MANIFEST_LIMIT + 1 - Buffer.byteLength(base)));
    expect(await readVerificationManifest(dir)).toEqual({ kind: 'manifest-unreadable' });
  });
  it('does not coerce non-string or whitespace script values into runnable scripts', async () => {
    const dir = folder();
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: {}, check: 1, lint: ' ', build: 'build' } }));
    expect(await readVerificationManifest(dir)).toMatchObject({ kind: 'read', scripts: { build: 'build' } });
  });
  it('shares pnpm > yarn > bun > npm detection without reading lock contents', async () => {
    const dir = folder(); writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"test"}}');
    const resolution = resolve({ mode: 'auto' });
    expect(await admitCompletionVerification(resolution, dir)).toMatchObject({ command: 'npm run test' });
    writeFileSync(path.join(dir, 'bun.lockb'), '');
    expect(await admitCompletionVerification(resolution, dir)).toMatchObject({ command: 'bun run test', applicability: 'unchecked' });
    writeFileSync(path.join(dir, 'yarn.lock'), '');
    expect(await admitCompletionVerification(resolution, dir)).toMatchObject({ command: 'yarn run test' });
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    expect(await admitCompletionVerification(resolution, dir)).toMatchObject({ command: 'pnpm run test' });
  });
});
