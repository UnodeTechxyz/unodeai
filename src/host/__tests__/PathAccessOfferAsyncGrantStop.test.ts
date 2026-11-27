/*
 * v0.9.101 (audit R6 of 354604ec, from Codex's probe): choosing Grant access for a share path checks the target again
 * through asynchronous file system calls. A Stop while they wait cancels the person's decision, so no session grant may
 * be committed after it. Only a synthetic file system boundary is controlled: no share or network lookup is issued.
 */
import { afterEach, expect, it, vi } from 'vitest';
import * as path from 'node:path';
vi.mock('vscode', () => ({}));

const gate = vi.hoisted(() => ({ resolving: false, reached: undefined as undefined | (() => void), wait: undefined as undefined | Promise<void> }));
vi.mock('node:fs/promises', async (original) => ({
  ...await original<object>(),
  realpath: async (p: string) => { if (gate.resolving) { gate.reached?.(); await gate.wait; } return path.resolve(p); },
  stat: async () => ({ isDirectory: () => false, isFile: () => true }),
}));
vi.mock('node:fs', async (original) => {
  const real = await original<any>();
  const remote = (p: unknown) => String(p).includes('203.0.113.9');
  const native = (p: string) => remote(p) ? path.resolve(p) : real.realpathSync.native(p);
  return { ...real, realpathSync: Object.assign((p: string) => native(p), { native }),
    statSync: (p: string, ...args: any[]) => remote(p) ? ({ isDirectory: () => false, isFile: () => true }) : real.statSync(p, ...args) };
});
import { SessionLocalReadScopeConsent, matchPathAccess } from '../../backend/localReadScope';
import { ChatViewProvider, type ChatViewDeps } from '../../views/ChatViewProvider';
import { createPathAccessOffer, type PathAccessItem } from '../PathAccessOffer';

afterEach(() => { gate.resolving = false; gate.reached = undefined; gate.wait = undefined; });

async function grantWhile(stopDuringCheck: boolean) {
  const owner = new SessionLocalReadScopeConsent(async () => false);
  const state = new Map<string, unknown>();
  const chat = new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'dev', name: 'dev', role: 'developer' }],
    send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(), onReply: () => () => {},
    state: { get: (key) => state.get(key), update: async (key, value) => { state.set(key, structuredClone(value)); } },
    getApprovals: () => ({ command: 'all', write: 'none' }), setApproval: vi.fn(),
  } as ChatViewDeps);
  chat.selectAgent('dev');
  const current = chat.captureScopeDecision('dev');
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { gate.reached = resolve; });
  gate.wait = new Promise<void>((resolve) => { release = resolve; });
  const file = process.platform === 'win32' ? '\\\\203.0.113.9\\share\\source.txt' : '/net/203.0.113.9/share/source.txt';
  let item!: PathAccessItem;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  let admitted = false;
  const offer = createPathAccessOffer({ owner, canOffer: () => true,
    captureRequest: () => ({ requestId: 'r1', isCurrent: current, decisionCurrent: current }),
    present: async () => false,
    item: (value) => { item = value; },
    choose: async () => { gate.resolving = true; return { permission: 'readwrite', lifetime: 'session' }; },
    granted: () => { admitted = true; finished(); }, unavailable: () => finished(), requestEnded: () => finished(),
  });
  offer(file);
  item.grant();
  await reached;
  if (stopDuringCheck) {
    chat.stopWaitingSends(['dev']);
    expect(current()).toBe(false);
  }
  release();
  await done;
  return { admitted, permitsLaterRequest: !!matchPathAccess(owner.pathAccessFor('r2'), file, 'readwrite') };
}

it('a Stop while a share grant is checked again cancels it: no session authority is committed', async () => {
  expect(await grantWhile(true)).toEqual({ admitted: false, permitsLaterRequest: false });
});

it('without a Stop the same share grant is committed and reaches a later request', async () => {
  expect(await grantWhile(false)).toEqual({ admitted: true, permitsLaterRequest: true });
});
