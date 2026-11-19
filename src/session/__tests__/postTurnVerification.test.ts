import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentConfig } from '../../types';
import type { AgentBackend, BackendEvent, BackendEventHandler, TurnAttachments } from '../../backend/AgentBackend';
import type { WorktreeVerificationOwner } from '../../backend/WorktreeVerificationOwner';
import type { VerificationEligibilitySnapshot } from '../../backend/VerificationEligibilitySnapshot';

class Backend implements AgentBackend {
  constructor(readonly agentId = 'dev') {}
  turns = 0; handler?: BackendEventHandler; attachments?: TurnAttachments;
  onEvent(handler: BackendEventHandler) { this.handler = handler; return () => {}; }
  async start() {} sendUserTurn(_text: string, attachments?: TurnAttachments) { this.turns++; this.attachments = attachments; }
  async stop() { this.emit({ kind: 'exit', code: 0 }); }
  abort() {} isAlive() { return true; } emit(event: BackendEvent) { this.handler?.(event); }
}

const config: AgentConfig = { id: 'dev', name: 'Dev', role: 'senior-dev', skill: '', model: 'fake',
  provider: { providerId: 'roam', apiKeySecretName: 'KEY' }, systemPrompt: '', autoApprove: false, allowedTools: [] };
const completed: BackendEvent = { kind: 'turn_complete', result: { text: 'Done.', isError: false, responseOutcome: { kind: 'reply' } } };

