import { describe, expect, it } from 'vitest';
import { ALREADY_USED_MESSAGE, type CommandExecutionProvider, type PreparedCommandExecution, type StartRefusal } from '../CommandExecution';
import { trustedExecutionProvider, UNTRUSTED_COMMAND_MESSAGE } from '../trustedExecution';
import { CMD_SHELL } from './shellFixtures';

/** A provider that records what started, in the foreground and in the background. */
function recordingProvider() {
  const started: string[] = [];
  const reported: unknown[] = [];
  const handed: Array<StartRefusal | undefined> = [];
  const provider: CommandExecutionProvider = {
    async acquire(opts) {
      handed.push(opts.startRefusal);
      const lease: PreparedCommandExecution = {
        ok: true,
        shell: CMD_SHELL,
        transport: 'direct',
        signal: new AbortController().signal,
        execute: async (command) => { started.push(`foreground ${command}`); return { status: 'exited', code: 0, output: '' }; },
        release: async () => undefined,
      };
      return lease;
    },
    prepareDirect: () => ({
      ok: true,
      shell: CMD_SHELL,
      execute: async (command) => { started.push(`direct ${command}`); return { status: 'exited', code: 0, output: '' }; },
      startBackground: (command) => { started.push(`background ${command}`); return { ok: false, error: 'fake' }; },
    }),
    reportUnconfirmedStops: (stops) => { reported.push(...stops); },
  };
  return { provider, started, reported, handed };
}

describe('trustedExecutionProvider (v0.9.96)', () => {
  it('checks Workspace Trust when a foreground or a background command would start, not only when it was prepared', async () => {
    const { provider, started, handed } = recordingProvider();
    let trusted = true;
    const wrapped = trustedExecutionProvider(provider, () => trusted);
    const lease = await wrapped.acquire({ cwd: '/w' });
    const background = wrapped.prepareDirect!();
    if (!lease.ok || !background.ok) throw new Error('refused while trusted');
    // The provider receives the trust check, to apply at each start it makes after the approval.
    expect(handed).toHaveLength(1);
    expect(handed[0]?.()).toBeUndefined();

    // Trust is withdrawn while the approvals wait.
    trusted = false;
    expect(handed[0]?.()).toMatchObject({ ok: false, message: UNTRUSTED_COMMAND_MESSAGE });
    expect(await lease.execute('npm test', 1_000)).toEqual({ status: 'not-started', code: null, reason: 'environment-changed', output: UNTRUSTED_COMMAND_MESSAGE });
    expect(background.startBackground('npm run dev', { cwd: '/w' })).toMatchObject({ ok: false, notStarted: { message: UNTRUSTED_COMMAND_MESSAGE } });
    expect(started).toEqual([]);

    // A refused command was consumed: trust coming back does not run it without a new preparation and approval.
    trusted = true;
    expect(await lease.execute('npm test', 1_000)).toMatchObject({ status: 'not-started', reason: 'disposed', output: ALREADY_USED_MESSAGE });
    expect(background.startBackground('npm run dev', { cwd: '/w' })).toMatchObject({ ok: false, notStarted: { reason: 'disposed' } });
    expect(started).toEqual([]);
    const again = await wrapped.acquire({ cwd: '/w' });
    if (!again.ok) throw new Error('refused while trusted');
    await again.execute('npm test', 1_000);
    expect(await again.execute('npm test', 1_000)).toMatchObject({ status: 'not-started', reason: 'disposed' });
    expect(started).toEqual(['foreground npm test']);
  });

  it('passes the report of unconfirmed background stops through', () => {
    const { provider, reported } = recordingProvider();
    trustedExecutionProvider(provider, () => true).reportUnconfirmedStops!([{ id: 'bg_1', command: 'npm run dev', detail: 'x' }]);
    expect(reported).toEqual([{ id: 'bg_1', command: 'npm run dev', detail: 'x' }]);
  });
});
