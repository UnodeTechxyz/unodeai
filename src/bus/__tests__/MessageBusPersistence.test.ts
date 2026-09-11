import { describe, it, expect } from 'vitest';
import { MessageBus } from '../MessageBus';

describe('MessageBus persistence (P1#5)', () => {
  it('exports the most recent messages bounded by limit', () => {
    const bus = new MessageBus();
    for (let i = 0; i < 10; i++) {
      bus.send('user', 'dev', 'task.assign', { instruction: `m${i}` });
    }
    const exported = bus.exportMessages(3);
    expect(exported).toHaveLength(3);
    expect(exported.map((m) => m.payload.instruction)).toEqual(['m7', 'm8', 'm9']);
  });

  it('imports persisted history into a fresh bus so the log survives a reload', () => {
    const source = new MessageBus();
    source.send('user', 'dev', 'task.assign', { instruction: 'before reload' });
    const saved = source.exportMessages();

    const restored = new MessageBus();
    expect(restored.getMessageCount()).toBe(0);
    restored.importMessages(saved);
    expect(restored.getMessageCount()).toBe(1);
    expect(restored.query({ type: 'task.assign' })[0].payload.instruction).toBe('before reload');
  });

  it('never serializes user attachment bytes or filenames into durable message history', () => {
    const bus = new MessageBus();
    const filename = 'confidential-local-report.pdf';
    const rawPdf = 'JVBERi0xLjcKcHJpdmF0ZQ==';
    bus.send('user', 'dev', 'ask.question', {
      instruction: 'Read the attachment.',
      userAttachments: [{
        name: filename,
        mime: 'application/pdf',
        kind: 'pdf',
        dataBase64: rawPdf,
        size: 16,
      }],
    });

    const persisted = bus.exportMessages();
    expect(persisted[0].payload.userAttachments).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain(filename);
    expect(JSON.stringify(persisted)).not.toContain(rawPdf);

    const restored = new MessageBus();
    restored.importMessages([{
      ...persisted[0],
      payload: {
        ...persisted[0].payload,
        userAttachments: [{ name: filename, mime: 'application/pdf', kind: 'pdf', dataBase64: rawPdf }],
      },
    }]);
    expect(JSON.stringify(restored.exportMessages())).not.toContain(filename);
    expect(JSON.stringify(restored.exportMessages())).not.toContain(rawPdf);
  });

  it('keeps coordinator briefs in the live task attempt but not activity or conversation persistence', () => {
    const bus = new MessageBus();
    bus.send('pm', 'dev', 'task.assign', {
      instruction: 'Investigate the task.',
      taskAttempt: {
        attemptId: 'attempt-1',
        contractId: 'contract-1',
        agentId: 'dev',
        grants: [],
        contract: {
          objective: 'Investigate the task.',
          coordinatorBrief: { text: 'SECRET-COORDINATOR-BRIEF', basisRefs: ['source-1'] },
        },
        baselineWorkspaceAuthority: 'independent-agent-authority',
      } as never,
    });

    expect(JSON.stringify(bus.query())).toContain('SECRET-COORDINATOR-BRIEF');
    const persisted = bus.exportMessages();
    expect(JSON.stringify(persisted)).not.toContain('SECRET-COORDINATOR-BRIEF');
    expect((persisted[0].payload.taskAttempt as any).contract.coordinatorBrief).toBeUndefined();
    expect((persisted[0].payload.taskAttempt as any).contract.objective).toBe('Investigate the task.');
  });

  it('does NOT re-dispatch imported messages to subscribers', () => {
    const bus = new MessageBus();
    const got: string[] = [];
    bus.onType('task.assign', (m) => got.push(m.payload.instruction ?? ''));
    bus.importMessages([
      {
        id: 'x', from: 'user', to: 'dev', type: 'task.assign', priority: 'normal',
        payload: { instruction: 'replayed' }, timestamp: new Date().toISOString(),
      },
    ]);
    expect(got).toEqual([]); // restore is for the log only, not a replay
    expect(bus.getMessageCount()).toBe(1);
  });

  it('ignores empty/invalid imports', () => {
    const bus = new MessageBus();
    bus.importMessages([]);
    bus.importMessages(undefined as never);
    expect(bus.getMessageCount()).toBe(0);
  });
});
