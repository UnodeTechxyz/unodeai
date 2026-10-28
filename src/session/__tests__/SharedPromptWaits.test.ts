import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedOperationLeases } from '../../mcp/SharedOperationLeases';
import { blockingPrompt } from '../../views/attentionSignal';
import { SharedPromptWaits } from '../SharedPromptWaits';
import { TurnTimingTracker } from '../TurnTiming';

/** The real turn clock behind the shared waits, on a clock the test moves. */
function harness(start = 100_000) {
  const state = { now: start };
  const tracker = new TurnTimingTracker(() => state.now);
  let prompts = 0;
  const waits = new SharedPromptWaits({
    approvalStarted: (sessionId, approvalId) => { tracker.approvalStarted(sessionId, approvalId); },
    approvalFinished: (sessionId, approvalId) => { tracker.approvalFinished(sessionId, approvalId); },
  }, () => `prompt-${++prompts}`);
  /** The turn of a request sent at `sentAtMs` that begins now and ends at once. */
  const turnOf = (sessionId: string, sentAtMs: number) => {
    tracker.begin(sessionId, new Date(sentAtMs).toISOString());
    return tracker.finish(sessionId)!;
  };
  return { state, tracker, waits, turnOf };
}

/** A prompt the test answers when it chooses. */
function openPrompt<T>() {
  let answer!: (value: T) => void;
  let fail!: (error: Error) => void;
  const shown = new Promise<T>((resolve, reject) => { answer = resolve; fail = reject; });
  return { show: () => shown, answer, fail };
}

describe('shared prompt waits', () => {
  it('takes one shared decision out of the queue time of every start that waited for it, each for its own wait', async () => {
    const { state, waits, turnOf } = harness();
    // Two requests go to two stopped agents that are both granted the same MCP server.
    const pmDone = waits.join('github', 'pm');
    state.now = 102_000;
    const prompt = openPrompt<string>();
    const answered = waits.prompt('github')(prompt.show);
    state.now = 110_000;
    const devDone = waits.join('github', 'dev');
    state.now = 140_000;
    prompt.answer('Approve & Mount');
    await expect(answered).resolves.toBe('Approve & Mount');
    // The server then takes 3 s to start: that part is the queue's.
    state.now = 143_000;
    pmDone();
    devDone();

    const pm = turnOf('pm', 100_000);
    expect(pm).toMatchObject({ durationMs: 5_000, approvalWaitMs: 38_000 });
    expect(pm.phases).toMatchObject({ queuedMs: 5_000 });
    // The second start joined 8 s into the prompt: only its own 30 s are the person's.
    const dev = turnOf('dev', 110_000);
    expect(dev).toMatchObject({ durationMs: 3_000, approvalWaitMs: 30_000 });
    // An agent that never waited on this mount is not touched by it.
    expect(turnOf('qa', 100_000)).toMatchObject({ durationMs: 43_000, approvalWaitMs: 0 });
  });

  it('stops charging a start that gave up while the prompt was still open', async () => {
    const { state, waits, turnOf } = harness(0);
    const first = waits.join('github', 'pm');
    const second = waits.join('github', 'pm');
    state.now = 2_000;
    const prompt = openPrompt<string>();
    const answered = waits.prompt('github')(prompt.show);
    // One of its two waits ends: it is still waiting for the person.
    state.now = 10_000;
    first();
    // Its readiness deadline passes at 30 s with the dialog still on screen.
    state.now = 30_000;
    second();
    second();
    state.now = 90_000;
    prompt.answer('Skip');
    await answered;

    state.now = 95_000;
    const pm = turnOf('pm', 0);
    expect(pm).toMatchObject({ durationMs: 67_000, approvalWaitMs: 28_000 });
  });

  it('releases every waiter when the prompt cannot be shown, and pauses nobody once it has ended', async () => {
    const { state, tracker, waits, turnOf } = harness(0);
    const done = waits.join('github', 'pm');
    const prompt = openPrompt<string>();
    const answered = waits.prompt('github')(prompt.show);
    state.now = 4_000;
    prompt.fail(new Error('no window'));
    await expect(answered).rejects.toThrow('no window');
    done();

    state.now = 5_000;
    tracker.begin('pm', new Date(0).toISOString());
    expect(tracker.snapshot('pm')).toMatchObject({ approvalPending: false, activeMs: 1_000 });
    tracker.finish('pm');
    // A later start that waits on the same server finds no prompt open.
    const later = waits.join('github', 'dev');
    state.now = 9_000;
    later();
    expect(turnOf('dev', 5_000)).toMatchObject({ durationMs: 4_000, approvalWaitMs: 0 });
  });
});

/**
 * The whole path a mount approval takes when a start gives up on it: the shared lease, the readiness deadline, the
 * dialog that stays on screen, and the retry that opens a second dialog behind it. Only the dialogs are stand-ins.
 */
