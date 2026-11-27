/*
 * v0.9.101 (E2, T101-12, named by the Owner 2026-11-03): a share, device or `/net` path a coordinator writes into a task
 * scope was resolved on disk when the dispatch was judged: SMB to that server with the person's credentials, and a block
 * until it failed. It is judged by its spelling until a grant or Full access names it. Every filesystem function is
 * wrapped; a call naming a TEST-NET address (203.0.113.x) is recorded and fails at once, so nothing is contacted.
 */
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrchestrationHostAdapter, type CoordinatorRuntimePort, type OrchestrationEvidencePort } from '../OrchestrationHostAdapter';
import { agentConfig, tempFolder } from '../../../views/__tests__/support/fileNavigationHost';
import type { SessionPathAccessGrant } from '../../../backend/localReadScope';
import type { DelegationTaskScope } from '../../../types';

const probes = vi.hoisted(() => ({ net: '203.0.113.', host: '203.0.113.11', calls: [] as string[] }));
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
    out[key] = typeof value === 'function' && !/^[A-Z]/.test(key) ? wrap(value as (...args: unknown[]) => unknown, key)
      : key === 'default' && value && typeof value === 'object' ? guarded(value as object, module) : value;
  }
  return out as T;
}
vi.mock('fs', async (original) => guarded(await original<object>(), 'fs'));
vi.mock('node:fs', async (original) => guarded(await original<object>(), 'node:fs'));
vi.mock('fs/promises', async (original) => guarded(await original<object>(), 'fs/promises'));
vi.mock('node:fs/promises', async (original) => guarded(await original<object>(), 'node:fs/promises'));

const cleanups: Array<() => void> = [];
afterEach(() => { probes.calls.length = 0; cleanups.splice(0).forEach((cleanup) => cleanup()); });

const windows = process.platform === 'win32';
const share = windows ? `\\\\${probes.host}\\share\\docs` : `/net/${probes.host}/share/docs`;
const spellings = windows ? [share, `//${probes.host}/share/docs`, `\\\\?\\UNC\\${probes.host}\\share\\docs`] : [share, `/NET/${probes.host}/share/docs`];

function host(options: { full?: boolean } = {}) {
  const made = tempFolder({ 'workspace.md': 'workspace' }, 'unode-remote-scope-');
  cleanups.push(made.cleanup);
  const root = realpathSync.native(made.root);
  const config = agentConfig('worker', { backend: 'openai-compat', workingDirectory: root });
  const grants: { list: SessionPathAccessGrant[] } = { list: [] };
  const runtime: Partial<CoordinatorRuntimePort> = {
    workspace: () => ({ root: () => root, roots: () => [root], additionalReadRoots: () => [], isTrusted: () => true }),
    fullFileAccess: () => options.full ?? false,
    taskScopeActive: () => true,
    backendKindFor: (agent) => agent.backend ?? 'openai-compat',
    configForAgent: () => config,
    pathGrantsFor: () => grants.list,
  };
  const adapter = new OrchestrationHostAdapter(runtime as CoordinatorRuntimePort, {} as OrchestrationEvidencePort);
  return { root, config, grants, adapter };
}
const scope = (...entries: Array<[string, 'read' | 'readwrite']>): DelegationTaskScope =>
  ({ folderAccess: entries.map(([target, permission]) => ({ path: target, permission })) });

describe('v0.9.101 E2 (T101-12): a share path in a task scope', () => {
  it('that nothing holds is admitted only as a pending need, judged by its spelling, named for Grant access, with no disk call', () => {
    const h = host();
    for (const spelling of spellings) {
      const result = h.adapter.resolveTaskWorkspaceAccess(h.config, scope([spelling, 'readwrite']), 'r1');
      expect(probes.calls, spelling).toEqual([]);
      // v0.9.101 (H1): no authority, only the need, so a grant made while the task runs reaches it.
      expect(result.reason, spelling).toBeUndefined();
      expect(result.access, spelling).toMatchObject({ readRoots: [], writeRoots: [], readFiles: [], writeFiles: [],
        pending: { readRoots: [path.resolve(h.root, spelling)], writeRoots: [path.resolve(h.root, spelling)] } });
      expect(result.outOfReach, spelling).toEqual([path.resolve(h.root, spelling)]);
    }
  });

  it('beside a workspace entry: the workspace part is admitted and the share is named, with no disk call for it', () => {
    const h = host();
    const result = h.adapter.resolveTaskWorkspaceAccess(h.config, scope(['.', 'readwrite'], [share, 'read']), 'r1');
    expect(probes.calls).toEqual([]);
    expect(result.access?.writeRoots).toContain(h.root);
    expect(result.outOfReach).toEqual([path.resolve(share)]);
  });

  it('under a Folder Access ceiling it is not offered, and still not looked up', () => {
    const h = host();
    const ceilinged = { ...h.config, folderAccess: [{ path: h.root, permission: 'readwrite' as const }] };
    const result = h.adapter.resolveTaskWorkspaceAccess(ceilinged, scope([share, 'read']), 'r1');
    expect(probes.calls).toEqual([]);
    expect(result.access).toBeUndefined();
    expect(result.outOfReach).toBeUndefined();
  });

  it('that a grant or Full access names keeps its real resolution', () => {
    const granted = host();
    granted.grants.list = [{ id: 'g1', permission: 'read', lifetime: 'session', current: () => true,
      target: { kind: 'directory', permission: 'read', lexicalPath: share, realPath: share, realParent: path.dirname(share) } }];
    // The test's fake network fails every lookup; a real server would answer it.
    try { granted.adapter.resolveTaskWorkspaceAccess(granted.config, scope([share, 'read']), 'r1'); } catch { /* the recorded lookup is the fact */ }
    expect(probes.calls.length).toBeGreaterThan(0);
    probes.calls.length = 0;
    const full = host({ full: true });
    // The test's fake network fails every lookup; a real server would answer it.
    try { full.adapter.resolveTaskWorkspaceAccess(full.config, scope([share, 'read']), 'r1'); } catch { /* the recorded lookup is the fact */ }
    expect(probes.calls.length).toBeGreaterThan(0);
  });
});
