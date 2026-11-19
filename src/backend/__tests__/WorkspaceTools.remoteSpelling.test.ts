import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceTools } from '../WorkspaceTools';
import { matchPathAccess, SessionLocalReadScopeConsent, type SessionPathAccessGrant } from '../localReadScope';
import { fileToolReachesAnotherComputer, heldBySpelling, reachesAnotherComputer } from '../../host/namedOutsidePaths';

/**
 * v0.9.101 (E2, named by the Owner 2026-11-03): a refused file tool on a share, device or `/net` spelling reached the
 * disk before it refused: SMB to that server with the person's credentials, about 21 s on an address that does not
 * answer. Every filesystem function the tools, the grant owner and the path helpers import is wrapped here. A call that
 * names a TEST-NET address (203.0.113.x) is recorded and fails at once, so no test contacts a computer: the record is
 * the proof.
 */
const probes = vi.hoisted(() => ({ net: '203.0.113.', host: '203.0.113.7', calls: [] as string[] }));
function guarded<T extends object>(real: T, module: string): T {
  const out: Record<string, unknown> = {};
  const wrap = (fn: (...args: unknown[]) => unknown, name: string) => {
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const named = args.find((arg) => typeof arg === 'string' && arg.includes(probes.net));
      if (named !== undefined) {
        probes.calls.push(`${module}.${name}(${String(named)})`);
        const error = Object.assign(new Error(`EHOSTUNREACH (test): ${String(named)}`), { code: 'EHOSTUNREACH' });
        if (module.includes('promises')) return Promise.reject(error);
        throw error;
      }
      return fn.apply(this, args);
    } as unknown as Record<string, unknown>;
    for (const key of Object.keys(fn)) {
      const value = (fn as unknown as Record<string, unknown>)[key];
      wrapped[key] = typeof value === 'function' ? wrap(value as (...args: unknown[]) => unknown, `${name}.${key}`) : value;
    }
    return wrapped;
  };
  for (const [key, value] of Object.entries(real)) {
    // Classes (Stats, Dirent, streams) are constructed, never called: they stay as they are.
    out[key] = typeof value === 'function' && !/^[A-Z]/.test(key) ? wrap(value as (...args: unknown[]) => unknown, key)
      : key === 'default' && value && typeof value === 'object' ? guarded(value as object, module) : value;
  }
  return out as T;
}
vi.mock('fs', async (original) => guarded(await original<object>(), 'fs'));
vi.mock('node:fs', async (original) => guarded(await original<object>(), 'node:fs'));
vi.mock('fs/promises', async (original) => guarded(await original<object>(), 'fs/promises'));
vi.mock('node:fs/promises', async (original) => guarded(await original<object>(), 'node:fs/promises'));

const windows = process.platform === 'win32';
const host = probes.host;
/** The spellings that reach another computer by this host's own rules. */
const remote = windows
  ? [`\\\\${host}\\share\\docs\\report.txt`, `//${host}/share/docs/report.txt`, `\\\\?\\UNC\\${host}\\share\\docs\\report.txt`]
  : [`/net/${host}/share/docs/report.txt`, `/tmp/../net/${host}/share/docs/report.txt`, `/NET/${host}/share/docs/report.txt`];
const device = windows ? [`\\\\.\\pipe\\${host}-pipe`] : [];
const grantedFolder = windows ? `\\\\${host}\\share\\docs` : `/net/${host}/share/docs`;