describe('a shared mount that times out and is retried while its first dialog is still open', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });
  afterEach(() => vi.useRealTimers());

  function world() {
    const tracker = new TurnTimingTracker(() => Date.now());
    const waits = new SharedPromptWaits({
      approvalStarted: (sessionId, approvalId) => { tracker.approvalStarted(sessionId, approvalId); },
      approvalFinished: (sessionId, approvalId) => { tracker.approvalFinished(sessionId, approvalId); },
    });
    const leases = new SharedOperationLeases<string, 'mounted' | 'skipped'>();
    const dialogs: Array<(choice: string | undefined) => void> = [];
    // The mount as the host performs it: one approval dialog, raced against every waiter giving the mount up.
    const mount = async (signal: AbortSignal): Promise<'mounted' | 'skipped'> => {
      const approval = blockingPrompt(
        undefined,
        () => new Promise<string | undefined>((resolve) => dialogs.push(resolve)),
        waits.prompt('github'),
      );
      const choice = await Promise.race([
        approval,
        new Promise<undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true })),
      ]);
      return !signal.aborted && choice === 'Approve & Mount' ? 'mounted' : 'skipped';
    };
    // An agent start waiting for that mount until its readiness deadline, as the host does.
    const start = (sessionId: string, deadlineMs: number) => {
      const lease = leases.acquire('github', mount);
      return waits.waitAs('github', sessionId, lease.promise, deadlineMs).finally(() => lease.release());
    };
    return { tracker, dialogs, start };
  }

  it('leaves no session paused when both starts run out before either dialog is closed', async () => {
    const { tracker, dialogs, start } = world();
    // 0 s: a request is sent to a stopped agent. Its start needs the mount approved and nobody answers.
    const first = start('pm', 45_000);
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(first).resolves.toEqual({ timedOut: true });
    expect(dialogs).toHaveLength(1);

    // 50 s: the agent is started again with the first dialog still on screen. A second dialog opens behind it.
    await vi.advanceTimersByTimeAsync(5_000);
    const second = start('pm', 45_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(dialogs).toHaveLength(2);

    // 95 s: the second start runs out as well. 100 s and 101 s: the person closes the old dialog, then the new one.
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(second).resolves.toEqual({ timedOut: true });
    await vi.advanceTimersByTimeAsync(5_000);
    dialogs[0](undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    dialogs[1](undefined);

    // 110 s: a third start needs no approval and the queued request runs.
    await vi.advanceTimersByTimeAsync(9_000);
    tracker.begin('pm', new Date(0).toISOString());
    expect(tracker.snapshot('pm')).toMatchObject({ approvalPending: false, activeMs: 20_000 });
    // It waited for a person during both starts, 45 s each, and at no other time.
    expect(tracker.finish('pm')).toMatchObject({ durationMs: 20_000, approvalWaitMs: 90_000 });

    // Nothing is left over to pause a later turn.
    await vi.advanceTimersByTimeAsync(60_000);
    tracker.begin('pm', new Date(Date.now()).toISOString());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tracker.snapshot('pm')).toMatchObject({ approvalPending: false });
    expect(tracker.finish('pm')).toMatchObject({ durationMs: 5_000, approvalWaitMs: 0 });
  });

  it('charges the retry for the old dialog and its own, and stops when the mount is approved', async () => {
    const { tracker, dialogs, start } = world();
    const first = start('pm', 45_000);
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(first).resolves.toEqual({ timedOut: true });

    // 50 s: retry. 60 s: the old dialog is closed. 70 s: the new one is approved and the mount completes.
    await vi.advanceTimersByTimeAsync(5_000);
    const second = start('pm', 45_000);
    await vi.advanceTimersByTimeAsync(10_000);
    dialogs[0](undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    dialogs[1]('Approve & Mount');
    await expect(second).resolves.toEqual({ timedOut: false, value: 'mounted' });

    // 72 s: the request runs. Of its 72 s in the queue, 45 s and 20 s were a person's.
    await vi.advanceTimersByTimeAsync(2_000);
    tracker.begin('pm', new Date(0).toISOString());
    expect(tracker.snapshot('pm')).toMatchObject({ approvalPending: false });
    expect(tracker.finish('pm')).toMatchObject({ durationMs: 7_000, approvalWaitMs: 65_000 });
  });

  it('pauses a second agent only for its own wait when it starts during the first agent\'s retry', async () => {
    const { tracker, dialogs, start } = world();
    const first = start('pm', 45_000);
    await vi.advanceTimersByTimeAsync(45_000);
    await first;
    await vi.advanceTimersByTimeAsync(5_000);
    const retry = start('pm', 45_000);
    // 60 s: another agent granted the same server starts and joins the mount that is already waiting.
    await vi.advanceTimersByTimeAsync(10_000);
    const other = start('dev', 45_000);
    await vi.advanceTimersByTimeAsync(10_000);
    dialogs[0](undefined);
    dialogs[1]('Approve & Mount');
    await expect(retry).resolves.toEqual({ timedOut: false, value: 'mounted' });
    await expect(other).resolves.toEqual({ timedOut: false, value: 'mounted' });
    expect(dialogs).toHaveLength(2);

    tracker.begin('dev', new Date(60_000).toISOString());
    expect(tracker.finish('dev')).toMatchObject({ durationMs: 0, approvalWaitMs: 10_000 });
    tracker.begin('pm', new Date(0).toISOString());
    expect(tracker.finish('pm')).toMatchObject({ durationMs: 5_000, approvalWaitMs: 65_000 });
  });
});
