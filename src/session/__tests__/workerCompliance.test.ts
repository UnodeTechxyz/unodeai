import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { workerComplianceProtocol } from '../SessionManager';
import { AgentConfig } from '../../types';

const cfg = (over: Partial<AgentConfig>): AgentConfig => ({
  id: 'a', role: 'senior-dev', name: 'Dev', skill: '', skills: [],
  provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
  model: 'deepseek-v4-flash', systemPrompt: '', autoApprove: false,
  allowedTools: ['read', 'write', 'execute'],
  ...over,
});

describe('workerComplianceProtocol', () => {
  it('keeps the shipped coordinator runtime guidance byte-for-byte unchanged by content receipt support', () => {
    const prompt = workerComplianceProtocol(cfg({ role: 'pm', allowedTools: ['delegate'] }), 'a');
    expect(createHash('sha256').update(prompt).digest('hex')).toBe('65b5d24520586cd612a9605554b8ce049619e5842486e07dbd9c0f93febcd8f3');
    expect(prompt).not.toContain('declare_turn_deliverable');
    expect(prompt).not.toContain('deliver_declared_content');
    expect(prompt).not.toContain('publish_content_receipt');
  });

  it('injects the protocol for worker agents (incl. the shared fresh-read rule)', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    expect(out).toMatch(/Cite from a fresh read, never from memory/i); // shared by every agent
    expect(out).toContain('Carrying out an assigned task');
    expect(out).toMatch(/do not reply with only a plan/i);
    expect(out).toMatch(/Do NOT tell the requester to run a command/i);
  });

  it('includes the P2 worker-protocol rules (from dogfood findings)', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    // Re-read before claiming "already done" (caught: agent claimed a change from stale memory).
    expect(out).toMatch(/READ the relevant file\(s\).*current contents/is);
    expect(out).toMatch(/never rely on\s+your memory/i);
    // Don't weaken tests to pass (caught: agent changed an assertion to match buggy output).
    expect(out).toMatch(/fixing the CODE, never by weakening the tests/i);
    // Small, verifiable steps.
    expect(out).toMatch(/small, verifiable steps/i);
    // Todo hygiene: mark the final step completed before reporting done.
    expect(out).toMatch(/todo list honest/i);
    expect(out).toMatch(/mark the FINAL step completed/i);
  });

  it('makes workers ground the task in the real code before acting (weak-model failure mode)', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    expect(out).toMatch(/Ground the task in the REAL code before you act/i);
    expect(out).toMatch(/instruction tells you the INTENT/i);
    expect(out).toMatch(/RECONCILE the instruction with what you found/i);
    expect(out).toMatch(/do not invent a function, file, import, or pattern/i);
    expect(out).toMatch(/instruction CONFLICTS with reality/i);
  });

  it('does NOT give the coordinator the worker-only ground-first / task protocol', () => {
    const out = workerComplianceProtocol(cfg({ role: 'pm', allowedTools: ['read', 'search', 'delegate', 'message'] }), 'a');
    expect(out).toMatch(/Cite from a fresh read, never from memory/i);
    expect(out).toMatch(/read it this turn/i);
    expect(out).not.toContain('Carrying out an assigned task'); // not the worker protocol
    expect(out).not.toMatch(/Ground the task in the REAL code/i);
  });

  it('gives any delegate-holding agent the same fresh-read rule', () => {
    const out = workerComplianceProtocol(cfg({ role: 'custom', allowedTools: ['read', 'delegate'] }), 'pm');
    expect(out).toMatch(/Cite from a fresh read, never from memory/i);
  });

  it('uses the supplied coordinator id rather than a PM role or delegate capability', () => {
    const secondPm = cfg({ id: 'pm-2', role: 'pm', allowedTools: ['delegate'] });

    expect(workerComplianceProtocol(secondPm, 'pm')).toContain('Carrying out an assigned task');
    expect(workerComplianceProtocol(secondPm, 'pm')).not.toContain('## How to delegate');
    expect(workerComplianceProtocol(cfg({ id: 'pm', role: 'pm' }), 'pm')).toContain('## How to delegate');
  });

  it('does not retain the transcript-visibility instruction after structural receipt publication', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    expect(out).not.toContain('A tool result is not a user-visible reply');
    expect(out).not.toMatch(/"I read it" is not "I\s*showed it to you\./i);
    expect(out).not.toMatch(/Do not rely on tool-card rendering/i);
  });

  it('still applies to read-only workers like the reviewer', () => {
    expect(workerComplianceProtocol(cfg({ role: 'reviewer', allowedTools: ['read', 'search', 'message'] }), 'pm')).toContain('deliverable');
  });
});

describe('coordinator delegation protocol reaches EXISTING agents (prompt-freeze regression)', () => {
  // An agent's systemPrompt is copied from its role template at creation and PERSISTED, so a template edit
  // only ever reaches NEW agents. A field report caught this: the delegation rule was fixed, but a PM created
  // earlier kept blocking on assign_task and the user could not reach it. The rule must be appended at
  // RUNTIME (so old PMs get it) and must SUPERSEDE the frozen copy still in their prompt.
  it('appends the non-blocking delegation rule to a coordinator at runtime', () => {
    const pm = workerComplianceProtocol({ id: 'pm', role: 'pm', allowedTools: ['delegate'] } as never, 'pm');
    expect(pm).toMatch(/dispatch_task/);
    expect(pm).toMatch(/collect_ready_tasks/);
    expect(pm).toMatch(/END YOUR TURN/i);
    expect(pm).toMatch(/SUPERSEDES any earlier delegation instruction/i);
    expect(pm).toMatch(/no blocking delegation tool/i);
  });

  it('does not give a non-coordinator worker delegation rules', () => {
    const worker = workerComplianceProtocol({ role: 'senior-dev', allowedTools: ['write'] } as never, 'pm');
    expect(worker).not.toMatch(/dispatch_task/);
  });
});
