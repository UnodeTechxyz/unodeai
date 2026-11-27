/*
 * v0.9.99 (B10/B20): the extension's own wiring of unverified continuation, run from the actual source of
 * extension.ts (the extension does not load outside VS Code). The policy is the real resolver; only the host
 * services around it are stand-ins.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveCompletionVerificationPolicy,
  verificationExplicitlyRequired,
  verificationUnrunOrUnknown,
  type VerificationPolicyResolution,
} from '../../backend/CompletionVerificationPolicy';

const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function extensionFunction(name: string): string {
  const node = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  expect(node, name).toBeDefined();
  return ts.transpileModule(node!.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function load<T>(name: string, host: Record<string, unknown>): T {
  return new Function('host', `with (host) { ${extensionFunction(name)}; return ${name}; }`)(host) as T;
}

const policy = (completionVerification: unknown): VerificationPolicyResolution => resolveCompletionVerificationPolicy({
  workspaceId: 'workspace', agentSkills: ['code'], completionVerification, readLegacyGlobalCommand: () => undefined,
});

describe('which verification the user explicitly required (v0.9.99)', () => {
  it('a command the user set, or an unreadable policy, is required; automatic detection and disabled are not', () => {
    expect(verificationExplicitlyRequired(policy({ mode: 'command', command: 'npm test' }))).toBe(true);
    expect(verificationExplicitlyRequired(policy({ mode: 'Auto' }))).toBe(true);
    expect(verificationExplicitlyRequired(policy({ mode: 'auto' }))).toBe(false);
    expect(verificationExplicitlyRequired(policy(undefined))).toBe(false);
    expect(verificationExplicitlyRequired(policy({ mode: 'disabled' }))).toBe(false);
  });

  it('only "could not run" and "unknown" outcomes count; failed, stale and invalid do not', () => {
    expect(verificationUnrunOrUnknown({ kind: 'outcome-unknown' })).toBe(true);
    for (const reason of ['disabled', 'not-applicable', 'approval-required', 'policy-blocked', 'spawn-failed']) {
      expect(verificationUnrunOrUnknown({ kind: 'not-run', reason })).toBe(true);
    }
    expect(verificationUnrunOrUnknown({ kind: 'not-run', reason: 'policy-stale' })).toBe(false);
    expect(verificationUnrunOrUnknown({ kind: 'not-run', reason: 'configuration-invalid' })).toBe(false);
    expect(verificationUnrunOrUnknown({ kind: 'failed' })).toBe(false);
    expect(verificationUnrunOrUnknown({ kind: 'passed' })).toBe(false);
  });
});

describe('the actual worktree unverified-merge admission (B10)', () => {
  function host(options: { team: unknown; verifyBeforeMerge?: boolean; trusted?: boolean; dirty?: boolean }) {
    const state = { team: options.team, trusted: options.trusted ?? true, dirty: options.dirty ?? false, root: '/ws' };
    const h = {
      firstWorkspaceRoot: () => state.root,
      sessionManager: { getAll: () => [] },
      skillsForAgent: () => [],
      persistence: { loadTeamConfig: async () => ({ completionVerification: state.team }) },
      vscode: { workspace: { getConfiguration: () => ({ inspect: () => ({}) }), get isTrusted() { return state.trusted; } } },
      readHostVerificationPolicy: async () => policy(state.team),
      verificationExplicitlyRequired,
      configuredSetting: (key: string, fallback: unknown) => key === 'worktree.verifyBeforeMerge'
        ? options.verifyBeforeMerge ?? fallback : key === 'concurrencyStrategy' ? 'worktree' : fallback,
      runGitIn: vi.fn(async () => ({ code: 0, stdout: state.dirty ? ' M file.ts\n' : '' })),
    };
    const admit = load<(root: string, wt: unknown, owner: unknown, current: () => boolean) => Promise<any>>('worktreeUnverifiedMergeAdmission', h);
    return { h, state, admit };
  }
  const owner = (current = true) => ({ isCurrent: () => current });
  const wt = { path: '/ws/.unode/worktrees/dev', branch: 'unode/dev' };

  it('admits an unverified merge under automatic detection, bound to a clean lane, trust and the root', async () => {
    const { admit, state, h } = host({ team: { mode: 'auto' } });
    const admission = await admit('/ws', wt, owner(), () => true);
    expect(admission).toBeDefined();
    expect(admission.isCurrent()).toBe(false); // not refreshed yet: no clean-lane observation
    await admission.refresh();
    expect(h.runGitIn).toHaveBeenCalledWith(wt.path, ['status', '--porcelain']);
    expect(admission.isCurrent()).toBe(true);
    state.trusted = false; expect(admission.isCurrent()).toBe(false); state.trusted = true;
    state.root = '/other'; expect(admission.isCurrent()).toBe(false); state.root = '/ws';
    state.dirty = true; await admission.refresh(); expect(admission.isCurrent()).toBe(false);
  });

  it('refuses when the user set a command, and turns refused if one is set before the merge', async () => {
    expect(await host({ team: { mode: 'command', command: 'npm test' } }).admit('/ws', wt, owner(), () => true)).toBeUndefined();
    const { admit, state } = host({ team: { mode: 'auto' } });
    const admission = await admit('/ws', wt, owner(), () => true);
    state.team = { mode: 'command', command: 'npm test' };
    await admission.refresh();
    expect(admission.isCurrent()).toBe(false);
  });

  it('a command with "verify before merge" turned off is not a requirement; an unreadable policy is', async () => {
    expect(await host({ team: { mode: 'command', command: 'npm test' }, verifyBeforeMerge: false }).admit('/ws', wt, owner(), () => true)).toBeDefined();
    expect(await host({ team: { mode: 'Auto' }, verifyBeforeMerge: false }).admit('/ws', wt, owner(), () => true)).toBeUndefined();
  });

  it('is not current for an expired owner or a replaced coordinator', async () => {
    const expired = await host({ team: undefined }).admit('/ws', wt, owner(false), () => true);
    await expired.refresh(); expect(expired.isCurrent()).toBe(false);
    const replaced = await host({ team: undefined }).admit('/ws', wt, owner(), () => false);
    await replaced.refresh(); expect(replaced.isCurrent()).toBe(false);
  });
});

describe('the actual workflow check reports whether the policy requires it (B20)', () => {
  function host(team: unknown, readFails = false) {
    const h = {
      firstWorkspaceRoot: () => '/ws',
      sessionManager: { getAll: () => [] },
      skillsForAgent: () => [],
      persistence: { loadTeamConfig: async () => ({ completionVerification: team }) },
      vscode: { workspace: { getConfiguration: () => ({}), isTrusted: true } },
      agentRosterEdits: { admissionAllowed: true },
      commandPolicy: {}, verificationPreparer: () => ({ ok: false }), verifyTimeoutMs: () => 1000, notifyVerifyCommandOutsideRoot: () => {},
      runHostVerificationCheck: async () => ({ kind: 'not-run', reason: 'spawn-failed', source: 'team-document', detail: 'No shell.' }),
      readHostVerificationPolicy: async () => { if (readFails) throw new Error('unreadable'); return policy(team); },
      verificationExplicitlyRequired,
    };
    return load<(request: unknown) => Promise<any>>('runWorkflowVerification', h);
  }
  const request = { runId: 'run', workspaceRoot: '/ws', signal: new AbortController().signal, isCurrent: () => true };

  it.each([
    [{ mode: 'auto' }, false],
    [undefined, false],
    [{ mode: 'disabled' }, false],
    [{ mode: 'command', command: 'npm test' }, true],
  ])('policy %j: required=%s', async (team, required) => {
    await expect(host(team)(request)).resolves.toMatchObject({ blocked: true, required, check: { kind: 'not-run' } });
  });

  it('a policy it cannot read afterwards counts as required', async () => {
    await expect(host({ mode: 'auto' }, true)(request)).resolves.toMatchObject({ required: true });
  });
});
