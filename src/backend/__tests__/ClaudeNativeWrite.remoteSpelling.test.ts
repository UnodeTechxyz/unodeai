/*
 * v0.9.101 (E2, named by the Owner 2026-11-03; audit of 85ebb229: "retain one focused native-entry check before claiming
 * E2 for that route"): Claude's native Write and Edit reach the shared write policy at the PreToolUse hook. With the host
 * file tools wired, as the extension wires them, a share, device or `/net` spelling nothing holds must be refused by its
 * spelling, with no disk call: a lookup opens SMB to that server with the person's credentials. Every filesystem function
 * is wrapped; a call naming a TEST-NET address (203.0.113.x) is recorded and fails at once, so nothing is contacted.
 */
import { realpathSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import type { AgentConfig } from '../../types';
import { FileWritePolicy } from '../fileWritePolicy';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import type { SessionPathAccessGrant } from '../localReadScope';
import { WorkspaceTools } from '../WorkspaceTools';

const probes = vi.hoisted(() => ({ net: '203.0.113.', host: '203.0.113.9', calls: [] as string[] }));
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

afterEach(async () => { probes.calls.length = 0; await removeTemporaryFolders(); });

const windows = process.platform === 'win32';
const host = probes.host;
const remote = windows
  ? [`\\\\${host}\\share\\docs\\report.txt`, `//${host}/share/docs/report.txt`, `\\\\?\\UNC\\${host}\\share\\docs\\report.txt`]
  : [`/net/${host}/share/docs/report.txt`, `/NET/${host}/share/docs/report.txt`];
const grantedFolder = windows ? `\\\\${host}\\share\\docs` : `/net/${host}/share/docs`;

function config(root: string): AgentConfig {
  return {
    id: 'claude-1', name: 'Claude Dev', role: 'developer', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-5', systemPrompt: 'Follow the role.', autoApprove: true, allowedTools: ['read', 'write'],
    backend: 'claude', workingDirectory: root,
  };
}

async function fixture(grants: SessionPathAccessGrant[] = []) {
  const root = realpathSync.native(await temporaryFolder('unode-e2-claude-'));
  const policy = new FileWritePolicy({ workspaceId: () => 'w', dirtyEditorPaths: () => [], gitPath: async () => ({ repository: false }) });
  const fileWrites = policy.forAgent({ agentId: 'claude-1', requestId: () => 'r1', notice: () => undefined, decide: async () => 'once' });
  const hostFileTools = new WorkspaceTools(root, new Set(['read', 'write']));
  hostFileTools.setLivePathAccess(() => grants);
  const offered: string[] = [];
  const accesses: Array<string | undefined> = [];
  const backend = new ClaudeHeadlessBackend(config(root), undefined, undefined, {
    fileWrites, livePathAccess: () => grants, hostFileTools,
    onOutsideRoot: (target: string, access?: string) => { offered.push(target); accesses.push(access); },
    writeApprovalAsk: () => false,
  } as any);
  const gate = async (tool: string, input: Record<string, unknown>, id: string) =>
    (backend as any).handlePreToolUse({ tool_name: tool, tool_input: input, tool_use_id: id }) as Promise<{ allow: boolean; reason?: string }>;
  return { gate, offered, accesses, root };
}

const grant = (target: string): SessionPathAccessGrant => ({
  id: `grant-${target}`, permission: 'readwrite', lifetime: 'session', current: () => true,
  target: { kind: 'directory', permission: 'readwrite', lexicalPath: target, realPath: target, realParent: path.dirname(target) },
});

describe('v0.9.101 E2: Claude native Write and Edit on a share, device or /net spelling', () => {
  it('is refused at the hook by its spelling, in milliseconds, with no disk call, and still offers Grant access', async () => {
    const h = await fixture();
    let id = 0;
    for (const target of remote) {
      for (const [tool, input] of [['Write', { file_path: target, content: 'x' }], ['Edit', { file_path: target, old_string: 'a', new_string: 'b' }]] as const) {
        const started = performance.now();
        const decision = await h.gate(tool, { ...input }, `toolu_${++id}`);
        expect(probes.calls, `${tool} ${target}`).toEqual([]);
        expect(decision.allow, `${tool} ${target}`).toBe(false);
        expect(performance.now() - started, `${tool} ${target}`).toBeLessThan(1000);
      }
    }
    expect(h.offered.some((target) => target.includes(host))).toBe(true);
  });

  // Smoke of ba309ddb, A: a refused write asked for Read, so the work waiting on it never became runnable.
  it('a refused native Write or Edit offers Grant access for what it needed: Read + Write', async () => {
    const h = await fixture();
    const outside = realpathSync.native(await temporaryFolder('unode-e2-claude-out-'));
    for (const [tool, input] of [['Write', { file_path: path.join(outside, 'summary.txt'), content: 'x' }],
      ['Edit', { file_path: path.join(outside, 'notes.txt'), old_string: 'a', new_string: 'b' }]] as const) {
      expect((await h.gate(tool, { ...input }, `toolu_${tool}`)).allow, tool).toBe(false);
    }
    const mine = h.offered.map((target, index) => ({ target, access: h.accesses[index] })).filter(({ target }) => target.startsWith(outside));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every(({ access }) => access === 'readwrite')).toBe(true);
  });

  it('a grant that holds it keeps its real resolution', async () => {
    const h = await fixture([grant(grantedFolder)]);
    await h.gate('Write', { file_path: remote[0], content: 'x' }, 'toolu_granted');
    expect(probes.calls.some((call) => call.includes('report.txt'))).toBe(true);
  });
});
