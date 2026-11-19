import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPolicy, type CommandApprovalMode } from '../CommandPolicy';
import type { CommandExecutionProvider, PreparedDirectCommand } from '../CommandExecution';
import { createDirectCommandPreparer, createDirectExecutionProvider } from '../DirectCommandExecution';
import { gateShellCommand, type CommandApprovalDecision } from '../ShellCommandGate';
import { resolveCompletionVerificationPolicy } from '../CompletionVerificationPolicy';
import { prepareCompletionVerificationCheck, type CompletionVerificationCheckOptions } from '../CompletionVerificationCheck';
import type { VerificationAdmissionReaders } from '../CompletionVerificationAdmission';
import { WorkspaceTools } from '../WorkspaceTools';
import { REQUEST_LIMIT_STOPPED_REFUSAL } from '../requestBoundary';
import { captureCwdIdentity, composeCommandStartCheck, sameCwdIdentity, CWD_APPEARED_MESSAGE, CWD_CHANGED_MESSAGE } from '../commandStartCheck';
import { BASH_SHELL } from './shellFixtures';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

/** Real temp folders: `first`, `second` and an `alias` link to `first`. */
async function folders() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-start-check-'))); roots.push(root);
  const first = path.join(root, 'first'); const second = path.join(root, 'second'); const alias = path.join(root, 'alias');
  await fs.mkdir(first); await fs.mkdir(second); await fs.symlink(first, alias, linkType);
  return {
    root, first, second, alias,
    retarget: async () => { await fs.unlink(alias); await fs.symlink(second, alias, linkType); },
    /** Removed from its path and created again. The old folder stays alive elsewhere until the new one exists, so the
     * file system cannot hand the new folder the old one's inode number (that reuse is the Owner-accepted residual). */
    recreate: async (folder: string) => { await fs.rename(folder, folder + '-removed'); await fs.mkdir(folder); },
  };
}

/** The same folder in a different spelling: a different case on Windows, a `.` segment elsewhere. */
function otherSpelling(folder: string): string {
  return process.platform === 'win32' ? folder.toUpperCase() : `${folder}${path.sep}.`;
}

describe('S4.2 physical cwd identity', () => {
  it('captures realpath, dev and ino; another spelling of the same folder is the same', async () => {
    const f = await folders();
    const before = await captureCwdIdentity(f.alias);
    expect(before).toMatchObject({ kind: 'physical', cwd: f.alias, realpath: await fs.realpath(f.first) });
    expect(await sameCwdIdentity(before, f.first)).toBe('same');
    expect(await sameCwdIdentity(before, otherSpelling(f.first))).toBe('same');
    expect(await sameCwdIdentity(before)).toBe('same');
  });

  it('a retargeted link, a recreated folder and a deleted folder are changed', async () => {
    const f = await folders();
    const viaAlias = await captureCwdIdentity(f.alias); await f.retarget();
    expect(await sameCwdIdentity(viaAlias)).toBe('changed');
    const direct = await captureCwdIdentity(f.second); await f.recreate(f.second);
    expect(await sameCwdIdentity(direct)).toBe('changed');
    const gone = await captureCwdIdentity(f.first); await fs.rename(f.first, f.first + '-moved');
    expect(await sameCwdIdentity(gone)).toBe('changed');
  });

  it('an unavailable first capture is re-attempted: still missing stays unavailable, appearing later is changed', async () => {
    const f = await folders(); const later = path.join(f.root, 'later'); const file = path.join(f.root, 'file.txt');
    await fs.writeFile(file, 'not a folder');
    expect(await captureCwdIdentity(file)).toEqual({ kind: 'unavailable', cwd: file });
    const before = await captureCwdIdentity(later);
    expect(before).toEqual({ kind: 'unavailable', cwd: later });
    expect(await sameCwdIdentity(before)).toBe('unavailable');
    await fs.mkdir(later);
    expect(await sameCwdIdentity(before)).toBe('changed');
  });

  it('the composed start check runs live authority, the identity, then the gate callback, and never approves a moved folder', async () => {
    const f = await folders(); const order: string[] = [];
    const gate = vi.fn(async () => { order.push('gate'); return undefined; });
    const check = composeCommandStartCheck(gate, await captureCwdIdentity(f.alias), () => { order.push('live'); return undefined; });
    expect(await check()).toBeUndefined(); expect(order).toEqual(['live', 'gate', 'live']);
    await f.retarget();
    expect(await check()).toEqual({ ok: false, reason: 'effect-changed', message: CWD_CHANGED_MESSAGE, changed: 'working-folder' });
    expect(gate).toHaveBeenCalledTimes(1);
    const later = path.join(f.root, 'later'); const appeared = composeCommandStartCheck(gate, await captureCwdIdentity(later), () => undefined);
    expect(await appeared()).toBeUndefined();
    await fs.mkdir(later);
    expect(await appeared()).toEqual({ ok: false, reason: 'policy-changed', message: CWD_APPEARED_MESSAGE });
  });

  it('the real gate binds an ordinary command (npm test) to its physical folder, not only an outward one (C2 probe)', async () => {
    const f = await folders();
    const gate = await gateShellCommand({ command: 'npm test', roots: [f.root], cwd: f.alias, source: 'config',
      shell: BASH_SHELL, commandPolicy: new CommandPolicy('all') });
    expect(gate.ok).toBe(true); if (!gate.ok) throw new Error('fixture');
    expect(await gate.revalidate!()).toBeUndefined();
    await f.retarget();
    expect(await gate.revalidate!()).toEqual({ ok: false, reason: 'effect-changed', message: CWD_CHANGED_MESSAGE, changed: 'working-folder' });
  });
});

