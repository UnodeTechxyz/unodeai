import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareOwnedPythonCache, pythonCacheEnvironment, terminalPythonCacheEnvironment } from '../PythonCache';

const fixtures: string[] = [];
const fixture = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-python-cache-')));
  fixtures.push(root); return root;
};
afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  for (const root of fixtures.splice(0)) {
    if (fs.realpathSync(root) !== root || path.dirname(root) !== fs.realpathSync(os.tmpdir())) throw Error('Unsafe fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('prepares a separate owned global-storage child and detects replacement without granting its parent', () => {
  const root = fixture(); const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const cache = prepareOwnedPythonCache(path.join(root, 'storage'), [workspace])!;
  expect(path.relative(path.join(root, 'storage', 'python-cache'), cache.root).split(path.sep)).toHaveLength(2);
  expect(cache.current()).toBe(true);
  fs.renameSync(cache.root, cache.root + '-old'); fs.mkdirSync(cache.root);
  expect(cache.current()).toBe(false);
});

it('distinguishes replacement when Windows file identifiers exceed Number integer precision', () => {
  const root = fixture(); const storage = path.join(root, 'storage'); const cacheRoot = prepareOwnedPythonCache(storage, [])!.root;
  const originalStat = fs.lstatSync; const firstIdentity = originalStat(cacheRoot, { bigint: true }).ino;
  const wide = 2n ** 60n;
  expect(Number(wide)).toBe(Number(wide + 1n));
  vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: { bigint?: boolean }) => {
    const stat = originalStat(target, options as never);
    if (path.resolve(String(target)) !== cacheRoot) return stat;
    const ino = wide + (originalStat(target, { bigint: true }).ino === firstIdentity ? 0n : 1n);
    return Object.assign(stat, { ino: options?.bigint ? ino : Number(ino) });
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  const cache = prepareOwnedPythonCache(storage, [])!; expect(cache.current()).toBe(true);
  fs.renameSync(cacheRoot, cacheRoot + '-old'); fs.mkdirSync(cacheRoot);
  expect(cache.current()).toBe(false);
});

it('isolates member and workspace cache leaves while keeping normal helper cache writes usable', () => {
  const storage = path.join(fixture(), 'storage');
  const a = prepareOwnedPythonCache(storage, [], 'member-a', 'workspace-one')!;
  const b = prepareOwnedPythonCache(storage, [], 'member-b', 'workspace-one')!;
  const otherWorkspace = prepareOwnedPythonCache(storage, [], 'member-a', 'workspace-two')!;
  expect(new Set([a.root, b.root, otherWorkspace.root]).size).toBe(3);
  expect(prepareOwnedPythonCache(storage, [], 'member-a', 'workspace-one')!.root).toBe(a.root);
  fs.writeFileSync(path.join(a.root, 'helper.pyc'), 'cache');
  expect(fs.readFileSync(path.join(a.root, 'helper.pyc'), 'utf8')).toBe('cache');
  expect(fs.existsSync(path.join(b.root, 'helper.pyc'))).toBe(false);
  expect(fs.existsSync(path.join(otherWorkspace.root, 'helper.pyc'))).toBe(false);
});

it('does not create an optional cache in a workspace or through redirected storage', () => {
  const root = fixture();
  expect(prepareOwnedPythonCache(path.join(root, 'nested-storage'), [root])).toBeUndefined();
  expect(fs.existsSync(path.join(root, 'nested-storage'))).toBe(false);
  const target = path.join(root, 'target'); fs.mkdirSync(target);
  const link = path.join(root, 'linked'); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(prepareOwnedPythonCache(link, [])).toBeUndefined();
  expect(fs.existsSync(path.join(target, 'python-cache'))).toBe(false);
  expect(prepareOwnedPythonCache(undefined, [])).toBeUndefined();
  expect(prepareOwnedPythonCache('relative', [])).toBeUndefined();
});

it.each(['', 'user-selected-cache'])('keeps a Windows-cased process override %j without logging its value', value => {
  const environment = { pythonpycacheprefix: value, OTHER: 'preserved' };
  expect(pythonCacheEnvironment(environment, 'owned-cache', 'win32')).toEqual({ environment, source: 'user' });
  expect(pythonCacheEnvironment({}, 'owned-cache', 'win32')).toEqual({ environment: { PYTHONPYCACHEPREFIX: 'owned-cache' }, source: 'unode' });
  expect(pythonCacheEnvironment({}, undefined)).toEqual({ environment: {}, source: 'unavailable' });
});

it.each([null, '', 'terminal-selected-cache'])('respects terminal setting override/removal %j ahead of injected default', value => {
  expect(terminalPythonCacheEnvironment({}, { pythonpycacheprefix: value }, 'owned-cache', 'win32'))
    .toEqual({ environment: {}, source: 'user' });
  expect(terminalPythonCacheEnvironment({ PYTHONPYCACHEPREFIX: 'inherited' }, {}, 'owned-cache'))
    .toEqual({ environment: {}, source: 'user' });
});

it('uses case-sensitive POSIX environment keys and does not mutate input objects', () => {
  const environment = Object.freeze({ pythonpycacheprefix: 'unrelated' });
  expect(pythonCacheEnvironment(environment, 'owned-cache', 'linux')).toEqual({
    environment: { pythonpycacheprefix: 'unrelated', PYTHONPYCACHEPREFIX: 'owned-cache' }, source: 'unode',
  });
  expect(terminalPythonCacheEnvironment({}, {}, 'owned-cache', 'linux')).toEqual({ environment: { PYTHONPYCACHEPREFIX: 'owned-cache' }, source: 'unode' });
});

it('carries an agent cache choice into terminal creation while retaining a terminal setting removal ahead of it', () => {
  const agent = { pythonpycacheprefix: 'agent-cache' };
  expect(terminalPythonCacheEnvironment({}, {}, 'owned-cache', 'win32', agent))
    .toEqual({ environment: agent, source: 'user' });
  expect(terminalPythonCacheEnvironment({}, { PYTHONPYCACHEPREFIX: null }, 'owned-cache', 'win32', agent))
    .toEqual({ environment: {}, source: 'user' });
});

it('merges a differently cased agent cache over an inherited Windows value without duplicate child environment keys', () => {
  const result = pythonCacheEnvironment({ PYTHONPYCACHEPREFIX: 'inherited', OTHER: 'retained' }, 'owned-cache', 'win32',
    { pythonpycacheprefix: 'agent-choice' });
  expect(result).toEqual({ environment: { pythonpycacheprefix: 'agent-choice', OTHER: 'retained' }, source: 'user' });
});
