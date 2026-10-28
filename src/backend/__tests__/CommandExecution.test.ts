import { describe, expect, it } from 'vitest';
import {
  ALREADY_USED_MESSAGE,
  ExecutionLane,
  guardDirectCommand,
  LANE_DISPOSED_MESSAGE,
  laneStartRefusal,
  type PreparedDirectCommand,
  sameExecutionDirectory,
} from '../CommandExecution';
import { CMD_SHELL } from './shellFixtures';

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

describe('ExecutionLane (v0.9.96)', () => {
  it('admits one invocation at a time, in order', async () => {
    const lane = new ExecutionLane();
    const order: string[] = [];
    const first = await lane.enter();
    if (!('signal' in first)) throw new Error('first refused');
    const second = lane.enter().then((ticket) => { order.push('second'); return ticket; });
    const third = lane.enter().then((ticket) => { order.push('third'); return ticket; });
    await settle();
    expect(order).toEqual([]);
    first.release();
    const secondTicket = await second;
    expect(order).toEqual(['second']);
    if ('signal' in secondTicket) secondTicket.release();
    const thirdTicket = await third;
    expect(order).toEqual(['second', 'third']);
    if ('signal' in thirdTicket) thirdTicket.release();
    expect(lane.busy).toBe(false);
  });

  // v0.9.99 (A5): the lane has no quarantine. An earlier command whose stop was not confirmed releases its ticket like
  // any other, and the next command of the agent is admitted.
  it('has no quarantine: the next invocation is admitted once the earlier one releases, whatever its outcome', async () => {
    const lane = new ExecutionLane();
    const ticket = await lane.enter();
    if (!('signal' in ticket)) throw new Error('refused');
    const queued = lane.enter();
    ticket.release();
    const next = await queued;
    expect('signal' in next).toBe(true);
    expect(lane.state).toBe('open');
    expect('quarantine' in lane).toBe(false);
  });

  it('closing aborts and releases what has not started, and waits only for what runs', async () => {
    const lane = new ExecutionLane();
    const running = await lane.enter();
    if (!('signal' in running)) throw new Error('refused');
    running.setPhase('running');
    const queued = lane.enter();
    let closed = false;
    const closing = lane.close().then(() => { closed = true; });
    expect(await queued).toEqual({ ok: false, reason: 'disposed', message: LANE_DISPOSED_MESSAGE });
    expect(running.signal.aborted).toBe(true);
    await settle();
    expect(closed).toBe(false);
    running.release();
    await closing;
    expect(lane.state).toBe('closed');
  });

  it('closing does not wait for an approval nobody answers', async () => {
    const lane = new ExecutionLane();
    const waiting = await lane.enter();
    if (!('signal' in waiting)) throw new Error('refused');
    waiting.setPhase('awaiting-approval');
    await lane.close();
    expect(waiting.signal.aborted).toBe(true);
    expect(lane.busy).toBe(false);
  });
});

describe('guardDirectCommand and laneStartRefusal (v0.9.96)', () => {
  it('checks the host conditions again when the command would start, and starts nothing when they fail', async () => {
    const calls: string[] = [];
    const inner: PreparedDirectCommand = {
      ok: true,
      shell: CMD_SHELL,
      execute: async (command) => { calls.push(`run ${command}`); return { status: 'exited', code: 0, output: '' }; },
      startBackground: (command) => { calls.push(`start ${command}`); return { ok: false, error: 'fake' }; },
    };
    let refusal: ReturnType<typeof laneStartRefusal>;
    const distrusted = { ok: false, reason: 'cwd-unverified', message: 'Command not run: the workspace is no longer trusted.' } as const;
    refusal = distrusted;
    const background = guardDirectCommand(inner, () => refusal);
    expect(background.shell).toBe(CMD_SHELL);
    expect(background.startBackground('npm run dev', { cwd: '/w' })).toEqual({ ok: false, error: distrusted.message, notStarted: distrusted });
    const foreground = guardDirectCommand(inner, () => refusal);
    expect(await foreground.execute('npm test', { cwd: '/w' })).toEqual({ status: 'not-started', code: null, reason: 'environment-changed', output: distrusted.message });
    const reset = guardDirectCommand(inner, () => ({ ok: false, reason: 'disposed', message: LANE_DISPOSED_MESSAGE }));
    expect(await reset.execute('npm test', { cwd: '/w' })).toMatchObject({ status: 'not-started', reason: 'disposed' });
    expect(calls).toEqual([]);

    // A refused preparation stays used: when the condition clears, it still starts nothing. Only a new one does.
    refusal = undefined;
    expect(background.startBackground('npm run dev', { cwd: '/w' })).toEqual({ ok: false, error: ALREADY_USED_MESSAGE, notStarted: { ok: false, reason: 'disposed', message: ALREADY_USED_MESSAGE } });
    expect(await background.execute('npm test', { cwd: '/w' })).toMatchObject({ status: 'not-started', reason: 'disposed', output: ALREADY_USED_MESSAGE });
    expect(await foreground.execute('npm test', { cwd: '/w' })).toMatchObject({ status: 'not-started', reason: 'disposed' });
    expect(calls).toEqual([]);
    const fresh = guardDirectCommand(inner, () => refusal);
    fresh.startBackground('npm run dev', { cwd: '/w' });
    expect(await fresh.execute('npm test', { cwd: '/w' })).toMatchObject({ status: 'not-started', reason: 'disposed' });
    expect(calls).toEqual(['start npm run dev']);
  });

  it('refuses a start past a reset lane, and allows one beside an open lane', async () => {
    const lane = new ExecutionLane();
    expect(laneStartRefusal(lane)).toBeUndefined();
    const reset = new ExecutionLane();
    await reset.close();
    expect(laneStartRefusal(reset)).toEqual({ ok: false, reason: 'disposed', message: LANE_DISPOSED_MESSAGE });
  });
});

describe('sameExecutionDirectory (v0.9.96)', () => {
  const identity = async (candidate: string) => candidate;

  it('matches Windows drive spellings and a physically equal junction, and nothing else', async () => {
    const physical: Record<string, string> = { 'C:\\link': 'C:\\work\\project', 'C:\\work\\project': 'C:\\work\\project', 'c:\\WORK\\project': 'C:\\work\\project' };
    const realpath = async (candidate: string) => physical[candidate] ?? candidate;
    expect(await sameExecutionDirectory('C:\\work\\project', 'c:\\WORK\\project', 'win32', realpath)).toBe(true);
    expect(await sameExecutionDirectory('C:\\work\\project', 'C:\\link', 'win32', realpath)).toBe(true);
    expect(await sameExecutionDirectory('C:\\work\\project', 'C:\\work\\project\\', 'win32', identity)).toBe(true);
    expect(await sameExecutionDirectory('C:\\work\\project', 'C:\\work\\other', 'win32', identity)).toBe(false);
  });

  it('is case-sensitive on POSIX and fails closed on a missing, relative or unresolvable path', async () => {
    expect(await sameExecutionDirectory('/work/project', '/work/Project', 'posix', identity)).toBe(false);
    expect(await sameExecutionDirectory('/work/project', undefined, 'posix', identity)).toBe(false);
    expect(await sameExecutionDirectory('/work/project', 'project', 'posix', identity)).toBe(false);
    const failing = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    expect(await sameExecutionDirectory('/work/project', '/work/project', 'posix', failing)).toBe(false);
  });
});