/**
 * The completion check through the real gates and the production direct executor. Only the process start is
 * recorded: it starts `node -e ""` with the cwd the executor gives it, so a missing folder fails as a real start does.
 */
function completionHarness(cwd: string, mode: CommandApprovalMode = 'ask') {
  const abort = new AbortController();
  const policy = new CommandPolicy(mode);
  const spawned: string[] = [];
  const startProcess = vi.fn((_command: string, options: SpawnOptions) => {
    spawned.push(String(options.cwd));
    return nodeSpawn(process.execPath, ['-e', ''], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  });
  const real = createDirectCommandPreparer({ spawn: startProcess });
  /** Runs between the last state check and the executor's own start check: "between the gates and the start". */
  let beforeStart: () => Promise<void> | void = () => undefined;
  const prepare = vi.fn(() => {
    const prepared = real();
    if (!prepared.ok) return prepared;
    const wrapped: PreparedDirectCommand = { ...prepared, execute: async (command, opts) => { await beforeStart(); return prepared.execute(command, opts); } };
    return wrapped;
  });
  const approval = vi.fn(async (): Promise<CommandApprovalDecision> => ({ allow: true }));
  const readers: VerificationAdmissionReaders = { manifest: async () => ({ kind: 'read', scripts: { test: 'test' } }), packageManager: async () => 'npm' };
  let refreshes = 0; let onRefresh: (count: number) => Promise<void> | void = () => undefined;
  const resolution = resolveCompletionVerificationPolicy({ workspaceId: 'workspace-A', agentSkills: [],
    completionVerification: { mode: 'command', command: 'npm test' }, readLegacyGlobalCommand: () => undefined });
  const options: CompletionVerificationCheckOptions = {
    resolution, cwd, roots: [path.dirname(cwd)], signal: abort.signal,
    request: { kind: 'session', sessionId: 'session-A', requestId: 'request-A', attemptId: 'attempt-A' },
    currentResolution: () => resolution, isCurrentRequest: () => true, isTrusted: () => true, directoryAllowed: () => true,
    commandPolicy: () => policy, prepare, requestApproval: approval, readers,
    refreshResolution: async () => { await onRefresh(++refreshes); },
  };
  return {
    abort, policy, spawned, startProcess, approval, prepare,
    run: () => prepareCompletionVerificationCheck(options).run(),
    beforeStart: (change: () => Promise<void> | void) => { beforeStart = change; },
    /** The second refresh runs after both gates, before the final checks. */
    afterGates: (change: () => Promise<void> | void) => { onRefresh = async count => { if (count === 2) await change(); }; },
  };
}

describe('S4.2 the completion check command is re-validated where it starts (real gates, real executor)', () => {
  it('an unchanged command in an equivalent spelling of its folder runs once, with one approval and no second card', async () => {
    const f = await folders(); const h = completionHarness(f.alias);
    expect(await h.run()).toMatchObject({ kind: 'passed', exitCode: 0 });
    expect(h.approval).toHaveBeenCalledTimes(1); expect(h.spawned).toEqual([f.alias]);
    const spelled = completionHarness(otherSpelling(f.first));
    expect(await spelled.run()).toMatchObject({ kind: 'passed' }); expect(spelled.spawned).toHaveLength(1);
  });

  it('a junction retargeted after approval, between the gates and the start, is refused with no process', async () => {
    const f = await folders(); const h = completionHarness(f.alias);
    h.beforeStart(f.retarget);
    expect(await h.run()).toMatchObject({ kind: 'not-run', detail: CWD_CHANGED_MESSAGE });
    expect(h.startProcess).not.toHaveBeenCalled(); expect(h.approval).toHaveBeenCalledTimes(1);
  });

  it('a junction retargeted while the approval waits is refused with no process', async () => {
    const f = await folders(); const h = completionHarness(f.alias);
    h.approval.mockImplementation(async () => { await f.retarget(); return { allow: true }; });
    expect(await h.run()).toMatchObject({ kind: 'not-run' });
    expect(h.startProcess).not.toHaveBeenCalled(); expect(h.approval).toHaveBeenCalledTimes(1);
  });

  it('a folder deleted and recreated after approval is refused with no process', async () => {
    const f = await folders(); const h = completionHarness(f.first);
    h.afterGates(() => f.recreate(f.first));
    expect(await h.run()).toMatchObject({ kind: 'not-run', detail: CWD_CHANGED_MESSAGE });
    expect(h.startProcess).not.toHaveBeenCalled();
  });

  it('a folder missing at approval that exists at the start is refused as changed', async () => {
    const f = await folders(); const later = path.join(f.root, 'later'); const h = completionHarness(later);
    h.beforeStart(() => fs.mkdir(later));
    expect(await h.run()).toMatchObject({ kind: 'not-run', detail: CWD_APPEARED_MESSAGE });
    expect(h.startProcess).not.toHaveBeenCalled();
  });

  it('a folder that stays missing fails with the start error itself, never as approved on the old binding', async () => {
    const f = await folders(); const missing = path.join(f.root, 'missing'); const h = completionHarness(missing);
    const outcome = await h.run();
    expect(outcome).toMatchObject({ kind: 'not-run', reason: 'spawn-failed' });
    if (outcome.kind !== 'not-run') throw new Error('fixture');
    expect(outcome.detail).toContain('Failed to start the command');
    expect(outcome.detail).not.toContain('working folder');
    expect(h.startProcess).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['On→Off', (policy: CommandPolicy) => policy.reload('none', [])],
    ['Off→On', (policy: CommandPolicy) => { policy.reload('none', []); policy.reload('ask', []); }],
    ['Off→On (all)', (policy: CommandPolicy) => { policy.reload('none', []); policy.reload('all', []); }],
  ] as const)('%s between the gates and the start does not start the process or reuse the approval', async (_name, change) => {
    const f = await folders(); const h = completionHarness(f.first);
    h.beforeStart(() => change(h.policy));
    expect(await h.run()).toMatchObject({ kind: 'not-run' });
    expect(h.startProcess).not.toHaveBeenCalled(); expect(h.approval).toHaveBeenCalledTimes(1);
  });

  it('Stop before the start creates no process', async () => {
    const f = await folders(); const h = completionHarness(f.first);
    h.beforeStart(() => h.abort.abort());
    expect(await h.run()).toMatchObject({ kind: 'not-run' });
    expect(h.startProcess).not.toHaveBeenCalled();
  });
});

describe('S4.2 an ordinary run_command is bound to its physical folder (real WorkspaceTools, real executor)', () => {
  type Folders = Awaited<ReturnType<typeof folders>>;
  async function workspace(change: { duringApproval?: (f: Folders) => Promise<void>; beforeStart?: (f: Folders) => Promise<void> }) {
    const f = await folders(); const started: string[] = [];
    const provider = createDirectExecutionProvider(createDirectCommandPreparer({
      spawn: (_command, options) => { started.push(String(options.cwd));
        return nodeSpawn(process.execPath, ['-e', ''], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); },
    }));
    // The change lands after the gate and its approval, as the lease starts: only the executor's start check sees it.
    const execution: CommandExecutionProvider = { ...provider, acquire: async (opts) => {
      const lease = await provider.acquire(opts);
      return lease.ok ? { ...lease, execute: async (...args) => { await change.beforeStart?.(f); return lease.execute(...args); } } : lease;
    } };
    const asked = vi.fn(async (): Promise<CommandApprovalDecision> => { await change.duringApproval?.(f); return { allow: true }; });
    const tools = new WorkspaceTools(f.first, new Set(['execute']), 'agent', undefined, new CommandPolicy('ask'), 30_000,
      asked, undefined, undefined, execution);
    return { f, tools, started, asked };
  }

  it('runs when the folder is unchanged, with one approval', async () => {
    const w = await workspace({});
    expect((await w.tools.run('run_command', { command: 'npm test' })).status).toBe('success');
    expect(w.started).toHaveLength(1); expect(w.asked).toHaveBeenCalledTimes(1);
  });

  it('a folder deleted and recreated while the approval waits is refused with no process', async () => {
    const w = await workspace({ duringApproval: f => f.recreate(f.first) });
    const outcome = await w.tools.run('run_command', { command: 'npm test' });
    expect(outcome.status).toBe('refused'); expect(outcome.output).toContain(CWD_CHANGED_MESSAGE);
    // Audit R2: the folder change is the reason, not a request-limit Stop by the person.
    expect(outcome.output).not.toContain(REQUEST_LIMIT_STOPPED_REFUSAL);
    expect(w.started).toEqual([]); expect(w.asked).toHaveBeenCalledTimes(1);
  });

  it('a folder deleted and recreated after the gate, at the start, is refused by the executor check with no process', async () => {
    const w = await workspace({ beforeStart: f => f.recreate(f.first) });
    const outcome = await w.tools.run('run_command', { command: 'npm test' });
    expect(outcome.status).toBe('refused'); expect(outcome.output).toContain(CWD_CHANGED_MESSAGE);
    // Audit R2: the folder change is the reason, not a request-limit Stop by the person.
    expect(outcome.output).not.toContain(REQUEST_LIMIT_STOPPED_REFUSAL);
    expect(w.started).toEqual([]); expect(w.asked).toHaveBeenCalledTimes(1);
  });
});
