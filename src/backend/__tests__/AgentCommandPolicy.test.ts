import { describe, expect, it } from 'vitest';
import { AgentCommandPolicy, narrowerCommandMode } from '../AgentCommandPolicy';
import { CommandPolicy } from '../CommandPolicy';
import { ON_CMD, ON_POSIX, ON_WINDOWS_POWERSHELL } from './shellFixtures';

describe('AgentCommandPolicy', () => {
  it('inherits the global policy exactly when no narrowing is stored', () => {
    const policy = new AgentCommandPolicy(new CommandPolicy('ask', ['npm test']), undefined, 'Ada');
    expect(policy.check('npm test', ON_POSIX)).toEqual({ allowed: true });
    expect(policy.check('git status', ON_POSIX)).toMatchObject({ allowed: false, ask: true, reason: 'global command policy requires approval' });
  });

  it('cannot run a globally allowed command the agent did not select', () => {
    const policy = new AgentCommandPolicy(
      new CommandPolicy('allowlist', ['npm test', 'git status']),
      { approvalMode: 'allowlist', allowedCommands: ['npm test'] },
      'Ada',
    );
    expect(policy.check('npm test', ON_POSIX).allowed).toBe(true);
    expect(policy.check('git status', ON_POSIX)).toMatchObject({ allowed: false, reason: expect.stringContaining('agent command narrowing for Ada') });
  });

  it('keeps the intersection when the global allowlist later shrinks', () => {
    const global = new CommandPolicy('allowlist', ['npm test', 'git status']);
    const policy = new AgentCommandPolicy(
      global,
      { approvalMode: 'allowlist', allowedCommands: ['npm test'] },
      'Ada',
    );
    expect(policy.check('npm test', ON_POSIX).allowed).toBe(true);
    global.reload('allowlist', ['git status']);
    expect(policy.check('npm test', ON_POSIX)).toMatchObject({ allowed: false, reason: expect.stringContaining('global command policy') });
  });

  it('a selected project approval counts only in the shell grammar it was given in', () => {
    const global = new CommandPolicy('allowlist', { configured: ['npm test'], project: [{ grammar: 'powershell', template: 'git status' }] });
    const policy = new AgentCommandPolicy(
      global,
      { approvalMode: 'allowlist', allowedCommands: ['git status', 'npm test'] },
      'Ada',
    );
    expect(policy.check('git status', ON_WINDOWS_POWERSHELL).allowed).toBe(true);
    expect(policy.check('npm test', ON_CMD).allowed).toBe(true);
    expect(policy.check('git status', ON_CMD)).toMatchObject({ allowed: false, reason: expect.stringContaining('global command policy') });
    // The ceiling holds even where the global policy itself would ask: an unselected grant stays outside it.
    const asking = new AgentCommandPolicy(
      new CommandPolicy('ask', { configured: [], project: [{ grammar: 'powershell', template: 'git status' }] }),
      { approvalMode: 'allowlist', allowedCommands: [] },
      'Ada',
    );
    expect(asking.check('git status', ON_WINDOWS_POWERSHELL)).toMatchObject({ allowed: false, reason: expect.stringContaining('agent command narrowing for Ada') });
  });

  it('always names the level that refused the command', () => {
    const global = new CommandPolicy('none');
    const policy = new AgentCommandPolicy(global, { approvalMode: 'all', allowedCommands: [] }, 'Ada');
    expect(policy.check('npm test', ON_POSIX).reason).toContain('global command policy');
  });

  it('clamps a stale saved mode to the global ceiling', () => {
    expect(narrowerCommandMode('allowlist', 'all')).toBe('allowlist');
    expect(narrowerCommandMode('ask', 'allowlist')).toBe('allowlist');
  });
});