const folders: string[] = [];
afterEach(async () => {
  probes.calls.length = 0;
  await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })));
});
async function tools() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-remote-spelling-')));
  folders.push(root);
  await fs.writeFile(path.join(root, 'local.txt'), 'local');
  const workspace = new WorkspaceTools(root, new Set(['read', 'write']));
  const offered: string[] = [];
  workspace.setOutsideRootObserver((target) => offered.push(target));
  return { root, workspace, offered };
}
const grant = (target: string, permission: 'read' | 'readwrite' = 'read'): SessionPathAccessGrant => ({
  id: `grant-${target}`, permission, lifetime: 'session', current: () => true,
  target: { kind: 'directory', permission, lexicalPath: target, realPath: target, realParent: path.dirname(target) },
});
const calls = (target: string) => [
  ['read_file', { path: target }],
  ['list_dir', { path: target }],
  ['search_files', { query: 'x', path: target }],
  ['write_file', { path: target, content: 'x' }],
  ['apply_edit', { path: target, old_string: 'a', new_string: 'b' }],
  ['delete_file', { path: target }],
  ['delete_dir', { path: target }],
] as const;

describe('v0.9.101 E2: a share, device or /net spelling a file tool is refused', () => {
  it('is refused by its spelling, in milliseconds, with no disk call, and still offers Grant access', async () => {
    const h = await tools();
    for (const target of remote) {
      for (const [tool, args] of calls(target)) {
        const started = performance.now();
        const result = await h.workspace.run(tool, { ...args });
        const elapsed = performance.now() - started;
        expect(probes.calls, `${tool} ${target}`).toEqual([]);
        expect(result, `${tool} ${target}`).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
        expect(result.output).toContain('outside the configured working boundary');
        expect(elapsed, `${tool} ${target}`).toBeLessThan(1000);
      }
      expect(h.offered.some((offered) => offered.includes(host)), target).toBe(true);
    }
    for (const target of device) {
      for (const [tool, args] of calls(target)) {
        const result = await h.workspace.run(tool, { ...args });
        expect(probes.calls, `${tool} ${target}`).toEqual([]);
        expect(result.status, `${tool} ${target}`).not.toBe('ok');
      }
    }
    // An ordinary read beside them is untouched.
    expect((await h.workspace.run('read_file', { path: 'local.txt' })).output).toContain('local');
  });

  it('a grant on another share leaves the spelling refused without a disk call', async () => {
    const h = await tools();
    const other = windows ? '\\\\203.0.113.8\\share\\docs' : '/net/203.0.113.8/share/docs';
    h.workspace.setLivePathAccess(() => [grant(other)]);
    for (const target of remote) {
      const result = await h.workspace.run('read_file', { path: target });
      expect(result, target).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    }
    // The granted share's own root may be looked at: the person granted it. The other one never is.
    const ungranted = () => probes.calls.filter((call) => call.includes(host));
    expect(ungranted()).toEqual([]);
    expect(matchPathAccess([grant(other)], remote[0], 'read')).toBeUndefined();
    expect(ungranted()).toEqual([]);
  });

  it('a grant that names it keeps its real resolution, as Full access does', async () => {
    const h = await tools();
    // The target itself is resolved on disk, not only the granted folder that holds it.
    const resolved = () => probes.calls.filter((call) => call.includes('report.txt'));
    h.workspace.setLivePathAccess(() => [grant(grantedFolder)]);
    // POSIX spellings are compared with their letter case: a grant on `/net/<host>/...` does not name `/NET/<host>/...`,
    // which stays refused by its spelling, unprobed (Linux CI on 7044a3cc). Every spelling the grant does name resolves.
    const named = remote.filter((target) => windows || !target.startsWith('/NET/'));
    expect(named.length).toBeGreaterThan(1);
    for (const target of named) {
      probes.calls.length = 0;
      await h.workspace.run('read_file', { path: target });
      expect(resolved().length, target).toBeGreaterThan(0);
    }
    if (!windows) {
      probes.calls.length = 0;
      const other = `/NET/${host}/share/docs/report.txt`;
      expect(await h.workspace.run('read_file', { path: other })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
      // The granted share's own root may be looked at (the person granted it); the target it does not name never is.
      expect(resolved(), other).toEqual([]);
    }
    probes.calls.length = 0;
    matchPathAccess([grant(grantedFolder)], remote[0], 'read');
    expect(resolved().length).toBeGreaterThan(0);

    const full = await tools();
    full.workspace.setFullFileAccess(() => true);
    probes.calls.length = 0;
    await full.workspace.run('read_file', { path: remote[0] });
    expect(resolved().length).toBeGreaterThan(0);
  });
});

// Security re-audit (F3): choosing Grant access for a share resolves it, which opens SMB to that server; it did so with
// synchronous calls, and the window froze for about 21 seconds before the picker when the server did not answer.
describe('v0.9.101 E2: Grant access for a share, device or /net spelling', () => {
  it('resolves it only through the asynchronous file system, never a blocking call', async () => {
    const owner = new SessionLocalReadScopeConsent(async () => false);
    probes.calls.length = 0;
    await owner.requestPathAccess(remote[0], { requestId: 'r1', isCurrent: () => true }, async () => undefined).catch(() => undefined);
    expect(probes.calls.length).toBeGreaterThan(0);
    expect(probes.calls.filter((call) => !/^(node:)?fs\/promises\./.test(call))).toEqual([]);
  });
});

describe('v0.9.101 E2: what holds a share, device or /net spelling, by the spelling alone', () => {
  it('reads Windows rules on any host', () => {
    const win = path.win32;
    const share = `\\\\${host}\\share`;
    expect(reachesAnotherComputer(win.resolve(`${share}\\docs\\a.txt`))).toBe(true);
    for (const remoteSpelling of [`${share}\\a.txt`, `//${host}/share/a.txt`, `\\\\?\\UNC\\${host}\\share\\a.txt`, '\\\\.\\pipe\\x']) {
      expect(fileToolReachesAnotherComputer(win.resolve(remoteSpelling)), remoteSpelling).toBe(true);
    }
    // A local drive in the extended spelling, as path.toNamespacedPath gives it, is that drive.
    for (const localSpelling of ['\\\\?\\C:\\work\\a.txt', '\\\\?\\c:\\', 'C:\\work\\a.txt']) {
      expect(fileToolReachesAnotherComputer(win.resolve(localSpelling)), localSpelling).toBe(false);
    }
    expect(heldBySpelling(`${share}\\docs\\a.txt`, [`${share}\\docs`], [], win)).toBe(true);
    expect(heldBySpelling(`\\\\?\\UNC\\${host}\\SHARE\\Docs\\a.txt`, [`${share}\\docs`], [], win)).toBe(true);
    expect(heldBySpelling(`//${host}/share/docs/a.txt`, [`${share}\\docs`], [], win)).toBe(true);
    expect(heldBySpelling(`${share}\\docs\\a.txt`, [], [`${share}\\docs\\a.txt`], win)).toBe(true);
    expect(heldBySpelling(`${share}\\other\\a.txt`, [`${share}\\docs`], [`${share}\\docs\\a.txt`], win)).toBe(false);
    expect(heldBySpelling(`\\\\203.0.113.8\\share\\docs\\a.txt`, [`${share}\\docs`], [], win)).toBe(false);
    expect(heldBySpelling(`${share}\\docs\\a.txt`, ['C:\\work'], ['C:\\work\\a.txt'], win)).toBe(false);
  });

  it('reads POSIX rules on any host', () => {
    const posix = path.posix;
    expect(reachesAnotherComputer(posix.resolve(`/tmp/../net/${host}/a.txt`))).toBe(true);
    expect(reachesAnotherComputer(posix.resolve('/home/net/a.txt'))).toBe(false);
    expect(heldBySpelling(`/net/${host}/share/a.txt`, [`/net/${host}/share`], [], posix)).toBe(true);
    expect(heldBySpelling(`/tmp/../net/${host}/share/a.txt`, [`/net/${host}/share`], [], posix)).toBe(true);
    expect(heldBySpelling(`/net/${host}/other/a.txt`, [`/net/${host}/share`], [], posix)).toBe(false);
    expect(heldBySpelling(`/net/${host}/share/a.txt`, ['/home/me/work'], [], posix)).toBe(false);
  });
});
