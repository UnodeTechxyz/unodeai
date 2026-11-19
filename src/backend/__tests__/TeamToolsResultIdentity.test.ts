import { describe, expect, it, vi } from 'vitest';
const clock = vi.hoisted(() => ({ next: 0 }));
vi.mock('uuid', () => ({ v4: () => `issued-${++clock.next}` }));
import { TeamTools, type DelegationDispatchEvent } from '../TeamTools';
import { MessageBus } from '../../bus/MessageBus';
import { RunLedger } from '../../observability/RunLedger';

describe('result identity before a worker can answer', () => {
  it('allocates the settlement token before task.assign and stores exactly that token in the ledger', async () => {
    const bus = new MessageBus(); let assignmentId = 0; let receipt: DelegationDispatchEvent | undefined;
    const ledger = new RunLedger();
    const team = new TeamTools('pm', {
      list: () => [{ id: 'pm', role: 'pm', name: 'PM', status: 'running' }, { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle' }],
      resolve: ref => ref === 'dev' ? { id: 'dev' } : undefined,
    }, bus, { onDelegationDispatched: event => { receipt = event; ledger.recordDelegationDispatched(event); } });
    try {
      bus.onType('task.assign', message => {
        assignmentId = Number(message.id.slice(7));
        bus.send('dev', 'pm', 'task.complete', { instruction: 'usable answer' }, 'normal', message.correlationId);
      });
      await team.run('assign_task_async', { agent: 'dev', instruction: 'work' });
      expect(receipt?.resultCompletion).toBeDefined();
      expect(Number(receipt!.resultCompletion!.settledEventId.slice(7))).toBeLessThan(assignmentId);
      expect(ledger.resultIdentity('pm', receipt!.handle)?.settledEventId).toBe(receipt!.resultCompletion!.settledEventId);
    } finally { team.cancelPending(); bus.dispose(); }
  });
});
