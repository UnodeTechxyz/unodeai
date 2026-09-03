import { describe, it, expect, vi } from 'vitest';
import { ApprovalEvent, ApprovalQueue } from '../approvals';

describe('ApprovalQueue', () => {
  it('resolves a request with the user decision and removes it from the queue', async () => {
    const q = new ApprovalQueue();
    const p = q.request({ kind: 'command', agentName: 'Dev', command: 'npm test' });
    expect(q.list()).toHaveLength(1);
    expect(q.pendingCount()).toBe(1);

    const id = q.list()[0].id;
    expect(q.resolve(id, { action: 'session' })).toBe(true);
    await expect(p).resolves.toEqual({ action: 'session' });
    expect(q.list()).toHaveLength(0);
    expect(q.pendingCount()).toBe(0);
  });

  it('carries a deny note through to the awaiter', async () => {
    const q = new ApprovalQueue();
    const p = q.request({ kind: 'command', agentName: 'Dev', command: 'rm -rf /' });
    q.resolve(q.list()[0].id, { action: 'deny', note: 'use npm run clean' });
    await expect(p).resolves.toEqual({ action: 'deny', note: 'use npm run clean' });
  });

  it('keeps multiple requests independent and resolvable out of order', async () => {
    const q = new ApprovalQueue();
    const a = q.request({ kind: 'write', agentName: 'A', path: 'a.ts', verb: 'create', diff: '+1' });
    const b = q.request({ kind: 'write', agentName: 'B', path: 'b.ts', verb: 'overwrite', diff: '+2' });
    expect(q.list()).toHaveLength(2);
    const [idA, idB] = q.list().map((r) => r.id);

    q.resolve(idB, { action: 'always' });
    await expect(b).resolves.toEqual({ action: 'always' });
    expect(q.list().map((r) => r.id)).toEqual([idA]);

    q.resolve(idA, { action: 'once' });
    await expect(a).resolves.toEqual({ action: 'once' });
    expect(q.list()).toHaveLength(0);
  });

  it('resolve() returns false for an unknown or already-resolved id', () => {
    const q = new ApprovalQueue();
    q.request({ kind: 'command', agentName: 'Dev', command: 'ls' });
    const id = q.list()[0].id;
    expect(q.resolve(id, { action: 'once' })).toBe(true);
    expect(q.resolve(id, { action: 'once' })).toBe(false);
    expect(q.resolve('nope', { action: 'once' })).toBe(false);
  });

  it('denyAll() resolves everything pending as a deny (so a torn-down panel never hangs)', async () => {
    const q = new ApprovalQueue();
    const a = q.request({ kind: 'command', agentName: 'A', command: 'x' });
    const b = q.request({ kind: 'write', agentName: 'B', path: 'b', verb: 'create', diff: '' });
    q.denyAll();
    await expect(a).resolves.toEqual({ action: 'deny' });
    await expect(b).resolves.toEqual({ action: 'deny' });
    expect(q.list()).toHaveLength(0);
    expect(q.pendingCount()).toBe(0);
  });

  it('fires onChange when the queue changes', () => {
    const onChange = vi.fn();
    const q = new ApprovalQueue(onChange);
    q.request({ kind: 'command', agentName: 'Dev', command: 'ls' });
    expect(onChange).toHaveBeenCalledTimes(1);
    q.resolve(q.list()[0].id, { action: 'once' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('emits transport-neutral pending and decided events with the approver identity', async () => {
    const events: ApprovalEvent[] = [];
    const q = new ApprovalQueue(undefined, (event) => events.push(event));
    const pending = q.request({
      kind: 'command',
      agentId: 'agent-42',
      sessionId: 'session-42',
      agentName: 'Developer',
      command: 'npm test',
    }, 500);
    const id = q.list()[0].id;

    expect(events[0]).toMatchObject({
      type: 'pending',
      approval: {
        id,
        agent: { id: 'agent-42', name: 'Developer' },
        sessionId: 'session-42',
        action: { kind: 'command', summary: 'Run a command', target: 'npm test' },
        deadline: expect.any(String),
      },
    });
    // The event is ordinary data: safe for a future mobile/web subscriber and contains no editor object.
    expect(JSON.stringify(events[0]).toLowerCase()).not.toContain('vscode');

    q.resolve(id, { action: 'once' }, 'local:owner-1');
    await expect(pending).resolves.toEqual({ action: 'once' });
    expect(events[1]).toMatchObject({
      type: 'decided',
      approvalId: id,
      agent: { id: 'agent-42', name: 'Developer' },
      sessionId: 'session-42',
      decision: { action: 'once' },
      approverId: 'local:owner-1',
    });
  });

  it('returns the host-attached actor only for a contemporaneous human decision', async () => {
    const q = new ApprovalQueue();
    const decided = q.requestWithIdentity({ kind: 'command', agentName: 'Dev', command: 'npm test' });
    q.resolve(q.list()[0].id, { action: 'once' }, 'local:machine-canary');
    await expect(decided).resolves.toMatchObject({
      action: 'once', approverId: 'local:machine-canary', approvalId: expect.stringMatching(/^appr-/),
    });

    const disposed = q.requestWithIdentity({ kind: 'write', agentName: 'Dev', path: 'a.ts', verb: 'create' });
    q.denyAll();
    await expect(disposed).resolves.toMatchObject({ action: 'deny', approvalId: expect.stringMatching(/^appr-/) });
  });

  it('removes a bounded approval and returns a clean deny when its human window lapses', async () => {
    vi.useFakeTimers();
    try {
      const events: ApprovalEvent[] = [];
      const q = new ApprovalQueue(undefined, (event) => events.push(event));
      const pending = q.requestWithIdentity({ kind: 'tool', agentId: 'researcher', agentName: 'Researcher', toolName: 'Web access' }, 60);
      expect(q.pendingCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toMatchObject({
        action: 'deny', note: 'The approval window expired.', expired: true, approvalId: expect.stringMatching(/^appr-/),
      });
      expect(q.pendingCount()).toBe(0);
      expect(q.list()).toEqual([]);
      expect(events.at(-1)).toMatchObject({
        type: 'expired',
        agent: { id: 'researcher', name: 'Researcher' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never revives an expired approval as approved or reuses its opaque id', async () => {
    vi.useFakeTimers();
    try {
      const q = new ApprovalQueue();
      const expired = q.requestWithIdentity({ kind: 'command', agentName: 'Dev', command: 'npm test' }, 60);
      const expiredId = q.list()[0].id;
      await vi.advanceTimersByTimeAsync(60);
      await expect(expired).resolves.toMatchObject({ action: 'deny', expired: true, approvalId: expiredId });
      expect(q.resolve(expiredId, { action: 'once' })).toBe(false);

      const fresh = q.requestWithIdentity({ kind: 'command', agentName: 'Dev', command: 'npm test' }, 60);
      const freshId = q.list()[0].id;
      expect(freshId).not.toBe(expiredId);
      expect(q.resolve(freshId, { action: 'once' })).toBe(true);
      await expect(fresh).resolves.toMatchObject({ action: 'once', approvalId: freshId });

      // Mutation canary: restoring a resolver in expire(), or resolving the old id after it has left the
      // queue, turns a timed-out consent into an approval without a fresh human decision.
    } finally {
      vi.useRealTimers();
    }
  });
});