describe('completed task verification ownership', () => {
  it('refuses manual review when a stopped-looking worker has an unconfirmed process stop', async () => {
    const bus = new MessageBus();
    const backend = Object.assign(new Backend(), { stop: async () => ({ stopped: false, detail: 'still running' }) });
    const manager = new SessionManager(4, bus, { createBackend: () => backend, resolveEnv: async () => ({}) });
    try {
      manager.create(config); await manager.start('dev', { pin: 'take' }); backend.emit({ kind: 'ready' });
      await manager.stop('dev');
      await vi.waitFor(() => expect(manager.get('dev')?.stopEvidence?.state).toBe('unconfirmed'));
      const operation = vi.fn();
      expect(await manager.withIdleLaneWork('dev', operation)).toBeUndefined(); expect(operation).not.toHaveBeenCalled();
    } finally { manager.dispose(); }
  });
  it.each(['idle', 'stopped', 'absent'] as const)('manual review holds new work without a completed-task lease (%s)', async state => {
    const bus = new MessageBus(); const backend = new Backend();
    const manager = new SessionManager(4, bus, { createBackend: () => backend, resolveEnv: async () => ({}) });
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    try {
      if (state !== 'absent') manager.create(config);
      if (state === 'idle') { await manager.start('dev', { pin: 'take' }); backend.emit({ kind: 'ready' }); }
      const reviewing = manager.withIdleLaneWork('dev', async current => {
        expect(current()).toBe(true);
        if (state === 'absent') expect(() => manager.create(config)).toThrow(/manual merge/);
        else {
          bus.send('user', 'dev', 'ask.question', { instruction: 'queued' });
          await expect(manager.start('dev', { pin: 'take' })).rejects.toThrow(/manual merge/);
          expect(backend.turns).toBe(0);
        }
        await pending; expect(current()).toBe(true); return 'reviewed';
      });
      expect(await manager.withIdleLaneWork('dev', async () => 'overlap')).toBeUndefined();
      release(); expect(await reviewing).toBe('reviewed');
      if (state === 'idle') await vi.waitFor(() => expect(backend.turns).toBe(1));
      if (state === 'stopped') { await vi.waitFor(() => expect(manager.get('dev')?.status).toBe('starting')); backend.emit({ kind: 'ready' }); await vi.waitFor(() => expect(backend.turns).toBe(1)); }
    } finally { release(); manager.dispose(); }
  });
  it('refuses a running worker and invalidates an idle review when Stop is pressed', async () => {
    const bus = new MessageBus(); const backend = new Backend();
    const manager = new SessionManager(4, bus, { createBackend: () => backend, resolveEnv: async () => ({}) });
    try {
      manager.create(config); await manager.start('dev', { pin: 'take' }); backend.emit({ kind: 'ready' });
      await manager.withIdleLaneWork('dev', async current => { await manager.stop('dev'); expect(current()).toBe(false); });
      await manager.start('dev', { pin: 'take' }); backend.emit({ kind: 'ready' });
      bus.send('user', 'dev', 'ask.question', { instruction: 'running' });
      const operation = vi.fn(); expect(await manager.withIdleLaneWork('dev', operation)).toBeUndefined(); expect(operation).not.toHaveBeenCalled();
    } finally { manager.dispose(); }
  });
  it.each(['ready', 'not-applicable', 'configuration-invalid'] as const)('eligibility %s is configuration, never a passing check', async kind => {
    const bus = new MessageBus(); const backend = new Backend(); const records: any[] = [];
    const binding = { source: 'team-document' as const, workspaceId: 'workspace-A', teamKind: 'software' as const, policyDigest: 'digest' };
    const snapshot: VerificationEligibilitySnapshot = kind === 'ready' ? { kind, source: 'team-document', binding, command: 'private-command' }
      : kind === 'not-applicable' ? { kind, source: 'team-document', binding } : { kind, source: 'team-document' };
    const manager = new SessionManager(4, bus, { createBackend: () => backend, resolveEnv: async () => ({}), verificationSnapshot: async () => snapshot });
    manager.on('session.requestCloseout', event => records.push(event.data.record));
    try {
      manager.create(config); await manager.start('dev', { pin: 'take' }); backend.emit({ kind: 'ready' });
      bus.send('user', 'dev', 'ask.question', { instruction: 'task' });
      await vi.waitFor(() => expect(backend.turns).toBe(1)); backend.emit(completed);
      expect(records[0].observations.checks).toMatchObject({ passed: 0, failed: 0 });
      expect(records[0].observations.checks.verificationConfigured).toBe(kind === 'ready' ? true : kind === 'not-applicable' ? false : undefined);
      expect(JSON.stringify(records[0])).not.toMatch(/private-command|policyDigest|workspace-A/);
    } finally { manager.dispose(); }
  });
  it.each([false, true])('snapshots before handover without borrowing a stale eligibility response (stop=%s)', async stop => {
    const bus = new MessageBus(); const backend = new Backend(); let resolveSnapshot!: (snapshot: VerificationEligibilitySnapshot) => void;
    const snapshot = new Promise<VerificationEligibilitySnapshot>(resolve => { resolveSnapshot = resolve; });
    const read = vi.fn(() => snapshot); const legacy = vi.fn(() => true); const records: any[] = [];
    const manager = new SessionManager(4, bus, { createBackend: () => backend, resolveEnv: async () => ({}),
      verificationSnapshot: read, verificationConfigured: legacy });
    manager.on('session.requestCloseout', event => records.push(event.data.record));
    try {
      manager.create(config); await manager.start('dev', { pin: 'take' }); backend.emit({ kind: 'ready' });
      bus.send('user', 'dev', 'ask.question', { instruction: 'first' });
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      expect(backend.turns).toBe(0);
      if (stop) await manager.stop('dev');
      resolveSnapshot({ kind: 'disabled', source: 'team-document', binding: {
        workspaceId: 'workspace-A', source: 'team-document', teamKind: 'knowledge', policyDigest: 'digest',
      } });
      if (stop) {
        await new Promise(resolve => setTimeout(resolve, 0)); expect(backend.turns).toBe(0);
        expect(records[0].observations.checks.verificationConfigured).toBeUndefined();
      } else {
        await vi.waitFor(() => expect(backend.turns).toBe(1));
        expect(backend.attachments?.verificationEligibility).toMatchObject({ kind: 'disabled', source: 'team-document' });
        backend.emit(completed);
        expect(records[0].observations.checks).toMatchObject({ verificationConfigured: false, passed: 0, failed: 0 });
        expect(JSON.stringify(records[0])).not.toMatch(/policyDigest|workspace-A/);
      }
      expect(legacy).not.toHaveBeenCalled();
    } finally { manager.dispose(); }
  });
  it.each([false, true])('holds a reentrant new task until the merge settles (stop=%s)', async stop => {
    const bus = new MessageBus(); const backend = new Backend();
    let owner!: WorktreeVerificationOwner; let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const hook = vi.fn(async (_id, _error, lease) => { owner = lease; await pending; });
    const manager = new SessionManager(4, bus, { createBackend: () => backend, resolveEnv: async () => ({}), onTurnComplete: hook });
    try {
      manager.create(config); await manager.start('dev', { pin: 'take' }); backend.emit({ kind: 'ready' });
      const first = bus.send('user', 'dev', 'ask.question', { instruction: 'first' });
      const requestId = manager.currentRequestId('dev');
      bus.onType('task.complete', () => { bus.send('user', 'dev', 'ask.question', { instruction: 'second' }); });
      backend.emit(completed);
      expect(owner.request).toEqual({ kind: 'session', sessionId: 'dev', requestId, attemptId: first.id });
      expect(owner.isCurrent()).toBe(true); expect(backend.turns).toBe(1);
      expect(manager.liveRequestAgents(requestId!)).toEqual(['dev']);
      expect(manager.requestRunning(requestId!)).toBe(true);
      if (stop) {
        expect(manager.stopRequest(requestId!)).toBe(1);
        expect(owner.signal.aborted).toBe(true); expect(owner.isCurrent()).toBe(false);
      }
      release(); await vi.waitFor(() => expect(backend.turns).toBe(stop ? 1 : 2));
      expect(owner.isCurrent()).toBe(false);
      if (!stop) {
        expect(manager.currentTurnId('dev')).not.toBe(first.id);
        expect(manager.currentRequestId('dev')).not.toBe(requestId);
      }
    } finally { release(); manager.dispose(); }
  });

  it('stopping the coordinator aborts only post-turn checks of that original request', async () => {
    const bus = new MessageBus(); const backends = new Map<string, Backend>();
    const owners = new Map<string, WorktreeVerificationOwner>(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const manager = new SessionManager(4, bus, {
      createBackend: agent => { const backend = new Backend(agent.id); backends.set(agent.id, backend); return backend; },
      resolveEnv: async () => ({}), onTurnComplete: async (id, _error, owner) => { if (owner) owners.set(id, owner); await pending; },
    });
    try {
      for (const id of ['pm', 'dev', 'other']) {
        manager.create({ ...config, id, role: id === 'pm' ? 'pm' : 'senior-dev' });
        await manager.start(id, { pin: 'take' }); backends.get(id)!.emit({ kind: 'ready' });
      }
      bus.send('user', 'pm', 'ask.question', { instruction: 'root task' });
      bus.send('pm', 'dev', 'task.assign', { instruction: 'worker task' }, 'normal', 'handle-A');
      bus.send('user', 'other', 'ask.question', { instruction: 'independent task' });
      backends.get('dev')!.emit(completed); backends.get('other')!.emit(completed);
      expect(owners.get('dev')!.isCurrent()).toBe(true); expect(owners.get('other')!.isCurrent()).toBe(true);
      await manager.stop('pm');
      expect(owners.get('dev')!.signal.aborted).toBe(true); expect(owners.get('dev')!.isCurrent()).toBe(false);
      expect(owners.get('other')!.signal.aborted).toBe(false); expect(owners.get('other')!.isCurrent()).toBe(true);
    } finally { release(); manager.dispose(); }
  });

  it('does not lease a stopped/failed turn or an agent without an original completion', async () => {
    const bus = new MessageBus(); const backend = new Backend(); const hook = vi.fn();
    const manager = new SessionManager(4, bus, { createBackend: () => backend, resolveEnv: async () => ({}), onTurnComplete: hook });
    try {
      manager.create(config); await manager.start('dev', { pin: 'take' }); backend.emit({ kind: 'ready' });
      const operation = vi.fn(async () => {});
      expect(await manager.withCompletedTurnWork('dev', operation)).toBeUndefined();
      bus.send('user', 'dev', 'ask.question', { instruction: 'task' });
      backend.emit({ kind: 'turn_complete', result: { text: 'Stopped.', isError: false, responseOutcome: { kind: 'stopped' },
        stop: { state: 'stopped', reason: 'user' } as any } });
      expect(await manager.withCompletedTurnWork('dev', operation)).toBeUndefined();
      expect(operation).not.toHaveBeenCalled();
      expect(hook).toHaveBeenCalledWith('dev', true);
    } finally { manager.dispose(); }
  });
});
