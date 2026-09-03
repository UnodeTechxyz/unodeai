import { describe, expect, it } from 'vitest';
import { AgentCommandPolicy, narrowerCommandMode } from '../AgentCommandPolicy';
import { CommandPolicy } from '../CommandPolicy';

describe('AgentCommandPolicy', () => {
  it('inherits the global policy exactly when no narrowing is stored', () => {
    const policy = new AgentCommandPolicy(new CommandPolicy('ask', ['npm test']), undefined, 'Ada');
    expect(policy.check('npm test')).toEqual({ allowed: true });
    expect(policy.check('git status')).toMatchObject({ allowed: false, ask: true, reason: 'global command policy requires approval' });
  });

  it('cannot run a globally allowed command the agent did not select', () => {
    const policy = new AgentCommandPolicy(
      new CommandPolicy('allowlist', ['npm test', 'git status']),
      { approvalMode: 'allowlist', allowedCommands: ['npm test'] },
      'Ada',
    );
    expect(policy.check('npm test').allowed).toBe(true);
    expect(policy.check('git status')).toMatchObject({ allowed: false, reason: expect.stringContaining('agent command narrowing for Ada') });
  });

  it('keeps the intersection when the global allowlist later shrinks', () => {
    const global = new CommandPolicy('allowlist', ['npm test', 'git status']);
    const policy = new AgentCommandPolicy(
      global,
      { approvalMode: 'allowlist', allowedCommands: ['npm test'] },
      'Ada',
    );
    expect(policy.check('npm test').allowed).toBe(true);
    global.reload('allowlist', ['git status']);
    expect(policy.check('npm test')).toMatchObject({ allowed: false, reason: expect.stringContaining('global command policy') });
  });

  it('always names the level that refused the command', () => {
    const global = new CommandPolicy('none');
    const policy = new AgentCommandPolicy(global, { approvalMode: 'all', allowedCommands: [] }, 'Ada');
    expect(policy.check('npm test').reason).toContain('global command policy');
  });

  it('clamps a stale saved mode to the global ceiling', () => {
    expect(narrowerCommandMode('allowlist', 'all')).toBe('allowlist');
    expect(narrowerCommandMode('ask', 'allowlist')).toBe('allowlist');
  });
});
